// POST /api/login — 校验密码，签发 httpOnly 会话 cookie
import { createSession, verifyPassword, sessionCookieHeader } from '../lib/auth.js';
import { json } from '../lib/http.js';

const MAX_ATTEMPTS = 8;
const LOCK_TTL_S = 15 * 60; // 锁 15 分钟

export async function onRequestPost(context) {
  const { env, request } = context;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const body = await request.json().catch(() => ({}));
  const { password, remember } = body || {};

  // 防暴力：IP 维度失败计数（存 KV）
  const rateKey = `rate:${ip}`;
  if (env.CACHE) {
    let rate = { count: 0, until: 0 };
    try {
      rate = JSON.parse((await env.CACHE.get(rateKey)) || '{"count":0,"until":0}');
    } catch {
      /* ignore */
    }
    if (rate.until > Date.now() || rate.count >= MAX_ATTEMPTS) {
      if (rate.until <= Date.now()) {
        await env.CACHE.put(rateKey, JSON.stringify({ count: 0, until: Date.now() + LOCK_TTL_S * 1000 }), {
          expirationTtl: LOCK_TTL_S,
        });
      }
      return json({ error: '尝试次数过多，请 15 分钟后再试' }, 429);
    }
  }

  if (!(await verifyPassword(env, password))) {
    if (env.CACHE) {
      let rate = { count: 0, until: 0 };
      try {
        rate = JSON.parse((await env.CACHE.get(rateKey)) || '{"count":0,"until":0}');
      } catch {
        /* ignore */
      }
      await env.CACHE.put(rateKey, JSON.stringify({ count: rate.count + 1, until: 0 }), {
        expirationTtl: LOCK_TTL_S,
      });
    }
    return json({ error: '密码错误' }, 401);
  }

  // 登录成功：清掉失败计数
  if (env.CACHE) await env.CACHE.delete(rateKey);

  const token = await createSession(env.AUTH_SECRET, !!remember);
  const isLocal =
    request.url.startsWith('http://') &&
    (request.url.includes('localhost') || request.url.includes('127.0.0.1') || request.url.includes('0.0.0.0'));

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookieHeader(token, { remember: !!remember, isLocal }),
    },
  });
}
