// 仓库 workflow 数据：拉取 GitHub → 精简字段 → KV 缓存
// 只存前端实际使用的字段（pickWorkflow/pickRun），避免原始响应里几十个冗余 URL 字段
// 缓存 TTL 600s：详情页 runs 延迟最多 10 分钟，换取 KV 写次数减半
import { gh, pickWorkflow, pickRun } from './github.js';
import { cached } from './cache.js';

export const WFDATA_TTL = 600;

export async function fetchWorkflowData(env, fullName) {
  return cached(env, `wfdata:v2:${fullName}`, WFDATA_TTL, async () => {
    const [owner, repo] = fullName.split('/');
    const [workflowsRes, runsRes] = await Promise.allSettled([
      gh(env, `/repos/${owner}/${repo}/actions/workflows?per_page=100`),
      gh(env, `/repos/${owner}/${repo}/actions/runs?per_page=100`),
    ]);
    const workflows = workflowsRes.status === 'fulfilled'
      ? (workflowsRes.value.workflows || []).map(pickWorkflow)
      : [];
    const runs = runsRes.status === 'fulfilled'
      ? (runsRes.value.workflow_runs || []).map(pickRun)
      : [];
    const errors = [];
    if (workflowsRes.status === 'rejected') errors.push(`workflows: ${workflowsRes.reason.message}`);
    if (runsRes.status === 'rejected') errors.push(`runs: ${runsRes.reason.message}`);
    return { workflows, runs, errors };
  });
}
