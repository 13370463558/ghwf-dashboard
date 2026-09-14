// GET /api/schedulerLog — 调度器触发日志（KV key "scheduler:log"，最多保留 100 条）
// 由 server/scheduler.js 每次触发后写入；面板「调度日志」页展示
import { json } from '../lib/http.js';

const LOG_KEY = 'scheduler:log';
const MAX_ENTRIES = 100;

export async function onRequestGet(context) {
  const { env } = context;
  let entries = [];
  try {
    const raw = await env.CACHE?.get(LOG_KEY);
    if (raw) entries = JSON.parse(raw);
  } catch { /* ignore */ }
  return json({ entries });
}

// 写入一条调度日志（供 server/scheduler.js 调用）
// entry: { repo, workflow_path, cron, result, detail, at }
export async function appendSchedulerLog(env, entry) {
  let entries = [];
  try {
    const raw = await env.CACHE?.get(LOG_KEY);
    if (raw) entries = JSON.parse(raw);
  } catch { /* ignore */ }
  entries.unshift({ ...entry, at: entry.at || new Date().toISOString() });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
  await env.CACHE?.put(LOG_KEY, JSON.stringify(entries));
}
