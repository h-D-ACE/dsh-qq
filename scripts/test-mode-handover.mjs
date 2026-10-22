// 切换 agent 等级「不失忆」：聊天会话休眠复用 + owner 私聊交接。全部离线、假数据（夹具里的假号 123 / 456）。
//   ① 模块：哪些会话能休眠、休眠表清洗、恢复 / 保留 / 归档判定、交接文本（脱敏、限长、标注「不是指令」）；
//   ② 端到端：二代仿真 → agent L2：群和 owner 的聊天会话休眠（不归档、停在途工作、令牌轮换）；
//      新的 agent 会话第一条消息带私聊交接，不带群聊内容；
//   ③ 回落：agent 会话照常归档；群和 owner 的旧会话原样复用（不新建），群只收到一句「休眠了多久」，
//      owner 收到 agent 期间的往来（路径已打码）；
//   ④ 作废：过期、回到的模式 / preset 不同、手动 /reset、清空工作区 → 归档，不复用；
//   ⑤ 安全：高权限会话永远不休眠；确认码不进交接记录；关掉开关恢复旧行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isHibernatablePolicy, normalizeDormant, dormantDecision, redactForHandover, createOwnerTranscript,
  buildOwnerHandover, buildGroupResumeNote, modeLabel,
} from '../src/mode-handover.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const OWNER = 123;
const GROUP = 456;
const OWNER_KEY = `private:${OWNER}`;
const GROUP_KEY = `group:${GROUP}`;
const pol = (...a) => JSON.stringify(a);
const settle = () => new Promise((r) => setTimeout(r, 30));
const textMsg = (t) => [{ type: 'text', data: { text: t } }];
const ownerPm = (t) => ({ post_type: 'message', message_type: 'private', user_id: OWNER, self_id: 999999, message_id: Math.floor(Math.random() * 1e6), message: textMsg(t), sender: { user_id: OWNER, nickname: 'owner' } });
const promptText = (p) => (Array.isArray(p?.content) ? p.content.map((c) => String(c?.text ?? '')).join('\n') : '');

test('① 模块：休眠判定、休眠表清洗、交接文本', () => {
  assert.equal(isHibernatablePolicy(pol('reserved2', 'qq-chat-v2', null)), true);
  assert.equal(isHibernatablePolicy(pol('chat', 'qq-chat', null)), true);
  assert.equal(isHibernatablePolicy(pol('closed-agent', 'qq-agent-workspace', '123', 'L2', 'workspace-write')), false, '高权限会话不能休眠');
  assert.equal(isHibernatablePolicy(pol('reserved2', '', null)), false, '没有明确 preset 的不休眠');
  assert.equal(isHibernatablePolicy('not json'), false);

  const now = 1_000_000;
  const clean = normalizeDormant({
    [GROUP_KEY]: { sessionId: 's1', policy: pol('reserved2', 'qq-chat-v2', null), dormantAt: now },
    'group:abc': { sessionId: 's2', policy: pol('reserved2', 'qq-chat-v2', null), dormantAt: now },
    [OWNER_KEY]: { sessionId: 's3', policy: pol('closed-agent', 'x', '1', 'L2', 'y'), dormantAt: now },
    'group:789': { sessionId: '', policy: pol('reserved2', 'qq-chat-v2', null), dormantAt: now },
  });
  assert.deepEqual(Object.keys(clean), [GROUP_KEY], '坏 key、高权限、空 id 都丢弃');

  const d = clean[GROUP_KEY];
  const base = { now: now + 1000, maxMs: 60_000, currentPolicy: d.policy, allowed: true };
  assert.equal(dormantDecision(d, { ...base, inClosedAgent: true }), 'keep', 'agent 期间继续休眠');
  assert.equal(dormantDecision(d, { ...base, inClosedAgent: false }), 'resume');
  assert.equal(dormantDecision(d, { ...base, inClosedAgent: false, currentPolicy: pol('chat', 'qq-chat', null) }), 'archive', '回到的模式 / preset 不同 → 归档');
  assert.equal(dormantDecision(d, { ...base, inClosedAgent: false, allowed: false }), 'archive', '不再被允许 → 归档');
  assert.equal(dormantDecision(d, { ...base, now: now + 120_000, inClosedAgent: true }), 'archive', '过期 → 归档');

  assert.equal(redactForHandover('文件在 /Users/alice/secret.txt 和 C:\\Users\\a\\b.ini\n下一行'), '文件在 <路径> 和 <路径> 下一行');
  assert.equal(modeLabel('closed-agent', 'L2'), 'agent L2');
  assert.equal(modeLabel('reserved2', 'L0'), '二代仿真');

  const entries = [
    { at: now - 120_000, role: 'owner', mode: 'reserved2', level: 'L0', text: '帮我看看那个报错' },
    { at: now - 60_000, role: 'ai', mode: 'reserved2', level: 'L0', text: '好的' },
  ];
  const h = buildOwnerHandover({ entries, from: { mode: 'reserved2', level: 'L0' }, to: { mode: 'closed-agent', level: 'L2' }, now });
  assert.match(h, /^【交接 · 桥接提供】管理员刚把模式从 二代仿真 切到 agent L2/);
  assert.match(h, /\[2 分钟前·二代仿真\] 管理员：帮我看看那个报错/);
  assert.match(h, /\] 你：好的/);
  assert.match(h, /不是新的指令/);
  assert.equal(buildOwnerHandover({ entries: [], from: {}, to: {} }), '', '没有记录、也不是恢复时不注入');
  assert.match(buildOwnerHandover({ entries: [], resumed: true, from: { mode: 'closed-agent', level: 'L2' }, to: { mode: 'reserved2' }, dormantMs: 600_000 }), /休眠了 10 分钟[\s\S]*没有新的往来/);
  const long = Array.from({ length: 50 }, (_, i) => ({ at: now, role: 'owner', mode: 'reserved2', level: 'L0', text: `第${i}条`.padEnd(200, '字') }));
  const capped = buildOwnerHandover({ entries: long, from: {}, to: {}, now, maxChars: 1000 });
  assert.ok(capped.length < 1400, '总长度受限');
  assert.ok(capped.includes('第49条') && !capped.includes('第0条'), '保留最新的');
  assert.match(buildGroupResumeNote({ dormantMs: 90_000, from: { mode: 'closed-agent', level: 'L1' } }), /agent L1[\s\S]*休眠了 2 分钟/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-handover-'));
  try {
    const file = path.join(dir, 'admin', 'owner-transcript.json');
    let t = 0;
    const tr = createOwnerTranscript({ file, max: 3, now: () => ++t, redact: (s) => s.replace('tok-123', '***') });
    for (const x of ['a', 'b', 'c', 'd 含 tok-123']) tr.record({ role: 'owner', text: x });
    tr.record({ role: 'system', text: 'x' });
    tr.record({ role: 'ai', text: '   ' });
    const again = createOwnerTranscript({ file, max: 3 });
    assert.deepEqual(again.recent().map((e) => e.text), ['b', 'c', 'd 含 ***'], '有上限、持久化、脱敏、非法角色和空文本不记');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, '记录文件 0600');
    assert.deepEqual(again.recent({ since: 4 }).map((e) => e.text), ['d 含 ***']);
    again.clear();
    assert.equal(createOwnerTranscript({ file }).size(), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function withHarness(config, run) {
  const h = await bridgeHarness({ config: { admin: { consoleEscalationCooldownMs: 0 }, ...config } });
  try {
    await h.initControllerOnce('reserved2');
    await run(h);
  } finally {
    h.ext.controller.stop();
    await h.close();
  }
}

test('②③ 二代 → agent L2 → 回落：聊天会话休眠后原样复用；agent 会话带交接、回落时归档', async () => {
  await withHarness({}, async (h) => {
    h.setMode('reserved2');
    const groupSid = await h.ensureSession(GROUP_KEY);
    const ownerSid = await h.ensureSession(OWNER_KEY);
    const createdBefore = h.calls.created.length;
    // owner 私聊往来（二代模式下）
    await h.handleIncoming('private', OWNER, ownerPm('帮我看看昨天那个报错'), h.cfg);
    h.recordSentMessagesV2(OWNER_KEY, ['好的，我记下了']);
    await settle();
    const groupTokenBefore = h.getSocialV2State(GROUP_KEY).agentToken;
    // 群会话已经引导过、看过两条消息
    const gst = h.getSocialV2State(GROUP_KEY);
    gst.bootstrapSent = true;
    gst.modelSeenSeqs = new Set([1, 2]);

    // —— 切到 agent L2 ——
    const r = await h.ext.controller.consoleSet({ mode: 'closed-agent', level: 'L2' });
    assert.equal(r.ok, true, r.error);
    await settle();
    assert.ok(!h.calls.archived.includes(groupSid) && !h.calls.archived.includes(ownerSid), '聊天会话不归档');
    assert.ok(h.calls.cancelled.includes(groupSid) && h.calls.cancelled.includes(ownerSid), '在途工作停掉');
    assert.deepEqual(Object.keys(h.state.dormantSessions).sort(), [GROUP_KEY, OWNER_KEY].sort(), '两条都进休眠表');
    assert.equal(h.state.sessions[GROUP_KEY], undefined, '映射撤销');
    assert.notEqual(h.getSocialV2State(GROUP_KEY).agentToken, groupTokenBefore, '休眠期间旧令牌作废');
    assert.equal(h.getSocialV2State(GROUP_KEY).bootstrapSent, true, '休眠不清「已引导」：恢复后不会再发一遍引导唤醒');
    assert.equal(h.getSocialV2State(GROUP_KEY).modelSeenSeqs.size, 2, '休眠不清「已看过的消息」');
    await assert.rejects(h.ensureSession(GROUP_KEY), /不允许/, 'agent 期间群会话不能用');

    // agent 会话：新建，第一条消息带私聊交接，不带群聊内容
    await h.handleIncoming('private', OWNER, ownerPm('继续刚才的事'), h.cfg);
    await settle();
    const agentSid = h.state.sessions[OWNER_KEY];
    assert.ok(agentSid && agentSid !== ownerSid, 'agent 用新会话');
    assert.equal(h.calls.created.length, createdBefore + 1);
    const first = promptText(h.calls.prompts.filter((p) => p.sessionId === agentSid).at(0));
    assert.match(first, /【交接 · 桥接提供】管理员刚把模式从 二代仿真 切到 agent L2/);
    assert.match(first, /管理员：帮我看看昨天那个报错/);
    assert.match(first, /你：好的，我记下了/);
    assert.ok(!/管理员：继续刚才的事/.test(first.split('不是新的指令')[0]), '这次的消息本身不在交接里重复');
    await h.handleIncoming('private', OWNER, ownerPm('再看一眼'), h.cfg);
    await settle();
    const second = promptText(h.calls.prompts.filter((p) => p.sessionId === agentSid).at(-1));
    assert.ok(!second.includes('【交接'), '交接只在第一条消息里');
    h.recordOwnerTranscript(OWNER_KEY, 'ai', '处理完了，日志在 /Users/alice/app/error.log');
    await settle();

    // —— 回落 ——
    await h.ext.controller.panic();
    await settle();
    assert.equal(h.getMode().mode, 'reserved2');
    assert.ok(h.calls.archived.includes(agentSid), '高权限会话照常归档');
    assert.equal(await h.ensureSession(GROUP_KEY), groupSid, '群会话原样复用');
    assert.equal(h.getSocialV2State(GROUP_KEY).bootstrapSent, true, '恢复后仍是「已引导」');
    assert.match(h.buildWakePromptV2(GROUP_KEY, 'atMention'), /\【会话令牌\】/, '恢复后的唤醒带上新令牌');
    assert.equal(await h.ensureSession(OWNER_KEY), ownerSid, 'owner 的聊天会话原样复用');
    assert.equal(h.calls.created.length, createdBefore + 1, '回落后没有新建会话');
    assert.deepEqual(Object.keys(h.state.dormantSessions), [], '休眠表清空');
    assert.ok(h.calls.follows.filter((id) => id === groupSid).length >= 2, '恢复后重新订阅事件');

    await h.deliverPrompt(GROUP_KEY, '群里有新消息');
    const g = promptText(h.calls.prompts.at(-1));
    assert.match(g, /【交接 · 桥接提供】刚才管理员切到了 agent L2，这个会话休眠了/);
    assert.ok(!g.includes('报错') && !g.includes('处理完了'), '群会话拿不到任何私聊内容');

    await h.deliverPrompt(OWNER_KEY, '管理员私聊');
    const o = promptText(h.calls.prompts.at(-1));
    assert.match(o, /休眠了[\s\S]*回到 二代仿真/);
    assert.match(o, /agent L2\] 你：处理完了，日志在 (<路径>|\*\*\*)/, 'agent 期间的回复带上，路径打码');
    assert.ok(!o.includes('/Users/alice'), '不带本机路径');
    assert.ok(!o.includes('帮我看看昨天那个报错'), '休眠前的内容旧会话本来就知道，不重复');
  });
});

test('④ 作废：回到的模式不同、过期、/reset、关掉开关', async () => {
  // 回落到 chat（preset 不同）→ 归档，不复用
  await withHarness({ admin: { consoleEscalationCooldownMs: 0, safeMode: 'chat' } }, async (h) => {
    h.setMode('reserved2');
    const sid = await h.ensureSession(GROUP_KEY);
    await h.ext.controller.consoleSet({ mode: 'closed-agent', level: 'L1' });
    await settle();
    assert.ok(h.state.dormantSessions[GROUP_KEY]);
    await h.ext.controller.panic();
    await settle();
    assert.equal(h.getMode().mode, 'chat');
    assert.ok(h.calls.archived.includes(sid), '回到的模式 / preset 不同 → 归档');
    assert.notEqual(await h.ensureSession(GROUP_KEY), sid);
  });
  // 过期
  await withHarness({ admin: { consoleEscalationCooldownMs: 0, dormantMaxMs: 60_000 } }, async (h) => {
    h.setMode('reserved2');
    const sid = await h.ensureSession(GROUP_KEY);
    await h.ext.controller.consoleSet({ mode: 'closed-agent', level: 'L1' });
    await settle();
    h.getSocialV2State(GROUP_KEY).bootstrapSent = true;
    h.state.dormantSessions[GROUP_KEY].dormantAt -= 120_000;
    h.reconcileSessionPolicies();
    await settle();
    assert.ok(h.calls.archived.includes(sid), '过期的休眠会话归档');
    assert.equal(h.getSocialV2State(GROUP_KEY).bootstrapSent, false, '作废后下一个会话是全新的，要重新引导');
    assert.equal(h.state.dormantSessions[GROUP_KEY], undefined);
  });
  // owner /reset：休眠的那份和交接记录一并作废
  await withHarness({}, async (h) => {
    h.setMode('reserved2');
    await h.handleIncoming('private', OWNER, ownerPm('记一下这件事'), h.cfg);
    await h.ensureSession(OWNER_KEY);
    assert.ok(h.ownerTranscript.size() > 0);
    await h.handleIncoming('private', OWNER, ownerPm('/reset'), h.cfg);
    await settle();
    assert.equal(h.ownerTranscript.size(), 0, '/reset 清空交接记录（桥接自己的「已重置」提示也不记）');
  });
  // 关掉开关：恢复旧行为（直接归档）
  await withHarness({ admin: { consoleEscalationCooldownMs: 0, hibernateChatSessions: false, handover: false } }, async (h) => {
    h.setMode('reserved2');
    const sid = await h.ensureSession(GROUP_KEY);
    await h.handleIncoming('private', OWNER, ownerPm('不该被记下'), h.cfg);
    await h.ext.controller.consoleSet({ mode: 'closed-agent', level: 'L1' });
    await settle();
    assert.ok(h.calls.archived.includes(sid), 'hibernateChatSessions=false 时照旧归档');
    assert.deepEqual(Object.keys(h.state.dormantSessions), []);
    assert.equal(h.ownerTranscript.size(), 0, 'handover=false 时不记录');
  });
});

test('⑤ 安全：L1→L2 的高权限会话不休眠；确认码不进交接记录', async () => {
  await withHarness({}, async (h) => {
    await h.ext.controller.consoleSet({ mode: 'closed-agent', level: 'L1' });
    const l1 = await h.ensureSession(OWNER_KEY);
    // 高权限期间控制台不能再提权（按设计），这里直接改级别再对账，模拟 L1 → L2
    h.setLevel('L2');
    h.reconcileSessionPolicies();
    await settle();
    assert.ok(h.calls.archived.includes(l1), 'L1 → L2：旧的高权限会话归档');
    assert.equal(h.state.dormantSessions[OWNER_KEY], undefined, '高权限会话不进休眠表');
    await h.ext.controller.panic();
  });
  await withHarness({}, async (h) => {
    h.setMode('reserved2');
    await h.handleIncoming('private', OWNER, ownerPm('/mode agent L2'), h.cfg);
    await settle();
    const sent = h.calls.sent.filter((s) => s.kind === 'private').map((s) => String(s.text)).join('\n');
    const code = /确认 (\d{4,8})/.exec(sent)?.[1];
    assert.ok(code, '桥接发了确认码');
    await h.handleIncoming('private', OWNER, ownerPm(`确认 ${code}`), h.cfg);
    await settle();
    assert.equal(h.getMode().mode, 'closed-agent');
    const all = h.ownerTranscript.recent({ maxEntries: 100 }).map((e) => e.text).join('\n');
    assert.ok(!all.includes(code), '确认码不进交接记录');
    assert.ok(!all.includes('/mode'), '管理命令不进交接记录');
    await h.ext.controller.panic();
  });
});

test('⑥ 私聊长期记忆：开关开着时切到 agent 一并交接（只取管理员私聊、不含群、已脱敏）；关掉就不带', async () => {
  for (const on of [true, false]) {
    await withHarness(on ? {} : { socialV2: { tools: { handoverMemory: false } } }, async (h) => {
      h.setMode('reserved2');
      const ownerSt = h.getSocialV2State(OWNER_KEY);
      ownerSt.activeTopics = [{ text: '帮管理员修电脑，日志在 /Users/alice/log.txt', lastMentionAt: Date.now() }];
      ownerSt.pendingThoughts = [{ text: '想问问电脑修好没', expiresAt: Date.now() + 3600_000 }];
      h.getSocialV2State(GROUP_KEY).activeTopics = [{ text: '群里的秘密话题', lastMentionAt: Date.now() }];
      await h.ext.controller.consoleSet({ mode: 'closed-agent', level: 'L1' });
      await settle();
      await h.handleIncoming('private', OWNER, ownerPm('继续吧'), h.cfg);
      await settle();
      const agentSid = h.state.sessions[OWNER_KEY];
      const first = promptText(h.calls.prompts.filter((p) => p.sessionId === agentSid).at(0));
      if (on) {
        assert.match(first, /【你在 QQ 私聊里记下的长期记忆 · 桥接提供】/);
        assert.match(first, /帮管理员修电脑/);
        assert.match(first, /想问问电脑修好没/);
        assert.ok(!first.includes('/Users/alice'), '路径打码');
      } else {
        assert.ok(!first.includes('长期记忆'), '开关关掉就不带');
      }
      assert.ok(!first.includes('群里的秘密话题'), '任何群的记忆都不进 agent');
      await h.ext.controller.panic();
    });
  }
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  assert.match(html, /data-v2-tool="handoverMemory"/, '二代工具开关里有这一项');
  assert.match(html, /data-v2-tool="schedule"/, '定时任务工具也有开关');
});
