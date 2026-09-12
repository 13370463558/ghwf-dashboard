// 容器版 KV：替换 Cloudflare KV 的针孔适配
// - 缓存类 key（repos:/wfdata:/cron:/rate:）：放内存 Map，重启重建（数据本身是缓存，重新拉 GitHub 即可）
// - groups 配置（用户增删改的持久数据）：落盘 data/groups.json，重启不丢
import { promises as fs } from 'fs';
import path from 'path';

export function createKv(dataDir) {
  const mem = new Map(); // key -> { value: string, exp: number }
  const groupsFile = path.join(dataDir, 'groups.json');
  let groupsDirty = false;

  // 每隔 1 分钟把 groups 落盘一次（防频繁写盘）
  setInterval(() => {
    if (groupsDirty) flushGroups().then(() => (groupsDirty = false)).catch(() => {});
  }, 60000);

  async function flushGroups() {
    const val = mem.get('groups');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(groupsFile, val?.value ?? '{"groups":[],"defaultGroupId":null}', 'utf8');
  }

  // 启动时若有持久 groups 文件则加载
  async function init() {
    try {
      const raw = await fs.readFile(groupsFile, 'utf8');
      mem.set('groups', { value: raw, exp: 0 }); // 不设过期，永久
    } catch {
      /* 无文件，用默认空 */
    }
  }

  return {
    init,
    async get(key) {
      const v = mem.get(key);
      if (!v) return null;
      if (v.exp && v.exp < Date.now()) {
        mem.delete(key);
        return null;
      }
      return v.value;
    },
    async put(key, value, opts = {}) {
      const exp = opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0;
      mem.set(key, { value, exp });
      if (key === 'groups') groupsDirty = true;
      if (key === 'groups' && opts.expirationTtl === undefined) {
        // groups 立即落盘一次（不阻塞等待）
        flushGroups().then(() => (groupsDirty = false)).catch(() => {});
      }
    },
    async delete(key) {
      mem.delete(key);
      if (key === 'groups') {
        groupsDirty = true;
      }
    },
  };
}