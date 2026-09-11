// 格式化工具
export function relativeTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = then - Date.now(); // 正数 = 未来
  const abs = Math.abs(diff);
  const sec = Math.floor(abs / 1000);
  const suffix = diff > 0 ? '后' : '前';
  if (sec < 60) return diff > 0 ? '即将' : '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟${suffix}`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时${suffix}`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天${suffix}`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function shortSha(sha) {
  return sha ? sha.slice(0, 7) : '—';
}

// 下次运行时间 → 北京时间显示：今天/明天/日期 + HH:mm
export function beijingNext(iso) {
  if (!iso) return '—';
  const target = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const hh = String(target.getUTCHours()).padStart(2, '0');
  const mm = String(target.getUTCMinutes()).padStart(2, '0');
  const same = (a, b) =>
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(now.getUTCDate() + 1);
  if (same(target, now)) return `今天 ${hh}:${mm}`;
  if (same(target, tomorrow)) return `明天 ${hh}:${mm}`;
  return `${target.getUTCMonth() + 1}月${target.getUTCDate()}日 ${hh}:${mm}`;
}

// 该时间点是否落在北京时间"今天"
export function isBeijingToday(iso) {
  if (!iso) return false;
  const target = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return (
    target.getUTCFullYear() === now.getUTCFullYear() &&
    target.getUTCMonth() === now.getUTCMonth() &&
    target.getUTCDate() === now.getUTCDate()
  );
}
