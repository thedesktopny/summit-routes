// Driver API. Every call is authorised by the driver's private link token.
import { HttpError, json, readJson, randId, cleanStr, getSettings, todayIn, logEvent } from './lib.js';
import { recomputeRoute, checkRouteFinished } from './routes.js';
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
        env.DB.prepare('SELECT id, seq, name, address, phone, notes, lat, lng, status, eta, arrived_at, done_at, fail_reason, driver_note, received_by FROM stops WHERE route_id = ? ORDER BY seq, id').bind(r.id),
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
    const lat = num(b.lat), lng = num(b.lng);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'Ubicación inválida');
    let routeId = b.route_id ? intId(b.route_id) : null;
    if (routeId) {
      const r = await env.DB.prepare('SELECT id FROM routes WHERE id = ? AND driver_id = ?').bind(routeId, driver.id).first();
      if (!r) routeId = null;
    }
    const at = Math.min(num(b.at) || now, now);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO positions (driver_id, route_id, lat, lng, acc, speed, heading, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(driver.id, routeId, lat, lng, num(b.acc), num(b.speed), num(b.heading), at),
      env.DB.prepare('UPDATE drivers SET last_lat = ?, last_lng = ?, last_acc = ?, last_pos_at = ? WHERE id = ? AND (last_pos_at IS NULL OR last_pos_at <= ?)')
        .bind(lat, lng, num(b.acc), at, driver.id, at),
    ]);
    return json({ ok: true });
  }

  if ((m = sub.match(/^\/stops\/(\d+)\/arrive$/)) && method === 'POST') {
    const st = await myStop(env, driver, intId(m[1]));
    if (st.status === 'pending') {
      await env.DB.prepare(`UPDATE stops SET status = 'arrived', arrived_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, st.id).run();
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
    await env.DB.prepare(`UPDATE stops SET status = 'pending', done_at = NULL, arrived_at = NULL, fail_reason = '', updated_at = ? WHERE id = ?`).bind(now, st.id).run();
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
