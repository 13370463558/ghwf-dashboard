// KV 缓存封装：读命中直接返回；未命中执行 fetchFn 后写缓存（带 TTL）
// 本地开发没有绑定 KV 时自动降级为不缓存
export async function cached(env, key, ttlSeconds, fetchFn, { staleOnError = true } = {}) {
  const kv = env.CACHE;
  let hit = null;
  if (kv) {
    const raw = await kv.get(key);
    if (raw != null) {
      try {
        hit = JSON.parse(raw);
      } catch {
        hit = null;
      }
    }
  }
  if (hit != null) return hit;
  try {
    const data = await fetchFn();
    if (data !== undefined && kv) {
      await kv.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds });
    }
    return data;
  } catch (err) {
    // 上游失败时尽量回退到旧缓存
    if (staleOnError && hit != null) return hit;
    throw err;
  }
}
