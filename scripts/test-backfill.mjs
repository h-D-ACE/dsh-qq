// 断线期间错过的消息：恢复后补收。全部离线、假数据（夹具里的假号：管理员 123、群 456、机器人 999999）。
//   ① 模块：配置规范化、断档检测（含桥接重启后读回）、消息 ID 去重、命令类消息识别、挑选（时间窗、自己发的、
//      处理过的、命令单独拿出来、太旧、条数上限、按时间排序）、提示文字；
//   ② 端到端：补收的消息进未读（原始时间 + backfill 标记）、有 @ 就排上唤醒、唤醒提示最前面说明是补收的且送达后清掉；
//      不执行补收到的命令（群里 /reset、管理员私聊里的确认码），只私聊提醒管理员；重复补收不重复记；实时收过的不再补；
//      太旧的只记下不唤醒；非二代模式不补；
//   ③ 断档触发：上次事件包时间落盘，桥接启动后第一个事件包发现断档，自动补收；
//   ④ 拉历史失败：记下没补上的时间、一分钟后重试、下次断档从更早的时间一起补。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKFILL_DEFAULTS, normalizeBackfillConfig, createUpstreamGapTracker, createSeenMessageIds, isCommandLike, plainTextOf,
  selectBackfill, describeDuration, backfillNoticeBlock,
} from '../src/backfill.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
const OWNER = 'private:123';
const SELF = 999999;
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('① 模块', () => {
  assert.deepEqual(normalizeBackfillConfig({}), { ...BACKFILL_DEFAULTS });
  assert.equal(normalizeBackfillConfig({ gapMs: 5 }).gapMs, BACKFILL_DEFAULTS.gapMs, '太小回到默认');
  assert.equal(normalizeBackfillConfig({ enabled: false }).enabled, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-backfill-'));
  try {
    const file = path.join(dir, 'state', 'upstream-seen.json');
    let t = 1_000_000;
    const tr = createUpstreamGapTracker({ file, gapMs: 120_000, now: () => t });
    assert.equal(tr.notePacket(), null, '第一次（没有记录）不算断档');
    t += 30_000; assert.equal(tr.notePacket(), null, '30 秒一次心跳：正常');
    t += 60_000; assert.equal(tr.notePacket(), null);
    const since = t;
    t += 37 * 60_000;
    assert.deepEqual(tr.notePacket(), { since, gapMs: 37 * 60_000 }, '隔了 37 分钟：断过');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const saved = t;
    t += 10 * 60_000;
    const again = createUpstreamGapTracker({ file, gapMs: 120_000, now: () => t });
    assert.deepEqual(again.notePacket(), { since: saved, gapMs: 10 * 60_000 }, '桥接重启后读回上次时间，也能发现断档');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const seen = createSeenMessageIds({ max: 3 });
  seen.add(GROUP, 1); seen.add(GROUP, 2);
  assert.equal(seen.has(GROUP, '1'), true, '数字和字符串一样');
  assert.equal(seen.has('group:789', 1), false, '按会话分开');
  for (const i of [3, 4, 5]) seen.add(GROUP, i);
  assert.equal(seen.has(GROUP, 1), false, '有上限，旧的淘汰');

  for (const t of ['/reset', '/level L3', '123456', '确认', '#2 同意', 'y']) assert.equal(isCommandLike(t), true, t);
  for (const t of ['在吗', '确认一下今晚几点', '12345 是我的幸运数字', '']) assert.equal(isCommandLike(t), false, t);
  assert.equal(plainTextOf([{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: ' /reset' } }]), ' /reset');

  const now = 10_000_000_000;
  const msg = (id, minAgo, text, extra = {}) => ({ message_id: id, time: Math.floor((now - minAgo * 60_000) / 1000), user_id: 777, self_id: SELF, message: [{ type: 'text', data: { text } }], raw_message: text, ...extra });
  const seen2 = createSeenMessageIds(); seen2.add(GROUP, 3);
  const { items, skippedCommands } = selectBackfill([
    msg(5, 5, '后到的'), msg(1, 20, '先到的'), msg(2, 90, '断线前很久的'), msg(3, 10, '实时收过的'),
    msg(4, 8, '自己发的', { user_id: SELF }), msg(6, 6, '/reset'), msg(1, 20, '先到的'),
  ], { key: GROUP, since: now - 30 * 60_000, now, seen: seen2, config: {} });
  assert.deepEqual(items.map((x) => x.event.message_id), [1, 5], '只要断线这段时间的、按时间排序、去掉自己发的 / 收过的 / 重复的');
  assert.deepEqual(skippedCommands.map((x) => x.event.message_id), [6], '命令单独拿出来');
  assert.equal(items[0].ageMs, 20 * 60_000);
  const old = selectBackfill([msg(9, 400, '很早')], { key: GROUP, since: now - 500 * 60_000, now, config: {} });
  assert.equal(old.items[0].tooOld, true, '超过 6 小时：太旧');
  const many = selectBackfill(Array.from({ length: 80 }, (_, i) => msg(100 + i, 30 - i * 0.3, `第${i}条`)), { key: GROUP, since: now - 31 * 60_000, now, config: { maxPerConversation: 10 } });
  assert.equal(many.items.length, 10, '条数上限');
  assert.equal(many.items.at(-1).event.message_id, 179, '留的是最近的');

  assert.equal(describeDuration(37 * 60_000), '约 37 分钟');
  assert.equal(describeDuration(125 * 60_000), '约 2 小时 5 分');
  assert.match(backfillNoticeBlock({ gapMs: 37 * 60_000, count: 2, earliestAgeMs: 20 * 60_000 }), /^【补收 · 桥接提供】.*断开过约 37 分钟.*2 条.*约 20 分钟前/);
});

const ago = (min) => Math.floor((Date.now() - min * 60_000) / 1000);
const groupMsg = (id, min, segs, user = 777) => ({ post_type: 'message', message_type: 'group', group_id: 456, user_id: user, self_id: SELF, message_id: id, time: ago(min), message: segs, raw_message: segs.map((s) => s.data?.text ?? '').join(''), sender: { user_id: user, card: '群友', nickname: '群友' } });
const text = (t) => ({ type: 'text', data: { text: t } });
const atSelf = { type: 'at', data: { qq: String(SELF) } };
const ownerMsg = (id, min, t) => ({ post_type: 'message', message_type: 'private', user_id: 123, self_id: SELF, message_id: id, time: ago(min), message: [text(t)], raw_message: t, sender: { user_id: 123, nickname: '管理员' } });

function historyBot(hist) {
  return (action, params) => {
    if (action === 'get_group_msg_history') return { status: 'ok', retcode: 0, data: { messages: hist.group?.[params.group_id] ?? [] } };
    if (action === 'get_friend_msg_history') return { status: 'ok', retcode: 0, data: { messages: hist.private?.[params.user_id] ?? [] } };
    return { status: 'ok', retcode: 0, data: [] };
  };
}

test('② 端到端：补收进未读、排唤醒、提示说明、不执行命令、去重、太旧不唤醒、非二代不补', async () => {
  const hist = {
    group: { 456: [
      groupMsg(5001, 20, [atSelf, text(' 鲸鱼在吗')]),
      groupMsg(5002, 18, [text('它好像睡着了')]),
      groupMsg(5003, 15, [text('/reset')], 123),
      groupMsg(5004, 12, [text('我自己发的')], SELF),
      groupMsg(5005, 11, [text('实时收过的')]),
    ] },
    private: { 123: [ownerMsg(6001, 16, '654321'), ownerMsg(6002, 14, '在吗，回我一下')] },
  };
  const h = await bridgeHarness({ botRequest: historyBot(hist) });
  try {
    h.setMode('reserved2');
    const sid = await h.ensureSession(GROUP);
    const st = h.getSocialV2State(GROUP);
    st.bootstrapSent = true;
    h.roleRefresh.markSeen(GROUP, sid, h.currentRoleFingerprintV2());
    await h.handleIncoming('group', 456, groupMsg(5005, 11, [text('实时收过的')]), h.cfg); // 断线前实时收到过
    const unread0 = st.unread.length;

    const r = await h.runBackfill({ since: Date.now() - 25 * 60_000, gapMs: 25 * 60_000 });
    assert.ok(r.summary.some((x) => x.startsWith(GROUP)), JSON.stringify(r));
    const added = st.unread.slice(unread0);
    assert.equal(added.map((m) => m.messageId).join(','), '5001,5002', '只补错过的：不含命令、自己发的、实时收过的');
    assert.ok(added.every((m) => m.backfill === true), '标了 backfill');
    assert.ok(Math.abs(added[0].time - ago(20) * 1000) < 2000, '记原始发送时间');
    assert.equal(h.state.sessions[GROUP], sid, '群里补收到的 /reset 没有执行');
    assert.ok(st.pendingWakeReason, '有 @：排上了唤醒');

    const ownerSt = h.getSocialV2State(OWNER);
    assert.ok(ownerSt.unread.some((m) => m.messageId === '6002' && m.backfill), '管理员私聊的普通消息补收');
    assert.ok(!ownerSt.unread.some((m) => m.messageId === '6001'), '确认码不进未读');
    const warn = h.calls.sent.find((x) => x.kind === 'private' && String(x.id) === '123' && /没有执行/.test(String(x.text)));
    assert.ok(warn, '私聊提醒管理员命令没执行');
    assert.ok(!String(warn.text).includes('654321'), '提醒里的确认码打码');
    assert.equal(r.ownerCommands, 1);

    const prompt = h.buildWakePromptV2(GROUP, 'atMention');
    assert.match(prompt, /^【补收 · 桥接提供】.*2 条/, '唤醒提示最前面说明是补收的');
    await h.deliverPrompt(GROUP, '', { wakeReason: 'atMention' });
    assert.ok(!h.buildWakePromptV2(GROUP, 'atMention').includes('【补收'), '送达后清掉');

    const before = st.unread.length;
    await h.runBackfill({ since: Date.now() - 25 * 60_000, gapMs: 25 * 60_000 });
    assert.equal(st.unread.length, before, '重复补收不重复记');

    // 太旧的：只记下不唤醒
    hist.group[456].push(groupMsg(5010, 420, [atSelf, text(' 昨天的事')]));
    st.pendingWakeReason = null;
    if (st.wakeBatchTimer) { clearTimeout(st.wakeBatchTimer); st.wakeBatchTimer = null; }
    await h.runBackfill({ since: Date.now() - 500 * 60_000, gapMs: 500 * 60_000 });
    assert.ok(st.unread.some((m) => m.messageId === '5010' && m.backfill), '太旧的也记下');
    assert.ok(!st.pendingWakeReason, '太旧的不唤醒');

    // 非二代模式：不补
    hist.group[456].push(groupMsg(5020, 3, [atSelf, text(' 现在呢')]));
    h.setMode('chat');
    const skipped = await h.runBackfill({ since: Date.now() - 10 * 60_000, gapMs: 10 * 60_000 });
    assert.equal(skipped.skipped, 'mode');
    assert.ok(!st.unread.some((m) => m.messageId === '5020'), '非二代模式不补');
  } finally { await h.close(); }
});

test('③ 断档触发：桥接启动后第一个事件包发现断档并自动补收', async () => {
  const hist = { group: { 456: [groupMsg(7001, 5, [atSelf, text(' 有人吗')])] } };
  const h = await bridgeHarness({
    botRequest: historyBot(hist),
    config: { snowluma: { backfill: { settleMs: 0 } } },
    files: { 'state/upstream-seen.json': { lastPacketAt: Date.now() - 9 * 60_000 } },
  });
  try {
    h.setMode('reserved2');
    await h.ensureSession(GROUP);
    h.getSocialV2State(GROUP).bootstrapSent = true;
    h.noteUpstreamPacket('meta_event/heartbeat');
    for (let i = 0; i < 100 && !h.getSocialV2State(GROUP).unread.some((m) => m.messageId === '7001'); i += 1) await settle();
    assert.ok(h.getSocialV2State(GROUP).unread.some((m) => m.messageId === '7001' && m.backfill), '自动补收了');
    const n = h.getSocialV2State(GROUP).unread.length;
    h.noteUpstreamPacket('meta_event/heartbeat');
    await settle(80);
    assert.equal(h.getSocialV2State(GROUP).unread.length, n, '紧接着的心跳不再触发');
  } finally { await h.close(); }

  const off = await bridgeHarness({
    botRequest: historyBot(hist),
    config: { snowluma: { backfill: { enabled: false, settleMs: 0 } } },
    files: { 'state/upstream-seen.json': { lastPacketAt: Date.now() - 9 * 60_000 } },
  });
  try {
    off.setMode('reserved2');
    await off.ensureSession(GROUP);
    off.noteUpstreamPacket('meta_event/heartbeat');
    await settle(80);
    assert.ok(!off.getSocialV2State(GROUP).unread.some((m) => m.messageId === '7001'), '关掉后不补');
  } finally { await off.close(); }
});

test('④ 拉历史失败（Mac 半睡半醒、NapCat 还没起来）：不说「没有错过」，记下没补上的时间，重试时从更早的时间补', async () => {
  // 实测：DarkWake 时连接刚通，接口平台报「实例 napcat-main 不可用」，三个会话全失败，日志却写成「没有错过的消息」，
  // 下一次断档只从新的时间点往后补，中间那段就漏了。
  let down = true;
  const hist = { group: { 456: [groupMsg(8001, 30, [atSelf, text(' 早先 @ 你的')]), groupMsg(8002, 3, [text('后来的')])] } };
  const ok = historyBot(hist);
  const h = await bridgeHarness({ botRequest: (action, params) => { if (down && /msg_history/.test(action)) throw new Error('接口平台：实例 napcat-main 不可用（connect_failed）'); return ok(action, params); } });
  try {
    h.setMode('reserved2');
    await h.ensureSession(GROUP);
    h.getSocialV2State(GROUP).bootstrapSent = true;
    const first = await h.runBackfill({ since: Date.now() - 35 * 60_000, gapMs: 35 * 60_000 });
    assert.ok(first.failed.includes(GROUP), '这个群没拉到');
    assert.equal(first.retryInMs, 60_000, '一分钟后重试');
    assert.ok(h.backfillUnfinished.has(GROUP), '记下了没补上的时间');
    assert.equal(first.summary.length, 0, '什么都没补到，但记成失败而不是「没有错过」');

    // 恢复之后又来一次断档，起点比上次晚：没补上的群仍从更早的时间开始补
    down = false;
    const second = await h.runBackfill({ since: Date.now() - 5 * 60_000, gapMs: 5 * 60_000 });
    assert.equal(second.failed.length, 0);
    const ids = h.getSocialV2State(GROUP).unread.map((m) => m.messageId);
    assert.ok(ids.includes('8001'), '早先那段也补回来了');
    assert.ok(ids.includes('8002'));
    assert.ok(!h.backfillUnfinished.has(GROUP), '补上了就清掉');
    assert.equal(second.retryInMs, 0, '都拉到了不再重试');
  } finally { await h.close(); }
});
