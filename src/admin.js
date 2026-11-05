// Admin sign-in and admin API.
import {
  HttpError, json, readJson, randId, hmac, safeEqual, cleanStr, nameKey, addrKey,
  getSetting, setSetting, getSettings, getSecret, todayIn, isDate, isTime, logEvent,
} from './lib.js';
import { geocode } from './geo.js';
import { recomputeRoute } from './routes.js';
import { notify, saveSubscription } from './push.js';

const COOKIE = 'sr_admin';
const SESSION_DAYS = 30;

// ---------------- sign-in ----------------
async function pinHash(env, pin) { return hmac(await getSecret(env), `pin:${pin}`); }

function getCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  const ver = (await getSetting(env, 'pin_version')) || '1';
  const sig = await hmac(await getSecret(env), `admin.${exp}.${ver}`);
  return `${exp}.${sig}`;
}
async function validSession(req, env) {
  const v = getCookie(req, COOKIE);
  if (!v) return false;
  const [exp, sig] = v.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const ver = (await getSetting(env, 'pin_version')) || '1';
  return safeEqual(sig, await hmac(await getSecret(env), `admin.${exp}.${ver}`));
}
function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function checkOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, 'Bad origin');
}
function validPin(pin) { return typeof pin === 'string' && /^\d{4,10}$/.test(pin); }

export async function adminState(req, env) {
  const hasPin = !!(await getSetting(env, 'pin_hash'));
  return json({ needs_setup: !hasPin, authed: hasPin && (await validSession(req, env)) });
}

export async function adminSetup(req, env) {
  checkOrigin(req);
  if (await getSetting(env, 'pin_hash')) throw new HttpError(409, 'Already set up');
  const { pin, company_name } = await readJson(req);
  if (!validPin(pin)) throw new HttpError(400, 'PIN must be 4–10 digits');
  await setSetting(env, 'pin_hash', await pinHash(env, pin));
  await setSetting(env, 'pin_version', '1');
  if (company_name) await setSetting(env, 'company_name', cleanStr(company_name, 80));
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await makeSession(env), SESSION_DAYS * 86400) });
}

export async function adminLogin(req, env) {
  checkOrigin(req);
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const now = Date.now();
  const att = await env.DB.prepare('SELECT * FROM login_attempts WHERE ip = ?').bind(ip).first();
  if (att && now - att.first_at < 15 * 60 * 1000 && att.count >= 8) {
    throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  }
  const { pin } = await readJson(req);
  const stored = await getSetting(env, 'pin_hash');
  if (!stored) throw new HttpError(409, 'Not set up');
  if (!validPin(pin) || !safeEqual(await pinHash(env, pin), stored)) {
    if (!att || now - att.first_at >= 15 * 60 * 1000) {
      await env.DB.prepare('INSERT INTO login_attempts (ip, count, first_at) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET count = 1, first_at = excluded.first_at').bind(ip, now).run();
    } else {
      await env.DB.prepare('UPDATE login_attempts SET count = count + 1 WHERE ip = ?').bind(ip).run();
    }
    throw new HttpError(401, 'Wrong PIN');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await makeSession(env), SESSION_DAYS * 86400) });
}

export async function adminLogout() {
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

export async function requireAdmin(req, env) {
  checkOrigin(req);
  if (!(await validSession(req, env))) throw new HttpError(401, 'Please sign in');
}

// ---------------- helpers ----------------
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
function intId(v) { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id'); return n; }

async function getRouteOr404(env, id) {
  const r = await env.DB.prepare('SELECT * FROM routes WHERE id = ?').bind(id).first();
  if (!r) throw new HttpError(404, 'Route not found');
  return r;
}

function maskToken(t) { return t ? `${t.slice(0, 6)}…${t.slice(-4)}` : ''; }

// Save or update a customer from stop details. Returns the customer row.
async function upsertCustomer(env, { name, address, phone, notes, lat, lng, geo_label, geo_source }) {
  const nk = nameKey(name), ak = addrKey(address);
  if (!nk) return null;
  const now = Date.now();
  const existing = await env.DB.prepare('SELECT * FROM customers WHERE name_key = ? AND addr_key = ?').bind(nk, ak).first();
  if (existing) {
    await env.DB.prepare(`UPDATE customers SET name = ?, address = ?, phone = CASE WHEN ? != '' THEN ? ELSE phone END,
        notes = CASE WHEN ? != '' THEN ? ELSE notes END,
        lat = COALESCE(?, lat), lng = COALESCE(?, lng), geo_label = CASE WHEN ? != '' THEN ? ELSE geo_label END,
        geo_source = CASE WHEN ? != '' THEN ? ELSE geo_source END, uses = uses + 1, last_used_at = ? WHERE id = ?`)
      .bind(name, address, phone, phone, notes, notes, lat, lng, geo_label || '', geo_label || '', geo_source || '', geo_source || '', now, existing.id).run();
    return { ...existing, id: existing.id };
  }
  const r = await env.DB.prepare(`INSERT INTO customers (name, name_key, address, addr_key, phone, notes, lat, lng, geo_label, geo_source, uses, last_used_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .bind(name, nk, address, ak, phone, notes, lat, lng, geo_label || '', geo_source || '', now, now).run();
  return { id: r.meta.last_row_id };
}

async function stopNotifyDriver(env, route, origin, title, body) {
  if (!route.driver_id) return;
  const today = todayIn((await getSettings(env)).timezone);
  if (route.date !== today && route.status !== 'active') return;
  const d = await env.DB.prepare('SELECT token FROM drivers WHERE id = ?').bind(route.driver_id).first();
  if (!d) return;
  await notify(env, { kind: 'driver', driverId: route.driver_id, subject: origin, payload: { title, body, url: `/d/${d.token}`, tag: `route-${route.id}` } });
}

// ---------------- API ----------------
export async function adminApi(req, env, ctx, url) {
  const p = url.pathname.replace(/^\/api\/admin/, '');
  const method = req.method;
  const origin = url.origin;
  let m;

  // ----- settings -----
  if (p === '/settings' && method === 'GET') {
    const s = await getSettings(env);
    const { _raw, mapbox_token, ...rest } = s;
    return json({ ...rest, mapbox_token_set: !!mapbox_token, mapbox_token_hint: maskToken(mapbox_token), today: todayIn(s.timezone) });
  }
  if (p === '/settings' && method === 'PUT') {
    const b = await readJson(req);
    const out = {};
    if (b.company_name !== undefined) await setSetting(env, 'company_name', cleanStr(b.company_name, 80) || 'Summit Safety');
    if (b.timezone !== undefined) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch { throw new HttpError(400, 'Unknown time zone'); }
      await setSetting(env, 'timezone', b.timezone);
    }
    if (b.default_start_time !== undefined) {
      if (!isTime(b.default_start_time)) throw new HttpError(400, 'Start time must look like 08:00');
      await setSetting(env, 'default_start_time', b.default_start_time);
    }
    if (b.service_minutes !== undefined) {
      const n = Math.round(Number(b.service_minutes));
      if (!(n >= 0 && n <= 240)) throw new HttpError(400, 'Minutes per stop must be 0–240');
      await setSetting(env, 'service_minutes', String(n));
    }
    if (b.return_to_depot !== undefined) await setSetting(env, 'return_to_depot', b.return_to_depot ? '1' : '0');
    if (b.photo_required !== undefined) await setSetting(env, 'photo_required', b.photo_required ? '1' : '0');
    if (b.mapbox_token !== undefined) {
      const t = cleanStr(b.mapbox_token, 300);
      if (t && !/^[pst]k\.[A-Za-z0-9._-]+$/.test(t)) throw new HttpError(400, 'That does not look like a Mapbox token (it starts with pk.)');
      await setSetting(env, 'mapbox_token', t);
    }
    if (b.depot_address !== undefined) {
      const a = cleanStr(b.depot_address, 300);
      await setSetting(env, 'depot_address', a);
      if (a && num(b.depot_lat) != null && num(b.depot_lng) != null) {
        await setSetting(env, 'depot_lat', String(num(b.depot_lat)));
        await setSetting(env, 'depot_lng', String(num(b.depot_lng)));
        await setSetting(env, 'depot_label', 'Pinned on map');
        out.depot_label = 'Pinned on map';
      } else if (a) {
        const g = await geocode(env, a, (await getSettings(env)).mapbox_token);
        if (!g) throw new HttpError(400, 'Could not find the start address. Check it and try again.');
        await setSetting(env, 'depot_lat', String(g.lat));
        await setSetting(env, 'depot_lng', String(g.lng));
        await setSetting(env, 'depot_label', g.label);
        out.depot_label = g.label;
      } else {
        await env.DB.prepare(`DELETE FROM settings WHERE key IN ('depot_lat','depot_lng','depot_label')`).run();
      }
    }
    if (b.new_pin !== undefined) {
      if (!validPin(b.new_pin)) throw new HttpError(400, 'PIN must be 4–10 digits');
      await setSetting(env, 'pin_hash', await pinHash(env, b.new_pin));
      const ver = Number((await getSetting(env, 'pin_version')) || '1') + 1;
      await setSetting(env, 'pin_version', String(ver));
      // keep this browser signed in; all others are signed out
      return json({ ok: true, ...out }, 200, { 'set-cookie': sessionCookie(await makeSession(env), SESSION_DAYS * 86400) });
    }
    return json({ ok: true, ...out });
  }
  if (p === '/settings/test-mapbox' && method === 'POST') {
    const s = await getSettings(env);
    if (!s.mapbox_token) throw new HttpError(400, 'No Mapbox token saved yet');
    const res = await fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/-74.0060,40.7128;-73.9857,40.7484?access_token=${encodeURIComponent(s.mapbox_token)}`);
    if (!res.ok) return json({ ok: false, error: res.status === 401 ? 'Mapbox says the token is not valid' : `Mapbox error ${res.status}` });
    return json({ ok: true });
  }

  // ----- geocode preview -----
  if (p === '/geocode' && method === 'GET') {
    const q = cleanStr(url.searchParams.get('q'), 300);
    if (!q) throw new HttpError(400, 'Enter an address');
    const g = await geocode(env, q, (await getSettings(env)).mapbox_token);
    return json({ result: g });
  }

  // ----- drivers -----
  if (p === '/drivers' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM drivers ORDER BY active DESC, name COLLATE NOCASE').all();
    const subs = await env.DB.prepare(`SELECT driver_id, COUNT(*) AS n FROM push_subs WHERE kind = 'driver' GROUP BY driver_id`).all();
    const pushMap = Object.fromEntries(subs.results.map(r => [r.driver_id, r.n]));
    return json({ drivers: results.map(d => ({ ...d, push: pushMap[d.id] || 0 })) });
  }
  if (p === '/drivers' && method === 'POST') {
    const b = await readJson(req);
    const name = cleanStr(b.name, 80);
    if (!name) throw new HttpError(400, 'Enter the driver name');
    const r = await env.DB.prepare('INSERT INTO drivers (name, phone, token, active, created_at) VALUES (?, ?, ?, 1, ?)')
      .bind(name, cleanStr(b.phone, 40), randId(24), Date.now()).run();
    return json({ driver: await env.DB.prepare('SELECT * FROM drivers WHERE id = ?').bind(r.meta.last_row_id).first() });
  }
  if ((m = p.match(/^\/drivers\/(\d+)$/)) && method === 'PATCH') {
    const id = intId(m[1]);
    const b = await readJson(req);
    const d = await env.DB.prepare('SELECT * FROM drivers WHERE id = ?').bind(id).first();
    if (!d) throw new HttpError(404, 'Driver not found');
    const name = b.name !== undefined ? cleanStr(b.name, 80) : d.name;
    if (!name) throw new HttpError(400, 'Enter the driver name');
    const phone = b.phone !== undefined ? cleanStr(b.phone, 40) : d.phone;
    const active = b.active !== undefined ? (b.active ? 1 : 0) : d.active;
    await env.DB.prepare('UPDATE drivers SET name = ?, phone = ?, active = ? WHERE id = ?').bind(name, phone, active, id).run();
    if (!active) await env.DB.prepare(`DELETE FROM push_subs WHERE kind = 'driver' AND driver_id = ?`).bind(id).run();
    return json({ driver: await env.DB.prepare('SELECT * FROM drivers WHERE id = ?').bind(id).first() });
  }
  if ((m = p.match(/^\/drivers\/(\d+)\/new-link$/)) && method === 'POST') {
    const id = intId(m[1]);
    await env.DB.prepare('UPDATE drivers SET token = ? WHERE id = ?').bind(randId(24), id).run();
    await env.DB.prepare(`DELETE FROM push_subs WHERE kind = 'driver' AND driver_id = ?`).bind(id).run();
    return json({ driver: await env.DB.prepare('SELECT * FROM drivers WHERE id = ?').bind(id).first() });
  }
  if ((m = p.match(/^\/drivers\/(\d+)$/)) && method === 'DELETE') {
    const id = intId(m[1]);
    const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM routes WHERE driver_id = ?').bind(id).first();
    if (used.n > 0) {
      await env.DB.prepare('UPDATE drivers SET active = 0 WHERE id = ?').bind(id).run();
      await env.DB.prepare(`DELETE FROM push_subs WHERE kind = 'driver' AND driver_id = ?`).bind(id).run();
      return json({ ok: true, deactivated: true });
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM drivers WHERE id = ?').bind(id),
      env.DB.prepare(`DELETE FROM push_subs WHERE kind = 'driver' AND driver_id = ?`).bind(id),
    ]);
    return json({ ok: true });
  }

  // ----- customers -----
  if (p === '/customers' && method === 'GET') {
    const q = cleanStr(url.searchParams.get('q'), 100).toLowerCase();
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
    let rows;
    if (q) {
      const like = `%${q.replace(/[%_]/g, '')}%`;
      rows = await env.DB.prepare(`SELECT * FROM customers WHERE lower(name) LIKE ? OR lower(address) LIKE ? OR phone LIKE ?
        ORDER BY (lower(name) LIKE ?) DESC, uses DESC, name COLLATE NOCASE LIMIT ?`).bind(like, like, like, `${q}%`, limit).all();
    } else {
      rows = await env.DB.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE LIMIT ?').bind(limit).all();
    }
    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM customers').first();
    return json({ customers: rows.results, total: total.n });
  }
  if (p === '/customers' && method === 'POST') {
    const b = await readJson(req);
    const c = await customerFromBody(env, b);
    if (await env.DB.prepare('SELECT id FROM customers WHERE name_key = ? AND addr_key = ?').bind(nameKey(c.name), addrKey(c.address)).first()) {
      throw new HttpError(409, 'This customer with this address is already saved');
    }
    const now = Date.now();
    const r = await env.DB.prepare(`INSERT INTO customers (name, name_key, address, addr_key, phone, notes, lat, lng, geo_label, geo_source, uses, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .bind(c.name, nameKey(c.name), c.address, addrKey(c.address), c.phone, c.notes, c.lat, c.lng, c.geo_label, c.geo_source, now).run();
    return json({ customer: await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(r.meta.last_row_id).first() });
  }
  if ((m = p.match(/^\/customers\/(\d+)$/)) && method === 'PATCH') {
    const id = intId(m[1]);
    const cur = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
    if (!cur) throw new HttpError(404, 'Customer not found');
    const b = await readJson(req);
    const c = await customerFromBody(env, { ...cur, ...b, lat: b.lat !== undefined ? b.lat : (b.address !== undefined && b.address !== cur.address ? null : cur.lat), lng: b.lng !== undefined ? b.lng : (b.address !== undefined && b.address !== cur.address ? null : cur.lng) });
    const dup = await env.DB.prepare('SELECT id FROM customers WHERE name_key = ? AND addr_key = ? AND id != ?').bind(nameKey(c.name), addrKey(c.address), id).first();
    if (dup) throw new HttpError(409, 'Another saved customer already has this name and address');
    await env.DB.prepare(`UPDATE customers SET name = ?, name_key = ?, address = ?, addr_key = ?, phone = ?, notes = ?, lat = ?, lng = ?, geo_label = ?, geo_source = ? WHERE id = ?`)
      .bind(c.name, nameKey(c.name), c.address, addrKey(c.address), c.phone, c.notes, c.lat, c.lng, c.geo_label, c.geo_source, id).run();
    return json({ customer: await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first() });
  }
  if ((m = p.match(/^\/customers\/(\d+)$/)) && method === 'DELETE') {
    const id = intId(m[1]);
    await env.DB.batch([
      env.DB.prepare('UPDATE stops SET customer_id = NULL WHERE customer_id = ?').bind(id),
      env.DB.prepare('DELETE FROM customers WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }

  // ----- routes -----
  if (p === '/routes' && method === 'GET') {
    const s = await getSettings(env);
    const date = url.searchParams.get('date') || todayIn(s.timezone);
    if (!isDate(date)) throw new HttpError(400, 'Bad date');
    const { results } = await env.DB.prepare(`SELECT r.id, r.date, r.name, r.driver_id, r.status, r.start_time, r.distance_m, r.duration_s,
        r.started_at, r.finished_at, d.name AS driver_name, d.last_pos_at, d.last_lat, d.last_lng,
        (SELECT COUNT(*) FROM stops WHERE route_id = r.id) AS stop_count,
        (SELECT COUNT(*) FROM stops WHERE route_id = r.id AND status = 'done') AS done_count,
        (SELECT COUNT(*) FROM stops WHERE route_id = r.id AND status = 'failed') AS failed_count,
        (SELECT COUNT(*) FROM stops WHERE route_id = r.id AND lat IS NULL) AS unlocated_count
      FROM routes r LEFT JOIN drivers d ON d.id = r.driver_id WHERE r.date = ? ORDER BY r.id`).bind(date).all();
    return json({ date, routes: results });
  }
  if (p === '/routes/days' && method === 'GET') {
    // counts per day around a month, for the date picker dots
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!isDate(from) || !isDate(to)) throw new HttpError(400, 'Bad dates');
    const { results } = await env.DB.prepare('SELECT date, COUNT(*) AS n FROM routes WHERE date BETWEEN ? AND ? GROUP BY date').bind(from, to).all();
    return json({ days: results });
  }
  if (p === '/routes' && method === 'POST') {
    const b = await readJson(req);
    const s = await getSettings(env);
    const date = b.date || todayIn(s.timezone);
    if (!isDate(date)) throw new HttpError(400, 'Bad date');
    const driverId = b.driver_id ? intId(b.driver_id) : null;
    if (driverId && !(await env.DB.prepare('SELECT id FROM drivers WHERE id = ? AND active = 1').bind(driverId).first())) throw new HttpError(400, 'Driver not found');
    const startTime = b.start_time && isTime(b.start_time) ? b.start_time : s.default_start_time;
    const now = Date.now();
    const r = await env.DB.prepare(`INSERT INTO routes (date, name, driver_id, status, start_time, return_to_depot, created_at, updated_at)
      VALUES (?, ?, ?, 'planned', ?, ?, ?, ?)`).bind(date, cleanStr(b.name, 80), driverId, startTime, s.return_to_depot ? 1 : 0, now, now).run();
    const id = r.meta.last_row_id;
    if (b.copy_from_route) {
      await copyStops(env, intId(b.copy_from_route), id);
      await recomputeRoute(env, id);
    }
    await logEvent(env, { route_id: id, type: 'route_created' });
    return json({ route: await env.DB.prepare('SELECT * FROM routes WHERE id = ?').bind(id).first() });
  }
  if ((m = p.match(/^\/routes\/(\d+)$/)) && method === 'GET') {
    const id = intId(m[1]);
    const route = await env.DB.prepare(`SELECT r.*, d.name AS driver_name, d.phone AS driver_phone, d.last_lat, d.last_lng, d.last_acc, d.last_pos_at, d.last_seen_at
      FROM routes r LEFT JOIN drivers d ON d.id = r.driver_id WHERE r.id = ?`).bind(id).first();
    if (!route) throw new HttpError(404, 'Route not found');
    const [stops, photos, events, trail] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM stops WHERE route_id = ? ORDER BY seq, id').bind(id),
      env.DB.prepare('SELECT id, stop_id, created_at FROM photos WHERE route_id = ? ORDER BY created_at').bind(id),
      env.DB.prepare(`SELECT e.*, s.name AS stop_name FROM events e LEFT JOIN stops s ON s.id = e.stop_id WHERE e.route_id = ? ORDER BY e.at DESC LIMIT 200`).bind(id),
      env.DB.prepare('SELECT lat, lng, at FROM positions WHERE route_id = ? ORDER BY at DESC LIMIT 3000').bind(id),
    ]);
    const photoMap = {};
    for (const ph of photos.results) (photoMap[ph.stop_id] ||= []).push({ id: ph.id, url: `/p/${ph.id}.jpg`, at: ph.created_at });
    route.geometry = route.geometry ? JSON.parse(route.geometry) : null;
    return json({
      route,
      stops: stops.results.map(s => ({ ...s, photos: photoMap[s.id] || [] })),
      events: events.results,
      trail: trail.results.reverse().map(t => [t.lat, t.lng, t.at]),
    });
  }
  if ((m = p.match(/^\/routes\/(\d+)$/)) && method === 'PATCH') {
    const id = intId(m[1]);
    const route = await getRouteOr404(env, id);
    const b = await readJson(req);
    const upd = { ...route };
    if (b.name !== undefined) upd.name = cleanStr(b.name, 80);
    if (b.date !== undefined) { if (!isDate(b.date)) throw new HttpError(400, 'Bad date'); upd.date = b.date; }
    if (b.start_time !== undefined) { if (!isTime(b.start_time)) throw new HttpError(400, 'Bad start time'); upd.start_time = b.start_time; }
    if (b.return_to_depot !== undefined) upd.return_to_depot = b.return_to_depot ? 1 : 0;
    if (b.driver_id !== undefined) {
      upd.driver_id = b.driver_id ? intId(b.driver_id) : null;
      if (upd.driver_id && !(await env.DB.prepare('SELECT id FROM drivers WHERE id = ?').bind(upd.driver_id).first())) throw new HttpError(400, 'Driver not found');
    }
    if (b.status !== undefined) {
      if (!['planned', 'active', 'done'].includes(b.status)) throw new HttpError(400, 'Bad status');
      upd.status = b.status;
    }
    await env.DB.prepare(`UPDATE routes SET name = ?, date = ?, start_time = ?, return_to_depot = ?, driver_id = ?, status = ?, updated_at = ? WHERE id = ?`)
      .bind(upd.name, upd.date, upd.start_time, upd.return_to_depot, upd.driver_id, upd.status, Date.now(), id).run();
    if (b.driver_id !== undefined && upd.driver_id !== route.driver_id) {
      const d = upd.driver_id ? await env.DB.prepare('SELECT name FROM drivers WHERE id = ?').bind(upd.driver_id).first() : null;
      await logEvent(env, { route_id: id, driver_id: upd.driver_id, type: 'driver_assigned', detail: d ? d.name : 'none' });
    }
    if (b.start_time !== undefined || b.return_to_depot !== undefined || b.date !== undefined) await recomputeRoute(env, id);
    return json({ route: await env.DB.prepare('SELECT * FROM routes WHERE id = ?').bind(id).first() });
  }
  if ((m = p.match(/^\/routes\/(\d+)$/)) && method === 'DELETE') {
    const id = intId(m[1]);
    await getRouteOr404(env, id);
    const { results: photos } = await env.DB.prepare('SELECT id FROM photos WHERE route_id = ?').bind(id).all();
    if (photos.length) await env.FILES.delete(photos.map(ph => `photos/${ph.id}.jpg`));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM photos WHERE route_id = ?').bind(id),
      env.DB.prepare('DELETE FROM stops WHERE route_id = ?').bind(id),
      env.DB.prepare('DELETE FROM events WHERE route_id = ?').bind(id),
      env.DB.prepare('DELETE FROM positions WHERE route_id = ?').bind(id),
      env.DB.prepare('DELETE FROM routes WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }
  if ((m = p.match(/^\/routes\/(\d+)\/optimize$/)) && method === 'POST') {
    const id = intId(m[1]);
    await getRouteOr404(env, id);
    const s = await getSettings(env);
    const r = await recomputeRoute(env, id, { optimize: true });
    await logEvent(env, { route_id: id, type: 'optimized' });
    return json({ ...r, used_mapbox: !!s.mapbox_token, has_start: s.depot_lat != null });
  }
  if ((m = p.match(/^\/routes\/(\d+)\/reorder$/)) && method === 'POST') {
    const id = intId(m[1]);
    await getRouteOr404(env, id);
    const { stop_ids } = await readJson(req);
    if (!Array.isArray(stop_ids)) throw new HttpError(400, 'Bad order');
    const { results } = await env.DB.prepare('SELECT id FROM stops WHERE route_id = ?').bind(id).all();
    const valid = new Set(results.map(r => r.id));
    const ids = stop_ids.map(Number).filter(x => valid.has(x));
    if (ids.length !== valid.size) throw new HttpError(400, 'Order does not match the stops');
    await env.DB.batch(ids.map((sid, i) => env.DB.prepare('UPDATE stops SET seq = ? WHERE id = ?').bind(i + 1, sid)));
    await recomputeRoute(env, id);
    return json({ ok: true });
  }
  if ((m = p.match(/^\/routes\/(\d+)\/copy$/)) && method === 'POST') {
    const id = intId(m[1]);
    const src = await getRouteOr404(env, id);
    const b = await readJson(req);
    if (!isDate(b.date)) throw new HttpError(400, 'Pick a date');
    const now = Date.now();
    const r = await env.DB.prepare(`INSERT INTO routes (date, name, driver_id, status, start_time, return_to_depot, created_at, updated_at)
      VALUES (?, ?, ?, 'planned', ?, ?, ?, ?)`).bind(b.date, src.name, b.driver_id === undefined ? src.driver_id : (b.driver_id || null), src.start_time, src.return_to_depot, now, now).run();
    const newId = r.meta.last_row_id;
    await copyStops(env, id, newId);
    await recomputeRoute(env, newId);
    await logEvent(env, { route_id: newId, type: 'route_created', detail: `copied from route ${id}` });
    return json({ route: await env.DB.prepare('SELECT * FROM routes WHERE id = ?').bind(newId).first() });
  }
  if ((m = p.match(/^\/routes\/(\d+)\/send$/)) && method === 'POST') {
    const id = intId(m[1]);
    const route = await getRouteOr404(env, id);
    if (!route.driver_id) throw new HttpError(400, 'Pick a driver first');
    const d = await env.DB.prepare('SELECT * FROM drivers WHERE id = ?').bind(route.driver_id).first();
    const subs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subs WHERE kind = 'driver' AND driver_id = ?`).bind(route.driver_id).first();
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM stops WHERE route_id = ?').bind(id).first();
    const s = await getSettings(env);
    const when = route.date === todayIn(s.timezone) ? 'hoy' : route.date;
    await notify(env, { kind: 'driver', driverId: route.driver_id, subject: origin,
      payload: { title: `Tu ruta de ${when} está lista`, body: `${cnt.n} paradas. Toca para ver.`, url: `/d/${d.token}`, tag: `route-${id}` } });
    await logEvent(env, { route_id: id, driver_id: route.driver_id, type: 'sent_to_driver' });
    return json({ ok: true, push_devices: subs.n, link: `/d/${d.token}`, driver_phone: d.phone, driver_name: d.name });
  }

  // ----- stops -----
  if ((m = p.match(/^\/routes\/(\d+)\/stops$/)) && method === 'POST') {
    const routeId = intId(m[1]);
    const route = await getRouteOr404(env, routeId);
    const b = await readJson(req);
    const s = await getSettings(env);
    let src = {};
    if (b.customer_id) {
      const c = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(intId(b.customer_id)).first();
      if (!c) throw new HttpError(404, 'Customer not found');
      src = c;
    }
    const name = cleanStr(b.name ?? src.name, 120);
    const address = cleanStr(b.address ?? src.address, 300);
    const phone = cleanStr(b.phone ?? src.phone, 40);
    const notes = cleanStr(b.notes ?? src.notes, 1000);
    if (!name) throw new HttpError(400, 'Enter the company or person name');
    if (!address) throw new HttpError(400, 'Enter the address');
    let lat = num(b.lat), lng = num(b.lng), geo_label = '', geo_source = '';
    if (lat == null || lng == null) {
      if (src.id && addrKey(src.address) === addrKey(address) && src.lat != null) {
        lat = src.lat; lng = src.lng; geo_label = src.geo_label; geo_source = src.geo_source;
      } else {
        const g = await geocode(env, address, s.mapbox_token);
        if (g) { lat = g.lat; lng = g.lng; geo_label = g.label; geo_source = g.source; }
      }
    } else { geo_label = 'Pinned on map'; geo_source = 'manual'; }
    let customerId = src.id || null;
    if (b.save_customer !== false) {
      const c = await upsertCustomer(env, { name, address, phone, notes, lat, lng, geo_label, geo_source });
      if (c) customerId = c.id;
    }
    const maxSeq = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM stops WHERE route_id = ?').bind(routeId).first();
    const now = Date.now();
    const r = await env.DB.prepare(`INSERT INTO stops (route_id, seq, customer_id, name, address, phone, notes, lat, lng, geo_label, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(routeId, maxSeq.m + 1, customerId, name, address, phone, notes, lat, lng, geo_label, now, now).run();
    await recomputeRoute(env, routeId);
    if (route.status === 'active') {
      ctx.waitUntil(stopNotifyDriver(env, route, origin, 'Ruta actualizada', `Nueva parada: ${name}`));
    }
    const stop = await env.DB.prepare('SELECT * FROM stops WHERE id = ?').bind(r.meta.last_row_id).first();
    return json({ stop, located: lat != null });
  }
  if ((m = p.match(/^\/stops\/(\d+)$/)) && method === 'PATCH') {
    const id = intId(m[1]);
    const stop = await env.DB.prepare('SELECT * FROM stops WHERE id = ?').bind(id).first();
    if (!stop) throw new HttpError(404, 'Stop not found');
    const b = await readJson(req);
    const s = await getSettings(env);
    const upd = { ...stop };
    for (const [k, max] of [['name', 120], ['address', 300], ['phone', 40], ['notes', 1000]]) {
      if (b[k] !== undefined) upd[k] = cleanStr(b[k], max);
    }
    if (!upd.name) throw new HttpError(400, 'Enter the name');
    if (!upd.address) throw new HttpError(400, 'Enter the address');
    let moved = false;
    if (num(b.lat) != null && num(b.lng) != null) {
      upd.lat = num(b.lat); upd.lng = num(b.lng); upd.geo_label = 'Pinned on map'; moved = true;
    } else if (addrKey(upd.address) !== addrKey(stop.address)) {
      const g = await geocode(env, upd.address, s.mapbox_token);
      upd.lat = g ? g.lat : null; upd.lng = g ? g.lng : null; upd.geo_label = g ? g.label : ''; moved = true;
    }
    if (b.status !== undefined) {
      if (!['pending', 'done', 'failed'].includes(b.status)) throw new HttpError(400, 'Bad status');
      if (b.status === 'pending') { upd.status = 'pending'; upd.done_at = null; upd.arrived_at = null; upd.fail_reason = ''; }
      else { upd.status = b.status; upd.done_at = upd.done_at || Date.now(); }
    }
    await env.DB.prepare(`UPDATE stops SET name = ?, address = ?, phone = ?, notes = ?, lat = ?, lng = ?, geo_label = ?, status = ?, done_at = ?, arrived_at = ?, fail_reason = ?, updated_at = ? WHERE id = ?`)
      .bind(upd.name, upd.address, upd.phone, upd.notes, upd.lat, upd.lng, upd.geo_label, upd.status, upd.done_at, upd.arrived_at, upd.fail_reason, Date.now(), id).run();
    if (b.status !== undefined && b.status !== stop.status) {
      await logEvent(env, { route_id: stop.route_id, stop_id: id, type: 'status_by_office', detail: upd.status });
    }
    // keep the saved customer in sync
    if (stop.customer_id) {
      const c = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(stop.customer_id).first();
      if (c) {
        const nk = nameKey(upd.name), ak = addrKey(upd.address);
        const clash = await env.DB.prepare('SELECT id FROM customers WHERE name_key = ? AND addr_key = ? AND id != ?').bind(nk, ak, c.id).first();
        if (!clash) {
          await env.DB.prepare('UPDATE customers SET name = ?, name_key = ?, address = ?, addr_key = ?, phone = ?, notes = ?, lat = ?, lng = ?, geo_label = ? WHERE id = ?')
            .bind(upd.name, nk, upd.address, ak, upd.phone, upd.notes, upd.lat, upd.lng, upd.geo_label, c.id).run();
        }
      }
    }
    if (moved || b.status !== undefined) await recomputeRoute(env, stop.route_id);
    return json({ stop: await env.DB.prepare('SELECT * FROM stops WHERE id = ?').bind(id).first() });
  }
  if ((m = p.match(/^\/stops\/(\d+)$/)) && method === 'DELETE') {
    const id = intId(m[1]);
    const stop = await env.DB.prepare('SELECT * FROM stops WHERE id = ?').bind(id).first();
    if (!stop) throw new HttpError(404, 'Stop not found');
    const { results: photos } = await env.DB.prepare('SELECT id FROM photos WHERE stop_id = ?').bind(id).all();
    if (photos.length) await env.FILES.delete(photos.map(ph => `photos/${ph.id}.jpg`));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM photos WHERE stop_id = ?').bind(id),
      env.DB.prepare('DELETE FROM stops WHERE id = ?').bind(id),
    ]);
    await recomputeRoute(env, stop.route_id);
    const route = await env.DB.prepare('SELECT * FROM routes WHERE id = ?').bind(stop.route_id).first();
    if (route && route.status === 'active') ctx.waitUntil(stopNotifyDriver(env, route, origin, 'Ruta actualizada', `Se quitó la parada: ${stop.name}`));
    return json({ ok: true });
  }

  // ----- live map -----
  if (p === '/live' && method === 'GET') {
    const s = await getSettings(env);
    const date = url.searchParams.get('date') || todayIn(s.timezone);
    const { results } = await env.DB.prepare(`SELECT d.id, d.name, d.phone, d.last_lat, d.last_lng, d.last_acc, d.last_pos_at, d.last_seen_at,
        r.id AS route_id, r.status AS route_status,
        (SELECT COUNT(*) FROM stops WHERE route_id = r.id) AS stop_count,
        (SELECT COUNT(*) FROM stops WHERE route_id = r.id AND status IN ('done','failed')) AS finished_count,
        (SELECT name FROM stops WHERE route_id = r.id AND status IN ('pending','arrived') ORDER BY seq LIMIT 1) AS next_stop
      FROM routes r JOIN drivers d ON d.id = r.driver_id WHERE r.date = ? ORDER BY d.name`).bind(date).all();
    return json({ date, drivers: results, depot: s.depot_lat != null ? { lat: s.depot_lat, lng: s.depot_lng, label: s.depot_label } : null });
  }

  // ----- push for the office -----
  if (p === '/push/subscribe' && method === 'POST') {
    const b = await readJson(req);
    if (!(await saveSubscription(env, { kind: 'admin', sub: b.sub }))) throw new HttpError(400, 'Bad subscription');
    return json({ ok: true });
  }
  if (p === '/push/test' && method === 'POST') {
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subs WHERE kind = 'admin'`).first();
    await notify(env, { kind: 'admin', subject: origin, payload: { title: 'Test alert', body: 'Office alerts are working.', url: '/admin', tag: 'test' } });
    return json({ ok: true, devices: n.n });
  }

  throw new HttpError(404, 'Not found');
}

async function customerFromBody(env, b) {
  const name = cleanStr(b.name, 120);
  const address = cleanStr(b.address, 300);
  if (!name) throw new HttpError(400, 'Enter the name');
  if (!address) throw new HttpError(400, 'Enter the address');
  let lat = num(b.lat), lng = num(b.lng), geo_label = b.geo_label || '', geo_source = b.geo_source || '';
  if (lat == null || lng == null) {
    const g = await geocode(env, address, (await getSettings(env)).mapbox_token);
    if (g) { lat = g.lat; lng = g.lng; geo_label = g.label; geo_source = g.source; }
    else { lat = null; lng = null; geo_label = ''; geo_source = ''; }
  }
  return { name, address, phone: cleanStr(b.phone, 40), notes: cleanStr(b.notes, 1000), lat, lng, geo_label, geo_source };
}

async function copyStops(env, fromId, toId) {
  const { results } = await env.DB.prepare('SELECT * FROM stops WHERE route_id = ? ORDER BY seq, id').bind(fromId).all();
  const now = Date.now();
  if (!results.length) return;
  await env.DB.batch(results.map((s, i) => env.DB.prepare(`INSERT INTO stops (route_id, seq, customer_id, name, address, phone, notes, lat, lng, geo_label, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).bind(toId, i + 1, s.customer_id, s.name, s.address, s.phone, s.notes, s.lat, s.lng, s.geo_label, now, now)));
}
