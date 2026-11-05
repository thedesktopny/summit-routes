// Web Push (VAPID + aes128gcm, RFC 8291 / 8292) using only WebCrypto.
import { b64url, b64urlDecode, getSetting, setSetting } from './lib.js';

const enc = new TextEncoder();

export async function getVapid(env) {
  let pub = await getSetting(env, 'vapid_public');
  let priv = await getSetting(env, 'vapid_private_jwk');
  if (!pub || !priv) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    pub = b64url(await crypto.subtle.exportKey('raw', kp.publicKey));
    priv = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey));
    await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?), (?, ?)')
      .bind('vapid_public', pub, 'vapid_private_jwk', priv).run();
    pub = await getSetting(env, 'vapid_public');
    priv = await getSetting(env, 'vapid_private_jwk');
  }
  return { publicKey: pub, privateJwk: JSON.parse(priv) };
}

async function hmacRaw(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}
function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

export async function encryptPayload(p256dhB64, authB64, payloadStr) {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const prkKey = await hmacRaw(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1]));
  const ikm = await hmacRaw(prkKey, keyInfo);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacRaw(salt, ikm);
  const cek = (await hmacRaw(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmacRaw(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const plaintext = concat(enc.encode(payloadStr), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

async function vapidJwt(vapid, audience, subject) {
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

// Sends one notification. Returns the HTTP status from the push service.
export async function sendPush(env, sub, payload, subject) {
  const vapid = await getVapid(env);
  const url = new URL(sub.endpoint);
  const jwt = await vapidJwt(vapid, url.origin, subject);
  const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
      urgency: 'high',
      authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body,
  });
  return res.status;
}

// Send to every subscription matching kind (and driver), cleaning up dead ones.
export async function notify(env, { kind, driverId = null, payload, subject }) {
  const q = kind === 'driver'
    ? env.DB.prepare('SELECT * FROM push_subs WHERE kind = ? AND driver_id = ?').bind('driver', driverId)
    : env.DB.prepare('SELECT * FROM push_subs WHERE kind = ?').bind('admin');
  const { results } = await q.all();
  await Promise.all(results.map(async (sub) => {
    try {
      const status = await sendPush(env, sub, payload, subject);
      if (status === 404 || status === 410) {
        await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(sub.id).run();
      } else if (status >= 400) {
        await env.DB.prepare('UPDATE push_subs SET fail_count = fail_count + 1 WHERE id = ?').bind(sub.id).run();
        await env.DB.prepare('DELETE FROM push_subs WHERE id = ? AND fail_count >= 5').bind(sub.id).run();
      } else {
        await env.DB.prepare('UPDATE push_subs SET fail_count = 0 WHERE id = ?').bind(sub.id).run();
      }
    } catch (e) {
      console.log('push error', e && e.message);
    }
  }));
}

export async function saveSubscription(env, { kind, driverId = null, sub }) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return false;
  }
  await env.DB.prepare(`INSERT INTO push_subs (kind, driver_id, endpoint, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET kind = excluded.kind, driver_id = excluded.driver_id,
      p256dh = excluded.p256dh, auth = excluded.auth, fail_count = 0`)
    .bind(kind, driverId, sub.endpoint.slice(0, 1000), String(sub.keys.p256dh).slice(0, 200), String(sub.keys.auth).slice(0, 100), Date.now()).run();
  return true;
}

export { setSetting };
