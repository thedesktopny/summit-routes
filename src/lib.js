// Shared helpers: responses, ids, crypto, time zones, settings, schema.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export async function readJson(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'Invalid request'); }
}

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function randId(len = 22) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += ALNUM[b % ALNUM.length];
  return s;
}

export function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function cleanStr(v, max = 500) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

export function nameKey(s) { return cleanStr(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
export function addrKey(s) {
  return cleanStr(s).toLowerCase()
    .replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave').replace(/\broad\b/g, 'rd')
    .replace(/\bdrive\b/g, 'dr').replace(/\blane\b/g, 'ln').replace(/\bplace\b/g, 'pl')
    .replace(/\bboulevard\b/g, 'blvd').replace(/\bcourt\b/g, 'ct').replace(/\bsuite\b/g, 'ste')
    .replace(/[^a-z0-9]/g, '');
}

// ---------- time zone helpers ----------
export function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
// Epoch ms for a local date ("2026-11-05") + time ("08:00") in a time zone.
export function localToEpoch(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '08:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = tzOffsetMs(guess, tz);
  const first = guess - offset;
  const offset2 = tzOffsetMs(first, tz);
  return guess - offset2;
}
function tzOffsetMs(epoch, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epoch)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(epoch / 1000) * 1000;
}
export function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
export function isTime(s) { return typeof s === 'string' && /^\d{2}:\d{2}$/.test(s); }

// ---------- settings ----------
const settingsCache = new Map();
export async function getSetting(env, key, fallback = null) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : fallback;
}
export async function setSetting(env, key, value) {
  settingsCache.delete(key);
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value)).run();
}
export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(results.map(r => [r.key, r.value]));
  return {
    timezone: s.timezone || 'America/New_York',
    company_name: s.company_name || 'Summit Safety',
    depot_address: s.depot_address || '',
    depot_lat: s.depot_lat ? Number(s.depot_lat) : null,
    depot_lng: s.depot_lng ? Number(s.depot_lng) : null,
    depot_label: s.depot_label || '',
    default_start_time: s.default_start_time || '08:00',
    service_minutes: s.service_minutes ? Number(s.service_minutes) : 10,
    return_to_depot: s.return_to_depot === '1',
    photo_required: s.photo_required !== '0',
    mapbox_token: s.mapbox_token || '',
    _raw: s,
  };
}

// Internal secret used for signing sessions and hashing the PIN. Created on first use.
export async function getSecret(env) {
  let s = await getSetting(env, 'session_secret');
  if (!s) {
    s = randId(48);
    await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind('session_secret', s).run();
    s = await getSetting(env, 'session_secret');
  }
  return s;
}

// ---------- schema ----------
let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT DEFAULT '',
      token TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, last_seen_at INTEGER,
      last_lat REAL, last_lng REAL, last_acc REAL, last_pos_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_key TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '', addr_key TEXT NOT NULL DEFAULT '',
      phone TEXT DEFAULT '', notes TEXT DEFAULT '',
      lat REAL, lng REAL, geo_label TEXT DEFAULT '', geo_source TEXT DEFAULT '',
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, created_at INTEGER NOT NULL,
      UNIQUE(name_key, addr_key))`,
    `CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, name TEXT DEFAULT '',
      driver_id INTEGER, status TEXT NOT NULL DEFAULT 'planned',
      start_time TEXT DEFAULT '08:00', return_to_depot INTEGER NOT NULL DEFAULT 0,
      start_lat REAL, start_lng REAL, start_label TEXT DEFAULT '',
      distance_m REAL, duration_s REAL, geometry TEXT, optimized_at INTEGER,
      started_at INTEGER, finished_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS routes_date ON routes(date)`,
    `CREATE INDEX IF NOT EXISTS routes_driver ON routes(driver_id, date)`,
    `CREATE TABLE IF NOT EXISTS stops (
      id INTEGER PRIMARY KEY AUTOINCREMENT, route_id INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
      customer_id INTEGER, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
      phone TEXT DEFAULT '', notes TEXT DEFAULT '',
      lat REAL, lng REAL, geo_label TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', eta INTEGER,
      arrived_at INTEGER, done_at INTEGER, fail_reason TEXT DEFAULT '',
      driver_note TEXT DEFAULT '', received_by TEXT DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS stops_route ON stops(route_id, seq)`,
    `CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY, stop_id INTEGER NOT NULL, route_id INTEGER NOT NULL,
      driver_id INTEGER, size INTEGER, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS photos_stop ON photos(stop_id)`,
    `CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, driver_id INTEGER NOT NULL, route_id INTEGER,
      lat REAL NOT NULL, lng REAL NOT NULL, acc REAL, speed REAL, heading REAL, at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS positions_route ON positions(route_id, at)`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, route_id INTEGER, stop_id INTEGER, driver_id INTEGER,
      type TEXT NOT NULL, detail TEXT DEFAULT '', at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS events_route ON events(route_id, at)`,
    `CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, driver_id INTEGER,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      created_at INTEGER NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS geocache (
      q TEXT PRIMARY KEY, lat REAL, lng REAL, label TEXT, source TEXT, at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL)`,
  ];
  await env.DB.batch(stmts.map(s => env.DB.prepare(s)));
  schemaReady = true;
}

export async function logEvent(env, { route_id = null, stop_id = null, driver_id = null, type, detail = '' }) {
  await env.DB.prepare('INSERT INTO events (route_id, stop_id, driver_id, type, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(route_id, stop_id, driver_id, type, cleanStr(detail, 1000), Date.now()).run();
}
