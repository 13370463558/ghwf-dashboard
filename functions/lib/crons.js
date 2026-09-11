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
export async function readWorkflowInfo(env, fullName, workflowPath) {
  try {
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
  } catch {
    return { crons: [], dispatchable: false }; // 解析失败（文件缺失/二进制/加密/权限）静默跳过
  }
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
export function nextRunAt(cron, from = new Date()) {
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: from });
    const next = interval.next().toDate();
    return next.toISOString();
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
