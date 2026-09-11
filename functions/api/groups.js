// 分组配置 API
// GET /api/groups   → 读当前组配置
// PUT /api/groups   → 整体保存 { groups: [...], defaultGroupId }
import { getGroups, saveGroups } from '../lib/groups.js';
import { json } from '../lib/http.js';

export async function onRequestGet(context) {
  const { env } = context;
  return json(await getGroups(env));
}

export async function onRequestPut(context) {
  const { env, request } = context;
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.groups)) {
    return json({ error: '参数错误：需要 { groups: [...], defaultGroupId }' }, 400);
  }
  try {
    const saved = await saveGroups(env, body);
    return json({ ok: true, ...saved });
  } catch (err) {
    return json({ error: `保存失败: ${err.message}` }, 500);
  }
}
