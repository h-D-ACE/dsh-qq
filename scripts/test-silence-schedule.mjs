// 定时静默：按时间段让 AI 停下来省 token。全部离线、假数据（夹具里的假号 123 / 456）。
//   ① 模块：时间段校验、哪些天（每天 / 工作日 / 周末 / 自选 + 跳过节假日）、跨午夜以开始那天为准、接下来的时间段、
//      DeepSeek 高峰预设取自价目表、临时恢复到这一段结束、开始 / 结束检测、持久化 0600、读坏只读；
//   ② 桥接：静默时群消息记下但不唤醒、各种唤醒都不发（真正不花 token）、管理员私聊默认不受影响、发送被拦；
//      定时任务「叫 AI 来说」跳过 / 设了「照常执行」就放行、固定文字照发、预览标出会跳过的那几次；
//      手动「恢复正常」= 这一段临时恢复；结束时给被直接找过的会话补一次唤醒；控制台接口拒绝 agent token；
//   ③ 控制台：静默开关卡片里的定时静默面板与任务表单选项。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  normalizeSilenceConfig, activeWindow, upcomingWindows, peakPresetRanges, describeRange, rangeAppliesOnDay, createSilenceSchedule,
} from '../src/silence-schedule.js';
import { resolvePriceTable } from '../src/model-prices.js';
import { zonedParts } from '../src/scheduler/time.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const at = (iso) => Date.parse(iso);
const BJ = 'Asia/Shanghai';
const cfgOf = (ranges, extra = {}) => normalizeSilenceConfig({ enabled: true, timezone: BJ, ranges, ...extra });
const name = (cfg, iso, holidays = new Set()) => activeWindow(cfg, at(iso), { holidays })?.range.name ?? null;

test('① 模块：哪些天、节假日、跨午夜、接下来、高峰预设、临时恢复、持久化', () => {
  for (const [bad, re] of [
    [{ start: '9:0', end: '12:00' }, /HH:mm/],
    [{ start: '09:00', end: '09:00' }, /不能一样/],
    [{ start: '09:00', end: '12:00', days: 'custom', weekdays: [] }, /至少选一天/],
  ]) assert.throws(() => normalizeSilenceConfig({ ranges: [bad] }), re);
  assert.equal(normalizeSilenceConfig({}).enabled, false, '默认不开');
  assert.equal(normalizeSilenceConfig({ timezone: 'Mars/Base' }).timezone, BJ);

  const cfg = cfgOf([
    { name: '上午高峰', start: '09:00', end: '12:00', days: 'workdays', skipHolidays: true },
    { name: '周末', start: '10:00', end: '11:00', days: 'weekend' },
    { name: '周三午休', start: '12:00', end: '14:00', days: 'custom', weekdays: [3] },
    { name: '周五深夜', start: '23:00', end: '07:00', days: 'custom', weekdays: [5] },
    { name: '关掉的', enabled: false, start: '00:00', end: '23:59' },
  ]);
  const hol = new Set(['2026-10-23']);
  assert.equal(name(cfg, '2026-10-21T02:00:00Z', hol), '上午高峰', '周三 10:00');
  assert.equal(name(cfg, '2026-10-21T05:00:00Z', hol), '周三午休', '周三 13:00 自选');
  assert.equal(name(cfg, '2026-10-22T05:00:00Z', hol), null, '周四 13:00 不在自选里');
  assert.equal(name(cfg, '2026-10-23T02:00:00Z', hol), null, '节假日跳过');
  assert.equal(name(cfg, '2026-10-23T16:30:00Z', hol), '周五深夜', '周六 00:30：跨午夜按开始那天（周五）算');
  assert.equal(name(cfg, '2026-10-23T22:59:00Z', hol), '周五深夜', '周六 06:59 仍在');
  assert.equal(name(cfg, '2026-10-23T23:00:00Z', hol), null, '07:00 结束（不含）');
  assert.equal(name(cfg, '2026-10-24T02:30:00Z', hol), '周末', '周六 10:30');
  assert.equal(name(cfg, '2026-10-21T15:00:00Z', hol), null, '关掉的时间段不生效');
  assert.equal(activeWindow({ ...cfg, enabled: false }, at('2026-10-21T02:00:00Z')), null, '总开关关掉');
  assert.equal(rangeAppliesOnDay(cfg.ranges[0], { year: 2026, month: 10, day: 24 }, new Set()), false, '工作日不含周六');
  assert.match(describeRange(cfg.ranges[3]), /周五 23:00–07:00（跨午夜）/);

  const up = upcomingWindows(cfg, at('2026-10-21T03:00:00Z'), 3, { holidays: hol });
  assert.deepEqual(up.map((x) => x.range.name), ['上午高峰', '周三午休', '上午高峰'], '从正在进行的那段开始列');

  const preset = peakPresetRanges(resolvePriceTable());
  assert.deepEqual(preset.map((r) => [r.start, r.end, r.days, r.skipHolidays]), [['09:00', '12:00', 'workdays', true], ['14:00', '18:00', 'workdays', true]], '与价目表的高峰窗口一致');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-silence-'));
  try {
    const file = path.join(dir, 'silence.json');
    const clock = { t: at('2026-10-21T02:00:00Z') };
    const s = createSilenceSchedule({ file, now: () => clock.t });
    s.update({ enabled: true, timezone: BJ, ranges: preset });
    assert.equal(s.current().range.name, '上午高峰');
    assert.equal(s.poll().type, 'start');
    assert.equal(s.poll(), null, '状态没变不重复报');
    const w = s.resumeCurrent();
    assert.equal(w.range.name, '上午高峰');
    assert.equal(s.current(), null, '这一段临时恢复');
    assert.equal(s.poll().type, 'end');
    clock.t = at('2026-10-21T06:30:00Z'); // 14:30 下午高峰
    assert.equal(s.current().range.name, '下午高峰', '下一段照常静默');
    assert.equal(s.override(), null, '过了这一段，临时恢复自动作废');
    const again = createSilenceSchedule({ file, now: () => clock.t });
    assert.equal(again.config().ranges.length, 2, '持久化');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{坏');
    const bad = createSilenceSchedule({ file: path.join(dir, 'bad.json') });
    assert.equal(bad.isWritable(), false, '读坏了降级只读');
    bad.update({ enabled: true });
    assert.equal(fs.readFileSync(path.join(dir, 'bad.json'), 'utf8'), '{坏', '不覆盖');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
const settle = () => new Promise((r) => setTimeout(r, 40));
const groupAt = (text) => ({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 777, self_id: 999999, message_id: Math.floor(Math.random() * 1e6), message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text } }], raw_message: text, sender: { user_id: 777, card: '群友', nickname: '群友' } });
/** 覆盖「现在」的时间段（北京时间，前后各留 1 小时；跨午夜也没关系）。 */
function rangeAroundNow() {
  const p = zonedParts(Date.now(), BJ);
  const h = (n) => String((n + 24) % 24).padStart(2, '0');
  return { name: '测试段', start: `${h(p.hour - 1)}:00`, end: `${h(p.hour + 2)}:00`, days: 'every' };
}

test('② 桥接：静默时不唤醒、消息照记、私聊不受影响、定时任务跳过 / 放行、临时恢复、结束补唤醒', async () => {
  const h = await bridgeHarness({ config: { admin: { consoleEscalationCooldownMs: 0 } } });
  const server = h.startConsoleServer();
  try {
    await h.initControllerOnce('reserved2');
    h.setMode('reserved2');
    h.scheduler.updateSettings({ limits: { quietEnabled: false } }, { source: 'console' });
    const port = await listen(server);
    await h.ensureSession('group:456');
    // 开定时静默（覆盖现在）
    const saved = await req(port, '/api/silence', 'POST', {}, { enabled: true, timezone: BJ, ranges: [rangeAroundNow()] });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.active.name, '测试段');
    assert.ok(h.scheduledSilenceFor('group:456'), '群在静默里');
    assert.equal(h.scheduledSilenceFor('private:123'), null, '管理员私聊默认不受影响');
    assert.equal(h.shouldBlockSilentReply('group:456'), true, '群里发送被拦');

    // 群里 @ AI：消息记下，不唤醒；标记结束时补唤醒
    const prompts0 = h.calls.prompts.length;
    await h.handleIncoming('group', 456, groupAt('鲸鱼在吗'), h.cfg);
    await h.sendWakePromptV2('group:456', 'proactiveCheck');
    await h.sendWakePromptV2('group:456', 'timeout');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.calls.prompts.length, prompts0, '静默期间一次都没唤醒（不花 token）');
    const st = h.getSocialV2State('group:456');
    assert.ok(st.unread.some((m) => /鲸鱼在吗/.test(m.text)), '消息照样记进未读');
    assert.equal(st.silenceMissedDirect, true, '记下「有人直接找过 AI」');

    // 定时任务：叫 AI 来说 → 跳过；照常执行 → 放行；固定文字照发；预览标出会跳过
    const skip = h.scheduler.createTask({ name: 'AI 群聊', kind: 'ai', instruction: '随便聊一句', schedule: { type: 'daily', times: ['09:00'] }, targets: ['group:456'] }, { source: 'console' });
    const run = h.scheduler.createTask({ name: 'AI 例外', kind: 'ai', instruction: '提醒交周报', schedule: { type: 'daily', times: ['10:00'] }, targets: ['group:456'], runDuringSilence: true }, { source: 'console' });
    const text = h.scheduler.createTask({ name: '文字', kind: 'text', text: '记得喝水', schedule: { type: 'daily', times: ['11:00'] }, targets: ['group:456'] }, { source: 'console' });
    for (const t of [skip, run, text]) h.scheduler.getTask(t.id).nextRunAt = Date.now() - 1000;
    const sent0 = h.calls.sent.length;
    await h.scheduler.tick();
    for (let i = 0; i < 50 && h.calls.prompts.length === prompts0; i += 1) await settle();
    const hist = h.scheduler.snapshot().history;
    assert.match(hist.find((x) => x.taskId === skip.id)?.reason ?? '', /定时静默中（测试段/, '叫 AI 来说的任务被跳过');
    assert.equal(hist.find((x) => x.taskId === run.id)?.status, 'sent', '设了照常执行的放行');
    assert.ok(h.calls.prompts.slice(prompts0).some((p) => p.content.some((c) => /提醒交周报/.test(c.text ?? ''))), '照常执行的唤醒了 AI');
    assert.ok(h.calls.sent.slice(sent0).some((x) => String(x.text) === '记得喝水'), '固定文字照发');
    const pv = await req(port, '/api/scheduler/preview', 'POST', {}, { schedule: { type: 'interval', everyMinutes: 30, window: ['00:00', '23:30'] }, kind: 'ai', targets: ['group:456'], count: 5 });
    assert.ok(pv.json.next.some((x) => x.silenced === '测试段'), '预览标出落在静默里的那几次');

    // 手动「恢复正常」：这一段临时恢复
    const resume = await req(port, '/api/role-mode', 'POST', {}, { mode: 'active' });
    assert.equal(resume.json.resumedScheduled.name, '测试段');
    assert.equal(h.scheduledSilenceFor('group:456'), null, '这一段临时恢复了');
    const status = await req(port, '/api/status');
    assert.equal(status.json.silence, null, '状态里不再显示静默');

    // 结束（这里用关掉定时静默来模拟）：给被直接找过的会话补一次唤醒
    await req(port, '/api/silence', 'POST', {}, { enabled: true, timezone: BJ, ranges: [rangeAroundNow()] });
    h.silenceTick(); // 记下「静默中」
    await req(port, '/api/silence', 'POST', {}, { enabled: false, timezone: BJ, ranges: [rangeAroundNow()] });
    const prompts1 = h.calls.prompts.length;
    h.silenceTick();
    for (let i = 0; i < 50 && h.calls.prompts.length === prompts1; i += 1) await settle();
    const wake = h.calls.prompts.slice(prompts1).map((p) => p.content.map((c) => c.text ?? '').join('\n')).join('\n');
    // 会话若还忙着上一轮（上面「照常执行」的任务刚唤醒过它），补唤醒会排队，空下来再发
    const queued = (h.getSocialV2State('group:456').pendingWakeReasons || []).some((r) => r.reason === 'silenceEnded');
    assert.ok(/定时静默刚结束/.test(wake) || queued, '结束时补一次唤醒（立即发出，或会话忙时排队）');
    assert.equal(h.getSocialV2State('group:456').silenceMissedDirect, false);

    // 控制台接口：AI 的令牌不行；不合法的设置拒绝
    const asAgent = await req(port, '/api/silence', 'POST', { 'x-agent-token': st.agentToken }, { enabled: false });
    assert.equal(asAgent.status, 403);
    const bad = await req(port, '/api/silence', 'POST', {}, { enabled: true, ranges: [{ start: '09:00', end: '09:00' }] });
    assert.equal(bad.status, 400);
  } finally {
    h.scheduler.stop();
    h.ext.controller.stop();
    await new Promise((r) => server.close(r));
    await h.close();
  }
});

test('③ 控制台：静默开关卡片里有定时静默面板；任务表单有「静默时段内」选项', () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const sec = html.slice(html.indexOf('<section id="section-silent"'), html.indexOf('</section>', html.indexOf('<section id="section-silent"')));
  for (const id of ['silentOn', 'silentOff', 'silenceStatePill', 'silenceEnabled', 'silenceTz', 'silenceRanges', 'silenceAdd', 'silencePeak', 'silenceSave', 'silenceUpcoming']) assert.ok(sec.includes(`id="${id}"`), id);
  for (const opt of ['stopWakes', 'recordMessages', 'catchUpOnEnd', 'pauseAiTasks', 'includeOwnerPrivate']) assert.ok(sec.includes(`data-silence-opt="${opt}"`), opt);
  assert.match(html, /<option value="skip">定时静默时段内：跳过这次<\/option><option value="run">定时静默时段内：照常执行<\/option>/);
  assert.match(html, /定时任务免打扰（只拦定时任务发往群的消息/, '定时任务那边改名为「定时任务免打扰」');
  assert.ok(!/#section-silent \.row \{\s*grid-column:2/.test(html), '静默卡片不再把每一行钉在第 2 栏');
});
