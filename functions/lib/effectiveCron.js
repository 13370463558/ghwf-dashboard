// 有效 cron 计算：合并调度表（接管仓库）与 YAML 解析结果
// 接管仓库 → cron 以调度表为准（显示/统计/调度统一用这里的值）
// 未接管仓库 → 用 YAML 解析的 cron
const STATE_KEY = 'scheduler:state';

export async function getSchedulerState(env) {
  try {
    const raw = await env.CACHE?.get(STATE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { repos: {}, global_interval_minutes: 5 };
}

// 合并：返回 { crons: [...], takenOverMap: {full_name: {cron,...}} }
// crons 元素：{ workflow_name, path, cron, next_at }
// 后期望一个仓库通常租用调度表的 cron（接管时为用户的 cron）
export async function buildEffectiveCrons(env, fullName, yamlCrons) {
  const state = await getSchedulerState(env);
  const takeover = state.repos?.[fullName];
  if (takeover?.taken_over) {
    // 接管：用调度表的 cron
    const effective = [{
      workflow_name: takeover.workflow_path.split('/').pop().replace(/\.ya?ml$/i, ''),
      path: takeover.workflow_path,
      cron: takeover.cron,
      next_at: null, // 下面统一计算
      taken_over: true,
    }];
    return { crons: effective, takenOver: takeover };
  }
  // 未接管：用 YAML cron
  return { crons: yamlCrons, takenOver: null };
}