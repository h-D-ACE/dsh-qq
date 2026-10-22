// 定时任务的时区工具：所有计算都按任务自己的时区（默认北京时间），与这台机器的时区无关。
// 只用 Node 自带的 Intl，不引入依赖。

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** 时区名是否可用（Intl 认得）。 */
export function isValidTimeZone(tz) {
  try { formatter(String(tz)); return true; } catch { return false; }
}

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** 某一时刻在某时区的墙上时间：{ year, month, day, hour, minute, second, weekday(1=周一…7=周日) }。 */
export function zonedParts(ms, tz) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    weekday: WEEKDAY[parts.weekday] ?? 0,
  };
}

/**
 * 时区里的墙上时间 → UTC 毫秒。夏令时跳过的时刻（不存在的时间）落到跳变之后；重复的时刻取较早的一次。
 * 做法：先当成 UTC 猜一个时刻，再用该时刻的实际偏移修正两次。
 */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, tz) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(guess, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = target - asUtc;
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
}

/** 'YYYY-MM-DD'（按时区）。 */
export function dateKey(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 解析 'YYYY-MM-DD'；不合法返回 null。 */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** 解析 'HH:mm'；不合法返回 null。 */
export function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]); const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export const fmtTime = ({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
export const fmtDate = ({ year, month, day }) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 日历日加减（不涉及时区）。 */
export function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 日历日的星期（1=周一…7=周日）。 */
export function weekdayOf({ year, month, day }) {
  const w = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** 两个日历日之间相差几天（b - a）。 */
export function dayDiff(a, b) {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** 某时刻在某时区的 UTC 偏移，例如 'UTC+8'、'UTC-5'、'UTC+5:30'（夏令时会变，所以要带时刻）。 */
export function utcOffsetLabel(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const mins = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = mins < 0 ? '-' : '+';
  const a = Math.abs(mins);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}

/** 给人看的时间：'2026-10-22 06:00（北京时间 UTC+8）'、'2026-10-22 06:00（America/Chicago UTC-5）'。 */
export function describeInstant(ms, tz) {
  const p = zonedParts(ms, tz);
  if (/^(Etc\/)?(UTC|GMT|Zulu)$/i.test(tz)) return `${fmtDate(p)} ${fmtTime(p)}（UTC）`;
  const label = tz === 'Asia/Shanghai' ? '北京时间' : tz;
  return `${fmtDate(p)} ${fmtTime(p)}（${label} ${utcOffsetLabel(ms, tz)}）`;
}
