// 容器调度器：读调度表（KV），到点触发 GitHub workflow_dispatch
// 集成进 server.js，常驻运行。
// 调度表结构（KV "scheduler:state"）：
//   { repos: { "owner/name": { cron, workflow_path, interval_minutes, taken_over, last_trigger } },
//     global_interval_minutes: 5 }
// 每 global_interval_minutes 分钟检查一次。
//
// 触发可靠性（方案 B）：
//   dispatch 后延迟 confirmDelayMs 秒 → 查 GitHub runs 确认该 workflow 是否真的入队
//   未确认/失败 → 重试（最多 maxRetries 次）；全失败 → 记 fail_attempts，下轮不再重复，发 TG 通知
//   TG 配置从 env 读：TG_BOT_TOKEN / TG_CHAT_ID
//
// 触发历史落 KV（"scheduler:log"，最近 100 条）→ 面板「调度日志」页查看
// 调度表定期备份到 GitHub 仓库（lib/schedBackup.js，env SCHED_BACKUP_REPO）

import { CronExpressionParser } from 'cron-parser';
import { appendSchedulerLog } from '../functions/api/schedulerLog.js';
import { backupSchedulerState } from '../functions/lib/schedBackup.js';

const STATE_KEY = 'scheduler:state';
const DISPATCH_URL = (owner, repo, workflowId) =>
  `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`;
const RUNS_URL = (owner, repo, workflowId) =>
  `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?per_page=3&event=workflow_dispatch`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createScheduler(env, kv, logger) {
  let timer = null;
  let running = false;

  // 日志：优先用传入的 logger（带时间戳+写文件），否则降级 console
  const log = logger?.log || ((m) => console.log(m));
  const logErr = logger?.error || ((m) => console.error(m));

  // 配置（从 env，带默认）
  const confirmDelayMs = Number(env.SCHED_CONFIRM_DELAY || 15) * 1000; // dispatch 后确认延时，默认 15s
  const maxRetries = Number(env.SCHED_MAX_RETRIES || 3); // 最多尝试次数，默认 3（含首次）
  const tgToken = env.TG_BOT_TOKEN || '';
  const tgChatId = env.TG_CHAT_ID || '';

  async function getState() {
    try {
      const raw = await kv.get(STATE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return { repos: {}, global_interval_minutes: 5 };
  }

  // 通过 workflow_path 找 workflow id
  // 优先读 wfdata 缓存；缓存缺/找不到时直接调 GitHub API（避免缓存过期导致误判"找不到"）
  async function findWorkflowId(repo, workflowPath) {
    const [owner, repoName] = repo.split('/');
    // 1) 缓存找
    try {
      const wfData = JSON.parse((await kv.get(`wfdata:v2:${repo}`)) || 'null');
      if (wfData?.workflows) {
        const w = wfData.workflows.find((x) => x.path === workflowPath);
        if (w) return w.id;
      }
    } catch { /* ignore */ }

    // 2) 缓存缺/找不到 → 直接问 GitHub（最可靠，不依赖可能过期的缓存）
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/actions/workflows?per_page=100`, {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ghwf-dashboard-scheduler',
        },
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const w = (data.workflows || []).find((x) => x.path === workflowPath);
        if (w) return w.id;
      }
    } catch { /* ignore */ }
    return null;
  }

  function dueToRun(cron, lastTrigger, now) {
    try {
      const it = CronExpressionParser.parse(cron, { currentDate: new Date(lastTrigger || 0) });
      try { return it.next().toDate().getTime() <= now; } catch { return false; }
    } catch {
      return false;
    }
  }

  // dispatch 一次，返回 HTTP ok
  async function dispatchWorkflow(ownerRepo, workflowId, ref = 'main') {
    const [owner, repo] = ownerRepo.split('/');
    const res = await fetch(DISPATCH_URL(owner, repo, workflowId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ghwf-dashboard-scheduler',
      },
      body: JSON.stringify({ ref }),
    });
    return res.ok;
  }

  // dispatch 后延时确认：查该 workflow 的 runs（按 workflow_id 过滤，不受同仓库其他 workflow 干扰）
  // 找 workflow_id 匹配、且在 afterMs 之后创建的 run（说明刚触发的入队了）
  async function confirmRun(ownerRepo, workflowId, afterMs) {
    const [owner, repo] = ownerRepo.split('/');
    const res = await fetch(RUNS_URL(owner, repo, workflowId), {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ghwf-dashboard-scheduler',
      },
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    const runs = data.workflow_runs || [];
    return runs.some((r) => new Date(r.created_at).getTime() >= afterMs);
  }

  // 发 Telegram 通知（若已配置）
  async function sendTelegram(text) {
    if (!tgToken || !tgChatId) {
      log(`[scheduler][tg] 未配置 TG_BOT_TOKEN/TG_CHAT_ID，跳过通知: ${text}`);
      return;
    }
    try {
      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChatId, text, disable_web_page_preview: true }),
      });
    } catch (e) {
      logErr('[scheduler][tg] 通知失败:', e.message);
    }
  }

  // KV env 形态：appendSchedulerLog 走 env.CACHE（容器里就是 kv 实例）
  const kvEnv = { ...env, CACHE: kv };

  // 完整触发流程：dispatch + 延时确认 + 重试 + 失败通知
  // 返回 { ok, detail }：ok=true 表示确认成功；ok=false 表示最终失败（已通知）
  async function triggerWithRetry(repo, cfg, workflowId) {
    const dispatchTime = Date.now();
    let lastErr = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // 1. dispatch
      let dOk = false;
      try {
        dOk = await dispatchWorkflow(repo, workflowId);
      } catch (e) {
        lastErr = e.message;
      }
      if (!dOk) {
        lastErr = lastErr || `dispatch HTTP 非 2xx`;
        log(`[scheduler] ${repo} 尝试${attempt}/${maxRetries} dispatch 失败: ${lastErr}`);
        if (attempt < maxRetries) await sleep(Math.min(30000, 2000 * attempt)); // 退避
        continue;
      }

      // 2. 延时后确认入队
      await sleep(confirmDelayMs);
      let confirmed = false;
      try {
        confirmed = await confirmRun(repo, workflowId, dispatchTime);
      } catch (e) {
        lastErr = e.message;
      }
      if (confirmed) {
        log(`[scheduler] ${repo} dispatch+确认成功 (尝试${attempt})`);
        return { ok: true, detail: `尝试 ${attempt} 次成功` };
      }
      lastErr = `dispatch 后 ${confirmDelayMs / 1000}s 未确认到新 run`;
      log(`[scheduler] ${repo} 尝试${attempt}/${maxRetries} 未确认入队`);
      if (attempt < maxRetries) await sleep(Math.min(30000, 2000 * attempt));
    }

    // 全部失败 → 通知
    const msg = `⚠️ 调度触发失败（已重试 ${maxRetries} 次）\n仓库: ${repo}\nworkflow: ${cfg.workflow_path}\ncron: ${cfg.cron}\n原因: ${lastErr}`;
    await sendTelegram(msg);
    return { ok: false, detail: lastErr };
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const state = await getState();
      const now = Date.now();
      // 收集本轮到点的仓库 → 并行触发（原来串行，一个 dispatch+确认 15s+ 会拖长整个 tick）
      const dueList = [];
      for (const [repo, cfg] of Object.entries(state.repos || {})) {
        if (!cfg.taken_over) continue;
        if (!cfg.cron) continue;
        if (dueToRun(cfg.cron, cfg.last_trigger || 0, now)) dueList.push([repo, cfg]);
      }
      if (dueList.length) {
        log(`[scheduler] 本轮到点 ${dueList.length} 个仓库，并行触发`);
        await Promise.all(dueList.map(([repo, cfg]) => processRepo(repo, cfg, now)));
        // 触发完 state 有变化（last_trigger/last_result）→ 落盘 + 异步备份
        await kv.put(STATE_KEY, JSON.stringify(state));
        backupSchedulerState(env, state).catch(() => {});
      }
    } catch (e) {
      logErr('[scheduler] tick error:', e.message);
    } finally {
      running = false;
    }
  }

  // 单仓库触发流程（tick 并行调用）：找 workflow → dispatch+确认 → 写日志 + 记 state
  async function processRepo(repo, cfg, now) {
    const workflowId = await findWorkflowId(repo, cfg.workflow_path);
    if (!workflowId) {
      // 找不到 workflow：更新 last_trigger 防重试风暴 + 发 TG 通知（GitHub 和缓存都确认没有）
      log(`[scheduler] ${repo} 找不到 workflow (${cfg.workflow_path})，标记本轮跳过`);
      const msg = `⚠️ 调度触发失败\n仓库: ${repo}\n原因: 找不到 workflow（${cfg.workflow_path}）\n请确认该 workflow 未被删除或重命名`;
      await sendTelegram(msg);
      cfg.last_trigger = now;
      cfg.last_result = 'not_found';
      cfg.last_attempt_at = new Date(now).toISOString();
      await appendSchedulerLog(kvEnv, {
        repo, workflow_path: cfg.workflow_path, cron: cfg.cron,
        result: 'not_found', detail: '找不到 workflow（可能被删除或重命名）',
      });
      return;
    }

    const result = await triggerWithRetry(repo, cfg, workflowId);
    // 记录 last_trigger。成功或最终失败都记（避免每 tick 疯狂重试同一 cron）。
    cfg.last_trigger = now;
    cfg.last_result = result.ok ? 'success' : 'failed';
    cfg.last_attempt_at = new Date(now).toISOString();
    await appendSchedulerLog(kvEnv, {
      repo, workflow_path: cfg.workflow_path, cron: cfg.cron,
      result: result.ok ? 'success' : 'failed',
      detail: result.ok ? 'dispatch + 确认入队成功' : result.detail || '重试后仍未确认',
    });
  }

  return {
    start() {
      tick();
      const iv = () => {
        tick();
        getState().then((s) => {
          const minutes = Math.max(1, Math.min(60, s.global_interval_minutes || 5));
          if (timer) clearTimeout(timer);
          timer = setTimeout(iv, minutes * 60 * 1000);
        });
      };
      timer = setTimeout(iv, 60 * 1000);

      // 每日兜底备份（强制 force：即使 state 内容没变，也让备份文件的时间戳滚动，
      // 证明备份链路活着；若 state 有变化，tick/接管时已实时备份过）
      const dailyBackup = () => {
        getState().then((s) => backupSchedulerState(env, s, { force: true }).catch(() => {}));
        setTimeout(dailyBackup, 24 * 3600 * 1000);
      };
      setTimeout(dailyBackup, 60 * 1000);

      return this;
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}