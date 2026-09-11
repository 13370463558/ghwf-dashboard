// cron 解析与下次运行时间计算
// GitHub API 不返回 workflow 的 schedule，需要读 workflow YAML 文件解析 on.schedule[].cron
// 解析结果由调用方缓存（cron:<repo> 24h TTL），避免每次请求都读 GitHub
import { load as yamlLoad } from 'js-yaml';
import { CronExpressionParser } from 'cron-parser';
import { gh } from './github.js';

function encPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// 读取单个 workflow 文件的 cron 表达式列表（去重）+ 是否支持手动触发（workflow_dispatch）
// 关键：只有"确实没配 schedule"才返回空数组（会写入缓存）;
//      网络/权限/读取失败（subrequest 超限、403、404 等）必须 throw，防止把失败写进缓存导致 24h 假空
export async function readWorkflowInfo(env, fullName, workflowPath) {
  const [owner, repo] = fullName.split('/');
  const data = await gh(env, `/repos/${owner}/${repo}/contents/${encPath(workflowPath)}`);
  if (!data?.content) return { crons: [], dispatchable: false };
  // atob 返回 latin1 字节串，必须按 UTF-8 解码（YAML 里可能有中文注释，直接传 atob 结果
  // 会出现 C1 控制字符，js-yaml 会报 "non-printable characters"）
  const bytes = Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0));
  const yamlText = new TextDecoder().decode(bytes);
  const doc = yamlLoad(yamlText);
  if (!doc || typeof doc !== 'object') return { crons: [], dispatchable: false };
  const on = doc.on ?? doc['on'];
  const schedule = Array.isArray(on?.schedule) ? on.schedule : [];
  const crons = schedule
    .map((s) => (s && typeof s.cron === 'string' ? s.cron.trim() : ''))
    .filter(Boolean);
  const dispatchable = on?.workflow_dispatch !== undefined;
  return { crons: [...new Set(crons)], dispatchable };
}

// 解析仓库内所有 active workflow 的信息；workflows 来自 wfdata（id/name/path/state）
export async function fetchCronRows(env, fullName, workflows) {
  const rows = [];
  const active = (workflows || []).filter(
    (w) => w.state === 'active' && /\.ya?ml$/i.test(w.path || '')
  );
  for (const w of active) {
    const info = await readWorkflowInfo(env, fullName, w.path);
    if (info.crons.length || info.dispatchable) {
      rows.push({ id: w.id, name: w.name, path: w.path, crons: info.crons, dispatchable: info.dispatchable });
    }
  }
  return rows;
}

// 计算 cron 的下一次触发时间（UTC），失败返回 null
// 用 cron-parser；若其抛错（版本/兼容问题），降级为近似解析，保证 next_at 不为 null
export function nextRunAt(cron, from = new Date()) {
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: from });
    const next = interval.next().toDate();
    return next.toISOString();
  } catch {
    return fallbackNextRun(cron, from);
  }
}

// 近似 fallback：解析分/时/日/月/周，返回最早可能的未来时刻（一次性，不循环跨月）
// 用于 cron-parser 不可用时的兜底，避免 next_at 变为 null 导致前端显示"解析失败"
function fallbackNextRun(cron, from) {
  try {
    const parts = String(cron || '').trim().split(/\s+/);
    if (parts.length < 5) return null;
    const min = parseInt(parts[0], 10);
    const hour = parseInt(parts[1], 10);
    const dom = parts[2] === '*' ? '*' : parseInt(parts[2], 10);
    const month = parts[3] === '*' ? '*' : parseInt(parts[3], 10);
    const dow = parts[4] === '*' ? '*' : parseInt(parts[4], 10);
    if (Number.isNaN(min) || Number.isNaN(hour) || hour > 23) return null;

    // 在当前基础上推进，找到匹配"最近一次可用的今天/明天"的整点
    const now = new Date(from.getTime());
    now.setSeconds(0, 0);
    now.setUTCMinutes(min);
    now.setUTCHours(hour);
    // 从 from 起算，往后最多扫 8 天找匹配日
    for (let d = 0; d <= 8; d++) {
      const t = new Date(from.getTime() + d * 86400000);
      t.setSeconds(0, 0);
      t.setUTCMinutes(min);
      t.setUTCHours(hour);
      const okDow = dow === '*' || t.getUTCDay() === dow;
      const okDom = dom === '*' || t.getUTCDate() === dom;
      const okMonth = month === '*' || t.getUTCMonth() + 1 === month;
      if (okDow && okDom && okMonth && t.getTime() > from.getTime()) {
        return t.toISOString();
      }
    }
    return null;
  } catch {
    return null;
  }
}

// 北京时间"今天"窗口对应的 UTC 区间（cron 按 UTC 语义触发）
export function beijingTodayWindow(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const startUtc = new Date(
    Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600 * 1000
  );
  const endUtc = new Date(startUtc.getTime() + 24 * 3600 * 1000);
  return { startUtc, endUtc };
}

// 一组 cron 表达式在"今天"（北京时间）的触发时刻（分钟数，0-1439，北京时间）
export function scheduledTimesToday(crons, now = new Date()) {
  const { startUtc, endUtc } = beijingTodayWindow(now);
  const times = [];
  for (const cron of crons || []) {
    try {
      const it = CronExpressionParser.parse(cron, { currentDate: startUtc });
      let count = 0;
      let next = it.next();
      while (count < 200 && next.toDate().getTime() < endUtc.getTime()) {
        const t = next.toDate();
        const bjMin = Math.round(((t.getTime() + 8 * 3600 * 1000) % 86400000) / 60000);
        times.push(bjMin);
        count++;
        next = it.next();
      }
    } catch {
      /* 非法 cron 跳过 */
    }
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

// 一组 cron 表达式在"今天"（北京时间）计划触发的总次数
export function countScheduledToday(crons, now = new Date()) {
  const { startUtc, endUtc } = beijingTodayWindow(now);
  let total = 0;
  for (const cron of crons || []) {
    try {
      const it = CronExpressionParser.parse(cron, { currentDate: startUtc });
      let count = 0;
      let next = it.next();
      while (count < 200 && next.toDate().getTime() < endUtc.getTime()) {
        count++;
        next = it.next();
      }
      total += count;
    } catch {
      /* 非法 cron 跳过 */
    }
  }
  return total;
}
