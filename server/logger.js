// 调度器日志：带时间戳输出到控制台 + 写入日志文件
// 日志文件 data/logs/scheduler.log，每天 0 点（北京时间）清空重写
import { promises as fs } from 'fs';
import path from 'node:path';

const LOG_FILE = path.join('data', 'logs', 'scheduler.log');

export function createLogger() {
  let dayKey = ''; // 当前北京日期，跨天时清空重写

  function todayKey() {
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  }

  // 时间戳：UTC + 北京时间对照（调度按 UTC 语义，便于看时区）
  function ts() {
    const now = new Date();
    const utc = now.toISOString().slice(0, 19);
    const bj = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    return `${utc} UTC / ${bj} 北京`;
  }

  async function write(line) {
    try {
      // 跨天 → 清空旧日志（每天 0 点清除）
      const k = todayKey();
      if (k !== dayKey) {
        dayKey = k;
        await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
        await fs.writeFile(LOG_FILE, '', 'utf8'); // 清空
      } else {
        await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
      }
      await fs.appendFile(LOG_FILE, line + '\n', 'utf8');
    } catch (e) {
      console.error('[logger] 写日志失败:', e.message);
    }
  }

  return {
    log(msg) {
      const line = `[${ts()}] ${msg}`;
      console.log(line);
      write(line);
    },
    error(msg) {
      const line = `[${ts()}] [ERROR] ${msg}`;
      console.error(line);
      write(line);
    },
    getFilePath() {
      return LOG_FILE;
    },
  };
}