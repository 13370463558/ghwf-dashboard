// GET /api/cronPreview?cron=xxx — 校验 cron 并返回未来 5 次运行时间（北京时间）
import { CronExpressionParser } from 'cron-parser';
import { json } from '../lib/http.js';

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const cron = url.searchParams.get('cron') || '';

  if (!cron.trim()) return json({ error: 'cron 不能为空' }, 400);
  // 深度校验：cron-parser 能解析即合法
  let it;
  try {
    it = CronExpressionParser.parse(cron.trim());
  } catch {
    return json({ error: 'cron 表达式非法' }, 400);
  }

  // 拉未来 5 次（北京时间）
  const times = [];
  for (let i = 0; i < 5; i++) {
    const next = it.next().toDate();
    times.push(next.toISOString());
  }

  return json({ ok: true, cron: cron.trim(), times });
}