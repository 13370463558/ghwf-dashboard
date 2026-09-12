// Scheduler 管理 API
// 统一处理：接管(job=takeover) / 取消接管(untakeover) / 改cron(setcron) / 设检查周期(setinterval)
// 调度表存 KV key "scheduler:state"，结构：
//   {
//     repos: { "owner/name": { cron, workflow_path, workflow_id?, interval_minutes, last_trigger, taken_over } },
//     global_interval_minutes: 5
//   }
import { json } from '../lib/http.js';
import { CronExpressionParser } from 'cron-parser';
import { readWorkflowFile, writeWorkflowFile, operateSchedule, validateCron } from '../lib/yaml.js';

const STATE_KEY = 'scheduler:state';

async function getState(env) {
  try {
    const raw = await env.CACHE?.get(STATE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { repos: {}, global_interval_minutes: 5 };
}

async function saveState(env, state) {
  // 调度表永久存储，不设 TTL（避免被过期清掉）
  await env.CACHE?.put(STATE_KEY, JSON.stringify(state));
}

// cron 深度校验：用 cron-parser 试着解析，能解析即合法
function cronValid(cron) {
  try {
    CronExpressionParser.parse(cron);
    return true;
  } catch {
    return false;
  }
}

export async function onRequestGet(context) {
  const { env } = context;
  const state = await getState(env);
  return json({
    state: {
      repos: state.repos,
      global_interval_minutes: state.global_interval_minutes ?? 5,
    },
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const body = await request.json().catch(() => ({}));
  const { job, repo, workflow_path, cron, interval } = body || {};

  const state = await getState(env);

  // 设全局检查周期（不需要 repo）
  if (job === 'setinterval') {
    const n = Number(interval);
    if (Number.isNaN(n) || n < 1 || n > 60) return json({ error: '间隔必须是 1-60 分钟' }, 400);
    state.global_interval_minutes = n;
    await saveState(env, state);
    return json({ ok: true, global_interval_minutes: n });
  }

  // 其余 job 都需要 repo
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return json({ error: 'repo 格式应为 owner/name' }, 400);
  }

  // 接管 / 取消接管 / 改 cron 都需要 workflow_path
  if (!workflow_path || !/\.ya?ml$/i.test(workflow_path)) {
    return json({ error: '需要 workflow_path（如 .github/workflows/xx.yml）' }, 400);
  }

  // 接管：读文件 → 注释 schedule → 写回 → 存调度表
  if (job === 'takeover') {
    if (!cron || !cronValid(cron)) return json({ error: 'cron 非法，需为 5 段标准 cron' }, 400);
    try {
      const { content, sha } = await readWorkflowFile(env, repo, workflow_path);
      const newContent = operateSchedule(content, 'takeover', cron);
      if (newContent === content) {
        return json({ error: '未检测到可注释的 schedule，可能该 workflow 无 on.schedule' }, 400);
      }
      await writeWorkflowFile(env, repo, workflow_path, newContent, sha, `chore: takeover schedule (${repo}) - disable GitHub cron, use scheduler`);
      state.repos[repo] = { cron, workflow_path, interval_minutes: state.global_interval_minutes ?? 5, taken_over: true, last_trigger: Date.now() };
      await saveState(env, state);
      return json({ ok: true, state: state.repos[repo] });
    } catch (e) {
      return json({ error: `接管失败: ${e.message}` }, 502);
    }
  }

  // 取消接管：读文件 → 取消注释 schedule → 写回 → 删调度表
  if (job === 'untakeover') {
    try {
      const { content, sha } = await readWorkflowFile(env, repo, workflow_path);
      const newContent = operateSchedule(content, 'untakeover');
      if (newContent !== content) {
        await writeWorkflowFile(env, repo, workflow_path, newContent, sha, `chore: restore schedule (${repo}) - hand control back to GitHub`);
      }
      delete state.repos[repo];
      await saveState(env, state);
      return json({ ok: true });
    } catch (e) {
      return json({ error: `取消接管失败: ${e.message}` }, 502);
    }
  }

  // 改 cron：若为该仓库调度表中的（已接管）→ 只改调度表；否则改 YAML
  if (job === 'setcron') {
    if (!cron || !cronValid(cron)) return json({ error: 'cron 非法' }, 400);
    const existing = state.repos[repo];
    if (existing && existing.taken_over) {
      // 已接管：只改调度表
      existing.cron = cron;
      await saveState(env, state);
      return json({ ok: true, state: existing });
    }
    // 未接管：改 YAML 真实 cron
    try {
      const { content, sha } = await readWorkflowFile(env, repo, workflow_path);
      const newContent = operateSchedule(content, 'setcron', cron);
      if (newContent === content) {
        return json({ error: '未找到可修改的 cron 行' }, 400);
      }
      await writeWorkflowFile(env, repo, workflow_path, newContent, sha, `chore: update cron schedule (${repo}) -> ${cron}`);
      return json({ ok: true, path: workflow_path });
    } catch (e) {
      return json({ error: `修改 cron 失败: ${e.message}` }, 502);
    }
  }

  return json({ error: `未知 job: ${job}` }, 400);
}