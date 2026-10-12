/**
 * Tibia · API protegida (Cloudflare Pages Functions)
 * ---------------------------------------------------------------
 * La tienda y el panel hablan solo con /api. Esta función:
 *  - agrega la clave secreta al llamar a Apps Script (la hoja ya no es pública),
 *  - limita cuántos pedidos y votos puede enviar una misma conexión,
 *  - verifica Cloudflare Turnstile (anti-bots) si está configurado,
 *  - valida el PIN del dueño y firma su sesión para el panel.
 *
 * Variables de entorno (Cloudflare → proyecto tibia → Configuración → Variables y secretos):
 *  APPS_SCRIPT_URL    URL /exec del Apps Script (si falta, se usa la de abajo)
 *  APPS_SCRIPT_KEY    clave que genera «generarClave» en Apps Script        (secreto)
 *  ADMIN_PIN          PIN del dueño para entrar al panel                    (secreto)
 *  TURNSTILE_SITEKEY  clave pública del widget Turnstile                    (opcional)
 *  TURNSTILE_SECRET   clave secreta del widget Turnstile                    (opcional, secreto)
 */
const DEFAULT_SCRIPT = 'https://script.google.com/macros/s/AKfycbwiO3HNwTNb-4ZnLCfWOn8zxnyqtr6Zw4OB3pGLNzNqADAJJNl2wkDcFYe0MIHcw-s/exec';
const SESSION_DAYS = 30;
const LIMITS = { pedido: [6, 600], voto: [10, 600], login: [6, 900] }; // [máximo, segundos]

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

function scriptUrl(env, params) {
  const u = new URL(env.APPS_SCRIPT_URL || DEFAULT_SCRIPT);
  if (env.APPS_SCRIPT_KEY) u.searchParams.set('key', env.APPS_SCRIPT_KEY);
  Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}
async function callScript(env, method, body, params) {
  const r = await fetch(scriptUrl(env, params), method === 'GET' ? { redirect: 'follow' } : {
    method: 'POST', redirect: 'follow', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body)
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, error: 'La hoja no respondió bien' }; }
}

/* Límite por conexión usando la caché del borde (suficiente para un negocio pequeño). */
async function overLimit(request, kind) {
  const [max, ttl] = LIMITS[kind];
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  const cache = caches.default;
  const key = new Request(`https://rl.tibia.internal/${kind}/${encodeURIComponent(ip)}`);
  const hit = await cache.match(key);
  const n = hit ? Number(await hit.text()) || 0 : 0;
  if (n >= max) return true;
  await cache.put(key, new Response(String(n + 1), { headers: { 'cache-control': `max-age=${ttl}` } }));
  return false;
}

async function turnstileOk(env, token, request) {
  if (!env.TURNSTILE_SECRET) return true;            // sin Turnstile configurado: no se exige
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET); form.append('response', token);
  form.append('remoteip', request.headers.get('CF-Connecting-IP') || '');
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const d = await r.json().catch(() => ({}));
  return !!d.success;
}

/* ---------- sesión del dueño (token firmado con HMAC) ---------- */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(env, msg) {
  const secret = `${env.APPS_SCRIPT_KEY || ''}|${env.ADMIN_PIN || ''}|tibia-panel`;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}
function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}
async function makeToken(env) { const exp = Date.now() + SESSION_DAYS * 864e5; return `${exp}.${await hmac(env, String(exp))}`; }
async function tokenOk(env, token) {
  if (!token || !env.ADMIN_PIN) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sameText(sig, await hmac(env, exp));
}
const bearer = request => (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

/* ---------- rutas ---------- */
export async function onRequest({ request, env, params }) {
  const path = (params.path || []).join('/');
  const method = request.method;

  // Tienda: lectura de catálogo, cupos y votación
  if (path === '' && method === 'GET') {
    const d = await callScript(env, 'GET');
    if (d && d.ok && env.TURNSTILE_SITEKEY) d.turnstileSiteKey = env.TURNSTILE_SITEKEY;
    return json(d, d && d.ok ? 200 : 502);
  }

  // Tienda: pedidos y votos
  if (path === '' && method === 'POST') {
    let body; try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'Formato inválido' }, 400); }
    if (body.tipo !== 'pedido' && body.tipo !== 'voto') return json({ ok: false, error: 'No permitido' }, 403);
    if (await overLimit(request, body.tipo)) return json({ ok: false, error: 'Demasiados intentos. Espera unos minutos.' }, 429);
    const verified = await turnstileOk(env, body.cf, request);
    if (body.tipo === 'voto' && !verified) return json({ ok: false, error: 'Verificación fallida' }, 403);
    delete body.cf;
    return json(await callScript(env, 'POST', body, { v: verified ? '1' : '0' }));
  }

  // Panel: entrar con PIN
  if (path === 'admin/login' && method === 'POST') {
    if (!env.ADMIN_PIN || !env.APPS_SCRIPT_KEY) return json({ ok: false, error: 'El panel todavía no está configurado.' }, 503);
    if (await overLimit(request, 'login')) return json({ ok: false, error: 'Demasiados intentos. Espera 15 minutos.' }, 429);
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    if (!sameText(String(body.pin || ''), String(env.ADMIN_PIN))) return json({ ok: false, error: 'PIN incorrecto' }, 401);
    return json({ ok: true, token: await makeToken(env), dias: SESSION_DAYS });
  }

  // Panel: acciones del dueño
  if (path === 'admin' && method === 'POST') {
    if (!(await tokenOk(env, bearer(request)))) return json({ ok: false, error: 'Sesión vencida. Vuelve a entrar.' }, 401);
    let body; try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'Formato inválido' }, 400); }
    if (!/^admin_/.test(String(body.tipo || ''))) return json({ ok: false, error: 'No permitido' }, 403);
    return json(await callScript(env, 'POST', body, { admin: '1' }));
  }

  return json({ ok: false, error: 'No encontrado' }, 404);
}
