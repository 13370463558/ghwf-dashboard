// 哪吒探针 agent 拉起（容器版）
// 检测 .npm/nezha_agent 二进制 + .npm/nezha_agent.yml 配置存在，且 agent 未运行 → nohup 启动
// 用 node 原生 /proc 遍历检测进程（katabump 精简容器常缺 pgrep）
import { promises as fs } from 'fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const NZ_BIN = path.join(process.cwd(), '.npm', 'nezha_agent');
const NZ_CONF = path.join(process.cwd(), '.npm', 'nezha_agent.yml');

// 通过 /proc 判断 agent 是否在跑（按 config 路径匹配，避免误匹配其他进程）
async function isAgentRunning() {
  try {
    const procs = await fs.readdir('/proc');
    for (const p of procs) {
      if (!/^\d+$/.test(p)) continue;
      try {
        const cmdline = await fs.readFile(`/proc/${p}/cmdline`, 'utf8');
        if (cmdline.includes('nezha_agent') && cmdline.includes('nezha_agent.yml')) {
          return true;
        }
      } catch {
        /* 权限或已退出，跳过 */
      }
    }
  } catch {
    /* /proc 不可读，保守认为未运行 */
  }
  return false;
}

async function runAgent(env) {
  try {
    const [binOk, confOk] = await Promise.all([
      fs.access(NZ_BIN).then(() => true).catch(() => false),
      fs.access(NZ_CONF).then(() => true).catch(() => false),
    ]);
    if (!binOk) {
      console.log('[nezha] 未找到二进制 .npm/nezha_agent，跳过探针启动');
      return;
    }
    if (!confOk) {
      console.log('[nezha] 未找到配置 .npm/nezha_agent.yml，跳过探针启动');
      return;
    }
    if (await isAgentRunning()) {
      console.log('[nezha] agent 已在运行');
      return;
    }
    // 确保二进制有执行位（SFTP 上传往往丢失 x 位，运行前补）
    try {
      await fs.chmod(NZ_BIN, 0o755);
    } catch (e) {
      console.warn('[nezha] chmod 失败（可能仍无法执行）:', e.message);
    }
    console.log('[nezha] 启动哪吒探针…');
    // nohup 风格：完全脱离，日志重定向
    const child = spawn(NZ_BIN, ['-c', NZ_CONF], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    child.unref();
    // 日志单独写（用外层 shell 重定向不太可行，这里让子进程 stdout 丢弃即可）
    // 实际日志由 agent 自身写，或我们不收集（出错看面板）
  } catch (e) {
    console.error('[nezha] 启动失败:', e.message);
  }
}

// 暴露：容器 server.js 在启动时调用
export async function ensureNezha(env) {
  // 可通过环境变量开关（默认开）；且仅在容器版（非 CF）有意义
  if (process.env.NEZHA_DISABLE === '1' || process.env.NEZHA_DISABLE === 'true') {
    console.log('[nezha] NEZHA_DISABLE=1，跳过探针');
    return;
  }
  await runAgent(env);
}