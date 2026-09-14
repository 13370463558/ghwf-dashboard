// 调度表备份：定期把 scheduler:state 同步一份到 GitHub 仓库（JSON 文件）
// 目的：容器磁盘损坏/重装时调度表可恢复——被接管仓库的 YAML schedule 已注释掉，
//       调度表一旦丢失，所有续期任务同时静默中断，必须异地备份。
// 配置（env / .env，可选）：
//   SCHED_BACKUP_REPO   备份仓库，默认 GITHUB_TOKEN 所有者的 ghwf-dashboard（或 SCHED_BACKUP_REPO='owner/name'）
//   SCHED_BACKUP_PATH   文件路径，默认 data/scheduler-state.backup.json
//   SCHED_BACKUP_BRANCH 分支，默认 main
// 行为：
//   - backupSchedulerState(env)：state 有实质变化才写（比较上次备份内容，相同跳过）
//   - 5 分钟内多次调用自动去抖（备份是兜底，不需要每次变更即时）
//   - 失败静默（记 console），不阻塞主流程；备份失败主数据不受影响

const DEBOUNCE_MS = 5 * 60 * 1000;
const MOD_HEAD = 'chore(scheduler): auto backup scheduler state';

// 内存去抖（进程级）：repo -> { lastRun: ms, lastContent: string }
const memDebounce = new Map();

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function ghRaw(env, path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ghwf-dashboard-sched-backup',
    },
    body,
  });
  return res;
}

export async function backupSchedulerState(env, state, { force = false } = {}) {
  const repoFull = env.SCHED_BACKUP_REPO || '';
  if (!repoFull || !/^[\w.-]+\/[\w.-]+$/.test(repoFull)) return; // 未配置，跳过
  const filePath = env.SCHED_BACKUP_PATH || 'data/scheduler-state.backup.json';
  const branch = env.SCHED_BACKUP_BRANCH || 'main';

  const content = JSON.stringify({ backed_up_at: new Date().toISOString(), state }, null, 2);

  // 去抖 + 内容比对：内容与上次相同或距上次 <5min（非 force），跳过
  const d = memDebounce.get(repoFull) || {};
  if (!force) {
    if (d.lastContent === content) return;
    if (d.lastRun && Date.now() - d.lastRun < DEBOUNCE_MS) return;
  }

  const encPath = filePath.split('/').map(encodeURIComponent).join('/');
  try {
    // 读现有文件（拿 sha；404 = 新文件）
    const getRes = await ghRaw(env, `/repos/${repoFull}/contents/${encPath}?ref=${encodeURIComponent(branch)}`);
    let sha = null;
    if (getRes.ok) {
      const data = await getRes.json().catch(() => ({}));
      // 内容一致就不用再写（省 commit）
      const bytes = Uint8Array.from(atob(data.content || ''), (c) => c.charCodeAt(0));
      const existing = new TextDecoder().decode(bytes);
      try {
        if (existing && JSON.parse(existing)?.state && JSON.stringify(JSON.parse(existing).state) === JSON.stringify(state)) {
          memDebounce.set(repoFull, { lastRun: Date.now(), lastContent: content });
          return;
        }
      } catch { /* 损坏的备份文件，直接覆盖 */ }
      sha = data.sha;
    }

    // 写回
    const putRes = await ghRaw(env, `/repos/${repoFull}/contents/${encPath}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `${MOD_HEAD} ${new Date().toISOString()}`,
        content: b64encode(content),
        sha: sha || undefined,
        branch,
      }),
    });
    if (!putRes.ok) {
      console.error('[sched-backup] 备份失败:', putRes.status, (await putRes.text().catch(() => '')).slice(0, 200));
      return;
    }
    memDebounce.set(repoFull, { lastRun: Date.now(), lastContent: content });
    console.log(`[sched-backup] 调度表已备份 → ${repoFull}/${filePath}@${branch}`);
  } catch (e) {
    console.error('[sched-backup] 备份异常:', e.message);
  }
}

// 恢复：从备份仓库读回 state（面板/手动恢复用）
export async function restoreSchedulerStateFromBackup(env) {
  const repoFull = env.SCHED_BACKUP_REPO || '';
  if (!repoFull || !/^[\w.-]+\/[\w.-]+$/.test(repoFull)) return null;
  const filePath = env.SCHED_BACKUP_PATH || 'data/scheduler-state.backup.json';
  const branch = env.SCHED_BACKUP_BRANCH || 'main';
  const encPath = filePath.split('/').map(encodeURIComponent).join('/');
  const res = await ghRaw(env, `/repos/${repoFull}/contents/${encPath}?ref=${encodeURIComponent(branch)}`);
  if (!res.ok) throw new Error(`读取备份失败 ${res.status}`);
  const data = await res.json();
  const bytes = Uint8Array.from(atob(data.content || ''), (c) => c.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return parsed?.state || null;
}
