// YAML 操作：读/改 .github/workflows/*.yml 的 on.schedule
// 只用行级文本操作（不引入完整 YAML 序列化器），避免破坏文件其他内容
// 支持三种操作：
//   takeover   → 注释掉 on.schedule 中的 cron 行（接管：交给调度器）
//   untakeover → 取消注释 on.schedule（还原）
//   setcron    → 改 on.schedule 的 cron 值（未接管时）
//
// 注意：base64 编解码必须用 atob/btoa（Workerd 环境没有全局 Buffer），
//       并按 UTF-8 正确处理中文（atob 返回 latin1 字节串，需 TextDecoder 还原）
import { gh } from './github.js';

// 从 GitHub 读 workflow 文件（raw 文本 + sha）
export async function readWorkflowFile(env, fullName, path) {
  const [owner, repo] = fullName.split('/');
  const data = await gh(env, `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
  // atob → latin1 字节串 → 按 UTF-8 解码
  const bytes = Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0));
  const content = new TextDecoder().decode(bytes);
  return { content, sha: data.sha };
}

// 写回 GitHub（PUT Contents，需 commit）
export async function writeWorkflowFile(env, fullName, path, content, sha, message) {
  const [owner, repo] = fullName.split('/');
  // 按 UTF-8 编码 → latin1 字节 → btoa
  const bytes = new TextEncoder().encode(content);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'ghwf-dashboard',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ message, content: b64, sha }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`写文件失败 ${res.status}: ${e.message || res.statusText}`);
  }
  return res.json();
}

// 行级操作 schedule 区块
// 策略：找到 `schedule:` 行，记录其缩进；在其后的、缩进大于 schedule 缩进的行中找 `- cron:` 行处理
export function operateSchedule(content, action, newCron) {
  const lines = content.split(/\r?\n/);
  const out = [];
  let scheduleIndent = -1; // 'schedule:' 的缩进
  let inSchedule = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();

    if (/^schedule\s*:/.test(trimmed)) {
      // 进入 schedule 区块
      inSchedule = true;
      scheduleIndent = indent;
      out.push(line);
      continue;
    }

    if (inSchedule) {
      // 遇到缩进 <= schedule 且非空非注释的行 → 区块结束
      if (trimmed !== '' && !trimmed.startsWith('#') && indent <= scheduleIndent) {
        inSchedule = false;
      }
    }

    const isCronLine = /^-\s*cron\s*:/.test(trimmed);
    const isCommentCron = /^#\s*-\s*cron\s*:/.test(trimmed);

    if (inSchedule && isCronLine && !line.trim().startsWith('#')) {
      if (action === 'takeover') {
        // 注释这个 cron 行（保留缩进，行首加 # ）
        out.push(line.replace(/^(\s*)/, '$1# '));
        continue;
      } else if (action === 'untakeover') {
        // 本不应出现在这里，但若存在未注释的 cron 保持原样
        out.push(line);
        continue;
      } else if (action === 'setcron') {
        // 改值
        out.push(line.replace(
          /^(\s*-\s*cron\s*:\s*)(?:'[^']*'|"[^"]*"|.*)$/,
          (_m, prefix) => `${prefix}'${newCron}'`
        ));
        continue;
      }
    } else if (inSchedule && isCommentCron) {
      if (action === 'untakeover') {
        // 取消注释：去掉 缩进 后的 # 和一个空格
        out.push(line.replace(/^(\s*)#\s?/, '$1'));
        continue;
      } else if (action === 'takeover') {
        // 已注释的保持注释
        out.push(line);
        continue;
      } else if (action === 'setcron') {
        // 未接管不该有注释 cron；保持
        out.push(line);
        continue;
      }
    }

    out.push(line);
  }

  return out.join('\n');
}

// 校验 cron 表达式合法性（返回 null 表示合法，否则返回错误信息）
export function validateCron(cron) {
  if (typeof cron !== 'string' || !cron.trim()) return 'cron 表达式不能为空';
  const cronStr = cron.trim();
  const parts = cronStr.split(/\s+/);
  if (parts.length !== 5) return 'cron 必须为 5 段（分 时 日 月 周）';
  return null; // 其它深度校验交给 cron-parser（在调用方做）
}