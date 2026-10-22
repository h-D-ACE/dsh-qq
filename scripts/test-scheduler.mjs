// 定时任务：时区、规则计算、引擎限额与安全边界、/remind 命令、桥接接线。全部离线、假数据（假号 123 / 456）。
//   ① 时区：按任务时区计算，与机器时区无关；夏令时跳变；
//   ② 规则：每种重复方式的下一次时间、月末 / 闰年 / 工作日 / 排除日期 / 有效期；随机规则确定且在时间段内；不合法规则给出原因；
//   ③ 引擎：限额（任务数、最小间隔、每天次数、每群条数、免打扰）、错过补发、执行满 N 次停用、持久化、读坏不覆盖；
//      安全：AI 改不了总开关和限制；AI 只能发给管理员私聊，发群要开关且建成「待确认」；
//   ④ /remind 命令解析；
//   ⑤ 桥接：/remind 由桥接处理不进模型；到点发固定文字；「AI 来说」唤醒时提示词带上任务；
//      AI 工具只在管理员私聊可用、登记后另发确认；控制台接口拒绝 agent token；
//   ⑥ 控制台页面接线。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { zonedParts, zonedToUtc, dateKey, describeInstant, utcOffsetLabel } from '../src/scheduler/time.js';
import { normalizeSchedule, nextOccurrence, previewOccurrences, minutesForDay, describeSchedule, parseCron } from '../src/scheduler/schedule.js';
import { createScheduler, normalizeSettings, inQuietHours, DEFAULT_LIMITS } from '../src/scheduler/engine.js';
import { parseRemindCommand, formatTaskList } from '../src/scheduler/commands.js';
import { createScheduledNoteStore, scheduledPromptBlock } from '../src/scheduler/notes.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const BJ = 'Asia/Shanghai';
const at = (iso) => Date.parse(iso);
const bjText = (ms) => describeInstant(ms, BJ).slice(0, 16);
const next = (s, from, n = 4, extra = {}) => previewOccurrences(normalizeSchedule(s), at(from), n, { tz: BJ, seed: 'seed-1', ...extra }).map(bjText);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-scheduler-'));

test('① 时区：按任务时区算，与机器时区无关；夏令时跳变', () => {
  assert.equal(zonedToUtc({ year: 2026, month: 10, day: 22, hour: 6, minute: 0 }, BJ), at('2026-10-21T22:00:00Z'), '北京时间 06:00 = UTC 前一天 22:00');
  assert.deepEqual(zonedParts(at('2026-10-21T22:00:00Z'), BJ).hour, 6);
  assert.equal(dateKey(at('2026-10-21T17:00:00Z'), BJ), '2026-10-22', '跨日按任务时区');
  // 芝加哥 2026-03-08 02:00 跳到 03:00：不存在的 02:30 落到跳变之后
  const dst = zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/Chicago');
  assert.equal(zonedParts(dst, 'America/Chicago').hour, 3);
  assert.equal(next({ type: 'daily', times: ['09:00'] }, '2026-03-07T00:00:00Z', 3, { tz: 'America/Chicago' })
    .length, 3, '夏令时前后每天照常');
  // UTC 偏移：带上，且随夏令时变化
  assert.equal(utcOffsetLabel(at('2026-10-21T08:00:00Z'), BJ), 'UTC+8');
  assert.equal(utcOffsetLabel(at('2026-07-01T00:00:00Z'), 'America/Chicago'), 'UTC-5');
  assert.equal(utcOffsetLabel(at('2026-01-15T00:00:00Z'), 'America/Chicago'), 'UTC-6');
  assert.equal(utcOffsetLabel(at('2026-10-21T08:00:00Z'), 'Asia/Kolkata'), 'UTC+5:30');
  assert.match(describeInstant(at('2026-10-21T22:00:00Z'), BJ), /^2026-10-22 06:00（北京时间 UTC\+8）$/);
  assert.match(describeInstant(at('2026-10-21T22:00:00Z'), 'UTC'), /（UTC）$/);
});

test('② 规则：各种重复方式、边界日期、随机规则、不合法规则', () => {
  const from = '2026-10-21T08:00:00Z'; // 北京时间 10-21 16:00（周三）
  assert.deepEqual(next({ type: 'daily', times: ['06:00', '18:00'] }, from, 3), ['2026-10-21 18:00', '2026-10-22 06:00', '2026-10-22 18:00']);
  assert.deepEqual(next({ type: 'once', date: '2026-10-22', time: '09:00' }, from), ['2026-10-22 09:00'], '一次性只有一次');
  assert.deepEqual(next({ type: 'once', date: '2026-10-20', time: '09:00' }, from), [], '过去的一次性没有下一次');
  assert.deepEqual(next({ type: 'weekly', weekdays: [1, 5], times: ['08:00'] }, from, 3), ['2026-10-23 08:00', '2026-10-26 08:00', '2026-10-30 08:00']);
  const holidays = new Set(['2026-10-22']);
  assert.deepEqual(next({ type: 'workdays', times: ['18:00'] }, from, 3, { holidays }), ['2026-10-21 18:00', '2026-10-23 18:00', '2026-10-26 18:00'], '跳过节假日与周末');
  assert.deepEqual(next({ type: 'monthly', days: [31], times: ['20:00'] }, from, 3), ['2026-10-31 20:00', '2026-11-30 20:00', '2026-12-31 20:00'], '没有 31 号的月份用最后一天');
  assert.deepEqual(next({ type: 'monthly', days: [-1], times: ['20:00'] }, '2027-02-01T00:00:00Z', 1), ['2027-02-28 20:00']);
  assert.deepEqual(next({ type: 'monthlyWeekday', nth: -1, weekday: 5, times: ['17:00'] }, from, 2), ['2026-10-30 17:00', '2026-11-27 17:00'], '每月最后一个周五');
  assert.deepEqual(next({ type: 'yearly', dates: ['02-29'], times: ['08:00'] }, from, 2), ['2028-02-29 08:00', '2032-02-29 08:00'], '2 月 29 日只在闰年');
  assert.deepEqual(next({ type: 'dates', items: [{ date: '2026-12-31', time: '23:59' }, { date: '2026-10-01', time: '09:00' }] }, from), ['2026-12-31 23:59']);
  assert.deepEqual(next({ type: 'everyNDays', every: 3, startDate: '2026-10-20', times: ['09:00'] }, from, 3), ['2026-10-23 09:00', '2026-10-26 09:00', '2026-10-29 09:00']);
  assert.deepEqual(next({ type: 'interval', everyMinutes: 240, window: ['08:00', '23:00'] }, from, 3), ['2026-10-21 20:00', '2026-10-22 08:00', '2026-10-22 12:00']);
  assert.deepEqual(next({ type: 'daily', times: ['09:00'], excludeDates: ['2026-10-22'], endDate: '2026-10-24' }, from, 5), ['2026-10-23 09:00', '2026-10-24 09:00'], '排除日期与结束日期');
  assert.deepEqual(next({ type: 'daily', times: ['09:00'], excludeHolidays: true }, from, 1, { holidays }), ['2026-10-23 09:00'], '跳过法定节假日');

  // 随机：同一任务同一天算几次都一样；在时间段内；间隔够；每月随机的次数对
  const s = normalizeSchedule({ type: 'dailyRandom', count: 3, window: ['09:00', '22:00'], minGapMin: 60 });
  const day = { year: 2026, month: 10, day: 23 };
  const a = minutesForDay(day, s, { seed: 'x' }); const b = minutesForDay(day, s, { seed: 'x' });
  assert.deepEqual(a, b, '确定性：重启不会重抽');
  assert.equal(a.length, 3);
  assert.ok(a.every((m) => m >= 540 && m <= 1320), '都在 09:00～22:00');
  assert.ok(a[1] - a[0] >= 60 && a[2] - a[1] >= 60, '至少隔 60 分钟');
  assert.notDeepEqual(minutesForDay(day, s, { seed: 'y' }), a, '不同任务不同时刻');
  const mr = normalizeSchedule({ type: 'monthlyRandom', count: 4, dayRange: [1, 28], window: ['10:00', '21:00'] });
  let hits = 0;
  for (let d = 1; d <= 31; d += 1) hits += minutesForDay({ year: 2026, month: 11, day: d }, mr, { seed: 'm' }).length;
  assert.equal(hits, 4, '每月随机 4 次');

  for (const [bad, re] of [
    [{ type: 'daily', times: ['25:00'] }, /格式不对/],
    [{ type: 'weekly', weekdays: [], times: ['08:00'] }, /至少一天/],
    [{ type: 'dailyRandom', count: 20, window: ['09:00', '10:00'], minGapMin: 30 }, /放不下/],
    [{ type: 'interval', everyMinutes: 5 }, /10～1440/],
    [{ type: 'daily', times: ['09:00'], startDate: '2026-10-10', endDate: '2026-10-01' }, /结束日期/],
    [{ type: 'whatever' }, /不支持/],
  ]) assert.throws(() => normalizeSchedule(bad), re);
  assert.match(describeSchedule(normalizeSchedule({ type: 'monthly', days: [1, -1], times: ['09:00'] })), /每月 1 号、最后一天 09:00/);

  // 高级：cron（分 时 日 月 周）
  const cron = (expr, n = 4) => next({ type: 'cron', expr }, from, n);
  assert.deepEqual(cron('0 9 * * 1-5', 3), ['2026-10-22 09:00', '2026-10-23 09:00', '2026-10-26 09:00'], '工作日 9 点');
  assert.deepEqual(cron('0 9 * * MON-FRI', 1), ['2026-10-22 09:00'], '周几可以写英文缩写');
  assert.deepEqual(cron('0 9 * * 7', 1), ['2026-10-25 09:00'], '7 也是周日');
  assert.deepEqual(cron('*/30 8-9 * * *', 4), ['2026-10-22 08:00', '2026-10-22 08:30', '2026-10-22 09:00', '2026-10-22 09:30'], '步长与范围');
  assert.deepEqual(cron('0 12 1,15 * 5', 3), ['2026-10-23 12:00', '2026-10-30 12:00', '2026-11-01 12:00'], '日和周都限定时按「任一满足」');
  assert.deepEqual(cron('@daily', 1), ['2026-10-22 00:00']);
  for (const [bad, re] of [['0 9 * *', /5 段/], ['61 9 * * *', /超出范围/], ['* * * * *', /太多了/], ['0 9 * * X', /不是数字/], ['0 9 */0 * *', /步长/]]) {
    assert.throws(() => parseCron(bad), re, bad);
  }
  assert.equal(describeSchedule(normalizeSchedule({ type: 'cron', expr: '0  9 * *  1-5' })), 'cron：0 9 * * 1-5', '多余空格规范化');
});

function engine({ nowRef, deliver = async () => ({ status: 'sent' }), file } = {}) {
  const sent = [];
  const sch = createScheduler({
    file: file ?? path.join(tmpDir(), 'scheduler.json'),
    now: () => nowRef.t,
    deliver: async (task, target, ctx) => { sent.push({ id: task.id, target, ctx }); return deliver(task, target, ctx); },
    validateTarget: (k) => (/^(group|private):\d+$/.test(k) ? null : '格式不对'),
    ownerKey: () => 'private:123',
    holidays: [],
    sensitive: (t) => /\/Users\//.test(t),
  });
  sch.load();
  return { sch, sent };
}

test('③ 引擎：执行、错过、限额、免打扰、满次停用、持久化、安全边界', async () => {
  const nowRef = { t: at('2026-10-21T21:00:00Z') }; // 北京 10-22 05:00
  const dir = tmpDir(); const file = path.join(dir, 'scheduler.json');
  const { sch, sent } = engine({ nowRef, file });

  // 安全：AI 不能改总开关和限制；AI 只能发给管理员私聊
  assert.throws(() => sch.updateSettings({ enabled: false }, { source: 'owner-chat-ai' }), /只能在控制台/);
  assert.throws(() => sch.createTask({ kind: 'text', text: 'hi', schedule: { type: 'daily', times: ['06:00'] }, targets: ['group:456'] }, { source: 'owner-chat-ai' }), /只能登记发给管理员私聊/);
  sch.updateSettings({ allowAiGroup: true }, { source: 'console' });
  const pending = sch.createTask({ kind: 'text', text: 'hi', schedule: { type: 'daily', times: ['06:00'] }, targets: ['group:456'] }, { source: 'owner-chat-ai' });
  assert.equal(pending.enabled, false); assert.equal(pending.pendingConfirm, true, '发群的 AI 任务建成待确认');
  assert.throws(() => sch.setEnabled(pending.id, true, { source: 'owner-chat-ai' }), /管理员确认/);
  assert.equal(sch.setEnabled(pending.id, true, { source: 'owner-command' }).pendingConfirm, false, '管理员确认后启用');
  sch.deleteTask(pending.id, { source: 'console' });
  assert.throws(() => sch.createTask({ kind: 'text', text: 'hi', schedule: { type: 'cron', expr: '0 9 * * *' }, targets: ['private:123'] }, { source: 'owner-chat-ai' }), /cron 表达式只能在控制台/, 'AI 不能用 cron');
  const cronTask = sch.createTask({ kind: 'text', text: 'hi', schedule: { type: 'cron', expr: '0 9 * * *' }, targets: ['private:123'] }, { source: 'console' });
  sch.deleteTask(cronTask.id, { source: 'console' });
  assert.throws(() => sch.createTask({ kind: 'text', text: '看 /Users/a/x', schedule: { type: 'daily', times: ['06:00'] }, targets: ['private:123'] }, { source: 'console' }), /路径/);
  sch.updateSettings({ limits: { minIntervalMin: 30 } }, { source: 'console' });
  assert.throws(() => sch.createTask({ kind: 'text', text: 'x', schedule: { type: 'interval', everyMinutes: 10 }, targets: ['private:123'] }, { source: 'console' }), /至少隔 30 分钟/, '两次最小间隔');
  sch.updateSettings({ limits: { minIntervalMin: 10 } }, { source: 'console' });

  // 到点执行（固定时间带随机偏移：在 ±2 分钟内）
  const t1 = sch.createTask({ name: '早安', kind: 'text', text: '早上好', schedule: { type: 'daily', times: ['06:00'] }, targets: ['private:123'] }, { source: 'console' });
  const raw = sch.getTask(t1.id);
  assert.ok(Math.abs(raw.nextRunAt - at('2026-10-21T22:00:00Z')) <= 2 * 60_000, '偏移不超过 ±2 分钟');
  assert.match(t1.nextRunText, /2026-10-22 06:00（北京时间 UTC\+8）（前后 2 分钟内）/, '显示设定的时间');
  nowRef.t = raw.nextRunAt + 5_000;
  await sch.tick();
  assert.deepEqual(sent.map((x) => x.target), ['private:123']);
  assert.equal(sch.getTask(t1.id).runs, 1);
  assert.ok(sch.getTask(t1.id).nextScheduledAt === at('2026-10-22T22:00:00Z'), '下一次是第二天 06:00');

  // 错过太久：记 missed，不补发
  nowRef.t = sch.getTask(t1.id).nextRunAt + 30 * 60_000;
  await sch.tick();
  assert.equal(sent.length, 1, '超过补发时间不补发');
  assert.equal(sch.snapshot().history[0].status, 'missed');

  // 免打扰（群）、每群每天上限、满 N 次停用
  sch.updateSettings({ limits: { perGroupPerDay: 1, quietStart: '00:00', quietEnd: '07:00' } }, { source: 'console' });
  assert.equal(inQuietHours(at('2026-10-22T20:30:00Z'), sch.snapshot().settings.limits, BJ), true, '北京 04:30 在免打扰时段');
  const t2 = sch.createTask({ name: '群', kind: 'text', text: '大家好', schedule: { type: 'dates', items: [{ date: '2026-10-24', time: '04:30' }, { date: '2026-10-24', time: '12:00' }, { date: '2026-10-24', time: '13:00' }] }, targets: ['group:456'], maxRuns: 3, jitterMin: 0 }, { source: 'console' });
  for (const iso of ['2026-10-23T20:30:00Z', '2026-10-24T04:00:00Z', '2026-10-24T05:00:00Z']) {
    nowRef.t = at(iso) + 1000;
    await sch.tick();
  }
  const groupHist = sch.snapshot().history.filter((h) => h.taskId === t2.id);
  assert.deepEqual(groupHist.filter((h) => h.target).map((h) => h.status).reverse(), ['skipped', 'sent', 'skipped'], '免打扰跳过、发一条、到每群上限跳过');
  assert.match(groupHist.find((h) => h.status === 'skipped' && /免打扰/.test(h.reason))?.reason ?? '', /免打扰/);
  assert.equal(sch.getTask(t2.id).enabled, false, '执行满 3 次自动停用');

  // 持久化：重新加载数据还在
  const again = engine({ nowRef, file }).sch;
  assert.equal(again.snapshot().tasks.length, 2);
  assert.equal(again.snapshot().settings.limits.perGroupPerDay, 1);
  // 读坏的文件不覆盖
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, '{坏了');
  const broken = engine({ nowRef, file: badFile }).sch;
  assert.equal(broken.isWritable(), false);
  broken.createTask({ kind: 'text', text: 'x', schedule: { type: 'daily', times: ['09:00'] }, targets: ['private:123'] }, { source: 'console' });
  assert.equal(fs.readFileSync(badFile, 'utf8'), '{坏了', '读坏的数据文件不会被覆盖');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, '数据文件 0600');

  // 限制收敛：越界值收敛到范围内
  assert.equal(normalizeSettings({ limits: { maxTasks: 99999, jitterMin: -5 } }).limits.maxTasks, 200);
  assert.equal(normalizeSettings({ limits: { jitterMin: -5 } }).limits.jitterMin, 0);
  assert.equal(normalizeSettings({}).limits.maxTasks, DEFAULT_LIMITS.maxTasks);

  // 任务数上限
  sch.updateSettings({ limits: { maxTasks: 2 } }, { source: 'console' });
  assert.throws(() => sch.createTask({ kind: 'text', text: 'x', schedule: { type: 'daily', times: ['09:00'] }, targets: ['private:123'] }, { source: 'console' }), /上限 2/);
  // 启动补漏：错过太久的记 missed 并顺延
  nowRef.t = at('2026-11-30T00:00:00Z');
  sch.setEnabled(t1.id, true, { source: 'console' });
  sch.getTask(t1.id).nextRunAt = at('2026-11-29T00:00:00Z');
  assert.equal(sch.catchUpOnStart().length, 1);
});

test('④ /remind 命令解析', () => {
  const ctx = { now: at('2026-10-21T08:00:00Z'), tz: BJ };
  assert.deepEqual(parseRemindCommand('/remind', ctx), { action: 'help' });
  assert.deepEqual(parseRemindCommand('/remind list', ctx), { action: 'list' });
  assert.deepEqual(parseRemindCommand('/remind del 3', ctx), { action: 'delete', id: 3 });
  assert.deepEqual(parseRemindCommand('/remind add daily 06:00,22:00 早上好', ctx).task, { name: '早上好', schedule: { type: 'daily', times: ['06:00', '22:00'] }, kind: 'text', text: '早上好' });
  assert.deepEqual(parseRemindCommand('/remind add in 2h 喝水', ctx).task.schedule, { type: 'once', date: '2026-10-21', time: '18:00' }, '「2 小时后」按北京时间换算');
  const r = parseRemindCommand('/remind add random 3 09:00-22:00 ai 随便聊一句', ctx).task;
  assert.equal(r.kind, 'ai'); assert.equal(r.instruction, '随便聊一句'); assert.equal(r.schedule.count, 3);
  assert.match(parseRemindCommand('/remind add weekly 8 08:00 x', ctx).error, /1=周一/);
  assert.match(parseRemindCommand('/remind add daily 06:00', ctx).error, /内容/);
  assert.equal(parseRemindCommand('普通消息', ctx), null);
  assert.match(formatTaskList([]), /还没有定时任务/);
  const notes = createScheduledNoteStore();
  notes.add('k', { taskId: 1, name: 'n', instruction: '发个表情包', whenText: 'x' });
  assert.match(scheduledPromptBlock(notes.peek('k')), /【定时任务】[\s\S]*发个表情包/);
  assert.equal(notes.take('k').length, 1); assert.equal(notes.peek('k').length, 0);
});

const listen = (server) => new Promise((resolve) => { if (server.listening) resolve(server.address().port); else server.once('listening', () => resolve(server.address().port)); });
function req(port, p, method = 'GET', headers = {}, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject); r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const ownerPm = (t) => ({ post_type: 'message', message_type: 'private', user_id: 123, self_id: 999999, message_id: Math.floor(Math.random() * 1e6), message: [{ type: 'text', data: { text: t } }], sender: { user_id: 123, nickname: 'owner' } });
const settle = () => new Promise((r) => setTimeout(r, 40));

test('⑤ 桥接：/remind 不进模型、到点发文字、AI 来说带上任务、AI 工具只在管理员私聊、控制台拒绝 agent token', async () => {
  const h = await bridgeHarness({ config: { admin: { consoleEscalationCooldownMs: 0 } } });
  const server = h.startConsoleServer();
  try {
    await h.initControllerOnce('reserved2');
    h.setMode('reserved2');
    const port = await listen(server);
    // /remind：桥接直接处理，回复走管理通道，不进模型
    const before = h.calls.prompts.length;
    await h.handleIncoming('private', 123, ownerPm('/remind add daily 06:00 早上好'), h.cfg);
    await settle();
    assert.equal(h.calls.prompts.length, before, '/remind 不交给模型');
    const reply = h.calls.sent.filter((x) => x.kind === 'private').map((x) => String(x.text)).join('\n');
    assert.match(reply, /已登记 #1：每天 06:00/);
    // 到点：固定文字发给管理员
    const task = h.scheduler.getTask(1);
    task.nextRunAt = Date.now() - 1000;
    const sentBefore = h.calls.sent.length;
    await h.scheduler.tick();
    assert.ok(h.calls.sent.slice(sentBefore).some((x) => x.kind === 'private' && String(x.text) === '早上好'), '到点发出固定文字');
    // 叫 AI 来说：唤醒提示词带上任务（先关掉定时任务免打扰，测试不能依赖跑测试时的北京时间）
    h.scheduler.updateSettings({ limits: { quietEnabled: false } }, { source: 'console' });
    const ai = h.scheduler.createTask({ name: '陪聊', kind: 'ai', instruction: '随便发个可爱的表情包', schedule: { type: 'daily', times: ['09:00'] }, targets: ['group:456'] }, { source: 'console' });
    h.scheduler.getTask(ai.id).nextRunAt = Date.now() - 1000;
    await h.ensureSession('group:456');
    const promptsBefore = h.calls.prompts.length;
    await h.scheduler.tick();
    for (let i = 0; i < 50 && h.calls.prompts.length === promptsBefore; i += 1) await settle();
    const wake = h.calls.prompts.slice(promptsBefore).map((p) => p.content.map((c) => c.text ?? '').join('\n')).join('\n');
    assert.match(wake, /【定时任务】[\s\S]*随便发个可爱的表情包/, '唤醒提示词里有任务说明');
    assert.equal(h.scheduledNotes.peek('group:456').length, 0, '投递后取走，不会下次再重复');

    // AI 工具：群会话不能用；管理员私聊能用，桥接另发确认
    const ownerSt = h.getSocialV2State('private:123');
    const groupSt = h.getSocialV2State('group:456');
    const call = (key, token, payload) => req(port, '/api/socialV2/schedule', 'POST', { 'x-agent-token': token, 'x-agent-call': '1' }, { key, ...payload });
    const fromGroup = await call('group:456', groupSt.agentToken, { action: 'create', task: { kind: 'text', text: 'x', schedule: { type: 'daily', times: ['07:00'] } } });
    assert.equal(fromGroup.status, 403); assert.match(fromGroup.json.error, /只能在管理员的私聊里登记/);
    const sentBefore2 = h.calls.sent.length;
    const ok = await call('private:123', ownerSt.agentToken, { action: 'create', task: { name: '喝水', kind: 'text', text: '记得喝水', schedule: { type: 'daily', times: ['15:00'] } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.ok(ok.json.upcoming, '返回接下来几次的时间');
    await settle();
    assert.ok(h.calls.sent.slice(sentBefore2).some((x) => /AI 帮你登记了定时任务/.test(String(x.text))), '桥接另发确认给管理员');
    const toGroup = await call('private:123', ownerSt.agentToken, { action: 'create', task: { kind: 'text', text: 'x', schedule: { type: 'daily', times: ['07:00'] }, targets: ['group:456'] } });
    assert.equal(toGroup.status, 400); assert.match(toGroup.json.error, /只能登记发给管理员私聊[\s\S]*不要口头答应/);

    // 控制台接口：管理员可以；AI 的令牌不行
    const list = await req(port, '/api/scheduler');
    assert.equal(list.status, 200); assert.ok(list.json.tasks.length >= 3); assert.ok(list.json.targets.some((t) => t.kind === 'owner'));
    const asAgent = await req(port, '/api/scheduler/settings', 'POST', { 'x-agent-token': ownerSt.agentToken }, { enabled: false });
    assert.equal(asAgent.status, 403, '定时任务的控制台接口拒绝 agent token');
    const created = await req(port, '/api/scheduler/tasks', 'POST', {}, { name: '群公告', kind: 'text', text: '周末愉快', schedule: { type: 'weekly', weekdays: [5], times: ['18:00'] }, targets: ['group:456'] });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const badTarget = await req(port, '/api/scheduler/tasks', 'POST', {}, { kind: 'text', text: 'x', schedule: { type: 'daily', times: ['09:00'] }, targets: ['group:999999'] });
    assert.equal(badTarget.status, 400); assert.match(badTarget.json.error, /不在白名单/);
    const preview = await req(port, '/api/scheduler/preview', 'POST', {}, { schedule: { type: 'dailyRandom', count: 3, window: ['09:00', '22:00'] } });
    assert.equal(preview.json.next.length, 5);
  } finally {
    h.scheduler.stop();
    h.ext.controller.stop();
    await new Promise((r) => server.close(r));
    await h.close();
  }
});

test('⑥ 控制台：左侧「聊天行为」黑话词库下面有定时任务，页面与接口接上', () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const nav = html.slice(html.indexOf('<nav id="mainNav">'), html.indexOf('</nav>'));
  assert.ok(nav.indexOf('data-view="slang"') < nav.indexOf('data-view="scheduler"') && nav.indexOf('data-view="scheduler"') < nav.indexOf('<div class="nav-label">管理</div>'), '位置在黑话词库下面、「管理」分组之前');
  assert.match(html, /scheduler: \['定时任务'/);
  assert.match(html, /<section id="section-scheduler" data-page="scheduler"/);
  for (const id of ['schedEnabled', 'schedTimezone', 'schedAllowAiPrivate', 'schedAllowAiGroup', 'schedLimits', 'schedList', 'schedEditor', 'schedType', 'schedTargets', 'schedPreview', 'schedHistory']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /api\('\/api\/scheduler\/preview', 'POST'/);
  assert.match(html, /<option value="cron">高级：cron 表达式<\/option>/, '重复方式里有「高级」');
  assert.match(html, /<select id="schedTaskTz"><\/select>/, '任务时区是下拉');
  assert.match(html, /timeZoneName: 'shortOffset'/, '时区后面带 UTC 偏移');
  assert.match(html, /Intl\.supportedValuesOf\('timeZone'\)/, '列出全部时区');
  assert.match(html, /if \(page === 'scheduler' && typeof refreshScheduler === 'function'\) setTimeout\(\(\) => refreshScheduler\(\), 0\);/, '直接打开 #scheduler 时推迟到脚本跑完再刷新');
  // 时区下拉的初始化在 schedEl 定义之前，不能用 schedEl（否则整段脚本报错）
  const tzInit = html.indexOf("document.getElementById('schedTimezone').innerHTML = schedTzOptionsHtml(false);");
  assert.ok(tzInit > 0 && tzInit < html.indexOf('const schedEl = (id)'), '时区下拉初始化不依赖 schedEl');
});
