// Driver API. Every call is authorised by the driver's private link token.
import { HttpError, json, readJson, randId, cleanStr, getSettings, todayIn, logEvent } from './lib.js';
import { recomputeRoute, checkRouteFinished } from './routes.js';
import { haversine } from './geo.js';

// Auto arrive / depart tuning (metres, metres per second)
const ARRIVE_RADIUS = 120;      // close enough to count as "at the stop"
const ARRIVE_RADIUS_NOSPEED = 60;
const ARRIVE_MAX_SPEED = 3.5;   // about 8 mph: slowing down / parked
const DEPART_RADIUS = 250;      // left the stop
const MAX_ACCURACY = 100;       // ignore fuzzy fixes for arrive/depart
const ETA_EVERY_MS = 3 * 60 * 1000;

// Save GPS points, update the driver's live position, auto-mark arrivals/departures, refresh ETAs.
export async function ingestPositions(env, ctx, driver, raw, routeHint) {
  const now = Date.now();
  const pts = [];
  for (const b of raw || []) {
    if (!b || typeof b !== 'object') continue;
    const lat = num(b.lat), lng = num(b.lng);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) continue;
    let at = num(b.at) || now;
    if (at > now) at = now;
    if (at < now - 2 * 24 * 3600 * 1000) continue;
    const speed = num(b.speed);
    pts.push({ lat, lng, acc: num(b.acc), speed: speed != null && speed >= 0 ? speed : null, heading: num(b.heading), at });
  }
  if (!pts.length) return { saved: 0, changed: false };
  pts.sort((a, b) => a.at - b.at);

  // Which route these points belong to: the one the phone says, else the driver's active route.
  let route = null;
  const hint = Number(routeHint);
  if (Number.isInteger(hint) && hint > 0) {
    route = await env.DB.prepare('SELECT id, status, last_eta_at FROM routes WHERE id = ? AND driver_id = ?').bind(hint, driver.id).first();
  }
  if (!route || route.status !== 'active') {
    const act = await env.DB.prepare(`SELECT id, status, last_eta_at FROM routes WHERE driver_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`).bind(driver.id).first();
    if (act) route = act;
  }
  const routeId = route ? route.id : null;

  const last = pts[pts.length - 1];
  const stmts = pts.map(p => env.DB.prepare('INSERT INTO positions (driver_id, route_id, lat, lng, acc, speed, heading, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(driver.id, routeId, p.lat, p.lng, p.acc, p.speed, p.heading, p.at));
  stmts.push(env.DB.prepare('UPDATE drivers SET last_lat = ?, last_lng = ?, last_acc = ?, last_pos_at = ? WHERE id = ? AND (last_pos_at IS NULL OR last_pos_at <= ?)')
    .bind(last.lat, last.lng, last.acc, last.at, driver.id, last.at));
  if (routeId) stmts.push(env.DB.prepare('UPDATE routes SET gps_alert_at = NULL WHERE id = ? AND gps_alert_at IS NOT NULL').bind(routeId));
  await env.DB.batch(stmts);

  if (!route || route.status !== 'active') return { saved: pts.length, changed: false };

  // ---- auto arrive / depart ----
  const { results: stops } = await env.DB.prepare(`SELECT id, name, lat, lng, status, arrived_at, departed_at, arrive_source FROM stops
    WHERE route_id = ? AND lat IS NOT NULL AND lng IS NOT NULL`).bind(routeId).all();
  const updates = [];
  const events = [];
  const state = new Map(stops.map(s => [s.id, { ...s }]));
  for (const p of pts) {
    if (p.acc != null && p.acc > MAX_ACCURACY) continue;
    // Arrival: nearest pending stop within the radius while slow.
    let best = null, bestD = Infinity;
    for (const s of state.values()) {
      if (s.status !== 'pending') continue;
      const d = haversine(p, s);
      if (d < bestD) { bestD = d; best = s; }
    }
    const slow = p.speed == null ? bestD <= ARRIVE_RADIUS_NOSPEED : p.speed <= ARRIVE_MAX_SPEED;
    if (best && bestD <= ARRIVE_RADIUS && slow) {
      best.status = 'arrived'; best.arrived_at = p.at; best.departed_at = null; best.arrive_source = 'gps';
      updates.push(env.DB.prepare(`UPDATE stops SET status = 'arrived', arrived_at = ?, departed_at = NULL, arrive_source = 'gps', updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(p.at, now, best.id));
      events.push({ stop_id: best.id, type: 'arrived', detail: 'GPS' });
    }
    // Departure: a stop we were at, now far away.
    for (const s of state.values()) {
      if (!s.arrived_at || s.departed_at || s.status === 'pending') continue;
      if (p.at <= s.arrived_at) continue;
      if (haversine(p, s) > DEPART_RADIUS) {
        // Only drove past (GPS said arrived, stayed under 3 min, nothing marked): undo the arrival.
        if (s.status === 'arrived' && s.arrive_source === 'gps' && p.at - s.arrived_at < 3 * 60 * 1000) {
          s.status = 'pending'; s.arrived_at = null; s.departed_at = null; s.arrive_source = '';
          updates.push(env.DB.prepare(`UPDATE stops SET status = 'pending', arrived_at = NULL, departed_at = NULL, arrive_source = '', updated_at = ? WHERE id = ? AND status = 'arrived'`).bind(now, s.id));
          events.push({ stop_id: s.id, type: 'passed_by', detail: 'GPS' });
          continue;
        }
        s.departed_at = p.at;
        updates.push(env.DB.prepare('UPDATE stops SET departed_at = ?, updated_at = ? WHERE id = ? AND departed_at IS NULL').bind(p.at, now, s.id));
        events.push({ stop_id: s.id, type: 'departed', detail: s.status === 'arrived' ? 'not marked yet' : '' });
      }
    }
  }
  if (updates.length) {
    await env.DB.batch(updates);
    for (const e of events) await logEvent(env, { route_id: routeId, driver_id: driver.id, ...e });
  }

  // ---- live ETAs from where the driver really is ----
  if (updates.length || !route.last_eta_at || now - route.last_eta_at > ETA_EVERY_MS) {
    await env.DB.prepare('UPDATE routes SET last_eta_at = ? WHERE id = ?').bind(now, routeId).run();
    ctx.waitUntil(recomputeRoute(env, routeId).catch(e => console.log('eta failed', e && e.message)));
  }
  return { saved: pts.length, changed: updates.length > 0 };
}
import { notify, saveSubscription } from './push.js';

export async function findDriver(env, token) {
  return env.DB.prepare('SELECT * FROM drivers WHERE token = ? AND active = 1').bind(token).first();
}

function intId(v) { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Dato inválido'); return n; }
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

async function myStop(env, driver, stopId) {
  const s = await env.DB.prepare(`SELECT s.*, r.driver_id, r.status AS route_status, r.date AS route_date
    FROM stops s JOIN routes r ON r.id = s.route_id WHERE s.id = ?`).bind(stopId).first();
  if (!s || s.driver_id !== driver.id) throw new HttpError(404, 'Parada no encontrada');
  return s;
}

async function startRouteIfNeeded(env, routeId, driver) {
  const r = await env.DB.prepare('SELECT status FROM routes WHERE id = ?').bind(routeId).first();
  if (r && r.status === 'planned') {
    await env.DB.prepare(`UPDATE routes SET status = 'active', started_at = ?, updated_at = ? WHERE id = ?`).bind(Date.now(), Date.now(), routeId).run();
    await logEvent(env, { route_id: routeId, driver_id: driver.id, type: 'route_started' });
  }
}

export async function driverApi(req, env, ctx, url, token, sub) {
  const driver = await findDriver(env, token);
  if (!driver) throw new HttpError(401, 'Este enlace ya no es válido');
  const method = req.method;
  const origin = url.origin;
  const now = Date.now();
  let m;

  if (method !== 'GET') {
    const o = req.headers.get('origin');
    if (o && o !== origin) throw new HttpError(403, 'Bad origin');
  }

  ctx.waitUntil(env.DB.prepare('UPDATE drivers SET last_seen_at = ? WHERE id = ?').bind(now, driver.id).run());

  if (sub === '/today' && method === 'GET') {
    const s = await getSettings(env);
    const today = todayIn(s.timezone);
    const { results: routes } = await env.DB.prepare(`SELECT id, date, name, status, start_time, distance_m, duration_s, started_at, finished_at, return_to_depot
      FROM routes WHERE driver_id = ? AND (date = ? OR status = 'active') ORDER BY date, id`).bind(driver.id, today).all();
    const out = [];
    for (const r of routes) {
      const [stops, photos] = await env.DB.batch([
        env.DB.prepare('SELECT id, seq, name, address, phone, notes, lat, lng, status, eta, arrived_at, departed_at, arrive_source, done_at, fail_reason, driver_note, received_by FROM stops WHERE route_id = ? ORDER BY seq, id').bind(r.id),
        env.DB.prepare('SELECT id, stop_id FROM photos WHERE route_id = ? ORDER BY created_at').bind(r.id),
      ]);
      const pm = {};
      for (const ph of photos.results) (pm[ph.stop_id] ||= []).push({ id: ph.id, url: `/p/${ph.id}.jpg` });
      out.push({ ...r, stops: stops.results.map(st => ({ ...st, photos: pm[st.id] || [] })) });
    }
    const { results: upcoming } = await env.DB.prepare(`SELECT r.date, COUNT(s.id) AS stops FROM routes r LEFT JOIN stops s ON s.route_id = r.id
      WHERE r.driver_id = ? AND r.date > ? AND r.status != 'done' GROUP BY r.date ORDER BY r.date LIMIT 7`).bind(driver.id, today).all();
    return json({
      driver: { id: driver.id, name: driver.name },
      company: s.company_name,
      today,
      timezone: s.timezone,
      photo_required: s.photo_required,
      depot: s.depot_lat != null ? { lat: s.depot_lat, lng: s.depot_lng, label: s.depot_label } : null,
      routes: out,
      upcoming,
    });
  }

  if ((m = sub.match(/^\/routes\/(\d+)\/start$/)) && method === 'POST') {
    const id = intId(m[1]);
    const r = await env.DB.prepare('SELECT * FROM routes WHERE id = ? AND driver_id = ?').bind(id, driver.id).first();
    if (!r) throw new HttpError(404, 'Ruta no encontrada');
    await startRouteIfNeeded(env, id, driver);
    ctx.waitUntil(recomputeRoute(env, id));
    return json({ ok: true });
  }

  if (sub === '/position' && method === 'POST') {
    const b = await readJson(req);
    const r = await ingestPositions(env, ctx, driver, [b], b.route_id);
    if (!r.saved) throw new HttpError(400, 'Ubicación inválida');
    return json({ ok: true, changed: r.changed });
  }

  // Phone app: several points at once (sent from the background).
  if (sub === '/positions' && method === 'POST') {
    const b = await readJson(req);
    const pts = Array.isArray(b.points) ? b.points.slice(-300) : [];
    const r = await ingestPositions(env, ctx, driver, pts, b.route_id);
    if (b.app && typeof b.app === 'object') {
      const ver = cleanStr(String(b.app.version || ''), 40);
      const info = cleanStr(JSON.stringify(b.app), 400);
      ctx.waitUntil(env.DB.prepare('UPDATE drivers SET app_version = ?, app_info = ? WHERE id = ?').bind(ver, info, driver.id).run());
    }
    return json({ ok: true, saved: r.saved, changed: r.changed });
  }

  if ((m = sub.match(/^\/stops\/(\d+)\/arrive$/)) && method === 'POST') {
    const st = await myStop(env, driver, intId(m[1]));
    if (st.status === 'pending') {
      await env.DB.prepare(`UPDATE stops SET status = 'arrived', arrived_at = ?, arrive_source = 'manual', updated_at = ? WHERE id = ?`).bind(now, now, st.id).run();
      await startRouteIfNeeded(env, st.route_id, driver);
      await logEvent(env, { route_id: st.route_id, stop_id: st.id, driver_id: driver.id, type: 'arrived' });
    }
    return json({ ok: true });
  }

  if ((m = sub.match(/^\/stops\/(\d+)\/photo$/)) && method === 'POST') {
    const st = await myStop(env, driver, intId(m[1]));
    const ct = req.headers.get('content-type') || '';
    if (!ct.startsWith('image/jpeg')) throw new HttpError(400, 'La foto debe ser JPG');
    const buf = await req.arrayBuffer();
    if (buf.byteLength < 500 || buf.byteLength > 6 * 1024 * 1024) throw new HttpError(400, 'La foto es demasiado grande');
    const head = new Uint8Array(buf, 0, 3);
    if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) throw new HttpError(400, 'La foto no es válida');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE stop_id = ?').bind(st.id).first();
    if (count.n >= 6) throw new HttpError(400, 'Máximo 6 fotos por parada');
    const id = randId(22);
    await env.FILES.put(`photos/${id}.jpg`, buf, { httpMetadata: { contentType: 'image/jpeg' } });
    await env.DB.prepare('INSERT INTO photos (id, stop_id, route_id, driver_id, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, st.id, st.route_id, driver.id, buf.byteLength, now).run();
    await logEvent(env, { route_id: st.route_id, stop_id: st.id, driver_id: driver.id, type: 'photo' });
    return json({ id, url: `/p/${id}.jpg` });
  }

  if ((m = sub.match(/^\/photos\/([A-Za-z0-9]{22})$/)) && method === 'DELETE') {
    const ph = await env.DB.prepare(`SELECT p.*, s.status FROM photos p JOIN stops s ON s.id = p.stop_id WHERE p.id = ? AND p.driver_id = ?`).bind(m[1], driver.id).first();
    if (!ph) throw new HttpError(404, 'Foto no encontrada');
    if (ph.status === 'done' || ph.status === 'failed') throw new HttpError(400, 'La parada ya está cerrada');
    await env.FILES.delete(`photos/${ph.id}.jpg`);
    await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(ph.id).run();
    return json({ ok: true });
  }

  if ((m = sub.match(/^\/stops\/(\d+)\/(complete|fail)$/)) && method === 'POST') {
    const st = await myStop(env, driver, intId(m[1]));
    const b = await readJson(req);
    const done = m[2] === 'complete';
    if (st.status === 'done' || st.status === 'failed') return json({ ok: true, already: true });
    const s = await getSettings(env);
    if (done && s.photo_required) {
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE stop_id = ?').bind(st.id).first();
      if (c.n === 0) throw new HttpError(400, 'Toma al menos una foto de la entrega');
    }
    const reason = done ? '' : cleanStr(b.reason, 200);
    if (!done && !reason) throw new HttpError(400, 'Elige el motivo');
    const at = Math.min(num(b.at) || now, now);
    await env.DB.prepare(`UPDATE stops SET status = ?, done_at = ?, arrived_at = COALESCE(arrived_at, ?), fail_reason = ?, driver_note = ?, received_by = ?, updated_at = ? WHERE id = ?`)
      .bind(done ? 'done' : 'failed', at, at, reason, cleanStr(b.note, 1000), done ? cleanStr(b.received_by, 120) : '', now, st.id).run();
    await startRouteIfNeeded(env, st.route_id, driver);
    await logEvent(env, { route_id: st.route_id, stop_id: st.id, driver_id: driver.id, type: done ? 'delivered' : 'failed', detail: done ? cleanStr(b.received_by, 120) : reason });
    ctx.waitUntil((async () => {
      await notify(env, {
        kind: 'admin', subject: origin,
        payload: {
          title: done ? `Delivered — ${st.name}` : `Not delivered — ${st.name}`,
          body: done ? `${driver.name}${b.received_by ? ` · received by ${cleanStr(b.received_by, 60)}` : ''}` : `${driver.name} · ${reason}`,
          url: `/admin#route/${st.route_id}`, tag: `stop-${st.id}`,
        },
      });
      await checkRouteFinished(env, st.route_id, origin);
      await recomputeRoute(env, st.route_id);
    })());
    return json({ ok: true });
  }

  if ((m = sub.match(/^\/stops\/(\d+)\/undo$/)) && method === 'POST') {
    const st = await myStop(env, driver, intId(m[1]));
    if (st.status === 'pending') return json({ ok: true });
    await env.DB.prepare(`UPDATE stops SET status = 'pending', done_at = NULL, arrived_at = NULL, departed_at = NULL, arrive_source = '', fail_reason = '', updated_at = ? WHERE id = ?`).bind(now, st.id).run();
    await logEvent(env, { route_id: st.route_id, stop_id: st.id, driver_id: driver.id, type: 'undone' });
    await checkRouteFinished(env, st.route_id, origin);
    ctx.waitUntil(recomputeRoute(env, st.route_id));
    return json({ ok: true });
  }

  if (sub === '/push/subscribe' && method === 'POST') {
    const b = await readJson(req);
    if (!(await saveSubscription(env, { kind: 'driver', driverId: driver.id, sub: b.sub }))) throw new HttpError(400, 'Suscripción inválida');
    return json({ ok: true });
  }

  throw new HttpError(404, 'No encontrado');
}
