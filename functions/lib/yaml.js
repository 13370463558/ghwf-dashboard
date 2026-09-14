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
// 策略：
//   接管(takeover)：注释整个 `schedule:` 块（schedule: 行 + 其下所有行），使 on 下只留 workflow_dispatch，
//                    避免留下空 `schedule:` 导致 GitHub 解析报错（422 "Unexpected value ''"）
//   取消接管(untakeover)：取消注释整个 schedule 块
//   改cron(setcron)：只改 schedule 内 cron 的值（未接管时）
//
// ensureWorkflowDispatch(content)：on: 块内没有 workflow_dispatch 时自动插入（接管前提：
//   GitHub 只有配了 workflow_dispatch 的 workflow 才能被 API dispatch，否则接管后必然 422 失败风暴）
export function ensureWorkflowDispatch(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  let onLineIdx = -1; // 'on:' 行位置
  let onIndent = 0; // on: 的缩进
  let hasWorkflowDispatch = false; // 未注释的 workflow_dispatch 键
  let workflowIndent = null; // on: 下一级键的缩进（用于插入对齐）

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.match(/^\s*/)[0].length;

    // 找到 on: 行（未注释；兼容 'on' 与 on 两种写法）
    if (onLineIdx === -1 && (/^on\s*:/.test(trimmed) || /^'on'\s*:/.test(trimmed)) && !trimmed.startsWith('#')) {
      onLineIdx = i;
      onIndent = indent;
      out.push(line);
      continue;
    }

    if (onLineIdx !== -1) {
      // on: 块内：遇到缩进 <= on: 且非空非注释的行 → on 块结束
      if (trimmed !== '' && !trimmed.startsWith('#') && indent <= onIndent) {
        // on 块结束前若还没插入，在这之前补（保持 workflow_dispatch 在 on 块内的缩进）
        if (!hasWorkflowDispatch) {
          const wdIndent = workflowIndent !== null ? workflowIndent : onIndent + 2;
          out.push(' '.repeat(wdIndent) + 'workflow_dispatch:');
        }
        out.push(line);
        onLineIdx = -2; // 标记已处理完毕
        continue;
      }
      // 记录 on: 下一级的缩进（第一个子键）
      if (workflowIndent === null && trimmed !== '' && indent > onIndent) {
        workflowIndent = indent;
      }
      // 检测 workflow_dispatch 键（未注释；schedule 注释行里的 workflow_dispatch 也算——已注释的 schedule 块不覆盖它）
      if (/^(workflow_dispatch|#\s*workflow_dispatch)\s*:/.test(trimmed)) {
        // 已注释的 # workflow_dispatch: → 取消注释（激活）
        if (trimmed.startsWith('#')) {
          out.push(line.replace(/^(\s*)#\s?/, '$1'));
          hasWorkflowDispatch = true;
          continue;
        }
        hasWorkflowDispatch = true;
      }
      out.push(line);
      continue;
    }

    out.push(line);
  }

  // on: 块是文件末尾（没有遇到结束行）→ 追加在末尾
  if (onLineIdx !== -2 && onLineIdx !== -1 && !hasWorkflowDispatch) {
    const wdIndent = workflowIndent !== null ? workflowIndent : onIndent + 2;
    out.push(' '.repeat(wdIndent) + 'workflow_dispatch:');
  }

  return out.join('\n');
}

// 行级操作 schedule 区块（原逻辑）
export function operateSchedule(content, action, newCron) {
  const lines = content.split(/\r?\n/);
  const out = [];
  let scheduleIndent = -1; // 'schedule:' 的缩进
  let inSchedule = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();

    // 检测 schedule: 行（未注释状态）
    const isScheduleHeader = /^schedule\s*:/.test(trimmed) && !trimmed.startsWith('#');
    // 检测已注释的 schedule: 行（取消接管要还原）
    const isScheduleHeaderComment = /^#\s*schedule\s*:/.test(trimmed);

    if (isScheduleHeader || isScheduleHeaderComment) {
      const wasComment = trimmed.startsWith('#');
      // 进入 schedule 区块
      inSchedule = true;
      scheduleIndent = indent;
      out.push(applyScheduleLine(line, wasComment));
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
        // 注释这个 cron 行
        out.push(line.replace(/^(\s*)/, '$1# '));
        continue;
      } else if (action === 'setcron') {
        // 改值
        out.push(line.replace(
          /^(\s*-\s*cron\s*:\s*)(?:'[^']*'|"[^"]*"|.*)$/,
          (_m, prefix) => `${prefix}'${newCron}'`
        ));
        continue;
      } else if (action === 'untakeover') {
        // 已是未注释 cron（理论上不该），保持
        out.push(line);
        continue;
      }
    } else if (inSchedule && (isCommentCron || (/^#\s+-/.test(trimmed)))) {
      // schedule 内的注释行（原 cron 注释或其它注释），取消接管时还原非 schedule 头行
      if (action === 'takeover') {
        // 已注释保持注释
        out.push(line);
        continue;
      } else if (action === 'setcron') {
        // schedule 内的注释 cron 在 setcron 时保持（接管时 setcron 走调度表，不会到 YAML）
        out.push(line);
        continue;
      }
      // untakeover：对非 schedule-header 的注释行取消注释（还原 cron）
      if (action === 'untakeover' && isCommentCron) {
        out.push(line.replace(/^(\s*)#\s?/, '$1'));
        continue;
      }
    }

    out.push(line);
  }

  function applyScheduleLine(line, alreadyComment) {
    if (action === 'takeover' && !alreadyComment) {
      // 注释 schedule: 行
      return line.replace(/^(\s*)/, '$1# ');
    }
    if (action === 'untakeover' && alreadyComment) {
      // 还原 schedule: 行
      return line.replace(/^(\s*)#\s?/, '$1');
    }
    return line; // setcron 时 schedule 行保持原样
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