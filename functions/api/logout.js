// POST /api/logout — 清除会话 cookie
import { sessionCookieHeader } from '../lib/auth.js';
import { json } from '../lib/http.js';

export async function onRequestPost() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookieHeader('', { clear: true, isLocal: true }),
    },
  });
}
