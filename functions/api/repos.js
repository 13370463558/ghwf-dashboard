// GET /api/repos — 仓库 + workflow 概要
//   不带参数 → 默认组的仓库（主视图）；未设默认组 → 兜底返回全部
//   ?all=1    → 全部仓库（管理组勾选用）
// 缓存：repos:list 原始仓库列表 10min；repos:all 全量概览 10min；repos:g:<id> 组概览 5min
import { listAllRepos, gh, mapLimit, runConclusionStats, latestRunByWorkflow } from '../lib/github.js';
import { cached } from '../lib/cache.js';
import { getGroups } from '../lib/groups.js';
import { fetchWorkflowData } from '../lib/wfdata.js';
import { fetchCronRows, nextRunAt, countScheduledToday, beijingTodayWindow, scheduledTimesToday } from '../lib/crons.js';
import { json } from '../lib/http.js';

const LIST_TTL = 600;
const ALL_TTL = 600;
const GROUP_TTL = 300;
const CRON_TTL = 86400; // cron 解析结果缓存 24h，workflow 文件不常改
const CONCURRENCY = 6;

// 单个仓库的 workflows + runs（来自 lib/wfdata.js：精简字段 + KV 缓存，详情页与概览共享）

async function enrichRepo(env, repo, wfData) {
  const { workflows, runs, errors } = wfData;
  const lastByWorkflow = latestRunByWorkflow(runs);
  // workflows/runs 已由 lib/wfdata.js 精简，直接用
  const wfList = workflows.map((w) => ({
    ...w,
    last_run: lastByWorkflow.has(w.id) ? lastByWorkflow.get(w.id) : null,
  }));
  const stats = runConclusionStats(runs);
  const lastActivity = runs.length
    ? runs.reduce((max, r) => (r.created_at > max ? r.created_at : max), runs[0].created_at)
    : null;

  // 仓库级最近一次运行（卡片"上次运行"用）
  const lastRun = runs.length ? runs[0] : null;

  // cron 解析结果：24h TTL 缓存，miss 才读 workflow YAML（GitHub contents API）
  // 自动失效：仓库 pushed_at 或 workflow updated_at 快照变化（= 仓库有 push）→ 重新解析
  // （实测 workflows API 的 updated_at 不随文件变化，用 pushed_at 作为检测信号）
  const pushedAt = repo.pushed_at || '';
  const wfUpdated = workflows.map((w) => `${w.id}:${w.updated_at || ''}`).join('|');
  const snapshot = `${pushedAt}|${wfUpdated}`;
  // cron 解析失败（subrequest 超限/网络错误）绝不能导致仓库请求失败：
  // 有旧缓存 → 回退旧缓存；无 → 吞掉错误返回空（本轮 cron 不更新，下轮自动重试）
  let cronCache = null;
  try {
    cronCache = await cached(env, `cron:v3:${repo.full_name}`, CRON_TTL, async () => {
      const rows = await fetchCronRows(env, repo.full_name, workflows);
      return { rows, parsed_at: new Date().toISOString(), snapshot };
    });
    if (cronCache.snapshot !== snapshot) {
      // 检测到仓库有更新，重新解析 cron
      const rows = await fetchCronRows(env, repo.full_name, workflows);
      cronCache = { rows, parsed_at: new Date().toISOString(), snapshot };
      await env.CACHE.put(`cron:v3:${repo.full_name}`, JSON.stringify(cronCache), {
        expirationTtl: CRON_TTL,
      });
    }
  } catch {
    // cron 解析失败：不作为仓库错误上报
    if (!cronCache) cronCache = { rows: [], parsed_at: null, snapshot };
  }
  const crons = [];
  for (const row of cronCache.rows || []) {
    for (const cron of row.crons) {
      crons.push({
        workflow_name: row.name,
        cron,
        next_at: nextRunAt(cron),
      });
    }
  }

  // 北京时间"今天"：已运行次数（runs 落在今天窗口内）+ 计划运行次数（cron 今天应触发次数）
  const { startUtc, endUtc } = beijingTodayWindow();
  const today_runs = runs.filter((r) => {
    const t = new Date(r.created_at).getTime();
    return t >= startUtc.getTime() && t < endUtc.getTime();
  }).length;
  const today_scheduled = countScheduledToday(crons.map((c) => c.cron));

  // 图表数据：今天的计划触发时刻 + 实际运行时刻（分钟数，北京时间 0-1439）
  const RUNNING_STATUS = ['in_progress', 'queued', 'waiting', 'requested', 'pending'];
  const planned = scheduledTimesToday(crons.map((c) => c.cron));
  const runTimes = [];
  for (const r of runs) {
    const t = new Date(r.created_at).getTime();
    if (t < startUtc.getTime() || t >= endUtc.getTime()) continue;
    const started = r.run_started_at || r.created_at;
    const m = Math.round(((new Date(started).getTime() + 8 * 3600 * 1000) % 86400000) / 60000);
    let kind = 'neutral';
    if (RUNNING_STATUS.includes(r.status)) kind = 'running';
    else if (r.conclusion === 'success') kind = 'success';
    else if (['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)) kind = 'failure';
    runTimes.push({ m, kind });
  }
  runTimes.sort((a, b) => a.m - b.m);

  // 到时间未执行：计划时刻已过（北京），但该时刻后 6 小时内没有实际运行
  // （GitHub Actions schedule 延迟常见 1-5 小时，6 小时窗口覆盖大部分延迟）
  const nowMin = Math.round(((Date.now() + 8 * 3600 * 1000) % 86400000) / 60000);
  const missed = [];
  {
    const used = new Set();
    for (const p of planned) {
      if (p > nowMin) continue; // 还没到点
      const hit = runTimes.findIndex((r, idx) => !used.has(idx) && r.m >= p && r.m <= p + 360);
      if (hit >= 0) used.add(hit);
      else missed.push(p);
    }
  }

  return {
    full_name: repo.full_name,
    name: repo.name,
    owner: repo.owner ? repo.owner.login : null,
    private: repo.private,
    archived: !!repo.archived,
    description: repo.description,
    default_branch: repo.default_branch,
    html_url: repo.html_url,
    pushed_at: repo.pushed_at,
    updated_at: repo.updated_at,
    last_activity_at: lastActivity || repo.pushed_at,
    last_run: lastRun,
    workflows: wfList,
    run_stats: stats,
    crons,
    today_runs,
    today_scheduled,
    chart: { planned, runs: runTimes, missed },
    wf_error: errors.length ? errors.join('; ') : null,
  };
}

async function buildEnriched(env, repos) {
  return mapLimit(repos, CONCURRENCY, (repo) =>
    fetchWorkflowData(env, repo.full_name)
      .then((wfData) => enrichRepo(env, repo, wfData))
      .catch((err) => enrichRepo(env, repo, { workflows: [], runs: [], errors: [err.message] }))
  );
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const wantAll = url.searchParams.get('all') === '1';
  const groupCfg = await getGroups(env);

  try {
    const list = () => cached(env, 'repos:list', LIST_TTL, () => listAllRepos(env));

    // 管理用：全部仓库概览
    if (wantAll) {
      const data = await cached(env, 'repos:all:v3', ALL_TTL, async () => {
        const repos = await list();
        const enriched = await buildEnriched(env, repos);
        return { repos: enriched, generated_at: new Date().toISOString() };
      });
      return json({
        ...data,
        groups: groupCfg.groups,
        defaultGroupId: groupCfg.defaultGroupId,
        scope: 'all',
        group: null,
      });
    }

    // 主视图：默认组
    const defaultGroup = groupCfg.groups.find((g) => g.id === groupCfg.defaultGroupId) || null;
    if (!defaultGroup) {
      // 未设置默认组：兜底显示全部 + 提示前端引导建组
      const data = await cached(env, 'repos:all:v3', ALL_TTL, async () => {
        const repos = await list();
        const enriched = await buildEnriched(env, repos);
        return { repos: enriched, generated_at: new Date().toISOString() };
      });
      return json({
        ...data,
        groups: groupCfg.groups,
        defaultGroupId: null,
        scope: 'all',
        group: null,
      });
    }

    const data = await cached(env, `repos:g:v3:${defaultGroup.id}`, GROUP_TTL, async () => {
      const repos = await list();
      const byName = new Map(repos.map((r) => [r.full_name, r]));
      const inGroup = defaultGroup.repos.map((name) => byName.get(name)).filter(Boolean);
      const enriched = await buildEnriched(env, inGroup);
      return { repos: enriched, generated_at: new Date().toISOString() };
    });

    return json({
      ...data,
      groups: groupCfg.groups,
      defaultGroupId: groupCfg.defaultGroupId,
      scope: 'default',
      group: { id: defaultGroup.id, name: defaultGroup.name },
    });
  } catch (err) {
    return json({ error: `获取仓库失败: ${err.message}` }, 502);
  }
}
