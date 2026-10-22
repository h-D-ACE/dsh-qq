// 定时规则：校验 / 规范化，以及「某时刻之后的下一次执行时间」。
//
// 支持的规则（schedule.type）：
//   once           一次性：{ date:'YYYY-MM-DD', time:'HH:mm' }
//   daily          每天：{ times:['06:00', …] }
//   weekly         每周：{ weekdays:[1..7]（1=周一）, times }
//   workdays       工作日：{ times }（周一至周五，去掉内置的法定节假日；调休上班的周末不算）
//   monthly        每月几号：{ days:[1..31 或 -1=最后一天], times }（当月没有 31 号时用最后一天）
//   monthlyWeekday 每月第几个周几：{ nth:1..5 或 -1=最后一个, weekday:1..7, times }
//   yearly         每年：{ dates:['MM-DD'], times }（2 月 29 日只在闰年）
//   dates          特殊日期：{ items:[{ date, time }] }
//   everyNDays     每隔 N 天：{ every:N, startDate, times }
//   interval       每隔 N 分钟：{ everyMinutes, window?:['08:00','23:00'] }（从当天 window 起点或 0 点算起）
//   dailyRandom    每天随机几次：{ count, window:['09:00','22:00'], minGapMin }
//   monthlyRandom  每月随机几次：{ count, dayRange:[1,28], window, minGapMin }
//   cron           高级：5 段 cron 表达式 { expr:'0 9 * * 1-5' }（分 时 日 月 周；周 0 和 7 都是周日；
//                  日和周都限定时按「任一满足」，与常见 cron 一致；只能在控制台设置，AI 不能用）
// 通用：startDate / endDate（含当天）、excludeDates:['YYYY-MM-DD']、excludeHolidays（跳过法定节假日）。
//
// 随机规则用「任务种子 + 日期」做确定性随机：同一天算几次都是同样的时刻，重启不会重抽、不会多发。

import {
  zonedParts, zonedToUtc, parseDate, parseTime, fmtTime, fmtDate, daysInMonth, addDays, weekdayOf, dayDiff,
} from './time.js';

export const SCHEDULE_TYPES = Object.freeze([
  'once', 'daily', 'weekly', 'workdays', 'monthly', 'monthlyWeekday', 'yearly', 'dates', 'everyNDays', 'interval', 'dailyRandom', 'monthlyRandom', 'cron',
]);

// ── cron ────────────────────────────────────────────────────────────────────
const CRON_FIELDS = [
  { name: '分', min: 0, max: 59 },
  { name: '时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12, names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] },
  { name: '周', min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] },
];
const CRON_MACROS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
const MAX_CRON_PER_DAY = 288;

function cronValue(token, f) {
  const up = token.toUpperCase();
  const idx = f.names ? f.names.indexOf(up) : -1;
  if (idx >= 0) return f.name === '月' ? idx + 1 : idx;
  if (!/^\d+$/.test(token)) throw new Error(`cron 的「${f.name}」段里「${token}」不是数字`);
  return Number(token);
}

/** 解析一段 cron 字段 → { set: Set<number>, any: boolean }。 */
function parseCronField(text, f) {
  const set = new Set();
  const any = text === '*' || text === '?';
  for (const part of text.split(',')) {
    const m = /^(\*|\?|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron 的「${f.name}」段「${part}」写法不对`);
    const step = m[2] ? Number(m[2]) : 1;
    if (!(step >= 1)) throw new Error(`cron 的「${f.name}」段步长要 ≥ 1`);
    let lo; let hi;
    if (m[1] === '*' || m[1] === '?') { lo = f.min; hi = f.max; }
    else if (m[1].includes('-')) { const [a, b] = m[1].split('-'); lo = cronValue(a, f); hi = cronValue(b, f); }
    else { lo = cronValue(m[1], f); hi = m[2] ? f.max : lo; }
    if (lo < f.min || hi > f.max || lo > hi) throw new Error(`cron 的「${f.name}」段超出范围（${f.min}～${f.max}）`);
    for (let v = lo; v <= hi; v += step) set.add(f.name === '周' && v === 7 ? 0 : v);
  }
  return { set, any };
}

/** 解析 cron 表达式；不合法抛 Error（给人看的原因）。 */
export function parseCron(expr) {
  let e = String(expr ?? '').trim().replace(/\s+/g, ' ');
  if (CRON_MACROS[e.toLowerCase()]) e = CRON_MACROS[e.toLowerCase()];
  const parts = e.split(' ');
  if (parts.length !== 5) throw new Error('cron 要写 5 段：分 时 日 月 周，例如「0 9 * * 1-5」（工作日早上 9 点）');
  const [minute, hour, dom, month, dow] = parts.map((t, i) => parseCronField(t, CRON_FIELDS[i]));
  if (minute.set.size * hour.set.size > MAX_CRON_PER_DAY) throw new Error(`cron 一天会触发 ${minute.set.size * hour.set.size} 次，太多了（最多 ${MAX_CRON_PER_DAY} 次）`);
  return { minute, hour, dom, month, dow, expr: e };
}

function cronDayMatches(c, day) {
  if (!c.month.set.has(day.month)) return false;
  const wd = weekdayOf(day) % 7; // 0=周日
  const domHit = c.dom.set.has(day.day);
  const dowHit = c.dow.set.has(wd);
  if (c.dom.any && c.dow.any) return true;
  if (c.dom.any) return dowHit;
  if (c.dow.any) return domHit;
  return domHit || dowHit;
}
export const MAX_TIMES_PER_DAY = 24;
const SEARCH_DAYS = 800; // 每年 2 月 29 日最远要找 4 年 → 另行处理；其余规则 800 天内必有结果

function fail(message) { throw new Error(message); }

function normTimes(list, field = 'times') {
  const arr = Array.isArray(list) ? list : (list != null ? [list] : []);
  const out = [];
  for (const t of arr) {
    const p = parseTime(t);
    if (!p) fail(`时间「${t}」格式不对，要写成 HH:mm（例如 06:00）`);
    const s = fmtTime(p);
    if (!out.includes(s)) out.push(s);
  }
  if (!out.length) fail(`请至少填一个时间（${field}）`);
  if (out.length > MAX_TIMES_PER_DAY) fail(`一天最多 ${MAX_TIMES_PER_DAY} 个时间`);
  return out.sort();
}

function normWindow(w, fallback = ['00:00', '23:59']) {
  const arr = Array.isArray(w) && w.length === 2 ? w : fallback;
  const a = parseTime(arr[0]); const b = parseTime(arr[1]);
  if (!a || !b) fail('时间段格式不对，要写成 ["09:00","22:00"]');
  const am = a.hour * 60 + a.minute; const bm = b.hour * 60 + b.minute;
  if (bm <= am) fail('时间段的结束要晚于开始（不支持跨午夜）');
  return [fmtTime(a), fmtTime(b)];
}

function normDateOpt(s, label) {
  if (s == null || s === '') return null;
  const d = parseDate(s);
  if (!d) fail(`${label}「${s}」格式不对，要写成 YYYY-MM-DD`);
  return fmtDate(d);
}

function intIn(v, min, max, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label}要是 ${min}～${max} 的整数`);
  return n;
}

/** 校验并规范化一条规则；不合法抛 Error（message 给人看）。 */
export function normalizeSchedule(input) {
  const s = input && typeof input === 'object' ? input : {};
  const type = String(s.type ?? '');
  if (!SCHEDULE_TYPES.includes(type)) fail(`不支持的重复方式「${type}」`);
  const out = { type };
  switch (type) {
    case 'once': {
      const d = parseDate(s.date); const t = parseTime(s.time);
      if (!d) fail('一次性任务要填日期（YYYY-MM-DD）');
      if (!t) fail('一次性任务要填时间（HH:mm）');
      out.date = fmtDate(d); out.time = fmtTime(t);
      break;
    }
    case 'daily': case 'workdays':
      out.times = normTimes(s.times); break;
    case 'weekly': {
      const days = [...new Set((Array.isArray(s.weekdays) ? s.weekdays : []).map(Number))].filter((n) => n >= 1 && n <= 7).sort();
      if (!days.length) fail('每周任务要选至少一天');
      out.weekdays = days; out.times = normTimes(s.times); break;
    }
    case 'monthly': {
      const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))].filter((n) => (n >= 1 && n <= 31) || n === -1).sort((a, b) => (a === -1 ? 99 : a) - (b === -1 ? 99 : b));
      if (!days.length) fail('每月任务要选至少一个日子（1～31，或 -1 表示最后一天）');
      out.days = days; out.times = normTimes(s.times); break;
    }
    case 'monthlyWeekday':
      out.nth = Number(s.nth) === -1 ? -1 : intIn(s.nth, 1, 5, '第几个');
      out.weekday = intIn(s.weekday, 1, 7, '周几');
      out.times = normTimes(s.times); break;
    case 'yearly': {
      const dates = [];
      for (const md of Array.isArray(s.dates) ? s.dates : []) {
        const m = /^(\d{2})-(\d{2})$/.exec(String(md).trim());
        if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) < 1 || Number(m[2]) > daysInMonth(2024, Number(m[1]))) fail(`日期「${md}」格式不对，要写成 MM-DD`);
        if (!dates.includes(`${m[1]}-${m[2]}`)) dates.push(`${m[1]}-${m[2]}`);
      }
      if (!dates.length) fail('每年任务要填至少一个日期（MM-DD）');
      out.dates = dates.sort(); out.times = normTimes(s.times); break;
    }
    case 'dates': {
      const items = [];
      for (const it of Array.isArray(s.items) ? s.items : []) {
        const d = parseDate(it?.date); const t = parseTime(it?.time);
        if (!d || !t) fail(`特殊日期「${it?.date ?? ''} ${it?.time ?? ''}」格式不对`);
        const key = `${fmtDate(d)} ${fmtTime(t)}`;
        if (!items.some((x) => `${x.date} ${x.time}` === key)) items.push({ date: fmtDate(d), time: fmtTime(t) });
      }
      if (!items.length) fail('特殊日期任务要填至少一条日期和时间');
      if (items.length > 100) fail('特殊日期最多 100 条');
      out.items = items.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)); break;
    }
    case 'everyNDays': {
      out.every = intIn(s.every, 2, 365, '间隔天数');
      const d = parseDate(s.startDate);
      if (!d) fail('每隔 N 天的任务要填起始日期');
      out.startDate = fmtDate(d); out.times = normTimes(s.times); break;
    }
    case 'interval':
      out.everyMinutes = intIn(s.everyMinutes, 10, 1440, '间隔分钟数');
      out.window = normWindow(s.window); break;
    case 'dailyRandom':
      out.count = intIn(s.count, 1, MAX_TIMES_PER_DAY, '每天次数');
      out.window = normWindow(s.window, ['09:00', '22:00']);
      out.minGapMin = intIn(s.minGapMin ?? 30, 0, 720, '最小间隔分钟');
      break;
    case 'cron': {
      const c = parseCron(s.expr);
      out.expr = c.expr;
      break;
    }
    case 'monthlyRandom':
      out.count = intIn(s.count, 1, 31, '每月次数');
      {
        const r = Array.isArray(s.dayRange) && s.dayRange.length === 2 ? s.dayRange.map(Number) : [1, 28];
        if (!(r[0] >= 1 && r[1] <= 31 && r[0] <= r[1])) fail('日期范围要写成 [1, 28] 这样，且开始不晚于结束');
        out.dayRange = r;
      }
      out.window = normWindow(s.window, ['09:00', '22:00']);
      out.minGapMin = intIn(s.minGapMin ?? 30, 0, 720, '最小间隔分钟');
      break;
    default: break;
  }
  out.startDate = normDateOpt(s.startDate, '开始日期') ?? (type === 'everyNDays' ? out.startDate : null);
  out.endDate = normDateOpt(s.endDate, '结束日期');
  if (out.startDate && out.endDate && out.endDate < out.startDate) fail('结束日期不能早于开始日期');
  out.excludeDates = [...new Set((Array.isArray(s.excludeDates) ? s.excludeDates : []).map((d) => normDateOpt(d, '排除日期')).filter(Boolean))].sort();
  out.excludeHolidays = s.excludeHolidays === true;
  if (type === 'dailyRandom') {
    const [a, b] = out.window.map((t) => { const p = parseTime(t); return p.hour * 60 + p.minute; });
    if ((out.count - 1) * out.minGapMin > b - a) fail(`时间段只有 ${b - a} 分钟，放不下 ${out.count} 次、每次间隔 ${out.minGapMin} 分钟`);
  }
  return out;
}

// ── 确定性随机 ───────────────────────────────────────────────────────────────
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function seededRandom(seedStr) {
  let a = hash32(String(seedStr)) || 1;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const minutesOf = (hhmm) => { const p = parseTime(hhmm); return p.hour * 60 + p.minute; };

/** 在 [a, b] 分钟里随机放 count 个点，两两至少隔 gap 分钟（放不下时尽量放）。返回升序分钟数。 */
export function randomMinutes(rand, count, a, b, gap) {
  const span = b - a;
  const g = count > 1 ? Math.min(gap, Math.floor(span / (count - 1))) : 0;
  const free = span - (count - 1) * g;
  const pts = Array.from({ length: count }, () => Math.floor(rand() * (free + 1))).sort((x, y) => x - y);
  return pts.map((p, i) => a + p + i * g);
}

// ── 下一次 ──────────────────────────────────────────────────────────────────
function dayAllowed(day, s, holidays) {
  const key = fmtDate(day);
  if (s.startDate && key < s.startDate) return false;
  if (s.endDate && key > s.endDate) return false;
  if (s.excludeDates.includes(key)) return false;
  if (s.excludeHolidays && holidays.has(key)) return false;
  return true;
}

/** 某一天（日历日）按规则应在哪些分钟执行；不执行返回 []。seed 用于随机规则。 */
export function minutesForDay(day, s, { seed = '', holidays = new Set() } = {}) {
  if (!dayAllowed(day, s, holidays)) return [];
  const key = fmtDate(day);
  const wd = weekdayOf(day);
  const times = () => s.times.map(minutesOf);
  switch (s.type) {
    case 'once': return key === s.date ? [minutesOf(s.time)] : [];
    case 'daily': return times();
    case 'weekly': return s.weekdays.includes(wd) ? times() : [];
    case 'workdays': return wd <= 5 && !holidays.has(key) ? times() : [];
    case 'monthly': {
      const last = daysInMonth(day.year, day.month);
      const hit = s.days.some((d) => (d === -1 ? day.day === last : Math.min(d, last) === day.day));
      return hit ? times() : [];
    }
    case 'monthlyWeekday': {
      if (wd !== s.weekday) return [];
      const last = daysInMonth(day.year, day.month);
      const nth = Math.floor((day.day - 1) / 7) + 1;
      const isLast = day.day + 7 > last;
      return (s.nth === -1 ? isLast : nth === s.nth) ? times() : [];
    }
    case 'yearly': {
      const md = `${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
      return s.dates.includes(md) ? times() : [];
    }
    case 'dates': return s.items.filter((it) => it.date === key).map((it) => minutesOf(it.time));
    case 'everyNDays': {
      const diff = dayDiff(parseDate(s.startDate), day);
      return diff >= 0 && diff % s.every === 0 ? times() : [];
    }
    case 'interval': {
      const [a, b] = s.window.map(minutesOf);
      const out = [];
      for (let m = a; m <= b; m += s.everyMinutes) out.push(m);
      return out;
    }
    case 'dailyRandom': {
      const [a, b] = s.window.map(minutesOf);
      return randomMinutes(seededRandom(`${seed}|${key}`), s.count, a, b, s.minGapMin);
    }
    case 'cron': {
      const c = parseCron(s.expr);
      if (!cronDayMatches(c, day)) return [];
      const out = [];
      for (const h of [...c.hour.set].sort((a, b) => a - b)) for (const m of [...c.minute.set].sort((a, b) => a - b)) out.push(h * 60 + m);
      return out;
    }
    case 'monthlyRandom': {
      const last = daysInMonth(day.year, day.month);
      const lo = Math.min(s.dayRange[0], last); const hi = Math.min(s.dayRange[1], last);
      const pool = []; for (let d = lo; d <= hi; d += 1) pool.push(d);
      const rand = seededRandom(`${seed}|${day.year}-${day.month}`);
      for (let i = pool.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      const chosen = new Set(pool.slice(0, Math.min(s.count, pool.length)));
      if (!chosen.has(day.day)) return [];
      const [a, b] = s.window.map(minutesOf);
      return randomMinutes(seededRandom(`${seed}|${key}`), 1, a, b, 0);
    }
    default: return [];
  }
}

/**
 * afterMs 之后（不含）的下一次执行时刻（UTC 毫秒）；没有了返回 null。
 * @param {{ tz: string, seed?: string, holidays?: Set<string> }} ctx
 */
export function nextOccurrence(s, afterMs, { tz, seed = '', holidays = new Set() }) {
  if (s.type === 'dates') {
    for (const it of s.items) {
      const d = parseDate(it.date); const t = parseTime(it.time);
      if (!dayAllowed(d, s, holidays)) continue;
      const at = zonedToUtc({ ...d, ...t }, tz);
      if (at > afterMs) return at;
    }
    return null;
  }
  const start = zonedParts(afterMs, tz);
  let day = { year: start.year, month: start.month, day: start.day };
  const limit = s.type === 'yearly' ? 366 * 4 + 2 : SEARCH_DAYS;
  for (let i = 0; i < limit; i += 1) {
    if (s.endDate && fmtDate(day) > s.endDate) return null;
    if (s.type === 'once' && fmtDate(day) > s.date) return null;
    for (const m of minutesForDay(day, s, { seed, holidays })) {
      const at = zonedToUtc({ ...day, hour: Math.floor(m / 60), minute: m % 60 }, tz);
      if (at > afterMs) return at;
    }
    day = addDays(day, 1);
  }
  return null;
}

/** 接下来的 n 次（预览用）。 */
export function previewOccurrences(s, fromMs, n, ctx) {
  const out = [];
  let t = fromMs;
  for (let i = 0; i < n; i += 1) {
    const at = nextOccurrence(s, t, ctx);
    if (at == null) break;
    out.push(at);
    t = at;
  }
  return out;
}

/** 给人看的规则描述（列表、确认消息用）。 */
export function describeSchedule(s) {
  const t = (s.times ?? []).join('、');
  const W = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  let base;
  switch (s.type) {
    case 'once': base = `一次性：${s.date} ${s.time}`; break;
    case 'daily': base = `每天 ${t}`; break;
    case 'weekly': base = `每周${s.weekdays.map((d) => W[d].slice(1)).join('、')} ${t}`; break;
    case 'workdays': base = `工作日 ${t}`; break;
    case 'monthly': base = `每月 ${s.days.map((d) => (d === -1 ? '最后一天' : `${d} 号`)).join('、')} ${t}`; break;
    case 'monthlyWeekday': base = `每月${s.nth === -1 ? '最后一个' : `第 ${s.nth} 个`}${W[s.weekday]} ${t}`; break;
    case 'yearly': base = `每年 ${s.dates.join('、')} ${t}`; break;
    case 'dates': base = `特殊日期 ${s.items.length} 个（${s.items.slice(0, 3).map((x) => `${x.date} ${x.time}`).join('、')}${s.items.length > 3 ? '…' : ''}）`; break;
    case 'everyNDays': base = `从 ${s.startDate} 起每 ${s.every} 天 ${t}`; break;
    case 'interval': base = `${s.window[0]}～${s.window[1]} 之间每 ${s.everyMinutes} 分钟`; break;
    case 'dailyRandom': base = `每天随机 ${s.count} 次（${s.window[0]}～${s.window[1]}，至少隔 ${s.minGapMin} 分钟）`; break;
    case 'monthlyRandom': base = `每月随机 ${s.count} 次（${s.dayRange[0]}～${s.dayRange[1]} 号，${s.window[0]}～${s.window[1]}）`; break;
    case 'cron': base = `cron：${s.expr}`; break;
    default: base = s.type;
  }
  const extra = [];
  if (s.startDate && s.type !== 'everyNDays') extra.push(`从 ${s.startDate}`);
  if (s.endDate) extra.push(`到 ${s.endDate}`);
  if (s.excludeHolidays) extra.push('跳过法定节假日');
  if (s.excludeDates?.length) extra.push(`排除 ${s.excludeDates.length} 天`);
  return extra.length ? `${base}（${extra.join('，')}）` : base;
}
