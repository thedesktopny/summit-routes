/* Summit Chofer: first screen of the phone app. Remembers the driver's link. */
(function () {
  const KEY = 'summit_driver_token';
  const params = new URLSearchParams(location.search);
  const find = (txt) => { const m = String(txt || '').match(/\/d\/([A-Za-z0-9]{16,40})/) || String(txt || '').trim().match(/^([A-Za-z0-9]{16,40})$/); return m ? m[1] : null; };
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
  if (params.get('change')) { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } saved = null; }
  const fromUrl = find(params.get('t') || '');
  if (fromUrl) saved = fromUrl;
  if (saved) { location.replace('/d/' + saved); return; }

  const f = document.getElementById('f');
  const link = document.getElementById('link');
  const msg = document.getElementById('msg');
  document.getElementById('paste').onclick = async () => {
    try { link.value = await navigator.clipboard.readText(); } catch (e) { msg.textContent = 'Mantén el dedo en la caja y toca “Pegar”.'; link.focus(); }
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const t = find(link.value);
    if (!t) { msg.textContent = 'Ese enlace no se ve bien. Debe tener /d/ y un código.'; return; }
    msg.textContent = 'Revisando…';
    try {
      const r = await fetch('/api/d/' + t + '/today');
      if (r.status === 401) { msg.textContent = 'Ese enlace ya no es válido. Pide uno nuevo a la oficina.'; return; }
    } catch (err) { /* offline: try anyway */ }
    try { localStorage.setItem(KEY, t); } catch (err) { /* ignore */ }
    location.replace('/d/' + t);
  };
})();
