// Address lookup, drive times (Mapbox), and stop ordering.
import { cleanStr } from './lib.js';

const UA = 'SummitSafetyRoutes/2.0 (delivery routing; contact via site admin)';

function normQ(address) { return cleanStr(address, 300).toLowerCase().replace(/\s+/g, ' '); }

export async function geocode(env, address, mapboxToken) {
  const q = normQ(address);
  if (!q) return null;
  const cached = await env.DB.prepare('SELECT * FROM geocache WHERE q = ?').bind(q).first();
  if (cached && cached.lat != null) return { lat: cached.lat, lng: cached.lng, label: cached.label, source: cached.source };

  let hit = null;
  try { hit = await censusGeocode(address); } catch (e) { console.log('census', e.message); }
  if (!hit) { try { hit = await nominatimGeocode(address); } catch (e) { console.log('nominatim', e.message); } }
  if (!hit && mapboxToken) { try { hit = await mapboxGeocode(address, mapboxToken); } catch (e) { console.log('mapbox geo', e.message); } }
  if (hit) {
    await env.DB.prepare(`INSERT INTO geocache (q, lat, lng, label, source, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(q) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, label = excluded.label, source = excluded.source, at = excluded.at`)
      .bind(q, hit.lat, hit.lng, hit.label, hit.source, Date.now()).run();
  }
  return hit;
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function censusGeocode(address) {
  const u = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  u.searchParams.set('address', address);
  u.searchParams.set('benchmark', 'Public_AR_Current');
  u.searchParams.set('format', 'json');
  const data = await fetchJson(u, { headers: { 'user-agent': UA } });
  const m = data && data.result && data.result.addressMatches && data.result.addressMatches[0];
  if (!m) return null;
  return { lat: m.coordinates.y, lng: m.coordinates.x, label: m.matchedAddress, source: 'census' };
}

async function nominatimGeocode(address) {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '1');
  u.searchParams.set('countrycodes', 'us');
  u.searchParams.set('q', address);
  const data = await fetchJson(u, { headers: { 'user-agent': UA, 'accept-language': 'en' } });
  const r = data && data[0];
  if (!r) return null;
  const approx = ['city', 'town', 'village', 'county', 'state', 'postcode', 'administrative'].includes(r.type) || r.addresstype === 'city';
  return { lat: Number(r.lat), lng: Number(r.lon), label: (approx ? '≈ ' : '') + r.display_name, source: 'osm' };
}

async function mapboxGeocode(address, token) {
  const u = new URL('https://api.mapbox.com/search/geocode/v6/forward');
  u.searchParams.set('q', address);
  u.searchParams.set('country', 'us');
  u.searchParams.set('limit', '1');
  u.searchParams.set('permanent', 'true');
  u.searchParams.set('access_token', token);
  const data = await fetchJson(u);
  const f = data && data.features && data.features[0];
  if (!f) return null;
  const [lng, lat] = f.geometry.coordinates;
  return { lat, lng, label: (f.properties && (f.properties.full_address || f.properties.name)) || address, source: 'mapbox' };
}

// ---------- distances ----------
export function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function straightMatrix(points) {
  const n = points.length;
  const durations = [], distances = [];
  for (let i = 0; i < n; i++) {
    durations.push([]); distances.push([]);
    for (let j = 0; j < n; j++) {
      const d = i === j ? 0 : haversine(points[i], points[j]) * 1.35;
      distances[i].push(d);
      durations[i].push(d / 11); // ~40 km/h average
    }
  }
  return { durations, distances, source: 'estimate' };
}

// Drive-time matrix. Falls back to straight-line estimates if Mapbox is not set up or fails.
export async function travelMatrix(points, token) {
  if (!token || points.length > 25 || points.length < 2) return straightMatrix(points);
  try {
    const coords = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const u = new URL(`https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coords}`);
    u.searchParams.set('annotations', 'duration,distance');
    u.searchParams.set('access_token', token);
    const data = await fetchJson(u, {}, 12000);
    if (data.code !== 'Ok') throw new Error(data.code || 'matrix failed');
    const fb = straightMatrix(points);
    const durations = data.durations.map((row, i) => row.map((v, j) => (v == null ? fb.durations[i][j] * 3 : v)));
    const distances = data.distances.map((row, i) => row.map((v, j) => (v == null ? fb.distances[i][j] * 3 : v)));
    return { durations, distances, source: 'mapbox' };
  } catch (e) {
    console.log('matrix fallback', e.message);
    return straightMatrix(points);
  }
}

// Road geometry + per-leg times along an ordered list of points (chunks of 25 waypoints).
export async function routeLine(points, token) {
  if (points.length < 2) return null;
  if (!token) return null;
  try {
    const legs = [];
    const line = [];
    for (let start = 0; start < points.length - 1; start += 24) {
      const chunk = points.slice(start, start + 25);
      const coords = chunk.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
      const u = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${coords}`);
      u.searchParams.set('geometries', 'geojson');
      u.searchParams.set('overview', 'full');
      u.searchParams.set('access_token', token);
      const data = await fetchJson(u, {}, 12000);
      if (data.code !== 'Ok' || !data.routes || !data.routes[0]) throw new Error(data.code || 'directions failed');
      const r = data.routes[0];
      for (const l of r.legs) legs.push({ duration: l.duration, distance: l.distance });
      const c = r.geometry.coordinates;
      for (let i = line.length ? 1 : 0; i < c.length; i++) line.push([+c[i][1].toFixed(5), +c[i][0].toFixed(5)]);
    }
    return { legs, line };
  } catch (e) {
    console.log('directions failed', e.message);
    return null;
  }
}

// ---------- ordering ----------
// Node 0 is the start. Returns the visiting order of nodes 1..n-1.
export function solveOrder(cost, returnToStart) {
  const n = cost.length;
  if (n <= 2) return n === 2 ? [1] : [];
  if (n - 1 <= 11) return heldKarp(cost, returnToStart);
  let order = nearestNeighbour(cost);
  order = improve(order, cost, returnToStart);
  return order;
}

function pathCost(order, cost, ret) {
  let c = 0, prev = 0;
  for (const k of order) { c += cost[prev][k]; prev = k; }
  if (ret) c += cost[prev][0];
  return c;
}

function heldKarp(cost, ret) {
  const n = cost.length - 1; // stops are 1..n
  const FULL = 1 << n;
  const dp = new Float64Array(FULL * n).fill(Infinity);
  const parent = new Int8Array(FULL * n).fill(-1);
  for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = cost[0][j + 1];
  for (let mask = 1; mask < FULL; mask++) {
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask * n + j];
      if (cur === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const nm = mask | (1 << k);
        const v = cur + cost[j + 1][k + 1];
        if (v < dp[nm * n + k]) { dp[nm * n + k] = v; parent[nm * n + k] = j; }
      }
    }
  }
  const all = FULL - 1;
  let best = Infinity, last = 0;
  for (let j = 0; j < n; j++) {
    const v = dp[all * n + j] + (ret ? cost[j + 1][0] : 0);
    if (v < best) { best = v; last = j; }
  }
  const order = [];
  let mask = all, j = last;
  while (j !== -1) {
    order.push(j + 1);
    const p = parent[mask * n + j];
    mask &= ~(1 << j);
    j = p;
  }
  return order.reverse();
}

function nearestNeighbour(cost) {
  const n = cost.length;
  const seen = new Set([0]);
  const order = [];
  let cur = 0;
  while (order.length < n - 1) {
    let best = -1, bv = Infinity;
    for (let k = 1; k < n; k++) if (!seen.has(k) && cost[cur][k] < bv) { bv = cost[cur][k]; best = k; }
    order.push(best); seen.add(best); cur = best;
  }
  return order;
}

function improve(order, cost, ret) {
  let best = order.slice();
  let bestCost = pathCost(best, cost, ret);
  let improved = true, rounds = 0;
  const maxRounds = order.length > 30 ? 4 : 30; // keeps big routes within Cloudflare's time limit
  while (improved && rounds < maxRounds) {
    improved = false; rounds++;
    // 2-opt (segment reversal)
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const c = pathCost(cand, cost, ret);
        if (c < bestCost - 0.01) { best = cand; bestCost = c; improved = true; }
      }
    }
    // or-opt (move one stop elsewhere)
    for (let i = 0; i < best.length; i++) {
      for (let j = 0; j < best.length; j++) {
        if (i === j) continue;
        const cand = best.slice();
        const [x] = cand.splice(i, 1);
        cand.splice(j, 0, x);
        const c = pathCost(cand, cost, ret);
        if (c < bestCost - 0.01) { best = cand; bestCost = c; improved = true; }
      }
    }
  }
  return best;
}
