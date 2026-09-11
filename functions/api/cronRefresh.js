// POST /api/cron/refresh — 强制刷新 cron 缓存（清掉 cron:v2 key + 视图缓存）
// 默认组存在时只清组内仓库；无默认组时清全量视图缓存（重建时全量重新解析）
import { getGroups } from '../lib/groups.js';
import { json } from '../lib/http.js';

export async function onRequestPost(context) {
  const { env } = context;
  const groupCfg = await getGroups(env);
  const defaultGroup = groupCfg.groups.find((g) => g.id === groupCfg.defaultGroupId) || null;
  const targets = defaultGroup ? defaultGroup.repos : [];
  const cleared = [];

  if (env.CACHE) {
    for (const name of targets) {
      await env.CACHE.delete(`cron:v3:${name}`);
      cleared.push(name);
    }
    if (defaultGroup) {
      await env.CACHE.delete(`repos:g:v3:${defaultGroup.id}`);
    } else {
      await env.CACHE.delete('repos:all:v3');
    }
  }

  return json({ ok: true, cleared, scope: defaultGroup ? defaultGroup.id : null });
}
