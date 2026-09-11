// POST /api/workflowDispatch — 手动触发某个 workflow（GitHub dispatches API）
// body: { repo: "owner/name", workflowId: 123, ref: "main" }
import { json } from '../lib/http.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const body = await request.json().catch(() => null);
  const { repo, workflowId, ref } = body || {};
  if (!repo || !workflowId || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return json({ error: '参数错误：需要 repo / workflowId / ref' }, 400);
  }
  const [owner, name] = repo.split('/');
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${name}/actions/workflows/${workflowId}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ghwf-dashboard',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: ref || 'main' }),
      }
    );
    if (!res.ok) {
      let msg = `GitHub ${res.status}`;
      try {
        const e = await res.json();
        if (e?.message) msg = e.message;
      } catch {
        /* ignore */
      }
      return json({ error: `触发失败: ${msg}` }, 502);
    }
    // 触发成功 → 清该仓库 wfdata 缓存，下次拉取能看到新 run
    if (env.CACHE) await env.CACHE.delete(`wfdata:v2:${repo}`).catch(() => {});
    return json({ ok: true });
  } catch (err) {
    return json({ error: `触发失败: ${err.message}` }, 502);
  }
}
