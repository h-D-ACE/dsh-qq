// 定时任务引擎：任务的增删改查、到点执行、安全限制、错过补发、执行记录。
// 只负责「什么时候、发给谁、发什么」；真正怎么发（固定文字 / 叫 AI 来说）由 bridge.js 传入的 deliver 决定。
//
// 数据文件 state/scheduler.json（0600，不进仓库）：
//   { version, settings, tasks: [...], history: [...], counters: { 'YYYY-MM-DD': {...} }, nextId }
//
// 安全边界：
// - 总开关与安全限制只能由控制台 / 管理员命令改（source = console | owner-command）；AI 改不了；
// - AI 登记的任务只能发给管理员私聊；允许发往群时（allowAiGroup）也只建成「待你确认」的暂停状态，
//   需要你在控制台打开或发 /remind on <编号>；
// - 每次执行都按限制检查：每个任务每天、全部每天、每个群每天、定时任务免打扰时段（只拦定时任务发往群的消息）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeSchedule, nextOccurrence, previewOccurrences, describeSchedule, seededRandom } from './schedule.js';
import { isValidTimeZone, zonedParts, dateKey, parseTime, describeInstant } from './time.js';

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
export const DEFAULT_LIMITS = Object.freeze({
  maxTasks: 20,          // 同时存在的任务
  perTaskPerDay: 12,     // 单个任务每天最多执行
  totalPerDay: 50,       // 全部任务每天最多发出（按目标计条数）
  perGroupPerDay: 10,    // 每个群每天最多收到
  maxTargets: 10,        // 单个任务最多几个目标
  minIntervalMin: 10,    // 同一任务两次执行的最小间隔
  missedGraceMin: 10,    // 错过多久以内补发
  jitterMin: 2,          // 固定时间的随机偏移（±分钟；0 = 准点）
  maxTextChars: 500,
  maxInstructionChars: 300,
  quietEnabled: true,    // 定时任务免打扰：时段内定时任务不往群里发（不影响 AI 平时的回复）
  quietStart: '00:00',
  quietEnd: '07:00',
});
const LIMIT_RANGES = {
  maxTasks: [1, 200], perTaskPerDay: [1, 288], totalPerDay: [1, 2000], perGroupPerDay: [1, 500], maxTargets: [1, 50],
  minIntervalMin: [1, 1440], missedGraceMin: [0, 1440], jitterMin: [0, 30], maxTextChars: [20, 2000], maxInstructionChars: [20, 1000],
};
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  timezone: DEFAULT_TIMEZONE,
  allowAiPrivate: true,   // 允许 AI 在管理员私聊里登记任务（只发给管理员私聊）
  allowAiGroup: false,    // 允许 AI 登记发往群 / 其他好友的任务（建成暂停，需你确认）
  limits: DEFAULT_LIMITS,
});
const HISTORY_MAX = 300;
const ADMIN_SOURCES = ['console', 'owner-command'];
const RANDOM_TYPES = ['dailyRandom', 'monthlyRandom', 'interval'];

function clampInt(v, [min, max], fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** 规范化设置（缺省回落默认值；越界收敛到范围内）。 */
export function normalizeSettings(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const lim = r.limits && typeof r.limits === 'object' ? r.limits : {};
  const limits = {};
  for (const [k, def] of Object.entries(DEFAULT_LIMITS)) {
    if (LIMIT_RANGES[k]) limits[k] = clampInt(lim[k], LIMIT_RANGES[k], def);
    else if (typeof def === 'boolean') limits[k] = typeof lim[k] === 'boolean' ? lim[k] : def;
    else limits[k] = parseTime(lim[k]) ? String(lim[k]).padStart(5, '0') : def;
  }
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_SETTINGS.enabled,
    timezone: isValidTimeZone(r.timezone) ? String(r.timezone) : DEFAULT_TIMEZONE,
    allowAiPrivate: typeof r.allowAiPrivate === 'boolean' ? r.allowAiPrivate : DEFAULT_SETTINGS.allowAiPrivate,
    allowAiGroup: typeof r.allowAiGroup === 'boolean' ? r.allowAiGroup : DEFAULT_SETTINGS.allowAiGroup,
    limits,
  };
}

const minutesOf = (hhmm) => { const p = parseTime(hhmm); return p ? p.hour * 60 + p.minute : 0; };
/** 某时刻是否在免打扰时段（支持跨午夜，如 23:00～07:00）。 */
export function inQuietHours(ms, limits, tz) {
  if (!limits.quietEnabled) return false;
  const p = zonedParts(ms, tz);
  const m = p.hour * 60 + p.minute;
  const a = minutesOf(limits.quietStart); const b = minutesOf(limits.quietEnd);
  if (a === b) return false;
  return a < b ? (m >= a && m < b) : (m >= a || m < b);
}

/**
 * @param {{
 *   file: string,
 *   deliver: (task, targetKey, ctx) => Promise<{ status: 'sent'|'skipped'|'failed', reason?: string }>,
 *   validateTarget: (key) => string|null,   // 返回错误信息；null = 可以
 *   ownerKey: () => string,
 *   holidays?: Iterable<string>,
 *   now?: () => number,
 *   log?: (msg) => void,
 *   audit?: (event, detail) => void,
 *   sensitive?: (text) => boolean,
 * }} deps
 */
export function createScheduler({ file, deliver, validateTarget, ownerKey, holidays = [], now = Date.now, log = () => {}, audit = () => {}, sensitive = () => false }) {
  const holidaySet = new Set(holidays);
  let data = { version: 1, settings: normalizeSettings(), tasks: [], history: [], counters: {}, nextId: 1 };
  let timer = null;
  let ticking = false;
  let writable = true;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      data = {
        version: 1,
        settings: normalizeSettings(raw.settings),
        tasks: Array.isArray(raw.tasks) ? raw.tasks.filter((t) => t && Number.isInteger(t.id)) : [],
        history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_MAX) : [],
        counters: raw.counters && typeof raw.counters === 'object' ? raw.counters : {},
        nextId: Number.isInteger(raw.nextId) ? raw.nextId : 1,
      };
      for (const t of data.tasks) {
        try { t.schedule = normalizeSchedule(t.schedule); } catch (error) { t.enabled = false; t.lastResult = 'invalid'; t.lastReason = error.message; }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 读坏了不能当成空表再写回去覆盖：降级为只读，等人处理
        writable = false;
        log(`⚠️ 定时任务文件读取失败，已降级为只读（不会覆盖原文件）：${error?.message ?? error}`);
      }
    }
  }
  function save() {
    if (!writable) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const settings = () => data.settings;
  const tzOf = (task) => task.timezone || data.settings.timezone;
  const lim = () => data.settings.limits;
  const today = () => dateKey(now(), data.settings.timezone);

  function counter() {
    const k = today();
    if (!data.counters[k]) {
      // 只留最近 3 天
      for (const old of Object.keys(data.counters).sort().slice(0, -2)) delete data.counters[old];
      data.counters[k] = { total: 0, perTask: {}, perTarget: {} };
    }
    return data.counters[k];
  }

  function record(entry) {
    data.history.push({ at: now(), ...entry });
    if (data.history.length > HISTORY_MAX) data.history.splice(0, data.history.length - HISTORY_MAX);
  }

  function computeNext(task, afterMs) {
    const tz = tzOf(task);
    const scheduled = nextOccurrence(task.schedule, afterMs, { tz, seed: task.seed, holidays: holidaySet });
    if (scheduled == null) return { scheduledAt: null, runAt: null };
    const jitterMin = task.jitterMin ?? lim().jitterMin;
    let runAt = scheduled;
    if (jitterMin > 0 && !RANDOM_TYPES.includes(task.schedule.type)) {
      const r = seededRandom(`${task.seed}|j|${scheduled}`)();
      runAt = scheduled + Math.round((r * 2 - 1) * jitterMin * 60_000);
    }
    return { scheduledAt: scheduled, runAt };
  }
  function refreshNext(task, afterMs = now()) {
    const n = computeNext(task, afterMs);
    task.nextScheduledAt = n.scheduledAt;
    task.nextRunAt = n.runAt;
  }

  /** 校验任务输入；source 决定能做什么。返回规范化后的字段。 */
  function validateTask(input, { source, existing = null }) {
    const L = lim();
    const isAdmin = ADMIN_SOURCES.includes(source);
    const out = {};
    const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 40);
    out.name = name || '未命名任务';
    const kind = String(input.kind ?? existing?.kind ?? 'text');
    if (!['text', 'ai'].includes(kind)) throw new Error('内容类型只能是 text（固定文字）或 ai（叫 AI 来说）');
    out.kind = kind;
    const text = String(input.text ?? existing?.text ?? '').trim();
    const instruction = String(input.instruction ?? existing?.instruction ?? '').trim();
    if (kind === 'text') {
      if (!text) throw new Error('固定文字任务要填要发的内容');
      if (text.length > L.maxTextChars) throw new Error(`文字最多 ${L.maxTextChars} 字`);
      if (sensitive(text)) throw new Error('内容疑似含路径 / 凭据，不能登记');
    } else {
      if (!instruction) throw new Error('「叫 AI 来说」的任务要写清楚让 AI 做什么');
      if (instruction.length > L.maxInstructionChars) throw new Error(`给 AI 的说明最多 ${L.maxInstructionChars} 字`);
      if (sensitive(instruction)) throw new Error('说明疑似含路径 / 凭据，不能登记');
    }
    out.text = kind === 'text' ? text : '';
    out.instruction = kind === 'ai' ? instruction : '';
    const targets = [...new Set((Array.isArray(input.targets) ? input.targets : (existing?.targets ?? [])).map((k) => String(k).trim()).filter(Boolean))];
    if (!targets.length) throw new Error('请至少选一个发送对象');
    if (targets.length > L.maxTargets) throw new Error(`一个任务最多 ${L.maxTargets} 个发送对象`);
    for (const k of targets) {
      const err = validateTarget(k);
      if (err) throw new Error(err);
    }
    if (!isAdmin) {
      // AI 登记：只能发给管理员私聊；开了 allowAiGroup 才能发群 / 其他好友，而且要你确认
      const others = targets.filter((k) => k !== ownerKey());
      if (others.length && !data.settings.allowAiGroup) throw new Error('AI 只能登记发给管理员私聊的任务；要发到群或其他好友，请在控制台的「定时任务」里设置');
    }
    out.targets = targets;
    out.schedule = normalizeSchedule(input.schedule ?? existing?.schedule);
    // cron 很容易写错，只开放给控制台和管理员命令；AI 用结构化规则就够了
    if (!isAdmin && out.schedule.type === 'cron') throw new Error('cron 表达式只能在控制台设置；请改用每天 / 每周 / 每月等重复方式');
    const tz = input.timezone ?? existing?.timezone ?? null;
    if (tz != null && tz !== '' && !isValidTimeZone(tz)) throw new Error(`时区「${tz}」不认识`);
    out.timezone = tz || null;
    const maxRuns = input.maxRuns ?? existing?.maxRuns ?? null;
    out.maxRuns = maxRuns == null || maxRuns === '' ? null : clampInt(maxRuns, [1, 100000], null);
    const jitter = input.jitterMin ?? existing?.jitterMin ?? null;
    out.jitterMin = jitter == null || jitter === '' ? null : clampInt(jitter, LIMIT_RANGES.jitterMin, null);
    // 定时静默时段内：false = 跳过这次（默认，省钱）；true = 照常执行（只对「叫 AI 来说」有意义，固定文字本来就照发）
    out.runDuringSilence = (input.runDuringSilence ?? existing?.runDuringSilence) === true;
    const missed = String(input.missedPolicy ?? existing?.missedPolicy ?? 'grace');
    out.missedPolicy = ['grace', 'skip'].includes(missed) ? missed : 'grace';
    // 同一任务两次执行的最小间隔
    const probe = { ...out, seed: existing?.seed ?? 'probe' };
    const times = previewOccurrences(out.schedule, now(), 6, { tz: out.timezone || data.settings.timezone, seed: probe.seed, holidays: holidaySet });
    for (let i = 1; i < times.length; i += 1) {
      if (times[i] - times[i - 1] < L.minIntervalMin * 60_000) throw new Error(`两次执行至少隔 ${L.minIntervalMin} 分钟（安全限制里可以改）`);
    }
    if (out.schedule.type === 'once' && !times.length) throw new Error('这个时间已经过去了');
    return out;
  }

  function summarize(task) {
    // 显示「设定的时间」而不是加了随机偏移后的时刻（否则 06:00 会显示成 05:59，看着像设错了）
    const jitterMin = task.jitterMin ?? lim().jitterMin;
    const jittered = jitterMin > 0 && !RANDOM_TYPES.includes(task.schedule.type);
    const shown = task.nextScheduledAt ?? task.nextRunAt;
    return {
      ...task,
      scheduleText: describeSchedule(task.schedule),
      nextRunText: shown ? `${describeInstant(shown, tzOf(task))}${jittered ? `（前后 ${jitterMin} 分钟内）` : ''}${task.enabled ? '' : '，已暂停'}` : null,
    };
  }

  // ── 对外 API ───────────────────────────────────────────────────────────────
  const api = {
    load,
    save,
    isWritable: () => writable,
    snapshot() {
      return {
        settings: data.settings,
        defaults: DEFAULT_SETTINGS,
        tasks: data.tasks.map(summarize),
        history: data.history.slice(-100).reverse(),
        today: counter(),
      };
    },
    getTask: (id) => data.tasks.find((t) => t.id === Number(id)) ?? null,
    listTasks: ({ forAi = false } = {}) => data.tasks
      .filter((t) => !forAi || t.createdBy === 'owner-chat-ai' || t.targets.includes(ownerKey()))
      .map(summarize),

    /** 改设置：只有控制台 / 管理员命令可以。 */
    updateSettings(patch, { source }) {
      if (!ADMIN_SOURCES.includes(source)) throw new Error('定时任务的总开关和安全限制只能在控制台或管理员命令里改');
      const merged = normalizeSettings({ ...data.settings, ...patch, limits: { ...data.settings.limits, ...(patch?.limits ?? {}) } });
      data.settings = merged;
      for (const t of data.tasks) refreshNext(t);
      save();
      audit('scheduler.settings_updated', { source, enabled: merged.enabled, limits: merged.limits, allowAiGroup: merged.allowAiGroup });
      return merged;
    },

    createTask(input, { source }) {
      if (!['console', 'owner-command', 'owner-chat-ai'].includes(source)) throw new Error('来源不允许登记定时任务');
      if (source === 'owner-chat-ai' && !data.settings.allowAiPrivate) throw new Error('管理员关闭了「允许 AI 登记定时任务」');
      if (data.tasks.length >= lim().maxTasks) throw new Error(`定时任务已达上限 ${lim().maxTasks} 个（安全限制里可以改）`);
      const fields = validateTask(input, { source });
      const needsConfirm = source === 'owner-chat-ai' && fields.targets.some((k) => k !== ownerKey());
      const task = {
        id: data.nextId++,
        ...fields,
        enabled: needsConfirm ? false : input.enabled !== false,
        pendingConfirm: needsConfirm,
        createdBy: source,
        createdAt: now(),
        updatedAt: now(),
        seed: crypto.randomBytes(6).toString('hex'),
        runs: 0,
        lastRunAt: null,
        lastResult: null,
        lastReason: '',
      };
      refreshNext(task);
      data.tasks.push(task);
      save();
      audit('scheduler.task_created', { id: task.id, source, targets: task.targets, kind: task.kind, schedule: task.schedule, pendingConfirm: needsConfirm });
      log(`定时任务：新建 #${task.id}「${task.name}」${describeSchedule(task.schedule)}（来源 ${source}${needsConfirm ? '，待管理员确认' : ''}）`);
      return summarize(task);
    },

    updateTask(id, patch, { source }) {
      const task = api.getTask(id);
      if (!task) throw new Error(`没有编号 #${id} 的任务`);
      if (source === 'owner-chat-ai') {
        if (!data.settings.allowAiPrivate) throw new Error('管理员关闭了「允许 AI 登记定时任务」');
        if (patch.enabled === true && task.pendingConfirm) throw new Error('这个任务要管理员确认后才能启用（控制台打开，或发 /remind on 编号）');
      }
      const fields = validateTask({ ...patch }, { source, existing: task });
      const targetsGrew = fields.targets.some((k) => !task.targets.includes(k) && k !== ownerKey());
      Object.assign(task, fields, { updatedAt: now() });
      if (source === 'owner-chat-ai' && targetsGrew) { task.enabled = false; task.pendingConfirm = true; }
      if (typeof patch.enabled === 'boolean') {
        task.enabled = patch.enabled;
        if (patch.enabled && ADMIN_SOURCES.includes(source)) task.pendingConfirm = false;
      }
      refreshNext(task);
      save();
      audit('scheduler.task_updated', { id: task.id, source, enabled: task.enabled, targets: task.targets });
      return summarize(task);
    },

    setEnabled(id, enabled, { source }) {
      const task = api.getTask(id);
      if (!task) throw new Error(`没有编号 #${id} 的任务`);
      if (enabled && task.pendingConfirm && !ADMIN_SOURCES.includes(source)) throw new Error('这个任务要管理员确认后才能启用');
      task.enabled = !!enabled;
      if (enabled && ADMIN_SOURCES.includes(source)) task.pendingConfirm = false;
      task.updatedAt = now();
      refreshNext(task);
      save();
      audit('scheduler.task_toggled', { id: task.id, source, enabled: task.enabled });
      return summarize(task);
    },

    deleteTask(id, { source }) {
      const idx = data.tasks.findIndex((t) => t.id === Number(id));
      if (idx < 0) throw new Error(`没有编号 #${id} 的任务`);
      const [task] = data.tasks.splice(idx, 1);
      save();
      audit('scheduler.task_deleted', { id: task.id, source });
      log(`定时任务：删除 #${task.id}「${task.name}」（来源 ${source}）`);
      return summarize(task);
    },

    /** 预览：不保存，返回规范化规则与接下来 n 次。 */
    preview(input, n = 5) {
      const schedule = normalizeSchedule(input.schedule);
      const tz = input.timezone && isValidTimeZone(input.timezone) ? input.timezone : data.settings.timezone;
      const times = previewOccurrences(schedule, now(), n, { tz, seed: String(input.seed ?? 'preview'), holidays: holidaySet });
      return { schedule, scheduleText: describeSchedule(schedule), timezone: tz, next: times.map((t) => ({ at: t, text: describeInstant(t, tz) })) };
    },

    /** 立即执行一次（测试用；照样计入每日限额）。 */
    async runNow(id, { source }) {
      const task = api.getTask(id);
      if (!task) throw new Error(`没有编号 #${id} 的任务`);
      return execute(task, now(), { manual: true, source });
    },

    /** 启动时：把错过太久的任务记成 missed 并顺延，返回这些任务（给管理员发一条汇总）。 */
    catchUpOnStart() {
      const missed = [];
      const t = now();
      for (const task of data.tasks) {
        if (!task.enabled || task.nextRunAt == null) continue;
        const late = t - task.nextRunAt;
        const grace = task.missedPolicy === 'skip' ? 0 : lim().missedGraceMin * 60_000;
        if (late > grace) {
          record({ taskId: task.id, name: task.name, status: 'missed', reason: `桥接没有运行，错过了 ${describeInstant(task.nextRunAt, tzOf(task))}` });
          missed.push({ id: task.id, name: task.name, at: task.nextRunAt });
          refreshNext(task, t);
        }
      }
      if (missed.length) save();
      return missed;
    },

    async tick() {
      if (ticking || !data.settings.enabled) return [];
      ticking = true;
      const results = [];
      try {
        const t = now();
        for (const task of data.tasks) {
          if (!task.enabled || task.nextRunAt == null || task.nextRunAt > t) continue;
          const late = t - task.nextRunAt;
          const grace = task.missedPolicy === 'skip' ? 60_000 : Math.max(60_000, lim().missedGraceMin * 60_000);
          if (late > grace) {
            record({ taskId: task.id, name: task.name, status: 'missed', reason: `错过了 ${describeInstant(task.nextRunAt, tzOf(task))}（超过补发时间）` });
            refreshNext(task, t);
            continue;
          }
          results.push(await execute(task, task.nextScheduledAt ?? task.nextRunAt));
        }
        save();
      } finally {
        ticking = false;
      }
      return results;
    },

    start(intervalMs = 30_000) {
      if (timer) return;
      timer = setInterval(() => { void api.tick().catch((error) => log(`⚠️ 定时任务检查出错：${error?.message ?? error}`)); }, intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };

  async function execute(task, scheduledAt, { manual = false, source = 'schedule' } = {}) {
    const L = lim();
    const c = counter();
    const outcomes = [];
    if ((c.perTask[task.id] ?? 0) >= L.perTaskPerDay) {
      record({ taskId: task.id, name: task.name, status: 'skipped', reason: `今天已执行 ${L.perTaskPerDay} 次（单任务每天上限）` });
      outcomes.push({ target: '*', status: 'skipped' });
    } else {
      for (const target of task.targets) {
        const isGroup = target.startsWith('group:');
        let status; let reason = '';
        if (c.total >= L.totalPerDay) { status = 'skipped'; reason = `今天全部任务已发 ${L.totalPerDay} 条（每天上限）`; }
        else if (isGroup && (c.perTarget[target] ?? 0) >= L.perGroupPerDay) { status = 'skipped'; reason = `这个群今天已收到 ${L.perGroupPerDay} 条（每群每天上限）`; }
        else if (isGroup && !manual && inQuietHours(now(), L, data.settings.timezone)) { status = 'skipped'; reason = `定时任务免打扰时段（${L.quietStart}～${L.quietEnd}）`; }
        else {
          try {
            const r = await deliver(task, target, { scheduledAt, manual });
            status = r?.status ?? 'failed'; reason = r?.reason ?? '';
          } catch (error) {
            status = 'failed'; reason = String(error?.message ?? error);
          }
        }
        if (status === 'sent') {
          c.total += 1;
          c.perTarget[target] = (c.perTarget[target] ?? 0) + 1;
        }
        record({ taskId: task.id, name: task.name, target, status, reason, manual, source });
        outcomes.push({ target, status, reason });
      }
      c.perTask[task.id] = (c.perTask[task.id] ?? 0) + 1;
      if (!manual) task.runs = (task.runs ?? 0) + 1;
    }
    task.lastRunAt = now();
    task.lastResult = outcomes.every((o) => o.status === 'sent') ? 'sent' : (outcomes.some((o) => o.status === 'sent') ? 'partial' : outcomes[0]?.status ?? 'skipped');
    task.lastReason = outcomes.filter((o) => o.reason).map((o) => o.reason).join('；').slice(0, 200);
    if (!manual) {
      refreshNext(task, Math.max(now(), scheduledAt));
      if (task.maxRuns != null && task.runs >= task.maxRuns) {
        task.enabled = false;
        record({ taskId: task.id, name: task.name, status: 'finished', reason: `已执行满 ${task.maxRuns} 次，自动停用` });
      }
      if (task.nextRunAt == null && task.enabled) {
        task.enabled = false;
        record({ taskId: task.id, name: task.name, status: 'finished', reason: '没有下一次了，自动停用' });
      }
    }
    save();
    return { taskId: task.id, outcomes };
  }

  return api;
}
