// 容器调度器：读调度表（KV），到点触发 GitHub workflow_dispatch
// 集成进 server.js，常驻运行。
// 调度表结构（KV "scheduler:state"）：
//   { repos: { "owner/name": { cron, workflow_path, interval_minutes, taken_over, last_trigger } },
//     global_interval_minutes: 5 }
// 每 global_interval_minutes 分钟检查一次，对 cron 到点且未被触发过的 repo 执行 dispatch。
// dispatch 后记录 last_trigger，避免重复。

import { CronExpressionParser } from 'cron-parser';

const STATE_KEY = 'scheduler:state';
const DISPATCH_URL = (owner, repo, workflowId) =>
  `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`;

export function createScheduler(env, kv) {
  let timer = null;
  let running = false;

  async function getState() {
    try {
      const raw = await kv.get(STATE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return { repos: {}, global_interval_minutes: 5 };
  }

  // 通过 workflow_path 找 workflow id（读 wfdata 缓存）
  async function findWorkflowId(repo, workflowPath) {
    try {
      const wfData = JSON.parse((await kv.get(`wfdata:v2:${repo}`)) || 'null');
      if (wfData?.workflows) {
        const w = wfData.workflows.find((x) => x.path === workflowPath);
        if (w) return w.id;
      }
    } catch { /* ignore */ }
    return null;
  }

  // 判断 cron 是否该在"now"触发：以 lastTrigger 为起点，若下一次触发时间 <= now 则应触发
  // 注意：now 是时间戳数字
  function dueToRun(cron, lastTrigger, now) {
    try {
      const it = CronExpressionParser.parse(cron, { currentDate: new Date(lastTrigger || 0) });
      let next = null;
      try { next = it.next().toDate(); } catch { return false; }
      return next.getTime() <= now; // now 已是数字毫秒
    } catch {
      return false;
    }
  }

  async function dispatchWorkflow(env, ownerRepo, workflowId, ref = 'main') {
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

  async function tick() {
    if (running) return; // 防止重入
    running = true;
    try {
      const state = await getState();
      const now = Date.now();
      for (const [repo, cfg] of Object.entries(state.repos || {})) {
        if (!cfg.taken_over) continue;
        if (!cfg.cron) continue;
        if (dueToRun(cfg.cron, cfg.last_trigger || 0, now)) {
          const workflowId = await findWorkflowId(repo, cfg.workflow_path);
          if (!workflowId) {
            console.log(`[scheduler] ${repo} 找不到 workflow (${cfg.workflow_path})，跳过`);
            continue;
          }
          const ok = await dispatchWorkflow(env, repo, workflowId);
          // 更新 last_trigger（无论成败都记，避免无限重试；失败下轮靠下次 cron）
          cfg.last_trigger = now;
          state.repos[repo] = cfg;
          console.log(`[scheduler] ${repo} dispatch ${ok ? '成功' : '失败'} → ${cfg.cron}`);
        }
      }
      // 写回状态（含更新后的 last_trigger）。调度表永久，不设 TTL（避免被过期清掉）
      await kv.put(STATE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('[scheduler] tick error:', e.message);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      // 初始立即跑一次
      tick();
      const iv = () => {
        tick();
        // 重新读取间隔（支持运行时调 global_interval_minutes）
        getState().then((s) => {
          const minutes = Math.max(1, Math.min(60, s.global_interval_minutes || 5));
          if (timer) clearTimeout(timer);
          timer = setTimeout(iv, minutes * 60 * 1000);
        });
      };
      timer = setTimeout(iv, 60 * 1000);
      return this;
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}