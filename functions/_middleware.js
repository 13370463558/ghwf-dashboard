// 全局守卫：除 /api/login 外，所有 /api/* 路由都必须携带有效会话
// 注意：只拦截 /api/*，静态资源（登录页本身）必须放行，否则未登录时前端白屏
import { verifySession, parseCookies } from './lib/auth.js';
import { json } from './lib/http.js';

export async function onRequest(context) {
  const { env, request, next } = context;
  const url = new URL(request.url);

  // 非 API 请求（静态资源）直接放行
  if (!url.pathname.startsWith('/api/')) {
    return next();
  }

  // 登录接口放行（由 login.js 自己处理密码校验）
  if (url.pathname === '/api/login') {
    return next();
  }

  const cookies = parseCookies(request.headers.get('Cookie'));
  const ok = await verifySession(env.AUTH_SECRET, cookies.session);
  if (!ok) {
    return json({ error: '未登录或会话已过期' }, 401);
  }
  return next();
}
