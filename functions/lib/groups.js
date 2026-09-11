// 分组配置读写（存 KV，单 key）
const GROUPS_KEY = 'groups';

export function genGroupId() {
  return 'g_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export async function getGroups(env) {
  const empty = { groups: [], defaultGroupId: null };
  if (!env.CACHE) return empty;
  const raw = await env.CACHE.get(GROUPS_KEY);
  if (!raw) return empty;
  try {
    const data = JSON.parse(raw);
    return {
      groups: Array.isArray(data.groups) ? data.groups : [],
      defaultGroupId: data.defaultGroupId || null,
    };
  } catch {
    return empty;
  }
}

// 规范化并保存；校验默认组必须存在，id 缺失则生成
// 保存后自动失效相关视图缓存，确保主视图立即反映新的组成员
export async function saveGroups(env, data) {
  if (!env.CACHE) throw new Error('KV 未绑定');
  const old = await getGroups(env);
  const groups = (Array.isArray(data.groups) ? data.groups : []).map((g) => ({
    id: g.id && /^g_[A-Za-z0-9]+$/.test(g.id) ? g.id : genGroupId(),
    name: String(g.name || '未命名组').slice(0, 50),
    repos: Array.isArray(g.repos)
      ? [...new Set(g.repos.map((r) => String(r)))].slice(0, 300)
      : [],
  }));
  let defaultGroupId = data.defaultGroupId || null;
  if (defaultGroupId && !groups.some((g) => g.id === defaultGroupId)) {
    defaultGroupId = null;
  }
  const normalized = { groups, defaultGroupId };
  await env.CACHE.put(GROUPS_KEY, JSON.stringify(normalized));

  // 组配置变更 → 清旧/新默认组的视图缓存 + 管理全量缓存
  const keys = new Set(['repos:all:v3']);
  if (old.defaultGroupId) keys.add(`repos:g:v3:${old.defaultGroupId}`);
  if (normalized.defaultGroupId) keys.add(`repos:g:v3:${normalized.defaultGroupId}`);
  for (const k of keys) {
    await env.CACHE.delete(k).catch(() => {});
  }

  return normalized;
}
