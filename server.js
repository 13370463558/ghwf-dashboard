// 容器版入口：Node HTTP 服务器（无外部依赖，纯 node:http）
// 复用 functions/lib 与 functions/api 的全部 Fetch-API 处理器，零改动。
// 启动：PORT 环境变量（默认 8080），存储 data/ 目录（持久）。
//
// ★ 强制 UTC：cron 表达式按 GitHub UTC 语义；容器系统时区未知，统一用 UTC 保证调度判断正确。
//   （北京时间展示由 crons.js 的 beijingTodayWindow 单独按 +8 计算，不受此影响）
process.env.TZ = 'UTC';

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { createKv } from './server/kv.js';
import { createScheduler } from './server/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 加载 .env 文件（容器面板可能无法设置环境变量）----
// 若 /home/container/.env 存在，读出来注入 process.env（已存在的环境变量优先，不覆盖）
async function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  try {
    const raw = await readFile(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* .env 不存在，静默 */
  }
}

await loadDotEnv();

const DIST_DIR = process.env.DIST_DIR || path.join(__dirname, 'dist');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 8080);

// ---- 启动前自检 dist：若不存在则尝试构建（仅当 vite 可用时）----
async function ensureDist() {
  try {
    const s = await stat(path.join(DIST_DIR, 'index.html'));
    if (s.isFile()) return true; // dist 已存在，直接用
  } catch {
    /* 不存在，需构建 */
  }
  // dist 缺失：尝试 npm run build（若环境有 vite/wrangler）。静默失败不阻塞启动。
  try {
    console.log('dist 缺失，尝试构建前端…');
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('npx', ['vite', 'build'], { cwd: __dirname, stdio: 'inherit' });
    if (r.status === 0) {
      console.log('前端构建成功');
      return true;
    }
    console.log('前端构建失败（可能未安装 vite），将无法提供静态页面');
    return false;
  } catch (e) {
    console.log('前端构建异常:', e.message);
    return false;
  }
}

// ---- 环境注入：把容器环境变量变成 handlers 需要的 env 对象 ----
const kv = createKv(DATA_DIR);
const env = {
  ...process.env, // 暴露全部环境变量（含 SCHED_*/TG_*，供调度器读取）
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  APP_PASSWORD: process.env.APP_PASSWORD || '',
  AUTH_SECRET: process.env.AUTH_SECRET || '',
  CACHE: kv, // 文件/内存 KV 适配 Cloudflare KV 接口
  IS_LOCAL: 'true', // 容器走非 HTTPS cookie（不加 Secure）
};

// ---- 加载 API 处理器（按文件名映射路由）----
const apiDir = path.join(__dirname, 'functions', 'api');
const apiModules = await loadApiModules();
const middleware = (await import('./functions/_middleware.js')).onRequest;

async function loadApiModules() {
  const { readdir } = await import('node:fs/promises');
  const map = {};
  const files = await readdir(apiDir);
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const mod = await import(`./functions/api/${f}`);
    if (!map[f]) map[f] = {};
    if (mod.onRequestGet) map[f].GET = mod.onRequestGet;
    if (mod.onRequestPost) map[f].POST = mod.onRequestPost;
    if (mod.onRequestPut) map[f].PUT = mod.onRequestPut;
  }
  return map;
}

// ---- 路由：/api/<file> → 对应 handler ----
async function routeApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean); // ['api', 'repos']
  if (segments[0] !== 'api' || segments.length < 2) return false;

  const fileName = segments[1]; // 无扩展名文件名（如 repos, workflows, cronRefresh）
  // 兼容：cronRefresh 等驼峰文件名；也尝试下划线/连字符变体
  const candidateFiles = [fileName];
  if (/[A-Z]/.test(fileName)) candidateFiles.push(fileName.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
  const mod = apiModules[candidateFiles.find((n) => apiModules[`${n}.js`]) ? fileName + '.js' : ''];
  if (!mod) return false;

  const method = mod[req.method];
  if (!method) {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return true;
  }

  // 构造 Fetch 形态的 request，供 handler 使用
  const request = new Request(url.href, {
    method: req.method,
    headers: {
      host: req.headers.host || 'localhost',
      'content-type': req.headers['content-type'] || '',
      cookie: req.headers.cookie || '',
      'cf-connecting-ip': req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
    },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req),
  });

  // 构造 context：env + request + next（next 由路由分发，这里通过递归实现）
  const context = {
    env,
    request,
    next: async () => {
      // 中间件的 next：对非 API 静态/404 处理在 server.js 顶层做；这里简单返回 404
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };

  const result = await method(context);
  // result 是 Response 对象
  res.statusCode = result.status;
  const setCookie = result.headers.get('set-cookie');
  if (setCookie) res.setHeader('set-cookie', setCookie);
  res.setHeader('content-type', result.headers.get('content-type') || 'application/json');
  const text = await result.text();
  res.end(text);
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ---- 静态文件托管：dist/ ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, urlPath) {
  let filePath = path.normalize(path.join(DIST_DIR, urlPath));
  if (filePath.endsWith('/') || !path.extname(filePath)) filePath = path.join(filePath, 'index.html');
  if (!filePath.startsWith(DIST_DIR)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not file');
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('content-type', MIME[ext] || 'application/octet-stream');
    res.setHeader('cache-control', ext === '.html' ? 'no-cache' : 'public, max-age=86400');
    res.end(await readFile(filePath));
  } catch {
    // SPA fallback → index.html（除 /api 外）
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(await readFile(path.join(DIST_DIR, 'index.html')).catch(() => 'Not Found'));
  }
}

// ---- 启动 ----
await kv.init();
await ensureDist(); // 确保 dist 存在（缺失则尝试构建）

// 启动调度器（容器常驻，到点触发被接管的 workflow）
const { createLogger } = await import('./server/logger.js');
const scheduler = createScheduler(env, kv, createLogger()).start();
console.log('Scheduler started');

// 启动哪吒探针（若 .npm/nezha_agent 配置存在）
const { ensureNezha } = await import('./server/nezha.js');
await ensureNezha(env);
console.log('Nezha check done');

const server = createServer(async (req, res) => {
  try {
    // 1. 中间件：校验会话（放行 /api/login 与静态）
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const request = new Request(url.href, {
      method: req.method,
      headers: { host: req.headers.host || 'localhost', cookie: req.headers.cookie || '' },
    });
    const context = { env, request, next: async () => new Response(null, { status: 404 }) };
    const mwResult = await middleware(context);
    if (mwResult && mwResult.status === 401) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: '未登录或会话已过期' }));
      return;
    }

    // 2. API 路由
    const handled = await routeApi(req, res);
    if (handled) return;

    // 3. 静态
    if (url.pathname.startsWith('/api/')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('server error:', e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
});

server.listen(PORT, () => {
  console.log(`GHWF Dashboard listening on http://0.0.0.0:${PORT}`);
});