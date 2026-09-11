// 认证：单密码登录 + HMAC 签名的 httpOnly cookie
const enc = new TextEncoder();
const dec = new TextDecoder();

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 默认 7 天
const REMEMBER_TTL_MS = 30 * 24 * 3600 * 1000; // 记住我 30 天
const SESSION_COOKIE = 'session';

// ---- base64url 工具 ----
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---- HMAC-SHA256 签名 ----
async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64url(sig);
}

// ---- 会话 ----
export async function createSession(secret, remember = false) {
  const payload = { exp: Date.now() + (remember ? REMEMBER_TTL_MS : SESSION_TTL_MS) };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, body);
  return `${body}.${sig}`;
}

export async function verifySession(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const expected = await hmacSign(secret, body);
  if (sig.length !== expected.length) return false;
  // 常数时间比较，防时序攻击
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return false;
  try {
    const payload = JSON.parse(dec.decode(b64urlToBytes(body)));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return false;
  } catch {
    return false;
  }
  return true;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

// 生成 Set-Cookie 头。本地开发（http）不加 Secure，否则浏览器不收。
export function sessionCookieHeader(token, { remember = false, clear = false, isLocal = false } = {}) {
  const maxAge = clear ? 0 : remember ? REMEMBER_TTL_MS / 1000 : SESSION_TTL_MS / 1000;
  const value = clear ? '' : token;
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isLocal ? '' : '; Secure'}`;
}

// ---- 密码校验（常数时间比较） ----
export async function verifyPassword(env, input) {
  if (!env.APP_PASSWORD || !input || typeof input !== 'string') return false;
  const a = enc.encode(env.APP_PASSWORD);
  const b = enc.encode(input);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
