// GET /api/cron?repo=owner/name — 单独拉取/补齐某个仓库的 cron 信息
// 独立请求，subrequest 配额充足，不受 /api/repos 批量 50 上限影响
// 用于前端逐仓库补齐 cron（概览 /api/repos 只返回已有缓存，缺失的靠这里补）
import { fetchWorkflowData } from '../lib/wfdata.js';
import { getCronCache, forceRefreshCron } from '../lib/cronCache.js';
import { nextRunAt } from '../lib/crons.js';
import { json } from '../lib/http.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const repo = url.searchParams.get('repo') || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return json({ error: '参数 repo 格式应为 owner/name' }, 400);
  }

  // 可选强制刷新：?force=1
  const force = url.searchParams.get('force') === '1';

  try {
    // 读该仓库 wfdata（精简缓存），拿 workflows 列表
    const wfData = await fetchWorkflowData(env, repo);
    const workflows = wfData.workflows || [];

    // 强制刷新则忽略快照直接重解析，否则走缓存
    const cache = force
      ? await forceRefreshCron(env, repo, workflows)
      : await getCronCache(env, repo, workflows, '');
    const rows = cache.rows || [];

    // 转成前端卡片需要的格式
    const crons = [];
    const dispatchMap = new Map();
    for (const row of rows) {
      dispatchMap.set(row.id, !!row.dispatchable);
      for (const cron of row.crons) {
        crons.push({ workflow_name: row.name, path: row.path, cron, next_at: nextRunAt(cron) });
      }
    }

    // 顺带返回每个 workflow 的可手动触发状态（详情页用）
    const workflowsEnhanced = workflows.map((w) => ({
      ...w,
      dispatchable: !!dispatchMap.get(w.id),
    }));

    return json({ repo, crons, workflows: workflowsEnhanced, parsed_at: cache.parsed_at });
  } catch (err) {
    return json({ error: `获取 cron 失败: ${err.message}` }, 502);
  }
}