// Summit Safety Routes — Cloudflare Worker entry point.
import { HttpError, json, ensureSchema } from './lib.js';
import { adminApi, adminState, adminSetup, adminLogin, adminLogout, requireAdmin } from './admin.js';
import { driverApi, findDriver } from './driver.js';
import { getVapid } from './push.js';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(self), geolocation=(self)',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tile.openstreetmap.org",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

async function serveAsset(env, url, path, extraHeaders = {}) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
  if (!res.ok) return res;
  return new Response(res.body, { status: 200, headers: { ...HTML_HEADERS, ...extraHeaders } });
}

function notFoundPage(msg) {
  return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enlace no válido</title><body style="font-family:system-ui;padding:32px;text-align:center;color:#333">
<h2>${msg}</h2><p>Pide a la oficina un enlace nuevo.</p></body></html>`, { status: 404, headers: HTML_HEADERS });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      await ensureSchema(env);

      if (path === '/' || path === '/index.html') return Response.redirect(new URL('/admin', url), 302);
      if (path === '/admin' || path === '/admin/') return await serveAsset(env, url, '/admin.html');

      // Driver page and its per-driver install manifest
      let m = path.match(/^\/d\/([A-Za-z0-9]{16,40})\/?$/);
      if (m) {
        const driver = await findDriver(env, m[1]);
        if (!driver) return notFoundPage('Este enlace de chofer no es válido');
        return await serveAsset(env, url, '/driver.html');
      }
      m = path.match(/^\/d\/([A-Za-z0-9]{16,40})\/manifest\.webmanifest$/);
      if (m) {
        const driver = await findDriver(env, m[1]);
        if (!driver) return new Response('Not found', { status: 404 });
        return new Response(JSON.stringify({
          name: 'Summit Safety · Chofer',
          short_name: 'Summit Chofer',
          description: 'Rutas de entrega de Summit Safety',
          lang: 'es',
          start_url: `/d/${m[1]}`,
          scope: `/d/${m[1]}`,
          id: `/d/${m[1]}`,
          display: 'standalone',
          background_color: '#ffffff',
          theme_color: '#0f3d63',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        }), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' } });
      }

      // Proof photos
      m = path.match(/^\/p\/([A-Za-z0-9]{22})\.jpg$/);
      if (m) {
        const obj = await env.FILES.get(`photos/${m[1]}.jpg`);
        if (!obj) return new Response('Not found', { status: 404 });
        return new Response(obj.body, {
          headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' },
        });
      }

      if (path === '/api/vapid') {
        const v = await getVapid(env);
        return json({ publicKey: v.publicKey });
      }

      // Admin sign-in endpoints
      if (path === '/api/admin/state') return await adminState(request, env);
      if (path === '/api/admin/setup' && request.method === 'POST') return await adminSetup(request, env);
      if (path === '/api/admin/login' && request.method === 'POST') return await adminLogin(request, env);
      if (path === '/api/admin/logout' && request.method === 'POST') return await adminLogout(request, env);

      if (path.startsWith('/api/admin/')) {
        await requireAdmin(request, env);
        return await adminApi(request, env, ctx, url);
      }

      m = path.match(/^\/api\/d\/([A-Za-z0-9]{16,40})(\/.*)$/);
      if (m) return await driverApi(request, env, ctx, url, m[1], m[2]);

      if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);

      // Hidden: never serve html templates by their raw names
      if (path.endsWith('.html')) return new Response('Not found', { status: 404 });

      const res = await env.ASSETS.fetch(request);
      if (path === '/sw.js' && res.ok) {
        return new Response(res.body, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'service-worker-allowed': '/' } });
      }
      return res;
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.log('error', e && e.stack);
      return json({ error: 'Server error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    await env.DB.prepare('DELETE FROM positions WHERE at < ?').bind(cutoff).run();
    await env.DB.prepare('DELETE FROM login_attempts WHERE first_at < ?').bind(Date.now() - 24 * 3600 * 1000).run();
  },
};
