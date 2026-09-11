// GitHub REST API 封装（全部在服务端调用，token 不落浏览器）
const GH_API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function gh(env, path, { method = 'GET' } = {}) {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ghwf-dashboard',
    },
  });
  if (!res.ok) {
    let detail = `GitHub API ${res.status}`;
    try {
      const body = await res.json();
      if (body?.message) detail += `: ${body.message}`;
      if (res.status === 403 && body?.message?.includes('rate limit')) {
        detail += '（触发速率限制）';
      }
    } catch {
      /* ignore */
    }
    throw new GitHubError(res.status, detail);
  }
  return res.json();
}

// 分页拉取 token 权限内的所有仓库
export async function listAllRepos(env) {
  const repos = [];
  let page = 1;
  for (;;) {
    const batch = await gh(
      env,
      `/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=${page}&sort=updated`
    );
    repos.push(...batch);
    if (batch.length < 100) break;
    page++;
    if (page > 20) break; // 最多 2000 个，防止死循环
  }
  return repos;
}

// 带并发上限的 map（防止次级速率限制）
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// 运行状态判断
export function runConclusionStats(runs) {
  const stats = { success: 0, failure: 0, cancelled: 0, other: 0, in_progress: 0, total: runs.length };
  for (const r of runs) {
    if (r.status === 'in_progress' || r.status === 'queued' || r.status === 'waiting' || r.status === 'requested') {
      stats.in_progress++;
    } else if (r.conclusion === 'success') {
      stats.success++;
    } else if (r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'startup_failure') {
      stats.failure++;
    } else if (r.conclusion === 'cancelled') {
      stats.cancelled++;
    } else {
      stats.other++;
    }
  }
  return stats;
}

// 精简 workflow / run 字段（KV 存储与前端展示用）
export function pickWorkflow(w) {
  return {
    id: w.id,
    name: w.name,
    path: w.path,
    state: w.state,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

export function pickRun(r) {
  return {
    id: r.id,
    name: r.name,
    workflow_id: r.workflow_id,
    run_number: r.run_number,
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    head_branch: r.head_branch,
    head_sha: r.head_sha,
    created_at: r.created_at,
    updated_at: r.updated_at,
    run_started_at: r.run_started_at,
    actor: r.actor ? { login: r.actor.login, avatar_url: r.actor.avatar_url } : null,
    html_url: r.html_url,
  };
}

// 从 runs（按 created_at 降序）构建 workflow_id → 最新 run 的映射
export function latestRunByWorkflow(runs) {
  const map = new Map();
  for (const r of runs) {
    if (!map.has(r.workflow_id)) map.set(r.workflow_id, r);
  }
  return map;
}
