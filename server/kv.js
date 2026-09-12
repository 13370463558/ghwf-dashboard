// 容器版 KV：替换 Cloudflare KV 的针孔适配
// 所有 key 都持久化到 data/kv.json（内存 + 磁盘同步），重启不丢。
// 缓存类 key（repos:/wfdata:/cron:/rate:）也落盘——重启后读旧值，miss 再由 GitHub 重建，无害且少一次冷启动拉取。
// 调度表 scheduler:state 必须持久化（last_trigger 一旦丢失，重启后会重复触发同一 cron）。
import { promises as fs } from 'fs';
import path from 'path';

export function createKv(dataDir) {
  const mem = new Map(); // key -> { value: string, exp: number }
  const kvFile = path.join(dataDir, 'kv.json'); // 现在所有 key 都存这一个文件
  const MAX_SYNC_SECONDS = 10; // 最多每 10 秒批量写盘一次（防频繁写盘）
  let dirty = false;
  let syncTimer = null;

  // 批量写盘（去抖）
  function scheduleSync() {
    dirty = true;
    if (syncTimer) return;
    syncTimer = setTimeout(async () => {
      syncTimer = null;
      if (!dirty) return;
      dirty = false;
      await persist();
    }, MAX_SYNC_SECONDS * 1000);
  }

  async function persist() {
    try {
      const obj = {};
      for (const [k, v] of mem) {
        if (v.exp && v.exp < Date.now()) continue; // 跳过已过期
        obj[k] = v;
      }
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(kvFile, JSON.stringify(obj), 'utf8');
    } catch (e) {
      // 写盘失败不致命，内存仍可用
      dirty = true; // 标记待重试
    }
  }

  // 启动时加载持久文件
  async function init() {
    try {
      const raw = await fs.readFile(kvFile, 'utf8');
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) {
        if (v?.value !== undefined) mem.set(k, { value: v.value, exp: v.exp || 0 });
      }
    } catch {
      /* 无文件或损坏，用空 */
    }
    // 兜底：定时强制清理过期 + 确保持久
    setInterval(scheduleSync, 60000);
  }

  return {
    init,
    async get(key) {
      const v = mem.get(key);
      if (!v) return null;
      if (v.exp && v.exp < Date.now()) {
        mem.delete(key);
        dirty = true;
        return null;
      }
      return v.value;
    },
    async put(key, value, opts = {}) {
      const exp = opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0;
      mem.set(key, { value, exp });
      // 关键持久 key（调度状态、分组）立即落盘，防止 10 秒去抖窗口内重启丢失
      if (key === 'scheduler:state' || key === 'groups') {
        await persist();
      } else {
        scheduleSync(); // 其余缓存类 key 去抖落盘
      }
    },
    async delete(key) {
      mem.delete(key);
      dirty = true;
    },
  };
}