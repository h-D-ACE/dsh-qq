// 定时静默：按时间段自动让群聊 AI 停下来（避开高峰价、省 token）。
//
// 和原来的手动静默的区别：手动静默只拦「群友消息交给 AI」和「AI 往群里发」，AI 仍会被定时唤醒去思考（照样花钱）；
// 定时静默默认连唤醒一起停（被 @、主动冒泡、睡醒、回复检查都不唤醒），群消息照样记下，恢复后 AI 能补看。
//
// 规则：
// - 每个时间段：{ id, name, enabled, start:'HH:mm', end:'HH:mm', days, weekdays, skipHolidays }
//   days = every 每天 / workdays 工作日（周一至周五）/ weekend 周末 / custom 自选（weekdays: 1=周一 … 7=周日）
//   skipHolidays：跳过法定节假日（内置节假日表只有放假日，调休补班的周末不算工作日）
// - 跨午夜（如 23:00–07:00）以开始那天为准：「周五 23:00–07:00」= 周五晚到周六早。
// - 天数、时刻都按面板选的时区算，与机器时区无关。
// - 手动开关优先：手动开启静默时一直静默；定时静默期间点「恢复正常」= 这一段临时恢复（到这一段结束），下一段照常。
//
// 数据存在 state/silence-schedule.json（0600，不进仓库）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { zonedParts, zonedToUtc, parseTime, fmtTime, fmtDate, addDays, weekdayOf, isValidTimeZone, describeInstant } from './scheduler/time.js';

export const DAY_MODES = Object.freeze(['every', 'workdays', 'weekend', 'custom']);
export const MAX_RANGES = 20;
export const DEFAULT_SILENCE = Object.freeze({
  enabled: false,
  timezone: 'Asia/Shanghai',
  ranges: [],
  options: Object.freeze({
    stopWakes: true,          // 停止群聊 AI 的一切唤醒（真正省钱）
    recordMessages: true,     // 群消息照样记下（不唤醒），恢复后 AI 能补看
    pauseAiTasks: true,       // 定时任务里「叫 AI 来说」发往群的暂停（任务可单独设「照常执行」）；固定文字照发
    includeOwnerPrivate: false, // 管理员私聊也一起静默
    catchUpOnEnd: true,       // 静默期间有人 @ / 叫名字 / 提问 / 拍一拍 / 私聊，结束时补一次唤醒
  }),
});

const minutesOf = (hhmm) => { const p = parseTime(hhmm); return p.hour * 60 + p.minute; };

function normRange(r, i) {
  const x = r && typeof r === 'object' ? r : {};
  const start = parseTime(x.start); const end = parseTime(x.end);
  if (!start || !end) throw new Error(`第 ${i + 1} 个时间段的时间要写成 HH:mm`);
  if (fmtTime(start) === fmtTime(end)) throw new Error(`第 ${i + 1} 个时间段开始和结束不能一样`);
  const days = DAY_MODES.includes(x.days) ? x.days : 'every';
  const weekdays = [...new Set((Array.isArray(x.weekdays) ? x.weekdays : []).map(Number))].filter((d) => d >= 1 && d <= 7).sort();
  if (days === 'custom' && !weekdays.length) throw new Error(`第 ${i + 1} 个时间段选了「自选」，请至少选一天`);
  return {
    id: /^[a-z0-9]{4,16}$/.test(String(x.id ?? '')) ? String(x.id) : crypto.randomBytes(4).toString('hex'),
    name: String(x.name ?? '').trim().slice(0, 20) || `时间段 ${i + 1}`,
    enabled: x.enabled !== false,
    start: fmtTime(start),
    end: fmtTime(end),
    days,
    weekdays: days === 'custom' ? weekdays : [],
    skipHolidays: x.skipHolidays === true,
  };
}

/** 校验并规范化整份设置；不合法抛 Error（给人看的原因）。 */
export function normalizeSilenceConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ranges = Array.isArray(r.ranges) ? r.ranges : [];
  if (ranges.length > MAX_RANGES) throw new Error(`最多 ${MAX_RANGES} 个时间段`);
  const o = r.options && typeof r.options === 'object' ? r.options : {};
  const options = {};
  for (const [k, def] of Object.entries(DEFAULT_SILENCE.options)) options[k] = typeof o[k] === 'boolean' ? o[k] : def;
  return {
    enabled: r.enabled === true,
    timezone: isValidTimeZone(r.timezone) ? String(r.timezone) : DEFAULT_SILENCE.timezone,
    ranges: ranges.map(normRange),
    options,
  };
}

/** 某个时间段在某一天（日历日，按时区）是否生效（看开始那天）。 */
export function rangeAppliesOnDay(range, day, holidays) {
  const wd = weekdayOf(day);
  const key = fmtDate(day);
  if (range.skipHolidays && holidays.has(key)) return false;
  switch (range.days) {
    case 'workdays': return wd <= 5;
    case 'weekend': return wd >= 6;
    case 'custom': return range.weekdays.includes(wd);
    default: return true;
  }
}

/** 某时间段在某天开始的那一段的 [开始, 结束) UTC 毫秒（跨午夜时结束在第二天）。 */
function windowOn(range, day, tz) {
  const s = parseTime(range.start); const e = parseTime(range.end);
  const startMs = zonedToUtc({ ...day, hour: s.hour, minute: s.minute }, tz);
  const endDay = minutesOf(range.end) <= minutesOf(range.start) ? addDays(day, 1) : day;
  const endMs = zonedToUtc({ ...endDay, hour: e.hour, minute: e.minute }, tz);
  return { startMs, endMs };
}

/**
 * 现在处在哪个静默时间段（没有返回 null）。会同时检查「昨天开始、跨到今天」的时间段。
 * @returns {{ range, startMs, endMs } | null}
 */
export function activeWindow(config, nowMs, { holidays = new Set() } = {}) {
  if (!config?.enabled) return null;
  const tz = config.timezone;
  const p = zonedParts(nowMs, tz);
  const today = { year: p.year, month: p.month, day: p.day };
  let best = null;
  for (const range of config.ranges) {
    if (!range.enabled) continue;
    for (const day of [addDays(today, -1), today]) {
      if (!rangeAppliesOnDay(range, day, holidays)) continue;
      const w = windowOn(range, day, tz);
      if (nowMs >= w.startMs && nowMs < w.endMs && (!best || w.endMs > best.endMs)) best = { range, ...w };
    }
  }
  return best;
}

/** 接下来的静默时间段（预览用；按开始时间排序，最多 n 个，向后找 14 天）。 */
export function upcomingWindows(config, fromMs, n = 6, { holidays = new Set() } = {}) {
  if (!config?.enabled) return [];
  const tz = config.timezone;
  const p = zonedParts(fromMs, tz);
  let day = addDays({ year: p.year, month: p.month, day: p.day }, -1);
  const out = [];
  for (let i = 0; i < 16 && out.length < n * 3; i += 1) {
    for (const range of config.ranges) {
      if (!range.enabled || !rangeAppliesOnDay(range, day, holidays)) continue;
      const w = windowOn(range, day, tz);
      if (w.endMs > fromMs) out.push({ range, ...w });
    }
    day = addDays(day, 1);
  }
  return out.sort((a, b) => a.startMs - b.startMs).slice(0, n);
}

/** 「一键填入 DeepSeek 高峰时段」：按价目表的高峰窗口生成工作日、跳过节假日的时间段（北京时间）。 */
export function peakPresetRanges(priceTable) {
  const windows = Array.isArray(priceTable?.peakWindows) ? priceTable.peakWindows : [[9, 12], [14, 18]];
  const weekdays = Array.isArray(priceTable?.peakWeekdays) ? priceTable.peakWeekdays.map(Number) : [1, 2, 3, 4, 5];
  const isWorkdays = weekdays.length === 5 && [1, 2, 3, 4, 5].every((d) => weekdays.includes(d));
  const label = (h) => `${String(h).padStart(2, '0')}:00`;
  return windows.filter((w) => Array.isArray(w) && w.length === 2).map(([a, b], i) => ({
    name: a < 12 ? '上午高峰' : '下午高峰',
    enabled: true,
    start: label(a),
    end: label(b),
    days: isWorkdays ? 'workdays' : 'custom',
    weekdays: isWorkdays ? [] : weekdays,
    skipHolidays: true,
    id: `peak${i}`,
  }));
}

/** 时间段的中文描述。 */
export function describeRange(range) {
  const W = ['', '一', '二', '三', '四', '五', '六', '日'];
  const days = { every: '每天', workdays: '工作日', weekend: '周末', custom: `周${range.weekdays.map((d) => W[d]).join('、')}` }[range.days];
  const cross = minutesOf(range.end) <= minutesOf(range.start) ? '（跨午夜）' : '';
  return `${days}${range.skipHolidays ? '（跳过法定节假日）' : ''} ${range.start}–${range.end}${cross}`;
}

/**
 * 定时静默的状态机：读写配置、算当前状态、临时恢复、检测开始 / 结束。
 * @param {{ file: string, holidays?: Iterable<string>, now?: () => number, log?: (m) => void }} deps
 */
export function createSilenceSchedule({ file, holidays = [], now = Date.now, log = () => {} }) {
  const holidaySet = new Set(holidays);
  let config = normalizeSilenceConfig(DEFAULT_SILENCE);
  let override = null; // { rangeId, untilMs }：定时静默期间点了「恢复正常」
  let lastActiveKey = null;
  let writable = true;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    config = normalizeSilenceConfig(raw.config ?? raw);
    if (raw.override && Number(raw.override.untilMs) > now()) override = { rangeId: String(raw.override.rangeId), untilMs: Number(raw.override.untilMs) };
  } catch (error) {
    if (error?.code !== 'ENOENT') { writable = false; log(`⚠️ 定时静默设置读取失败，已降级为只读：${error?.message ?? error}`); }
  }
  function save() {
    if (!writable) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ config, override }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  /** 当前生效的定时静默（考虑临时恢复）；没有返回 null。 */
  function current(t = now()) {
    const w = activeWindow(config, t, { holidays: holidaySet });
    if (!w) return null;
    if (override && override.rangeId === w.range.id && t < override.untilMs) return null;
    return w;
  }
  const liveOverride = () => (override && now() < override.untilMs ? override : null);
  return {
    config: () => config,
    isWritable: () => writable,
    update(raw) { config = normalizeSilenceConfig(raw); override = null; save(); return config; },
    current,
    /** 某时刻会不会处在定时静默（不看临时恢复；给定时任务的预览用）。 */
    activeAt: (t) => activeWindow(config, t, { holidays: holidaySet }),
    /** 定时静默期间点「恢复正常」：这一段临时恢复。返回被恢复的那一段。 */
    resumeCurrent() {
      const w = activeWindow(config, now(), { holidays: holidaySet });
      if (!w) return null;
      override = { rangeId: w.range.id, untilMs: w.endMs };
      save();
      return w;
    },
    clearOverride() { override = null; save(); },
    override: () => (override && now() < override.untilMs ? override : null),
    /** 每次检查：返回状态变化（'start' | 'end' | null），用于记日志和结束时补唤醒。 */
    poll() {
      const w = current();
      const key = w ? `${w.range.id}@${w.startMs}` : null;
      let change = null;
      if (key && key !== lastActiveKey) change = { type: 'start', window: w };
      else if (!key && lastActiveKey) change = { type: 'end' };
      lastActiveKey = key;
      if (override && now() >= override.untilMs) { override = null; save(); }
      return change;
    },
    status() {
      const t = now();
      const w = current(t);
      const tz = config.timezone;
      return {
        config,
        active: w ? { name: w.range.name, range: describeRange(w.range), until: w.endMs, untilText: describeInstant(w.endMs, tz) } : null,
        override: liveOverride() ? { untilText: describeInstant(override.untilMs, tz) } : null,
        upcoming: upcomingWindows(config, t, 6, { holidays: holidaySet }).map((x) => ({
          name: x.range.name, startText: describeInstant(x.startMs, tz), endText: describeInstant(x.endMs, tz), startMs: x.startMs, endMs: x.endMs,
        })),
      };
    },
  };
}
