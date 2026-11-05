// Route planning shared by admin and driver: ordering, road line, ETAs, completion.
import { getSettings, localToEpoch, logEvent } from './lib.js';
import { travelMatrix, routeLine, solveOrder } from './geo.js';
import { notify } from './push.js';

const hasPos = s => s.lat != null && s.lng != null;

// Recalculate a route. With optimize=true the remaining stops are put in the best order.
export async function recomputeRoute(env, routeId, { optimize = false } = {}) {
  const settings = await getSettings(env);
  const route = await env.DB.prepare('SELECT * FROM routes WHERE id = ?').bind(routeId).first();
  if (!route) return null;
  const { results: stops } = await env.DB.prepare('SELECT * FROM stops WHERE route_id = ? ORDER BY seq, id').bind(routeId).all();

  const finished = stops.filter(s => s.status === 'done' || s.status === 'failed');
  let open = stops.filter(s => s.status !== 'done' && s.status !== 'failed');
  const openWithPos = open.filter(hasPos);
  const openNoPos = open.filter(s => !hasPos(s));

  // Where the drive starts: the driver's live position on an active route, else the depot.
  let start = null;
  let startTime;
  const now = Date.now();
  if (route.status === 'active' && route.driver_id) {
    const d = await env.DB.prepare('SELECT last_lat, last_lng, last_pos_at FROM drivers WHERE id = ?').bind(route.driver_id).first();
    if (d && d.last_lat != null && now - d.last_pos_at < 15 * 60 * 1000) start = { lat: d.last_lat, lng: d.last_lng };
    startTime = now;
  }
  if (!start && settings.depot_lat != null) start = { lat: settings.depot_lat, lng: settings.depot_lng };
  if (startTime === undefined) {
    startTime = localToEpoch(route.date, route.start_time || settings.default_start_time, settings.timezone);
    if (route.status === 'active') startTime = Math.max(startTime, now);
  }

  let ordered = openWithPos;
  const ret = !!route.return_to_depot && settings.depot_lat != null;
  if (optimize && openWithPos.length >= 2) {
    const pts = start ? [start, ...openWithPos] : openWithPos;
    const mx = await travelMatrix(pts, settings.mapbox_token);
    if (start) {
      const order = solveOrder(mx.durations, ret);
      ordered = order.map(k => openWithPos[k - 1]);
    } else {
      // No start point: try each stop as the first one and keep the best.
      let best = null, bestCost = Infinity;
      for (let s0 = 0; s0 < pts.length; s0++) {
        const idx = [s0, ...pts.map((_, i) => i).filter(i => i !== s0)];
        const sub = idx.map(i => idx.map(j => mx.durations[i][j]));
        const order = solveOrder(sub, false);
        let c = 0, prev = 0;
        for (const k of order) { c += sub[prev][k]; prev = k; }
        if (c < bestCost) { bestCost = c; best = [s0, ...order.map(k => idx[k])]; }
      }
      ordered = best.map(i => openWithPos[i]);
    }
  }

  // Road line + times between stops
  const linePts = [...(start ? [start] : []), ...ordered.map(s => ({ lat: s.lat, lng: s.lng }))];
  if (ret && start && ordered.length) linePts.push(start);
  let legs = null, line = null, distance = 0, duration = 0;
  if (linePts.length >= 2) {
    const rl = await routeLine(linePts, settings.mapbox_token);
    if (rl) { legs = rl.legs; line = rl.line; }
    else {
      const mx = await travelMatrix(linePts, '');
      legs = [];
      for (let i = 0; i < linePts.length - 1; i++) legs.push({ duration: mx.durations[i][i + 1], distance: mx.distances[i][i + 1] });
      line = null;
    }
    for (const l of legs) { distance += l.distance; duration += l.duration; }
  }

  // ETAs
  const etas = new Map();
  let t = startTime;
  const service = settings.service_minutes * 60 * 1000;
  ordered.forEach((s, i) => {
    const legIdx = start ? i : i - 1;
    if (legIdx >= 0 && legs && legs[legIdx]) t += legs[legIdx].duration * 1000;
    if (s.status === 'arrived') t = Math.max(t, now);
    etas.set(s.id, Math.round(t));
    t += service;
  });

  const finalOrder = [...finished.sort((a, b) => (a.done_at || 0) - (b.done_at || 0)), ...ordered, ...openNoPos];
  const stmts = finalOrder.map((s, i) => env.DB.prepare('UPDATE stops SET seq = ?, eta = ? WHERE id = ?')
    .bind(i + 1, etas.has(s.id) ? etas.get(s.id) : (s.status === 'done' || s.status === 'failed' ? s.eta : null), s.id));
  stmts.push(env.DB.prepare(`UPDATE routes SET geometry = ?, distance_m = ?, duration_s = ?, optimized_at = CASE WHEN ? THEN ? ELSE optimized_at END,
      start_lat = ?, start_lng = ?, updated_at = ? WHERE id = ?`)
    .bind(line ? JSON.stringify(line) : null, Math.round(distance), Math.round(duration + ordered.length * settings.service_minutes * 60),
      optimize ? 1 : 0, now, start ? start.lat : null, start ? start.lng : null, now, routeId));
  await env.DB.batch(stmts);
  return { optimized: optimize, stops: finalOrder.length, unlocated: openNoPos.length };
}

// After a stop changes, mark the route finished if nothing is left.
export async function checkRouteFinished(env, routeId, origin) {
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM stops WHERE route_id = ? AND status NOT IN ('done','failed')`).bind(routeId).first();
  const route = await env.DB.prepare('SELECT r.*, d.name AS driver_name FROM routes r LEFT JOIN drivers d ON d.id = r.driver_id WHERE r.id = ?').bind(routeId).first();
  if (!route) return;
  if (left.n === 0 && route.status !== 'done') {
    const total = await env.DB.prepare(`SELECT SUM(status='done') AS done, SUM(status='failed') AS failed FROM stops WHERE route_id = ?`).bind(routeId).first();
    await env.DB.prepare(`UPDATE routes SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ?`).bind(Date.now(), Date.now(), routeId).run();
    await logEvent(env, { route_id: routeId, driver_id: route.driver_id, type: 'route_done', detail: `${total.done || 0} delivered, ${total.failed || 0} failed` });
    await notify(env, {
      kind: 'admin', subject: origin,
      payload: { title: `Route finished — ${route.driver_name || 'driver'}`, body: `${total.done || 0} delivered, ${total.failed || 0} not delivered`, url: `/admin#route/${routeId}`, tag: `route-${routeId}` },
    });
  } else if (left.n > 0 && route.status === 'done') {
    await env.DB.prepare(`UPDATE routes SET status = 'active', finished_at = NULL, updated_at = ? WHERE id = ?`).bind(Date.now(), routeId).run();
  }
}
