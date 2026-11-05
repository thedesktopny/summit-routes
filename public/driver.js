/* Summit Safety Routes — página del chofer (español) */
(function () {
  const { esc, $, $$, toast, sheet, confirm, busy, icon } = C;
  C.messages = { network: 'Sin conexión. Se enviará cuando vuelva la señal.', server: 'Algo salió mal. Intenta de nuevo.' };

  const TOKEN = (location.pathname.match(/^\/d\/([A-Za-z0-9]{16,40})/) || [])[1];
  const API = `/api/d/${TOKEN}`;
  const S = { data: null, gpsOn: false, watchId: null, lastSent: null, wakeLock: null, expanded: new Set(), showDone: false, installEvt: null };

  // Per-driver install manifest
  const ml = document.createElement('link');
  ml.rel = 'manifest'; ml.href = `/d/${TOKEN}/manifest.webmanifest`;
  document.head.appendChild(ml);

  $('#mapbtn').innerHTML = icon('map');
  $('#refresh').innerHTML = icon('refresh');
  $('#refresh').onclick = (e) => busy(e.currentTarget, async () => { await flush(); await load(true); });
  $('#mapbtn').onclick = () => showMap();

  const tz = () => (S.data ? S.data.timezone : 'America/New_York');
  const hora = (ms) => C.fmtTime(ms, tz(), 'es-MX');
  const STATUS = { pending: 'Pendiente', arrived: 'En el lugar', done: 'Entregado', failed: 'No entregado' };
  const REASONS = ['Cerrado', 'No había nadie', 'El cliente no lo aceptó', 'Dirección incorrecta', 'No me dio tiempo', 'Otro'];

  // ---------------- outbox (works without signal) ----------------
  let dbp;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(`summit-outbox-${TOKEN}`, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('q', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function qAll() {
    const d = await db();
    return new Promise((res, rej) => { const r = d.transaction('q').objectStore('q').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function qAdd(item) {
    const d = await db();
    return new Promise((res, rej) => { const r = d.transaction('q', 'readwrite').objectStore('q').add(item); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function qDel(id) {
    const d = await db();
    return new Promise((res, rej) => { const r = d.transaction('q', 'readwrite').objectStore('q').delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
  }

  let outbox = [];
  const blobUrls = new Map();
  let flushing = null;
  async function refreshOutbox() { try { outbox = await qAll(); } catch { outbox = []; } }

  async function enqueue(item) {
    item.at = Date.now();
    await qAdd(item);
    await refreshOutbox();
    render();
    flush();
  }

  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      await refreshOutbox();
      for (const item of outbox) {
        try {
          const body = item.blob ? item.blob : (item.body ? { ...item.body, at: item.at } : undefined);
          await C.api(API + item.path, { method: item.method || 'POST', body });
          await qDel(item.id);
        } catch (e) {
          if (e.network || e.status >= 500 || e.status === 429) break; // try later
          await qDel(item.id); // the server refused it: drop it so the queue keeps moving
          toast(e.message, true);
        }
      }
      await refreshOutbox();
      flushing = null;
      render();
      if (!outbox.length) load();
    })();
    return flushing;
  }
  setInterval(() => { if (outbox.length && !document.hidden) flush(); }, 15000);
  window.addEventListener('online', () => flush());

  // ---------------- data ----------------
  async function load(showErrors = false) {
    try {
      S.data = await C.api(`${API}/today`);
      $('#hdr').textContent = S.data.company;
      render();
    } catch (e) {
      if (e.status === 401) {
        $('#main').innerHTML = `<div class="card empty"><h2>Este enlace ya no es válido</h2><p>Pide a la oficina un enlace nuevo.</p></div>`;
        stopGps();
        return;
      }
      if (!S.data) $('#main').innerHTML = `<div class="card empty"><p>${esc(e.message === C.messages.network ? 'Sin conexión.' : e.message)}</p><button class="btn-primary" id="rt">Intentar de nuevo</button></div>`;
      if ($('#rt')) $('#rt').onclick = () => load(true);
      else if (showErrors) toast(e.network ? 'Sin conexión' : e.message, true);
    }
  }

  // Apply queued actions on top of server data so the screen reflects them.
  function localStops(route) {
    return route.stops.map((s) => {
      const st = { ...s, photos: s.photos.slice(), pendingPhotos: [] };
      for (const it of outbox) {
        if (it.stopId !== s.id) continue;
        if (it.kind === 'arrive' && st.status === 'pending') { st.status = 'arrived'; st.arrived_at = it.at; }
        if (it.kind === 'complete') { st.status = 'done'; st.done_at = it.at; st.received_by = it.body.received_by; }
        if (it.kind === 'fail') { st.status = 'failed'; st.done_at = it.at; st.fail_reason = it.body.reason; }
        if (it.kind === 'undo') { st.status = 'pending'; st.done_at = null; }
        if (it.kind === 'photo') {
          if (!blobUrls.has(it.id)) blobUrls.set(it.id, URL.createObjectURL(it.blob));
          st.pendingPhotos.push({ qid: it.id, url: blobUrls.get(it.id) });
        }
      }
      return st;
    });
  }

  // ---------------- GPS ----------------
  function activeRoute() { return S.data && S.data.routes.find((r) => r.status === 'active'); }

  function startGps() {
    if (!('geolocation' in navigator) || S.watchId != null) return;
    S.watchId = navigator.geolocation.watchPosition(onPos, (err) => {
      S.gpsOn = false;
      if (err.code === 1) { stopGps(); S.gpsDenied = true; }
      render();
    }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
    keepAwake();
  }
  function stopGps() {
    if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
    S.watchId = null; S.gpsOn = false;
  }
  function onPos(p) {
    const wasOn = S.gpsOn;
    S.gpsOn = true; S.gpsDenied = false;
    const c = p.coords;
    const now = Date.now();
    const last = S.lastSent;
    const moved = last ? C_dist(last, c) : Infinity;
    if (!last || moved > 40 || now - last.t > 90000) {
      S.lastSent = { latitude: c.latitude, longitude: c.longitude, t: now };
      const r = activeRoute();
      C.api(`${API}/position`, { method: 'POST', body: { lat: c.latitude, lng: c.longitude, acc: c.accuracy, speed: c.speed, heading: c.heading, route_id: r ? r.id : null } }).catch(() => {});
    }
    if (!wasOn) render();
  }
  function C_dist(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.latitude - a.latitude) * toR, dLng = (b.longitude - a.longitude) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * toR) * Math.cos(b.latitude * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !S.wakeLock && !document.hidden) { S.wakeLock = await navigator.wakeLock.request('screen'); S.wakeLock.addEventListener('release', () => { S.wakeLock = null; }); } } catch { /* ignore */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (activeRoute()) { startGps(); keepAwake(); }
    flush().then(() => load());
  });

  // ---------------- render ----------------
  function render() {
    const main = $('#main');
    const d = S.data;
    if (!d) return;
    const routes = d.routes;
    let html = `<div class="row" style="margin:2px 2px 12px"><div class="grow"><div class="muted small">${esc(C.fmtDate(d.today, 'es-MX', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
      <h2>Hola, ${esc(d.driver.name)}</h2></div><button class="btn-sm" id="bell">${icon('bell', 16)} Avisos</button></div>`;

    if (outbox.length) html += `<div class="banner">${icon('refresh')}<div class="grow">${outbox.length} ${outbox.length === 1 ? 'cambio pendiente' : 'cambios pendientes'} de enviar. Se enviarán cuando haya señal.</div><button class="btn-sm" id="retry">Enviar</button></div>`;

    const ar = activeRoute();
    if (ar) {
      if (S.gpsDenied) html += `<div class="banner">${icon('pin')}<div class="grow">La ubicación está bloqueada. Actívala para esta página en los ajustes del teléfono.</div></div>`;
      else if (!S.gpsOn) html += `<div class="banner">${icon('pin')}<div class="grow">Ubicación apagada.</div><button class="btn-sm" id="gps">Activar</button></div>`;
      else html += `<div class="banner ok">${icon('pin')}<div class="grow small">Compartiendo tu ubicación mientras esta página está abierta.</div></div>`;
    }

    if (S.installEvt) html += `<div class="banner info"><div class="grow">Instala la app en tu teléfono para abrirla más rápido.</div><button class="btn-sm btn-primary" id="inst">Instalar</button></div>`;
    else if (isIos() && !isStandalone()) html += `<div class="banner info small"><div class="grow">Para recibir avisos en iPhone: toca <b>Compartir</b> y luego <b>Agregar a inicio</b>, y abre la app desde ahí.</div></div>`;

    if (!routes.length) {
      html += `<div class="card empty"><h3>No tienes ruta para hoy</h3>${d.upcoming.length ? `<p>Próximas rutas:</p>${d.upcoming.map((u) => `<div>${esc(C.fmtDate(u.date, 'es-MX', { weekday: 'long', day: 'numeric', month: 'long' }))} · ${u.stops} paradas</div>`).join('')}` : '<p class="muted">Cuando la oficina te asigne una ruta aparecerá aquí.</p>'}</div>`;
    }

    routes.forEach((r) => {
      const stops = localStops(r);
      const done = stops.filter((s) => s.status === 'done').length;
      const failed = stops.filter((s) => s.status === 'failed').length;
      const open = stops.filter((s) => s.status === 'pending' || s.status === 'arrived');
      const closed = stops.filter((s) => s.status === 'done' || s.status === 'failed');
      const next = open[0];
      html += `<div class="card" style="margin-bottom:10px"><div class="row"><h3 class="grow">${r.name ? esc(r.name) : 'Ruta de hoy'}${r.date !== d.today ? ` · ${esc(C.fmtDate(r.date, 'es-MX'))}` : ''}</h3>
          <span class="small muted">${done + failed}/${stops.length} listas</span></div>
        <div class="progress" style="margin-top:8px"><div class="p-done" style="width:${stops.length ? done / stops.length * 100 : 0}%"></div><div class="p-failed" style="width:${stops.length ? failed / stops.length * 100 : 0}%"></div></div>
        ${r.status === 'planned' ? `<p class="small muted" style="margin:10px 0 0">${stops.length} paradas · salida ${esc(r.start_time)}${r.duration_s ? ` · aprox. ${C.fmtDuration(r.duration_s)}` : ''}</p>
          <button class="btn-orange btn-block btn-lg" style="margin-top:12px" data-start="${r.id}">Comenzar ruta</button>` : ''}
        ${!open.length && stops.length ? `<div class="banner ok" style="margin:12px 0 0">${icon('check')} ¡Ruta terminada! Gracias.</div>` : ''}
      </div>`;
      if (next) html += stopCard(next, true);
      if (open.length > 1) {
        html += `<div class="section-title"><h3>Siguientes paradas (${open.length - 1})</h3></div><div class="list">`;
        open.slice(1).forEach((s) => { html += S.expanded.has(s.id) ? stopCard(s, false) : stopRow(s, stops.indexOf(s) + 1); });
        html += '</div>';
      }
      if (closed.length) {
        html += `<div class="section-title"><h3 class="grow">Completadas (${closed.length})</h3><button class="btn-sm btn-ghost" data-toggle-done>${S.showDone ? 'Ocultar' : 'Ver'}</button></div>`;
        if (S.showDone) html += `<div class="list">${closed.map((s) => doneRow(s, stops.indexOf(s) + 1)).join('')}</div>`;
      }
    });
    if (routes.length && d.upcoming.length) html += `<p class="small muted" style="margin-top:16px">Próximas: ${d.upcoming.map((u) => `${esc(C.fmtDate(u.date, 'es-MX'))} (${u.stops})`).join(', ')}</p>`;
    main.innerHTML = html;
    wire();
  }

  function stopCard(s, isNext) {
    const n = stopNumber(s);
    const photos = [...s.photos.map((p) => ({ ...p })), ...s.pendingPhotos];
    return `<div class="card ${isNext ? 'next-card' : ''}" data-stop="${s.id}" style="margin-bottom:10px">
      <div class="row"><div class="label grow">${isNext ? 'Siguiente parada' : 'Parada'} · #${n}</div>
        ${s.eta && s.status !== 'arrived' ? `<span class="small muted">llegada aprox. ${hora(s.eta)}</span>` : ''}${s.status === 'arrived' ? '<span class="chip arrived">En el lugar</span>' : ''}
        ${!isNext ? `<button class="icon" data-collapse="${s.id}" aria-label="Cerrar">${icon('up', 18)}</button>` : ''}</div>
      <div class="name">${esc(s.name)}</div>
      <div class="addr">${esc(s.address)}</div>
      ${s.notes ? `<div class="notes-box">${icon('note', 16)} ${esc(s.notes)}</div>` : ''}
      <div class="actions-2">
        <a class="btn btn-primary" href="${C.navUrl(s)}" target="_blank" rel="noopener">${icon('nav', 18)} Google Maps</a>
        <a class="btn" href="${C.wazeUrl(s)}" target="_blank" rel="noopener">Waze</a>
        ${s.phone ? `<a class="btn" href="${C.telHref(s.phone)}">${icon('phone', 18)} Llamar</a>` : ''}
        ${s.status === 'pending' ? `<button data-arrive="${s.id}">${icon('pin', 18)} Llegué</button>` : ''}
      </div>
      ${photos.length ? `<div class="thumbs">${photos.map((p) => `<div class="th"><img src="${p.url}" alt="Foto">${p.qid ? '<span class="pending-dot">por enviar</span>' : ''}</div>`).join('')}</div>` : ''}
      <button class="btn-green btn-block btn-lg" style="margin-top:12px" data-deliver="${s.id}">${icon('check', 20)} Entregado</button>
      <button class="btn-block btn-danger-ghost" style="margin-top:6px" data-fail="${s.id}">No se pudo entregar</button>
    </div>`;
  }
  function stopRow(s, n) {
    return `<div class="card stop stop-row" data-expand="${s.id}"><div class="num">${n}</div><div class="body">
      <div class="name">${esc(s.name)}</div><div class="addr">${esc(s.address)}</div>
      ${s.eta ? `<div class="small muted" style="margin-top:2px">aprox. ${hora(s.eta)}</div>` : ''}</div></div>`;
  }
  function doneRow(s, n) {
    return `<div class="card stop"><div class="num ${s.status}">${n}</div><div class="body">
      <div class="name">${esc(s.name)}</div><div class="addr">${esc(s.address)}</div>
      <div class="meta"><span class="chip ${s.status}">${STATUS[s.status]}</span><span class="small muted">${hora(s.done_at)}</span>${s.fail_reason ? `<span class="small">${esc(s.fail_reason)}</span>` : ''}</div></div>
      <button class="btn-sm btn-ghost" data-undo="${s.id}">${icon('undo', 16)} Deshacer</button></div>`;
  }
  function stopNumber(s) {
    for (const r of S.data.routes) { const i = r.stops.findIndex((x) => x.id === s.id); if (i >= 0) return i + 1; }
    return '';
  }
  function findStop(id) {
    for (const r of S.data.routes) { const s = localStops(r).find((x) => x.id === id); if (s) return { stop: s, route: r }; }
    return {};
  }

  function wire() {
    const m = $('#main');
    if ($('#retry')) $('#retry').onclick = (e) => busy(e.currentTarget, () => flush());
    if ($('#gps')) $('#gps').onclick = () => startGps();
    if ($('#inst')) $('#inst').onclick = async () => { const ev = S.installEvt; S.installEvt = null; ev.prompt(); render(); };
    $('#bell').onclick = () => alertsSheet();
    $$('[data-start]', m).forEach((b) => b.onclick = () => busy(b, async () => {
      try {
        await C.api(`${API}/routes/${b.dataset.start}/start`, { method: 'POST', body: {} });
        startGps();
        await load();
        toast('¡Buen viaje!');
        if (C.pushSupported() && Notification.permission === 'default') alertsSheet();
      } catch (e) { toast(e.message, true); }
    }));
    $$('[data-expand]', m).forEach((el) => el.onclick = () => { S.expanded.add(Number(el.dataset.expand)); render(); });
    $$('[data-collapse]', m).forEach((el) => el.onclick = () => { S.expanded.delete(Number(el.dataset.collapse)); render(); });
    $$('[data-toggle-done]', m).forEach((el) => el.onclick = () => { S.showDone = !S.showDone; render(); });
    $$('[data-arrive]', m).forEach((b) => b.onclick = () => {
      const id = Number(b.dataset.arrive);
      ensureStarted(id);
      enqueue({ kind: 'arrive', stopId: id, path: `/stops/${id}/arrive`, body: {} });
    });
    $$('[data-deliver]', m).forEach((b) => b.onclick = () => deliverSheet(Number(b.dataset.deliver)));
    $$('[data-fail]', m).forEach((b) => b.onclick = () => failSheet(Number(b.dataset.fail)));
    $$('[data-undo]', m).forEach((b) => b.onclick = async () => {
      if (!(await confirm('¿Deshacer?', 'La parada volverá a pendientes.', 'Deshacer', false, 'Cancelar'))) return;
      const id = Number(b.dataset.undo);
      enqueue({ kind: 'undo', stopId: id, path: `/stops/${id}/undo`, body: {} });
    });
  }

  function ensureStarted(stopId) {
    const { route } = findStop(stopId);
    if (route && route.status === 'planned') { route.status = 'active'; startGps(); }
  }

  // Photo picker used by both sheets
  function photoPicker(container, stopId, onChange) {
    const draw = () => {
      const { stop } = findStop(stopId);
      const photos = [...stop.photos, ...stop.pendingPhotos];
      container.innerHTML = `<div class="thumbs">${photos.map((p) => `<div class="th"><img src="${p.url}" alt="Foto">${p.qid ? '<span class="pending-dot">por enviar</span>' : ''}
          <button type="button" class="del" data-del="${p.qid ? 'q' + p.qid : p.id}" aria-label="Borrar">×</button></div>`).join('')}
        <label class="btn photo-add" aria-label="Tomar foto">${icon('camera', 26)}<input type="file" accept="image/*" capture="environment" hidden></label></div>`;
      container.querySelector('input[type=file]').onchange = async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          const blob = await C.compressImage(f);
          ensureStarted(stopId);
          await enqueue({ kind: 'photo', stopId, path: `/stops/${stopId}/photo`, blob });
        } catch { toast('No se pudo leer la foto', true); }
        draw(); onChange();
      };
      container.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
        const v = b.dataset.del;
        if (v.startsWith('q')) { await qDel(Number(v.slice(1))); await refreshOutbox(); }
        else {
          try { await C.api(`${API}/photos/${v}`, { method: 'DELETE' }); S.data.routes.forEach((r) => r.stops.forEach((s) => { s.photos = s.photos.filter((p) => p.id !== v); })); }
          catch (e) { toast(e.message, true); }
        }
        draw(); onChange(); render();
      });
    };
    draw();
    return () => { const { stop } = findStop(stopId); return stop.photos.length + stop.pendingPhotos.length; };
  }

  function deliverSheet(stopId) {
    const { stop } = findStop(stopId);
    if (!stop) return;
    const req = S.data.photo_required;
    const s = sheet(`Entregar · ${stop.name}`, `<form id="dv">
      <div class="small muted" style="margin-bottom:6px">Foto de la entrega${req ? ' (obligatoria)' : ''}</div>
      <div id="pp"></div>
      <label class="field" style="margin-top:12px"><span>¿Quién recibió? (opcional)</span><input type="text" name="received_by" maxlength="120" autocomplete="off"></label>
      <label class="field"><span>Nota (opcional)</span><textarea name="note" maxlength="1000"></textarea></label>
      <button class="btn-green btn-block btn-lg" type="submit" id="ok">${icon('check', 20)} Confirmar entrega</button></form>`);
    const f = $('#dv', s.el);
    const okBtn = $('#ok', s.el);
    let count;
    const upd = () => { okBtn.disabled = req && count() === 0; };
    count = photoPicker($('#pp', s.el), stopId, upd);
    upd();
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (req && count() === 0) return toast('Toma al menos una foto', true);
      ensureStarted(stopId);
      grabPosition();
      s.close();
      S.expanded.delete(stopId);
      await enqueue({ kind: 'complete', stopId, path: `/stops/${stopId}/complete`, body: { received_by: f.received_by.value, note: f.note.value } });
      toast('¡Entregado!');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }

  function failSheet(stopId) {
    const { stop } = findStop(stopId);
    if (!stop) return;
    const s = sheet(`No se pudo · ${stop.name}`, `<form id="fl">
      ${REASONS.map((r, i) => `<label class="reason"><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? '' : ''} required>${esc(r)}</label>`).join('')}
      <label class="field" style="margin-top:8px"><span>Nota</span><textarea name="note" maxlength="1000" placeholder="¿Qué pasó?"></textarea></label>
      <div class="small muted" style="margin-bottom:6px">Foto (opcional)</div><div id="pp"></div>
      <button class="btn-red btn-block btn-lg" type="submit" style="margin-top:12px">Confirmar</button></form>`);
    photoPicker($('#pp', s.el), stopId, () => {});
    $('#fl', s.el).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const reason = f.reason.value;
      if (!reason) return toast('Elige el motivo', true);
      if (reason === 'Otro' && !f.note.value.trim()) return toast('Escribe qué pasó', true);
      ensureStarted(stopId);
      grabPosition();
      s.close();
      S.expanded.delete(stopId);
      await enqueue({ kind: 'fail', stopId, path: `/stops/${stopId}/fail`, body: { reason, note: f.note.value } });
      toast('Guardado');
    };
  }

  function grabPosition() {
    if (!('geolocation' in navigator) || S.gpsDenied) return;
    navigator.geolocation.getCurrentPosition((p) => { S.lastSent = null; onPos(p); }, () => {}, { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 });
  }

  // ---------------- alerts ----------------
  async function alertsSheet() {
    const st = await C.pushState();
    const msg = {
      on: 'Los avisos están activados en este teléfono.',
      off: 'Activa los avisos para saber cuando la oficina te manda o cambia una ruta.',
      denied: 'Los avisos están bloqueados. Actívalos en los ajustes del navegador para esta página.',
      unsupported: isIos() ? 'En iPhone primero toca Compartir → Agregar a inicio, y abre la app desde la pantalla de inicio.' : 'Este navegador no puede mostrar avisos.',
    }[st];
    const s = sheet('Avisos', `<p>${esc(msg)}</p>${st === 'off' ? `<button class="btn-primary btn-block btn-lg" id="on">${icon('bell', 18)} Activar avisos</button>` : ''}`);
    if ($('#on', s.el)) $('#on', s.el).onclick = (e) => busy(e.currentTarget, async () => {
      try { await C.subscribePush(`${API}/push/subscribe`); toast('Avisos activados'); s.close(); }
      catch (err) { toast(err.message === 'denied' ? 'Los avisos fueron bloqueados' : err.message === 'unsupported' ? 'Este navegador no puede mostrar avisos' : err.message, true); }
    });
  }

  // ---------------- map ----------------
  function showMap() {
    if (!S.data) return;
    const s = sheet('Mapa', '<div id="drvmap"></div>');
    const map = L.map($('#drvmap', s.el));
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    const pts = [];
    S.data.routes.forEach((r) => localStops(r).forEach((x, i) => {
      if (x.lat == null) return;
      const cls = x.status === 'done' ? 'done' : x.status === 'failed' ? 'failed' : '';
      L.marker([x.lat, x.lng], { icon: L.divIcon({ className: '', html: `<div class="pin ${cls}"><span>${i + 1}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }) })
        .bindPopup(`<b>${esc(x.name)}</b><br>${esc(x.address)}<br><a href="${C.navUrl(x)}" target="_blank" rel="noopener">Navegar</a>`).addTo(map);
      pts.push([x.lat, x.lng]);
    }));
    if (S.lastSent) {
      L.marker([S.lastSent.latitude, S.lastSent.longitude], { icon: L.divIcon({ className: '', html: `<div class="truck-pin">${C.truckSvg}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }) }).addTo(map);
      pts.push([S.lastSent.latitude, S.lastSent.longitude]);
    }
    setTimeout(() => { map.invalidateSize(); if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 }); else if (S.data.depot) map.setView([S.data.depot.lat, S.data.depot.lng], 12); else map.setView([41.11, -74.04], 10); }, 60);
  }

  // ---------------- install ----------------
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; render(); });

  // ---------------- start ----------------
  (async () => {
    C.registerSW();
    await refreshOutbox();
    if (outbox.length) { await flush(); }
    await load(true);
    if (activeRoute()) startGps();
    setInterval(() => { if (!document.hidden && !$$('.sheet-backdrop').length) load(); }, 60000);
  })();
})();
