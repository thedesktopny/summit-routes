/* Summit Safety Routes — office (admin) page */
(function () {
  const { esc, $, $$, api, toast, sheet, confirm, busy, icon } = C;

  const S = {
    settings: null,
    drivers: [],
    date: null,
    timers: [],
    map: null,
    pinMode: null,
  };

  const app = document.getElementById('app');
  const tz = () => (S.settings ? S.settings.timezone : 'America/New_York');
  const t = (ms) => C.fmtTime(ms, tz());

  function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; }
  function every(ms, fn) { S.timers.push(setInterval(() => { if (!document.hidden) fn(); }, ms)); }
  function destroyMap() { if (S.map) { try { S.map.stop(); S.map.remove(); } catch { /* ignore */ } S.map = null; } }

  async function handleAuthError(e) {
    if (e && e.status === 401) { await boot(); return true; }
    return false;
  }
  async function guard(fn) {
    try { return await fn(); }
    catch (e) { if (!(await handleAuthError(e))) toast(e.message, true); }
  }

  // ---------------- sign in ----------------
  async function boot() {
    clearTimers(); destroyMap();
    let st;
    try { st = await api('/api/admin/state'); }
    catch (e) {
      app.innerHTML = `<div class="center-screen"><div class="card login-card"><h2>Can't connect</h2><p class="muted">${esc(e.message)}</p><button class="btn-primary btn-block" id="retry">Try again</button></div></div>`;
      $('#retry').onclick = boot;
      return;
    }
    if (st.needs_setup) return setupScreen();
    if (!st.authed) return loginScreen();
    await startApp();
  }

  function setupScreen() {
    app.innerHTML = `<div class="center-screen"><form class="card login-card" id="f">
      <div class="brand" style="justify-content:center;display:flex;gap:8px;align-items:center;margin-bottom:6px"><span style="width:12px;height:12px;border-radius:50%;background:var(--orange)"></span><h2>Summit Routes</h2></div>
      <p class="muted">Welcome! Create the office PIN. You'll use it to sign in.</p>
      <label class="field"><span>Company name</span><input type="text" name="company" value="Summit Safety" maxlength="80"></label>
      <label class="field"><span>New PIN (4–10 digits)</span><input class="pin-input" type="password" inputmode="numeric" pattern="[0-9]*" name="pin" autocomplete="new-password" required minlength="4" maxlength="10"></label>
      <label class="field"><span>Repeat PIN</span><input class="pin-input" type="password" inputmode="numeric" pattern="[0-9]*" name="pin2" autocomplete="new-password" required minlength="4" maxlength="10"></label>
      <div class="error-text" id="err"></div>
      <button class="btn-primary btn-block btn-lg" type="submit">Create PIN</button></form></div>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.pin.value !== f.pin2.value) { $('#err').textContent = 'The PINs do not match.'; return; }
      await busy(f.querySelector('button[type=submit]'), async () => {
        try { await api('/api/admin/setup', { method: 'POST', body: { pin: f.pin.value, company_name: f.company.value } }); location.hash = '#settings'; await boot(); }
        catch (err) { $('#err').textContent = err.message; }
      });
    };
  }

  function loginScreen() {
    app.innerHTML = `<div class="center-screen"><form class="card login-card" id="f">
      <div style="justify-content:center;display:flex;gap:8px;align-items:center;margin-bottom:10px"><span style="width:12px;height:12px;border-radius:50%;background:var(--orange)"></span><h2>Summit Routes</h2></div>
      <label class="field"><span>Office PIN</span><input class="pin-input" type="password" inputmode="numeric" pattern="[0-9]*" name="pin" autocomplete="current-password" required autofocus></label>
      <div class="error-text" id="err"></div>
      <button class="btn-primary btn-block btn-lg" type="submit">Sign in</button></form></div>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      await busy(e.target.querySelector('button[type=submit]'), async () => {
        try { await api('/api/admin/login', { method: 'POST', body: { pin: e.target.pin.value } }); await boot(); }
        catch (err) { $('#err').textContent = err.message; e.target.pin.select(); }
      });
    };
  }

  // ---------------- app shell ----------------
  const NAV = [
    ['routes', 'Routes', 'route'],
    ['live', 'Live map', 'map'],
    ['customers', 'Customers', 'users'],
    ['drivers', 'Drivers', 'truck'],
    ['settings', 'Settings', 'gear'],
  ];

  async function startApp() {
    S.settings = await api('/api/admin/settings');
    S.date = S.date || S.settings.today;
    app.innerHTML = `
      <header class="topbar"><div class="brand"><span class="dot"></span>${esc(S.settings.company_name)} Routes</div>
        <nav class="tabs">${NAV.map(([k, label]) => `<a href="#${k}" data-nav="${k}">${label}</a>`).join('')}</nav>
        <div class="spacer"></div></header>
      <main id="main"></main>
      <nav class="bottomnav">${NAV.map(([k, label, ic]) => `<a href="#${k}" data-nav="${k}">${icon(ic)}${label}</a>`).join('')}</nav>`;
    window.onhashchange = route;
    C.registerSW();
    await loadDrivers();
    route();
  }

  async function loadDrivers() {
    const d = await api('/api/admin/drivers');
    S.drivers = d.drivers;
  }

  function setNav(key) { $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key)); }

  async function route() {
    clearTimers(); destroyMap(); S.pinMode = null;
    $$('.sheet-backdrop').forEach((s) => s.remove());
    document.body.style.overflow = '';
    const h = location.hash.replace(/^#/, '') || 'routes';
    const main = $('#main');
    window.scrollTo(0, 0);
    let m;
    if ((m = h.match(/^route\/(\d+)$/))) { setNav('routes'); return guard(() => routeView(main, Number(m[1]))); }
    setNav(h);
    if (h === 'live') return guard(() => liveView(main));
    if (h === 'customers') return guard(() => customersView(main));
    if (h === 'drivers') return guard(() => driversView(main));
    if (h === 'settings') return guard(() => settingsView(main));
    setNav('routes');
    return guard(() => routesView(main));
  }

  // ---------------- map helpers ----------------
  function makeMap(el) {
    const map = L.map(el, { zoomControl: true, attributionControl: true, zoomAnimation: false, markerZoomAnimation: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const s = S.settings;
    if (s.depot_lat != null) map.setView([s.depot_lat, s.depot_lng], 11);
    else map.setView([41.11, -74.04], 10);
    S.map = map;
    return map;
  }
  const stopIcon = (label, cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}"><span>${esc(label)}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });
  const depotIcon = () => L.divIcon({ className: '', html: '<div class="depot-pin">S</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
  const truckIcon = (stale) => L.divIcon({ className: '', html: `<div class="truck-pin${stale ? ' stale' : ''}">${C.truckSvg}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] });
  const isStale = (at) => !at || Date.now() - at > 10 * 60 * 1000;

  // ---------------- Routes list ----------------
  async function routesView(main) {
    const setupMissing = S.settings.depot_lat == null || !S.settings.mapbox_token_set;
    main.innerHTML = `
      ${setupMissing ? `<div class="banner">${icon('gear')}<div class="grow">Finish setup: ${S.settings.depot_lat == null ? 'add your <b>start address</b>' : ''}${S.settings.depot_lat == null && !S.settings.mapbox_token_set ? ' and ' : ''}${!S.settings.mapbox_token_set ? 'add your <b>Mapbox key</b> for real drive times' : ''}.</div><a class="btn btn-sm" href="#settings">Settings</a></div>` : ''}
      <div class="datebar">
        <button class="icon" id="prev" aria-label="Previous day">${icon('back')}</button>
        <input type="date" id="date" value="${S.date}">
        <button class="icon" id="next" aria-label="Next day" style="transform:scaleX(-1)">${icon('back')}</button>
        <button class="btn-sm" id="today">Today</button>
      </div>
      <div class="section-title"><h2 id="dtitle"></h2><button class="btn-primary" id="new">${icon('plus')} New route</button></div>
      <div class="list" id="list"><div class="empty"><span class="spinner dark"></span></div></div>`;
    const setDate = (d) => { S.date = d; $('#date').value = d; load(); };
    $('#prev').onclick = () => setDate(C.addDays(S.date, -1));
    $('#next').onclick = () => setDate(C.addDays(S.date, 1));
    $('#today').onclick = () => setDate(S.settings.today);
    $('#date').onchange = (e) => e.target.value && setDate(e.target.value);
    $('#new').onclick = () => newRouteSheet();

    async function load() {
      const isToday = S.date === S.settings.today;
      $('#dtitle').textContent = (isToday ? 'Today · ' : '') + C.fmtDate(S.date, 'en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      const { routes } = await api(`/api/admin/routes?date=${S.date}`);
      const list = $('#list');
      if (!list) return;
      if (!routes.length) {
        list.innerHTML = `<div class="card empty">No routes for this day.<br><br><button class="btn-primary" id="new2">${icon('plus')} New route</button></div>`;
        $('#new2').onclick = () => newRouteSheet();
        return;
      }
      list.innerHTML = routes.map((r) => {
        const pctDone = r.stop_count ? (r.done_count / r.stop_count) * 100 : 0;
        const pctFail = r.stop_count ? (r.failed_count / r.stop_count) * 100 : 0;
        return `<a class="card" href="#route/${r.id}" style="text-decoration:none;color:inherit;display:block">
          <div class="row"><div class="grow"><h3 class="ellipsis">${esc(r.driver_name || 'No driver yet')}${r.name ? ` · <span class="muted">${esc(r.name)}</span>` : ''}</h3>
            <div class="muted small">${r.stop_count} stop${r.stop_count === 1 ? '' : 's'} · starts ${esc(r.start_time)}${r.duration_s ? ` · ${C.fmtDuration(r.duration_s)} · ${C.fmtMiles(r.distance_m)}` : ''}</div></div>
            <span class="chip ${r.status}">${statusLabel(r.status)}</span></div>
          <div class="progress" style="margin-top:10px"><div class="p-done" style="width:${pctDone}%"></div><div class="p-failed" style="width:${pctFail}%"></div></div>
          <div class="row small muted" style="margin-top:6px"><span>${r.done_count} delivered${r.failed_count ? ` · ${r.failed_count} not delivered` : ''}</span><span class="spacer"></span>
            ${r.unlocated_count ? `<span class="chip warn">${r.unlocated_count} address${r.unlocated_count === 1 ? '' : 'es'} not found</span>` : ''}
            ${r.status === 'active' && r.last_pos_at ? `<span>GPS ${C.ago(r.last_pos_at)}</span>` : ''}</div></a>`;
      }).join('');
    }
    await load();
    every(30000, () => guard(load));
  }

  function statusLabel(s) { return { planned: 'Planned', active: 'On the road', done: 'Finished' }[s] || s; }
  function stopStatusLabel(s) { return { pending: 'To do', arrived: 'Arrived', done: 'Delivered', failed: 'Not delivered' }[s] || s; }

  function driverOptions(selected, includeNone = true) {
    const act = S.drivers.filter((d) => d.active || d.id === selected);
    return (includeNone ? `<option value="">— No driver yet —</option>` : '') + act.map((d) => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  }

  function newRouteSheet() {
    const s = sheet('New route', `<form id="nr">
      <label class="field"><span>Date</span><input type="date" name="date" value="${S.date}" required></label>
      <label class="field"><span>Driver</span><select name="driver_id">${driverOptions(null)}</select>
        ${S.drivers.filter((d) => d.active).length ? '' : '<div class="hint">No drivers yet — add them in the Drivers tab. You can pick one later.</div>'}</label>
      <div class="grid2"><label class="field"><span>Start time</span><input type="time" name="start_time" value="${esc(S.settings.default_start_time)}"></label>
      <label class="field"><span>Name (optional)</span><input type="text" name="name" maxlength="80" placeholder="e.g. North"></label></div>
      <button class="btn-primary btn-block btn-lg" type="submit">Create route</button></form>`);
    $('#nr', s.el).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      await busy(f.querySelector('[type=submit]'), () => guard(async () => {
        const { route: r } = await api('/api/admin/routes', { method: 'POST', body: { date: f.date.value, driver_id: f.driver_id.value || null, start_time: f.start_time.value, name: f.name.value } });
        s.close();
        S.date = r.date;
        location.hash = `#route/${r.id}`;
      }));
    };
  }

  // ---------------- One route ----------------
  async function routeView(main, id) {
    main.innerHTML = '<div class="empty"><span class="spinner dark"></span></div>';
    let data = await api(`/api/admin/routes/${id}`);
    S.date = data.route.date;
    main.innerHTML = `
      <div class="row" style="margin-bottom:10px"><a class="btn btn-ghost btn-sm" href="#routes">${icon('back')} Routes</a><span class="spacer"></span>
        <button class="btn-sm" id="more">More…</button></div>
      <div class="split"><div>
        <div class="card" id="head"></div>
        <div id="pinbanner"></div>
        <div class="section-title"><h2>Stops</h2>
          <button class="btn-sm" id="opt">${icon('wand', 18)} Best order</button>
          <button class="btn-primary btn-sm" id="add">${icon('plus', 18)} Add stop</button></div>
        <div class="list" id="stops"></div>
        <div class="section-title"><h2>Activity</h2></div>
        <div class="card"><ul class="timeline" id="events"></ul></div>
      </div><div class="map-col"><div class="map" id="map"></div><div class="small muted" id="mapnote" style="margin:6px 4px"></div></div></div>`;
    const map = makeMap($('#map'));
    const layer = L.layerGroup().addTo(map);
    let fitted = false;

    function renderHead() {
      const r = data.route;
      const stops = data.stops;
      const done = stops.filter((s) => s.status === 'done').length;
      const failed = stops.filter((s) => s.status === 'failed').length;
      $('#head').innerHTML = `
        <div class="row wrap" style="margin-bottom:10px"><h2 class="grow">${esc(C.fmtDate(r.date, 'en-US', { weekday: 'long', month: 'short', day: 'numeric' }))}${r.name ? ` · ${esc(r.name)}` : ''}</h2>
          <span class="chip ${r.status}">${statusLabel(r.status)}</span></div>
        <div class="grid2">
          <label class="field" style="margin:0"><span>Driver</span><select id="drv">${driverOptions(r.driver_id)}</select></label>
          <label class="field" style="margin:0"><span>Start time</span><input type="time" id="stime" value="${esc(r.start_time)}"></label>
        </div>
        <div class="row wrap small" style="margin-top:12px;gap:14px">
          <span><b>${stops.length}</b> stops</span><span><b>${done}</b> delivered</span>${failed ? `<span style="color:var(--red)"><b>${failed}</b> not delivered</span>` : ''}
          ${r.duration_s ? `<span class="muted">${C.fmtDuration(r.duration_s)} · ${C.fmtMiles(r.distance_m)}</span>` : ''}
          ${r.status === 'active' && r.last_pos_at ? `<span class="muted">GPS ${C.ago(r.last_pos_at)}</span>` : ''}
        </div>
        <div class="row" style="margin-top:12px"><button class="btn-orange btn-block" id="send">${icon('send', 18)} Send to driver</button></div>`;
      $('#drv').onchange = (e) => guard(async () => {
        await api(`/api/admin/routes/${id}`, { method: 'PATCH', body: { driver_id: e.target.value || null } });
        toast('Driver updated'); await reload();
      });
      $('#stime').onchange = (e) => e.target.value && guard(async () => {
        await api(`/api/admin/routes/${id}`, { method: 'PATCH', body: { start_time: e.target.value } });
        toast('Start time updated'); await reload();
      });
      $('#send').onclick = (e) => busy(e.currentTarget, () => guard(() => sendToDriver(id)));
    }

    function nextStopId() {
      const n = data.stops.find((s) => s.status === 'pending' || s.status === 'arrived');
      return n ? n.id : null;
    }

    function renderStops() {
      const el = $('#stops');
      if (!data.stops.length) {
        el.innerHTML = `<div class="card empty">No stops yet. Tap <b>Add stop</b>.</div>`;
        return;
      }
      const nextId = data.route.status === 'active' ? nextStopId() : null;
      const open = data.stops.filter((s) => s.status === 'pending' || s.status === 'arrived');
      el.innerHTML = data.stops.map((s, i) => {
        const cls = s.id === nextId ? 'next' : s.status;
        const oi = open.findIndex((o) => o.id === s.id);
        return `<div class="card stop" data-id="${s.id}">
          <div class="num ${cls}">${i + 1}</div>
          <div class="body">
            <div class="name">${esc(s.name)}</div>
            <div class="addr">${esc(s.address)}</div>
            ${s.lat == null ? `<div class="chip warn" style="margin-top:6px">Address not found — edit or pin it on the map</div>` : ''}
            <div class="meta">
              <span class="chip ${s.status}">${stopStatusLabel(s.status)}</span>
              ${s.status === 'done' || s.status === 'failed' ? `<span class="small muted">${t(s.done_at)}</span>` : (s.eta ? `<span class="small muted">ETA ${t(s.eta)}</span>` : '')}
              ${s.phone ? `<a class="small" href="${C.telHref(s.phone)}">${esc(s.phone)}</a>` : ''}
            </div>
            ${s.notes ? `<div class="small muted" style="margin-top:4px">${icon('note', 14)} ${esc(s.notes)}</div>` : ''}
            ${s.received_by ? `<div class="small" style="margin-top:4px">Received by <b>${esc(s.received_by)}</b></div>` : ''}
            ${s.fail_reason ? `<div class="small" style="margin-top:4px;color:var(--red)">${esc(s.fail_reason)}</div>` : ''}
            ${s.driver_note ? `<div class="small" style="margin-top:4px">Driver: ${esc(s.driver_note)}</div>` : ''}
            ${s.photos.length ? `<div class="thumbs">${s.photos.map((p) => `<a href="${p.url}" target="_blank" rel="noopener"><img src="${p.url}" alt="Proof photo" loading="lazy"></a>`).join('')}</div>` : ''}
          </div>
          <div class="tools">
            <button class="icon" data-act="edit" aria-label="Edit">${icon('edit', 18)}</button>
            ${oi >= 0 && open.length > 1 ? `<div class="row" style="gap:0">
              <button class="icon" data-act="up" aria-label="Move up" ${oi > 0 ? '' : 'disabled style="visibility:hidden"'}>${icon('up', 18)}</button>
              <button class="icon" data-act="down" aria-label="Move down" ${oi < open.length - 1 ? '' : 'disabled style="visibility:hidden"'}>${icon('down', 18)}</button></div>` : ''}
          </div></div>`;
      }).join('');
      $$('.stop', el).forEach((card) => {
        const sid = Number(card.dataset.id);
        card.querySelectorAll('[data-act]').forEach((b) => {
          b.onclick = () => {
            const act = b.dataset.act;
            const stop = data.stops.find((x) => x.id === sid);
            if (act === 'edit') return editStopSheet(stop);
            if (act === 'up' || act === 'down') return busy(b, () => guard(() => move(sid, act === 'up' ? -1 : 1)));
          };
        });
      });
    }

    async function move(sid, dir) {
      const open = data.stops.filter((s) => s.status === 'pending' || s.status === 'arrived').map((s) => s.id);
      const closed = data.stops.filter((s) => !(s.status === 'pending' || s.status === 'arrived')).map((s) => s.id);
      const i = open.indexOf(sid), j = i + dir;
      if (i < 0 || j < 0 || j >= open.length) return;
      [open[i], open[j]] = [open[j], open[i]];
      await api(`/api/admin/routes/${id}/reorder`, { method: 'POST', body: { stop_ids: [...closed, ...open] } });
      await reload();
    }

    function renderMap() {
      layer.clearLayers();
      const pts = [];
      const s = S.settings;
      if (s.depot_lat != null) { L.marker([s.depot_lat, s.depot_lng], { icon: depotIcon(), title: 'Start' }).bindPopup('Start: ' + esc(s.depot_address || s.depot_label)).addTo(layer); pts.push([s.depot_lat, s.depot_lng]); }
      if (data.trail.length > 1) L.polyline(data.trail.map((p) => [p[0], p[1]]), { color: '#f26b1d', weight: 3, opacity: .6, dashArray: '4 6' }).addTo(layer);
      if (data.route.geometry) L.polyline(data.route.geometry, { color: '#0f3d63', weight: 4, opacity: .75 }).addTo(layer);
      else {
        const line = data.stops.filter((x) => x.lat != null && (x.status === 'pending' || x.status === 'arrived')).map((x) => [x.lat, x.lng]);
        if (data.route.status === 'active' && data.route.last_lat != null && !isStale(data.route.last_pos_at)) line.unshift([data.route.last_lat, data.route.last_lng]);
        else if (s.depot_lat != null && data.route.status !== 'active') line.unshift([s.depot_lat, s.depot_lng]);
        if (line.length > 1) L.polyline(line, { color: '#0f3d63', weight: 3, opacity: .5, dashArray: '2 8' }).addTo(layer);
      }
      const nextId = data.route.status === 'active' ? nextStopId() : null;
      data.stops.forEach((x, i) => {
        if (x.lat == null) return;
        L.marker([x.lat, x.lng], { icon: stopIcon(i + 1, x.id === nextId ? 'next' : x.status), title: x.name, zIndexOffset: x.id === nextId ? 500 : 0 })
          .bindPopup(`<b>${esc(x.name)}</b><br>${esc(x.address)}<br><span class="muted">${stopStatusLabel(x.status)}${x.eta && x.status !== 'done' ? ' · ETA ' + t(x.eta) : ''}</span>`).addTo(layer);
        pts.push([x.lat, x.lng]);
      });
      const r = data.route;
      if (r.last_lat != null && (r.status === 'active' || Date.now() - r.last_pos_at < 3600e3) && r.date === S.settings.today) {
        L.marker([r.last_lat, r.last_lng], { icon: truckIcon(isStale(r.last_pos_at)), zIndexOffset: 1000, title: r.driver_name })
          .bindPopup(`<b>${esc(r.driver_name || '')}</b><br>${C.ago(r.last_pos_at)}`).addTo(layer);
        pts.push([r.last_lat, r.last_lng]);
      }
      if (!fitted && pts.length) { map.fitBounds(pts, { padding: [30, 30], maxZoom: 14, animate: false }); fitted = true; }
      $('#mapnote').textContent = r.geometry ? '' : (S.settings.mapbox_token_set ? '' : 'Dotted line = straight-line estimate. Add a Mapbox key in Settings for real roads and drive times.');
    }

    function renderEvents() {
      const names = { route_created: 'Route created', driver_assigned: 'Driver set', optimized: 'Best order calculated', sent_to_driver: 'Sent to driver', route_started: 'Driver started the route', arrived: 'Arrived', photo: 'Photo taken', delivered: 'Delivered', failed: 'Not delivered', undone: 'Driver undid a stop', status_by_office: 'Status changed by office', route_done: 'Route finished' };
      $('#events').innerHTML = data.events.length ? data.events.map((e) => `<li><span class="t">${t(e.at)}</span><span>${esc(names[e.type] || e.type)}${e.stop_name ? ` — <b>${esc(e.stop_name)}</b>` : ''}${e.detail ? ` <span class="muted">(${esc(e.detail)})</span>` : ''}</span></li>`).join('') : '<li class="muted">Nothing yet</li>';
    }

    function renderAll() { renderHead(); renderStops(); renderMap(); renderEvents(); }

    async function reload() {
      data = await api(`/api/admin/routes/${id}`);
      if (!$('#stops')) return;
      renderAll();
    }

    renderAll();
    $('#add').onclick = () => addStopSheet(id, reload);
    $('#opt').onclick = (e) => busy(e.currentTarget, () => guard(async () => {
      const r = await api(`/api/admin/routes/${id}/optimize`, { method: 'POST', body: {} });
      await reload();
      toast(r.has_start ? 'Stops put in the best order' : 'Done — add a start address in Settings for better results');
    }));
    $('#more').onclick = () => moreSheet();

    map.on('click', (e) => {
      if (!S.pinMode) return;
      const stop = S.pinMode;
      S.pinMode = null;
      $('#pinbanner').innerHTML = '';
      guard(async () => {
        await api(`/api/admin/stops/${stop.id}`, { method: 'PATCH', body: { lat: e.latlng.lat, lng: e.latlng.lng } });
        toast('Location saved'); await reload();
      });
    });

    function editStopSheet(stop) {
      const s = sheet('Edit stop', `<form id="es">
        <label class="field"><span>Company / person</span><input type="text" name="name" value="${esc(stop.name)}" maxlength="120" required></label>
        <label class="field"><span>Address</span><input type="text" name="address" value="${esc(stop.address)}" maxlength="300" required>
          <div class="hint">${stop.lat != null ? `Found as: ${esc(stop.geo_label || '')}` : 'Not found on the map yet.'}</div></label>
        <label class="field"><span>Phone</span><input type="tel" name="phone" value="${esc(stop.phone)}" maxlength="40"></label>
        <label class="field"><span>Notes for the driver</span><textarea name="notes" maxlength="1000">${esc(stop.notes)}</textarea></label>
        <button class="btn-primary btn-block" type="submit">Save</button>
        <div class="row wrap" style="margin-top:10px">
          <button type="button" class="btn-sm" id="pin">${icon('pin', 16)} Pin on map</button>
          ${stop.status !== 'pending' ? `<button type="button" class="btn-sm" id="reset">${icon('undo', 16)} Back to “To do”</button>` : `<button type="button" class="btn-sm" id="mdone">${icon('check', 16)} Mark delivered</button>`}
          <span class="spacer"></span>
          <button type="button" class="btn-sm btn-danger-ghost" id="del">${icon('trash', 16)} Remove</button></div></form>`);
      $('#es', s.el).onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        await busy(f.querySelector('[type=submit]'), () => guard(async () => {
          const r = await api(`/api/admin/stops/${stop.id}`, { method: 'PATCH', body: { name: f.name.value, address: f.address.value, phone: f.phone.value, notes: f.notes.value } });
          s.close();
          toast(r.stop.lat == null ? 'Saved, but the address was not found. Use “Pin on map”.' : 'Saved', r.stop.lat == null);
          await reload();
        }));
      };
      $('#pin', s.el).onclick = () => {
        s.close();
        S.pinMode = stop;
        $('#pinbanner').innerHTML = `<div class="banner info" style="margin-top:10px">${icon('pin')}<div class="grow">Tap the map where <b>${esc(stop.name)}</b> is.</div><button class="btn-sm" id="cancelpin">Cancel</button></div>`;
        $('#cancelpin').onclick = () => { S.pinMode = null; $('#pinbanner').innerHTML = ''; };
        $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      const setStatus = (status) => guard(async () => {
        await api(`/api/admin/stops/${stop.id}`, { method: 'PATCH', body: { status } });
        s.close(); toast('Updated'); await reload();
      });
      if ($('#reset', s.el)) $('#reset', s.el).onclick = () => setStatus('pending');
      if ($('#mdone', s.el)) $('#mdone', s.el).onclick = () => setStatus('done');
      $('#del', s.el).onclick = async () => {
        if (!(await confirm('Remove stop?', `Remove ${stop.name} from this route? Its photos will be deleted.`, 'Remove'))) return;
        await guard(async () => { await api(`/api/admin/stops/${stop.id}`, { method: 'DELETE' }); s.close(); toast('Stop removed'); await reload(); });
      };
    }

    function moreSheet() {
      const r = data.route;
      const s = sheet('Route options', `
        <label class="check"><input type="checkbox" id="ret" ${r.return_to_depot ? 'checked' : ''}><span>Driver returns to the start at the end<div class="hint">Used when calculating the best order and total time.</div></span></label>
        <label class="field"><span>Route name</span><input type="text" id="rname" value="${esc(r.name)}" maxlength="80" placeholder="optional"></label>
        <div class="list">
          <button id="copy">${icon('copy', 18)} Copy these stops to another day</button>
          <button id="move">Move this route to another day</button>
          ${r.status === 'done' ? `<button id="reopen">Re-open route</button>` : `<button id="finish">Mark route finished</button>`}
          <button class="btn-danger-ghost" id="delr">${icon('trash', 18)} Delete route</button>
        </div>`);
      $('#ret', s.el).onchange = (e) => guard(async () => { await api(`/api/admin/routes/${id}`, { method: 'PATCH', body: { return_to_depot: e.target.checked } }); toast('Saved'); await reload(); });
      $('#rname', s.el).onchange = (e) => guard(async () => { await api(`/api/admin/routes/${id}`, { method: 'PATCH', body: { name: e.target.value } }); toast('Saved'); await reload(); });
      $('#copy', s.el).onclick = () => { s.close(); pickDateSheet('Copy stops to…', C.addDays(r.date, 1), true, async (date, driverId) => {
        const res = await api(`/api/admin/routes/${id}/copy`, { method: 'POST', body: { date, driver_id: driverId } });
        toast('Copied'); S.date = date; location.hash = `#route/${res.route.id}`;
      }); };
      $('#move', s.el).onclick = () => { s.close(); pickDateSheet('Move route to…', r.date, false, async (date) => {
        await api(`/api/admin/routes/${id}`, { method: 'PATCH', body: { date } });
        S.date = date; toast('Moved'); await reload();
      }); };
      if ($('#finish', s.el)) $('#finish', s.el).onclick = () => guard(async () => { await api(`/api/admin/routes/${id}`, { method: 'PATCH', body: { status: 'done' } }); s.close(); await reload(); });
      if ($('#reopen', s.el)) $('#reopen', s.el).onclick = () => guard(async () => { await api(`/api/admin/routes/${id}`, { method: 'PATCH', body: { status: 'active' } }); s.close(); await reload(); });
      $('#delr', s.el).onclick = async () => {
        if (!(await confirm('Delete route?', 'This deletes the route, its stops and proof photos. Saved customers stay.', 'Delete'))) return;
        await guard(async () => { await api(`/api/admin/routes/${id}`, { method: 'DELETE' }); s.close(); toast('Route deleted'); location.hash = '#routes'; });
      };
    }

    every(20000, () => guard(async () => {
      if ($$('.sheet-backdrop').length || S.pinMode) return;
      await reload();
    }));
  }

  function pickDateSheet(title, date, withDriver, onPick) {
    const s = sheet(title, `<form id="pd"><label class="field"><span>Date</span><input type="date" name="date" value="${date}" required></label>
      ${withDriver ? `<label class="field"><span>Driver</span><select name="driver_id">${driverOptions(null)}</select></label>` : ''}
      <button class="btn-primary btn-block" type="submit">OK</button></form>`);
    $('#pd', s.el).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      await busy(f.querySelector('[type=submit]'), () => guard(async () => { await onPick(f.date.value, withDriver ? (f.driver_id.value || null) : undefined); s.close(); }));
    };
  }

  async function sendToDriver(id) {
    const r = await api(`/api/admin/routes/${id}/send`, { method: 'POST', body: {} });
    const link = location.origin + r.link;
    const msg = `Hola ${r.driver_name}, tu ruta está lista: ${link}`;
    const phone = String(r.driver_phone || '').replace(/[^\d]/g, '');
    const wa = phone ? `https://wa.me/${phone.length === 10 ? '1' + phone : phone}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    sheet('Send to driver', `
      ${r.push_devices ? `<div class="banner ok">${icon('check')} Alert sent to ${esc(r.driver_name)}'s phone.</div>` : `<div class="banner">${esc(r.driver_name)} hasn't turned on alerts yet, so send the link by text or WhatsApp.</div>`}
      <div class="link-box" style="margin-bottom:12px">${esc(link)}</div>
      <div class="list">
        <a class="btn btn-green" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>
        <a class="btn" href="sms:${phone}?&body=${encodeURIComponent(msg)}">Text message</a>
        <button id="cp">${icon('copy', 18)} Copy link</button>
      </div>`).el.querySelector('#cp').onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast('Copy failed — select the link and copy it', true); }
    };
  }

  // Add stop with customer autocomplete
  function addStopSheet(routeId, after) {
    let chosen = null;
    const s = sheet('Add stop', `<form id="as" autocomplete="off">
      <label class="field"><span>Company / person</span><div class="ac"><input type="text" name="name" maxlength="120" required placeholder="Start typing a saved customer…"><div class="ac-list hidden" id="acl"></div></div></label>
      <label class="field"><span>Address</span><input type="text" name="address" maxlength="300" required placeholder="Street, town, state ZIP"></label>
      <label class="field"><span>Phone</span><input type="tel" name="phone" maxlength="40"></label>
      <label class="field"><span>Notes for the driver</span><textarea name="notes" maxlength="1000" placeholder="e.g. Use back door, ask for Mike"></textarea></label>
      <label class="check"><input type="checkbox" name="save" checked><span>Save to customers</span></label>
      <div class="sheet-actions"><button type="button" id="another">Add + another</button><button class="btn-primary" type="submit">Add stop</button></div></form>`);
    const f = $('#as', s.el);
    const acl = $('#acl', s.el);
    let timer, items = [], sel = -1;
    const hide = () => { acl.classList.add('hidden'); sel = -1; };
    const renderAc = () => {
      if (!items.length) return hide();
      acl.innerHTML = items.map((c, i) => `<div class="ac-item${i === sel ? ' sel' : ''}" data-i="${i}"><div><b>${esc(c.name)}</b></div><div class="a">${esc(c.address)}</div></div>`).join('');
      acl.classList.remove('hidden');
    };
    const pick = (c) => {
      chosen = c;
      f.name.value = c.name; f.address.value = c.address; f.phone.value = c.phone || ''; f.notes.value = c.notes || '';
      hide();
    };
    f.name.addEventListener('input', () => {
      chosen = null;
      clearTimeout(timer);
      const q = f.name.value.trim();
      if (q.length < 1) return hide();
      timer = setTimeout(async () => {
        try { items = (await api(`/api/admin/customers?q=${encodeURIComponent(q)}&limit=8`)).customers; sel = -1; renderAc(); } catch { /* ignore */ }
      }, 180);
    });
    f.name.addEventListener('keydown', (e) => {
      if (acl.classList.contains('hidden')) return;
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); renderAc(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderAc(); e.preventDefault(); }
      else if (e.key === 'Enter' && sel >= 0) { pick(items[sel]); e.preventDefault(); }
      else if (e.key === 'Escape') { hide(); e.stopPropagation(); }
    });
    acl.addEventListener('mousedown', (e) => { const it = e.target.closest('.ac-item'); if (it) { e.preventDefault(); pick(items[Number(it.dataset.i)]); } });
    f.name.addEventListener('blur', () => setTimeout(hide, 150));

    const submit = async (btn, again) => {
      if (!f.reportValidity()) return;
      await busy(btn, () => guard(async () => {
        const body = { name: f.name.value, address: f.address.value, phone: f.phone.value, notes: f.notes.value, save_customer: f.save.checked };
        if (chosen) body.customer_id = chosen.id;
        const r = await api(`/api/admin/routes/${routeId}/stops`, { method: 'POST', body });
        toast(r.located ? `Added ${r.stop.name}` : `Added, but the address wasn't found. Edit it or pin it on the map.`, !r.located);
        await after();
        if (again) { f.reset(); f.save.checked = true; chosen = null; f.name.focus(); }
        else s.close();
      }));
    };
    f.onsubmit = (e) => { e.preventDefault(); submit(f.querySelector('[type=submit]'), false); };
    $('#another', s.el).onclick = (e) => submit(e.currentTarget, true);
  }

  // ---------------- Live map ----------------
  async function liveView(main) {
    main.innerHTML = `<div class="section-title" style="margin-top:4px"><h2>Live · ${esc(C.fmtDate(S.settings.today))}</h2><button class="btn-sm" id="rf">${icon('refresh', 16)}</button></div>
      <div class="split"><div class="map-col" style="order:2"><div class="list" id="dl"></div></div><div><div class="map tall" id="map"></div></div></div>`;
    const map = makeMap($('#map'));
    const layer = L.layerGroup().addTo(map);
    let fitted = false;
    async function load() {
      const d = await api(`/api/admin/live?date=${S.settings.today}`);
      layer.clearLayers();
      const pts = [];
      if (d.depot) { L.marker([d.depot.lat, d.depot.lng], { icon: depotIcon() }).bindPopup('Start').addTo(layer); pts.push([d.depot.lat, d.depot.lng]); }
      d.drivers.forEach((x) => {
        if (x.last_lat != null && Date.now() - x.last_pos_at < 12 * 3600e3) {
          L.marker([x.last_lat, x.last_lng], { icon: truckIcon(isStale(x.last_pos_at)), title: x.name })
            .bindTooltip(esc(x.name), { permanent: true, direction: 'top', offset: [0, -16] })
            .bindPopup(`<b>${esc(x.name)}</b><br>${x.finished_count}/${x.stop_count} stops done<br>${x.next_stop ? 'Next: ' + esc(x.next_stop) + '<br>' : ''}GPS ${C.ago(x.last_pos_at)}`).addTo(layer);
          pts.push([x.last_lat, x.last_lng]);
        }
      });
      if (!fitted && pts.length) { map.fitBounds(pts, { padding: [40, 40], maxZoom: 13, animate: false }); fitted = true; }
      const dl = $('#dl');
      if (!dl) return;
      dl.innerHTML = d.drivers.length ? d.drivers.map((x) => `<a class="card" href="#route/${x.route_id}" style="text-decoration:none;color:inherit;display:block">
        <div class="row"><h3 class="grow">${esc(x.name)}</h3><span class="chip ${x.route_status}">${statusLabel(x.route_status)}</span></div>
        <div class="small muted" style="margin-top:4px">${x.finished_count}/${x.stop_count} stops${x.next_stop ? ` · next: ${esc(x.next_stop)}` : ''}</div>
        <div class="small ${isStale(x.last_pos_at) ? 'muted' : ''}" style="margin-top:2px">GPS ${C.ago(x.last_pos_at)}</div></a>`).join('')
        : '<div class="card empty">No routes with drivers today.</div>';
    }
    $('#rf').onclick = (e) => busy(e.currentTarget, () => guard(load));
    await load();
    every(15000, () => guard(load));
  }

  // ---------------- Customers ----------------
  async function customersView(main) {
    main.innerHTML = `<div class="section-title" style="margin-top:4px"><h2>Customers <span class="muted small" id="tot"></span></h2><button class="btn-primary" id="add">${icon('plus')} Add</button></div>
      <input type="search" id="q" placeholder="Search name, address or phone" style="margin-bottom:10px">
      <div class="list" id="cl"></div>`;
    let timer;
    async function load() {
      const q = $('#q').value.trim();
      const d = await api(`/api/admin/customers?q=${encodeURIComponent(q)}`);
      $('#tot').textContent = `(${d.total})`;
      $('#cl').innerHTML = d.customers.length ? d.customers.map((c) => `<div class="card" data-id="${c.id}">
        <div class="row"><div class="grow"><h3 class="ellipsis">${esc(c.name)}</h3><div class="small muted">${esc(c.address)}</div>
          <div class="small">${c.phone ? `<a href="${C.telHref(c.phone)}">${esc(c.phone)}</a>` : ''} ${c.lat == null ? '<span class="chip warn">not on map</span>' : ''} <span class="muted">${c.uses ? `· used ${c.uses}×` : ''}</span></div>
          ${c.notes ? `<div class="small muted">${esc(c.notes)}</div>` : ''}</div>
          <div class="tools row"><button class="btn-sm" data-act="route">${icon('plus', 16)} Route</button><button class="icon" data-act="edit" aria-label="Edit">${icon('edit', 18)}</button></div></div></div>`).join('')
        : `<div class="card empty">${q ? 'No matches.' : 'No saved customers yet. They are saved automatically when you add stops.'}</div>`;
      $$('#cl [data-id]').forEach((card) => {
        const c = d.customers.find((x) => x.id === Number(card.dataset.id));
        card.querySelector('[data-act=edit]').onclick = () => customerSheet(c, load);
        card.querySelector('[data-act=route]').onclick = () => addCustomerToRoute(c);
      });
    }
    $('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => guard(load), 200); };
    $('#add').onclick = () => customerSheet(null, load);
    await load();
  }

  function customerSheet(c, after) {
    const s = sheet(c ? 'Edit customer' : 'New customer', `<form id="cf">
      <label class="field"><span>Company / person</span><input type="text" name="name" value="${esc(c ? c.name : '')}" maxlength="120" required></label>
      <label class="field"><span>Address</span><input type="text" name="address" value="${esc(c ? c.address : '')}" maxlength="300" required>
        ${c ? `<div class="hint">${c.lat != null ? 'Found as: ' + esc(c.geo_label) : 'Not found on the map.'}</div>` : ''}</label>
      <label class="field"><span>Phone</span><input type="tel" name="phone" value="${esc(c ? c.phone : '')}" maxlength="40"></label>
      <label class="field"><span>Notes for the driver</span><textarea name="notes" maxlength="1000">${esc(c ? c.notes : '')}</textarea></label>
      <button class="btn-primary btn-block" type="submit">Save</button>
      ${c ? `<button type="button" class="btn-danger-ghost btn-block" id="del" style="margin-top:8px">${icon('trash', 16)} Delete customer</button>` : ''}</form>`);
    $('#cf', s.el).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { name: f.name.value, address: f.address.value, phone: f.phone.value, notes: f.notes.value };
      await busy(f.querySelector('[type=submit]'), () => guard(async () => {
        const r = c ? await api(`/api/admin/customers/${c.id}`, { method: 'PATCH', body }) : await api('/api/admin/customers', { method: 'POST', body });
        s.close();
        toast(r.customer.lat == null ? 'Saved, but the address was not found on the map' : 'Saved', r.customer.lat == null);
        await after();
      }));
    };
    if (c) $('#del', s.el).onclick = async () => {
      if (!(await confirm('Delete customer?', `Delete ${c.name}? Past stops are kept.`, 'Delete'))) return;
      await guard(async () => { await api(`/api/admin/customers/${c.id}`, { method: 'DELETE' }); s.close(); toast('Deleted'); await after(); });
    };
  }

  async function addCustomerToRoute(c) {
    const { routes } = await api(`/api/admin/routes?date=${S.date}`);
    const s = sheet(`Add ${c.name} to a route`, `<form id="ar">
      <label class="field"><span>Date</span><input type="date" name="date" value="${S.date}"></label>
      <label class="field"><span>Route</span><select name="route_id" required>${routes.map((r) => `<option value="${r.id}">${esc(r.driver_name || 'No driver')}${r.name ? ' · ' + esc(r.name) : ''} (${r.stop_count} stops)</option>`).join('')}</select>
        <div class="hint" id="nr">${routes.length ? '' : 'No routes that day. Create one in Routes first.'}</div></label>
      <button class="btn-primary btn-block" type="submit">Add stop</button></form>`);
    const f = $('#ar', s.el);
    f.date.onchange = async () => guard(async () => {
      const d = await api(`/api/admin/routes?date=${f.date.value}`);
      f.route_id.innerHTML = d.routes.map((r) => `<option value="${r.id}">${esc(r.driver_name || 'No driver')}${r.name ? ' · ' + esc(r.name) : ''} (${r.stop_count} stops)</option>`).join('');
      $('#nr', s.el).textContent = d.routes.length ? '' : 'No routes that day. Create one in Routes first.';
    });
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!f.route_id.value) return;
      await busy(f.querySelector('[type=submit]'), () => guard(async () => {
        await api(`/api/admin/routes/${f.route_id.value}/stops`, { method: 'POST', body: { customer_id: c.id } });
        s.close(); toast(`Added ${c.name}`);
      }));
    };
  }

  // ---------------- Drivers ----------------
  async function driversView(main) {
    main.innerHTML = `<div class="section-title" style="margin-top:4px"><h2>Drivers</h2><button class="btn-primary" id="add">${icon('plus')} Add driver</button></div>
      <p class="muted small" style="margin-top:-4px">Each driver gets a private link. Open it on their phone and tap “Add to home screen”. If a phone is lost, make a new link — the old one stops working.</p>
      <div class="list" id="dl"></div>`;
    async function load() {
      await loadDrivers();
      $('#dl').innerHTML = S.drivers.length ? S.drivers.map((d) => `<div class="card" data-id="${d.id}" style="${d.active ? '' : 'opacity:.6'}">
        <div class="row"><div class="grow"><h3>${esc(d.name)} ${d.active ? '' : '<span class="chip">Off</span>'}</h3>
          <div class="small muted">${d.phone ? esc(d.phone) + ' · ' : ''}last opened ${C.ago(d.last_seen_at)} · alerts ${d.push ? '<b style="color:var(--green)">on</b>' : 'off'}</div></div></div>
        <div class="row wrap" style="margin-top:10px">
          ${d.active ? `<button class="btn-sm btn-primary" data-act="share">${icon('link', 16)} Share link</button>` : ''}
          <button class="btn-sm" data-act="edit">${icon('edit', 16)} Edit</button>
          ${d.active ? `<button class="btn-sm" data-act="newlink">New link</button>` : ''}
          <button class="btn-sm btn-ghost" data-act="toggle">${d.active ? 'Turn off' : 'Turn on'}</button>
        </div></div>`).join('') : '<div class="card empty">No drivers yet.</div>';
      $$('#dl [data-id]').forEach((card) => {
        const d = S.drivers.find((x) => x.id === Number(card.dataset.id));
        card.querySelectorAll('[data-act]').forEach((b) => {
          b.onclick = async () => {
            const a = b.dataset.act;
            if (a === 'share') return shareLink(d);
            if (a === 'edit') return driverSheet(d, load);
            if (a === 'newlink') {
              if (!(await confirm('Make a new link?', `${d.name}'s current link will stop working. You'll need to send the new one.`, 'New link'))) return;
              return guard(async () => { const r = await api(`/api/admin/drivers/${d.id}/new-link`, { method: 'POST', body: {} }); await load(); shareLink(r.driver); });
            }
            if (a === 'toggle') {
              if (d.active && !(await confirm('Turn off driver?', `${d.name}'s link will stop working until you turn them back on.`, 'Turn off'))) return;
              return guard(async () => { await api(`/api/admin/drivers/${d.id}`, { method: 'PATCH', body: { active: !d.active } }); await load(); });
            }
          };
        });
      });
    }
    $('#add').onclick = () => driverSheet(null, load);
    await load();
  }

  function shareLink(d) {
    const link = `${location.origin}/d/${d.token}`;
    const msg = `Hola ${d.name}, este es tu enlace para las rutas de ${S.settings.company_name}. Ábrelo en tu teléfono y agrégalo a la pantalla de inicio: ${link}`;
    const phone = String(d.phone || '').replace(/[^\d]/g, '');
    const wa = phone ? `https://wa.me/${phone.length === 10 ? '1' + phone : phone}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`;
    const s = sheet(`${d.name}'s link`, `<div class="link-box" style="margin-bottom:12px">${esc(link)}</div>
      <div class="list"><a class="btn btn-green" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>
      <a class="btn" href="sms:${phone}?&body=${encodeURIComponent(msg)}">Text message</a>
      <button id="cp">${icon('copy', 18)} Copy link</button>
      <a class="btn btn-ghost" href="${link}" target="_blank" rel="noopener">Open driver page</a></div>`);
    $('#cp', s.el).onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast('Copy failed', true); } };
  }

  function driverSheet(d, after) {
    const s = sheet(d ? 'Edit driver' : 'New driver', `<form id="df">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(d ? d.name : '')}" maxlength="80" required></label>
      <label class="field"><span>Mobile (for sending the link)</span><input type="tel" name="phone" value="${esc(d ? d.phone : '')}" maxlength="40"></label>
      <button class="btn-primary btn-block" type="submit">Save</button></form>`);
    $('#df', s.el).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      await busy(f.querySelector('[type=submit]'), () => guard(async () => {
        const body = { name: f.name.value, phone: f.phone.value };
        const r = d ? await api(`/api/admin/drivers/${d.id}`, { method: 'PATCH', body }) : await api('/api/admin/drivers', { method: 'POST', body });
        s.close(); await after();
        if (!d) shareLink(r.driver); else toast('Saved');
      }));
    };
  }

  // ---------------- Settings ----------------
  async function settingsView(main) {
    S.settings = await api('/api/admin/settings');
    const st = S.settings;
    main.innerHTML = `
      <div class="section-title" style="margin-top:4px"><h2>Settings</h2></div>
      <form class="card" id="sf">
        <h3 style="margin-bottom:12px">Routes</h3>
        <label class="field"><span>Company name</span><input type="text" name="company_name" value="${esc(st.company_name)}" maxlength="80"></label>
        <label class="field"><span>Start address (where drivers leave from)</span><input type="text" name="depot_address" value="${esc(st.depot_address)}" maxlength="300" placeholder="Street, town, state ZIP">
          <div class="hint">${st.depot_lat != null ? 'Found as: ' + esc(st.depot_label) : 'Not set yet.'}</div></label>
        <div class="grid2">
          <label class="field"><span>Usual start time</span><input type="time" name="default_start_time" value="${esc(st.default_start_time)}"></label>
          <label class="field"><span>Minutes at each stop</span><input type="number" name="service_minutes" min="0" max="240" value="${st.service_minutes}"></label>
        </div>
        <label class="check"><input type="checkbox" name="return_to_depot" ${st.return_to_depot ? 'checked' : ''}><span>New routes return to the start at the end</span></label>
        <label class="check"><input type="checkbox" name="photo_required" ${st.photo_required ? 'checked' : ''}><span>Driver must take a photo to mark a stop delivered</span></label>
        <label class="field"><span>Time zone</span><select name="timezone">${['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'].map((z) => `<option ${z === st.timezone ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
        <button class="btn-primary btn-block" type="submit">Save</button>
      </form>
      <form class="card" id="mf">
        <h3>Mapbox (real roads &amp; drive times)</h3>
        <p class="small muted">Free for your volume. Create a free account at mapbox.com, copy the token that starts with <b>pk.</b>, and paste it here.</p>
        <div class="banner ${st.mapbox_token_set ? 'ok' : ''}">${st.mapbox_token_set ? `${icon('check')} Saved (${esc(st.mapbox_token_hint)})` : 'Not set — routes use straight-line estimates.'}</div>
        <label class="field"><span>${st.mapbox_token_set ? 'Replace token' : 'Mapbox token'}</span><input type="text" name="token" placeholder="pk.…" autocomplete="off" spellcheck="false"></label>
        <div class="row"><button class="btn-primary grow" type="submit">Save token</button>${st.mapbox_token_set ? '<button type="button" id="mt">Test</button>' : ''}</div>
      </form>
      <div class="card">
        <h3>Office alerts</h3>
        <p class="small muted">Get a phone or computer alert when a stop is delivered or not delivered. Turn it on for each device you use.</p>
        <div class="row"><button class="btn-primary grow" id="pon">${icon('bell', 18)} Turn on alerts on this device</button><button id="ptest">Test</button></div>
        <div class="small muted" id="pstate" style="margin-top:8px"></div>
      </div>
      <form class="card" id="pf">
        <h3 style="margin-bottom:12px">Change office PIN</h3>
        <label class="field"><span>New PIN (4–10 digits)</span><input type="password" inputmode="numeric" pattern="[0-9]*" name="pin" minlength="4" maxlength="10" required autocomplete="new-password"></label>
        <label class="field"><span>Repeat new PIN</span><input type="password" inputmode="numeric" pattern="[0-9]*" name="pin2" minlength="4" maxlength="10" required autocomplete="new-password"></label>
        <p class="small muted">Other devices will be signed out.</p>
        <button class="btn-block" type="submit">Change PIN</button>
      </form>
      <div class="card"><button class="btn-block btn-ghost" id="lo">${icon('logout', 18)} Sign out</button></div>`;

    $('#sf').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      await busy(f.querySelector('[type=submit]'), () => guard(async () => {
        const body = {
          company_name: f.company_name.value, default_start_time: f.default_start_time.value, service_minutes: f.service_minutes.value,
          return_to_depot: f.return_to_depot.checked, photo_required: f.photo_required.checked, timezone: f.timezone.value,
        };
        if (f.depot_address.value.trim() !== st.depot_address) body.depot_address = f.depot_address.value;
        await api('/api/admin/settings', { method: 'PUT', body });
        toast('Saved');
        await settingsView(main);
        $('.topbar .brand').innerHTML = `<span class="dot"></span>${esc(S.settings.company_name)} Routes`;
      }));
    };
    $('#mf').onsubmit = async (e) => {
      e.preventDefault();
      const v = e.target.token.value.trim();
      if (!v) return toast('Paste the token first', true);
      await busy(e.target.querySelector('[type=submit]'), () => guard(async () => {
        await api('/api/admin/settings', { method: 'PUT', body: { mapbox_token: v } });
        const r = await api('/api/admin/settings/test-mapbox', { method: 'POST', body: {} });
        toast(r.ok ? 'Mapbox key saved and working' : r.error, !r.ok);
        await settingsView(main);
      }));
    };
    if ($('#mt')) $('#mt').onclick = (e) => busy(e.currentTarget, () => guard(async () => {
      const r = await api('/api/admin/settings/test-mapbox', { method: 'POST', body: {} });
      toast(r.ok ? 'Mapbox is working' : r.error, !r.ok);
    }));
    const showPush = async () => {
      const s = await C.pushState();
      $('#pstate').textContent = { on: 'Alerts are on for this device.', off: 'Alerts are off on this device.', denied: 'Alerts are blocked in this browser’s settings.', unsupported: 'This browser can’t show alerts. On iPhone, add this page to the home screen first, then open it from there.' }[s];
      $('#pon').classList.toggle('hidden', s === 'on' || s === 'unsupported');
    };
    showPush();
    $('#pon').onclick = (e) => busy(e.currentTarget, async () => {
      try { await C.subscribePush('/api/admin/push/subscribe'); toast('Alerts turned on'); }
      catch (err) { toast(err.message === 'denied' ? 'Alerts were blocked. Allow notifications for this site.' : err.message === 'unsupported' ? 'This browser can’t show alerts' : err.message, true); }
      showPush();
    });
    $('#ptest').onclick = (e) => busy(e.currentTarget, () => guard(async () => {
      const r = await api('/api/admin/push/test', { method: 'POST', body: {} });
      toast(r.devices ? `Test sent to ${r.devices} device${r.devices === 1 ? '' : 's'}` : 'No devices have alerts on yet', !r.devices);
    }));
    $('#pf').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.pin.value !== f.pin2.value) return toast('The PINs do not match', true);
      await busy(f.querySelector('[type=submit]'), () => guard(async () => {
        await api('/api/admin/settings', { method: 'PUT', body: { new_pin: f.pin.value } });
        f.reset(); toast('PIN changed');
      }));
    };
    $('#lo').onclick = async () => { await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {}); boot(); };
  }

  boot();
})();
