// cron 缓存读取：读 KV cron:v3:<repo> → miss 或快照变化时才重新解析 workflow YAML
// 供 repos.js（概览）和 api/cron.js（按仓库手动补齐）共用
import { cached } from './cache.js';
import { fetchCronRows } from './crons.js';

export const CRON_TTL = 86400; // 24h，workflow 文件不常改

// 读取某仓库的 cron 缓存（自动刷新/快照重解析）。
// cronRows 计算失败时：不写缓存、不抛错，回退旧缓存（无则空），由前端 /api/cron 补齐
export async function getCronCache(env, fullName, workflows, pushedAt) {
  const wfUpdated = (workflows || []).map((w) => `${w.id}:${w.updated_at || ''}`).join('|');
  const snapshot = `${pushedAt || ''}|${wfUpdated}`;
  const key = `cron:v3:${fullName}`;

  let cache = null;
  try {
    cache = await cached(env, key, CRON_TTL, async () => ({
      rows: await fetchCronRows(env, fullName, workflows || []),
      parsed_at: new Date().toISOString(),
      snapshot,
    }));
    if (cache.snapshot !== snapshot) {
      const rows = await fetchCronRows(env, fullName, workflows || []);
      cache = { rows, parsed_at: new Date().toISOString(), snapshot };
      await env.CACHE?.put(key, JSON.stringify(cache), { expirationTtl: CRON_TTL }).catch(() => {});
    }
  } catch {
    // 解析失败：不写缓存；回退旧缓存或空（由调用方决定何时重试）
    if (!cache) cache = { rows: [], parsed_at: null, snapshot };
    if (!cache.rows && cache.rows !== null) cache.rows = [];
  }
  return cache;
}

// 强制重建某仓库的 cron 缓存（忽略快照，直接解析并覆盖写 KV）
export async function forceRefreshCron(env, fullName, workflows) {
  const rows = await fetchCronRows(env, fullName, workflows || []);
  const wfUpdated = (workflows || []).map((w) => `${w.id}:${w.updated_at || ''}`).join('|');
  const cache = { rows, parsed_at: new Date().toISOString(), snapshot: `|${wfUpdated}` };
  await env.CACHE?.put(`cron:v3:${fullName}`, JSON.stringify(cache), { expirationTtl: CRON_TTL });
  return cache;
}