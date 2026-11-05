// Shared browser helpers for the admin and driver pages.
(function () {
  const C = {};

  C.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  C.$ = (sel, root = document) => root.querySelector(sel);
  C.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  C.messages = { network: 'No connection. Try again.', server: 'Something went wrong. Try again.' };

  C.api = async function (path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body instanceof Blob) { init.body = opts.body; init.headers['content-type'] = opts.body.type || 'image/jpeg'; }
    else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
    let res;
    try { res = await fetch(path, init); }
    catch (e) { const err = new Error(C.messages.network); err.network = true; throw err; }
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error !== 'Server error') ? data.error : C.messages.server);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  };

  let toastTimer;
  C.toast = function (msg, isErr = false) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = isErr ? 'err' : ''; }, isErr ? 4500 : 2600);
  };

  // Bottom sheet. Returns { el, close }. onClose runs when dismissed.
  C.sheet = function (title, html, { onClose } = {}) {
    const bd = document.createElement('div');
    bd.className = 'sheet-backdrop';
    bd.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="sheet-head"><h2>${C.esc(title)}</h2>
      <button class="icon" data-close aria-label="Close">${C.icon('x')}</button></div><div class="sheet-body">${html}</div></div>`;
    document.body.appendChild(bd);
    document.body.style.overflow = 'hidden';
    const close = () => {
      if (!bd.isConnected) return;
      bd.remove();
      if (!document.querySelector('.sheet-backdrop')) document.body.style.overflow = '';
      onClose && onClose();
    };
    bd.addEventListener('click', (e) => { if (e.target === bd || e.target.closest('[data-close]')) close(); });
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    const first = bd.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea');
    if (first && window.matchMedia('(min-width: 761px)').matches) setTimeout(() => first.focus(), 50);
    return { el: bd.querySelector('.sheet'), close };
  };

  C.confirm = function (title, text, okLabel = 'OK', danger = true, cancelLabel = 'Cancel') {
    return new Promise((resolve) => {
      let done = false;
      const s = C.sheet(title, `<p>${C.esc(text)}</p><div class="sheet-actions">
        <button data-no>${C.esc(cancelLabel)}</button><button class="${danger ? 'btn-red' : 'btn-primary'}" data-yes>${C.esc(okLabel)}</button></div>`,
      { onClose: () => { if (!done) resolve(false); } });
      s.el.querySelector('[data-no]').onclick = () => { done = true; s.close(); resolve(false); };
      s.el.querySelector('[data-yes]').onclick = () => { done = true; s.close(); resolve(true); };
    });
  };

  // Disable a button and show a spinner while an async action runs.
  C.busy = async function (btn, fn) {
    if (btn.disabled) return;
    const html = btn.innerHTML;
    btn.disabled = true;
    const dark = !(/btn-(primary|orange|green|red)/.test(btn.className));
    btn.innerHTML = `<span class="spinner${dark ? ' dark' : ''}"></span>`;
    try { return await fn(); }
    finally { btn.disabled = false; btn.innerHTML = html; }
  };

  C.fmtTime = (ms, tz, locale = 'en-US') => ms ? new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(ms)) : '';
  C.fmtDate = (dateStr, locale = 'en-US', opts = { weekday: 'short', month: 'short', day: 'numeric' }) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  };
  C.fmtDuration = (sec, lang = 'en') => {
    if (sec == null) return '';
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  C.fmtMiles = (m) => (m == null ? '' : `${(m / 1609.34).toFixed(m < 16093 ? 1 : 0)} mi`);
  C.ago = (ms, lang = 'en') => {
    if (!ms) return lang === 'es' ? 'nunca' : 'never';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (lang === 'es') {
      if (s < 60) return 'hace un momento';
      if (s < 3600) return `hace ${Math.round(s / 60)} min`;
      if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
      return `hace ${Math.round(s / 86400)} d`;
    }
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  };
  C.addDays = (dateStr, n) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };
  C.telHref = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
  C.navUrl = (s) => s.lat != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(s.address)}`;
  C.wazeUrl = (s) => s.lat != null
    ? `https://waze.com/ul?ll=${s.lat},${s.lng}&navigate=yes`
    : `https://waze.com/ul?q=${encodeURIComponent(s.address)}&navigate=yes`;

  const ICONS = {
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
    trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
    route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 000-6H9a3 3 0 010-6h6.5"/>',
    map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 7M21.5 20a6.5 6.5 0 00-4-6"/>',
    truck: '<path d="M2 6h11v10H2zM13 9h4l4 4v3h-8z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    wand: '<path d="M4 20L16 8M14 4v3M18 8h3M17 3l1.5 1.5M19.5 11.5L21 13"/>',
    send: '<path d="M3 11l18-8-8 18-2-8-8-2z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
    phone: '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 006 6L16 13l5 2v4a2 2 0 01-2 2A17 17 0 013 5a2 2 0 012-2z"/>',
    nav: '<path d="M3 11l18-8-8 18-2-8-8-2z"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0114 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    bell: '<path d="M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0"/>',
    refresh: '<path d="M20 12a8 8 0 11-2.3-5.7M20 4v5h-5"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
    undo: '<path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3"/>',
    logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
    note: '<path d="M5 3h10l4 4v14H5zM9 11h6M9 15h6"/>',
  };
  C.icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  C.truckSvg = '<svg viewBox="0 0 24 24"><path d="M2 6h11v10H2zM13 9h4l4 4v3h-8z"/></svg>';

  // Resize a photo to max 1600px JPEG.
  C.compressImage = function (file, maxSide = 1600, quality = 0.78) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('photo'))), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('photo')); };
      img.src = url;
    });
  };

  // Push notifications
  C.pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  C.registerSW = async () => {
    if (!('serviceWorker' in navigator)) return null;
    try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { return null; }
  };
  C.subscribePush = async function (subscribePath) {
    if (!C.pushSupported()) throw new Error('unsupported');
    const reg = await C.registerSW();
    if (!reg) throw new Error('unsupported');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('denied');
    const { publicKey } = await C.api('/api/vapid');
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((publicKey.length + 3) % 4)), (c) => c.charCodeAt(0));
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const cur = sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      if (cur && cur.join(',') !== key.join(',')) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await C.api(subscribePath, { method: 'POST', body: { sub: sub.toJSON() } });
    return true;
  };
  C.pushState = async function () {
    if (!C.pushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg && await reg.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  };

  window.C = C;
})();
