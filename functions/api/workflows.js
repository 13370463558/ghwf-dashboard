// GET /api/workflows?repo=owner/name — 指定仓库的 workflows + 最近 100 次 runs（详情页）
// 数据来自 lib/wfdata.js（精简字段 + KV 缓存），每个 workflow 附加 last_run / dispatchable
import { latestRunByWorkflow } from '../lib/github.js';
import { fetchWorkflowData } from '../lib/wfdata.js';
import { json } from '../lib/http.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const repo = url.searchParams.get('repo') || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return json({ error: '参数 repo 格式应为 owner/name' }, 400);
  }

  try {
    const data = await fetchWorkflowData(env, repo);

    // 每个 workflow 附加最近一次 run + 是否可手动触发（dispatchable，来自 cron 缓存）
    const lastByWorkflow = latestRunByWorkflow(data.runs || []);
    const dispatchMap = new Map();
    if (env.CACHE) {
      const cronRaw = await env.CACHE.get(`cron:v3:${repo}`).catch(() => null);
      if (cronRaw) {
        try {
          const c = JSON.parse(cronRaw);
          for (const row of c.rows || []) dispatchMap.set(row.id, !!row.dispatchable);
        } catch {
          /* ignore */
        }
      }
    }
    const workflows = (data.workflows || []).map((w) => ({
      ...w,
      dispatchable: !!dispatchMap.get(w.id),
      last_run: lastByWorkflow.has(w.id) ? lastByWorkflow.get(w.id) : null,
    }));

    return json({
      repo,
      workflows,
      runs: data.runs,
      errors: data.errors,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return json({ error: `获取工作流失败: ${err.message}` }, 502);
  }
}
