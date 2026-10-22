// 切换 / 修改人格后，二代仿真会话重新读卡。全部离线、假数据（夹具里的假号 123 / 456、假角色卡）。
//   ① 模块：指纹、读卡记录（按会话 + 指纹，换会话也算没读过）、持久化 0600、坏数据丢弃、提示块文字；
//   ② 端到端：会话读过卡后不重复给；换人格 / 改内容 / 清除人格 → 下一次唤醒把新卡放在最前面，投递后记下、之后不再给；
//      引导唤醒不带（它自己会调用 qq_get_prompt）；
//   ③「立即」：只唤醒还没读到新卡的会话，原因是 roleRefresh；已读到的跳过；非二代模式不唤醒。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  roleFingerprint, buildRoleRefreshBlock, createRoleRefreshTracker, normalizeApplyMode,
} from '../src/role-refresh.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP_KEY = 'group:456';
const OWNER_KEY = 'private:123';
const CARD_A = '# 角色卡：测试鱼\n你是测试鱼，说话很凶。被怼就顶回去。';
const CARD_B = '# 角色卡：测试鱼\n你是测试鱼，说话软软的。被怼就撒娇。';
const promptText = (p) => (Array.isArray(p?.content) ? p.content.map((c) => String(c?.text ?? '')).join('\n') : '');
const settle = () => new Promise((r) => setTimeout(r, 30));

test('① 模块：指纹、读卡记录、持久化、提示块', () => {
  assert.equal(roleFingerprint('甲', 'x'), roleFingerprint('甲', 'x'));
  assert.notEqual(roleFingerprint('甲', 'x'), roleFingerprint('乙', 'x'), '换名字算换卡');
  assert.notEqual(roleFingerprint('甲', 'x'), roleFingerprint('甲', 'y'), '改内容算换卡');
  assert.match(roleFingerprint(null, ''), /^[0-9a-f]{16}$/, '没有角色也有指纹');
  assert.equal(normalizeApplyMode('immediate'), 'immediate');
  assert.equal(normalizeApplyMode('乱写'), 'nextWake');
  assert.equal(normalizeApplyMode(undefined), 'nextWake');

  const block = buildRoleRefreshBlock({ name: '测试鱼', hint: CARD_B });
  assert.match(block, /^【角色卡已更新 · 桥接提供】/);
  assert.match(block, /当前角色：测试鱼/);
  assert.match(block, /旧版角色卡作废/);
  assert.ok(block.includes(CARD_B), '带新卡全文');
  assert.match(block, /不要在聊天里提起/);
  assert.match(buildRoleRefreshBlock({ name: null, hint: '' }), /清除了当前角色/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-refresh-'));
  try {
    const file = path.join(dir, 'state', 'role-seen.json');
    let t = 1000;
    const tr = createRoleRefreshTracker({ file, now: () => t });
    const fp1 = roleFingerprint('甲', CARD_A);
    const fp2 = roleFingerprint('甲', CARD_B);
    assert.equal(tr.needsRefresh(GROUP_KEY, 's1', fp1), true, '没有记录 = 没读过');
    assert.equal(tr.needsRefresh(GROUP_KEY, '', fp1), false, '没有会话就无所谓');
    tr.markSeen(GROUP_KEY, 's1', fp1);
    assert.equal(tr.needsRefresh(GROUP_KEY, 's1', fp1), false);
    assert.equal(tr.needsRefresh(GROUP_KEY, 's1', fp2), true, '指纹变了');
    assert.equal(tr.needsRefresh(GROUP_KEY, 's2', fp1), true, '会话换了');
    assert.deepEqual(tr.stale({ [GROUP_KEY]: 's1', [OWNER_KEY]: 's9' }, fp1), [OWNER_KEY]);
    tr.markSeen('group:abc', 's1', fp1);
    tr.markSeen(OWNER_KEY, 's9', 'not-a-fp');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, '记录文件 0600');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(raw), [GROUP_KEY], '坏 key 不记');
    assert.ok(!JSON.stringify(raw).includes('测试鱼'), '只存指纹，不存卡片内容');
    fs.writeFileSync(file, JSON.stringify({ ...raw, 'group:789': { sessionId: 's', fp: 'zz' }, junk: 1 }));
    const again = createRoleRefreshTracker({ file });
    assert.equal(again.size(), 1, '重启后读回，坏条目丢弃');
    assert.equal(again.needsRefresh(GROUP_KEY, 's1', fp1), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function withHarness(run) {
  const h = await bridgeHarness({
    files: {
      'roles/测试鱼.md': CARD_A,
      'roles/测试鱼-2.md': CARD_B,
      'state/current-role.json': { role: '测试鱼', mode: 'active' },
    },
  });
  try {
    h.setMode('reserved2');
    await run(h);
  } finally {
    await h.close();
  }
}

const lastPromptFor = (h, sid) => promptText(h.calls.prompts.filter((p) => p.sessionId === sid).at(-1));

test('② 换卡后下一次唤醒带新卡，投递后记下、不再重复；引导唤醒不带', async () => {
  await withHarness(async (h) => {
    const sid = await h.ensureSession(GROUP_KEY);
    assert.ok(!h.roleRefreshBlockV2(GROUP_KEY, 'bootstrap'), '引导唤醒不带（它自己调用 qq_get_prompt）');
    // 模拟 AI 在引导时读过卡
    h.roleRefresh.markSeen(GROUP_KEY, sid, h.currentRoleFingerprintV2());
    assert.ok(!h.buildWakePromptV2(GROUP_KEY, 'atMention').includes('【角色卡已更新'), '读过的卡不重复给');

    // 改当前人格的内容
    fs.writeFileSync(path.join(h.temp, 'roles/测试鱼.md'), CARD_B);
    const prompt = h.buildWakePromptV2(GROUP_KEY, 'atMention');
    assert.ok(prompt.startsWith('【角色卡已更新 · 桥接提供】'), '新卡放在最前面');
    assert.ok(prompt.includes('说话软软的'), '带的是新内容');
    assert.ok(!prompt.includes('说话很凶'), '不带旧内容');

    // 真正投递一次唤醒：DSH 接受后记下，之后不再给
    await h.deliverPrompt(GROUP_KEY, '', { wakeReason: 'atMention' });
    await settle();
    assert.ok(lastPromptFor(h, sid).includes('【角色卡已更新'), '投递的唤醒里带新卡');
    assert.equal(h.roleRefresh.needsRefresh(GROUP_KEY, sid, h.currentRoleFingerprintV2()), false, '投递后记为已读');
    assert.ok(!h.buildWakePromptV2(GROUP_KEY, 'atMention').includes('【角色卡已更新'), '之后的唤醒不再重复');

    // 换人格
    fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: '测试鱼-2', mode: 'active' }));
    assert.match(h.buildWakePromptV2(GROUP_KEY, 'timeout'), /^【角色卡已更新[^\n]*当前角色：测试鱼-2/);

    // 清除人格
    fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: null, mode: 'active' }));
    assert.match(h.buildWakePromptV2(GROUP_KEY, 'timeout'), /^【角色卡已更新 · 桥接提供】管理员清除了当前角色/);

    // 群规则照样注入，不受影响
    h.getSocialV2State(GROUP_KEY).ownerRules = [{ id: 1, text: '本群语气软一点', createdAt: 1 }];
    const withRules = h.buildWakePromptV2(GROUP_KEY, 'timeout');
    assert.ok(withRules.includes('本群语气软一点') && withRules.includes('【角色卡已更新'), '规则和新卡同时在');
  });
});

test('③「立即」：只唤醒还没读到新卡的会话；非二代模式不唤醒', async () => {
  await withHarness(async (h) => {
    const gsid = await h.ensureSession(GROUP_KEY);
    const osid = await h.ensureSession(OWNER_KEY);
    const fp = h.currentRoleFingerprintV2();
    h.roleRefresh.markSeen(GROUP_KEY, gsid, fp);
    h.roleRefresh.markSeen(OWNER_KEY, osid, fp);
    assert.equal(h.refreshRoleNowV2().woke.length, 0, '都读过了就不唤醒');

    fs.writeFileSync(path.join(h.temp, 'roles/测试鱼.md'), CARD_B);
    h.roleRefresh.markSeen(OWNER_KEY, osid, h.currentRoleFingerprintV2());
    const r = h.refreshRoleNowV2();
    assert.deepEqual([...r.woke], [GROUP_KEY], '只唤醒没读到新卡的群');
    const st = h.getSocialV2State(GROUP_KEY);
    assert.equal(st.pendingWakeReason, 'roleRefresh', '计划了一次读卡唤醒');
    assert.match(h.buildWakePromptV2(GROUP_KEY, 'roleRefresh'), /原因：管理员更新了你的角色卡[\s\S]*不要为了换卡专门发言/);
    clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; st.pendingWakeReason = null;

    h.setMode('chat');
    assert.equal(h.refreshRoleNowV2().skipped, 'notV2', '聊天模式每条消息都带卡，不需要唤醒');
  });
});

// ── 接口：AI 调用 qq_get_prompt 记为已读；控制台 /api/role 的 apply 选项 ────────────────
const CONSOLE = { 'x-console-token': 'fixture-console-token' };
function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  const hd = { 'content-type': 'application/json', ...CONSOLE, ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: hd }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json, body: data }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('④ 接口：qq_get_prompt 记为已读；/api/role 下次唤醒 / 立即', async () => {
  await withHarness(async (h) => {
    const gsid = await h.ensureSession(GROUP_KEY);
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    try {
      const token = h.getSocialV2State(GROUP_KEY).agentToken;
      const p = await call(port, `/api/socialV2/prompt?key=${encodeURIComponent(GROUP_KEY)}`, { headers: { 'x-agent-token': token } });
      assert.equal(p.status, 200, p.body);
      assert.equal(h.roleRefresh.needsRefresh(GROUP_KEY, gsid, h.currentRoleFingerprintV2()), false, 'AI 读卡后记为已读');

      const next = await call(port, '/api/role', { method: 'POST', body: { role: '测试鱼-2' } });
      assert.equal(next.status, 200, next.body);
      assert.equal(next.json.refresh.apply, 'nextWake', '默认下次唤醒');
      assert.equal(next.json.refresh.pending, 1, '一个会话等下次唤醒读新卡');
      assert.ok(!h.getSocialV2State(GROUP_KEY).pendingWakeTimer, '默认不立即唤醒');

      const now = await call(port, '/api/role', { method: 'POST', body: { role: '测试鱼-2', apply: 'immediate' } });
      assert.equal(now.json.refresh.apply, 'immediate');
      assert.equal(now.json.refresh.woke, 1, '立即唤醒还没读到新卡的会话');
      const st = h.getSocialV2State(GROUP_KEY);
      assert.equal(st.pendingWakeReason, 'roleRefresh');
      clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; st.pendingWakeReason = null;

      const back = await call(port, '/api/role', { method: 'POST', body: { role: '测试鱼', apply: 'immediate' } });
      assert.equal(back.json.refresh.woke, 0, '切回会话已经读过的那张卡：不用唤醒');
    } finally { await new Promise((r) => server.close(r)); }
  });
});

test('⑤ 接口：保存人格内容也能选生效方式；改的不是当前人格就不唤醒', async () => {
  await withHarness(async (h) => {
    const gsid = await h.ensureSession(GROUP_KEY);
    h.roleRefresh.markSeen(GROUP_KEY, gsid, h.currentRoleFingerprintV2());
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    try {
      const other = await call(port, '/api/roles/update', { method: 'POST', body: { name: '测试鱼-2', content: CARD_B + '\n补一句。', apply: 'immediate' } });
      assert.equal(other.status, 200, other.body);
      assert.equal(other.json.refresh.notActive, true, '改的不是当前人格');
      assert.ok(!h.getSocialV2State(GROUP_KEY).pendingWakeTimer, '不唤醒任何会话');
      assert.equal(h.roleRefresh.needsRefresh(GROUP_KEY, gsid, h.currentRoleFingerprintV2()), false, '当前卡没变');

      const next = await call(port, '/api/roles/update', { method: 'POST', body: { name: '测试鱼', content: CARD_B } });
      assert.equal(next.json.refresh.apply, 'nextWake', '默认下次唤醒');
      assert.equal(next.json.refresh.pending, 1);
      assert.ok(!h.getSocialV2State(GROUP_KEY).pendingWakeTimer, '默认不立即唤醒');
      assert.ok(h.buildWakePromptV2(GROUP_KEY, 'atMention').startsWith('【角色卡已更新'), '下次唤醒带新卡');

      const now = await call(port, '/api/roles/update', { method: 'POST', body: { name: '测试鱼', content: CARD_B + '\n再补一句。', apply: 'immediate' } });
      assert.equal(now.json.refresh.woke, 1, '立即：唤醒还没读到新卡的会话');
      const st = h.getSocialV2State(GROUP_KEY);
      assert.equal(st.pendingWakeReason, 'roleRefresh');
      // 紧接着在切换区再点一次「立即」：唤醒还在合并窗口里，不会多叫一次
      const again = await call(port, '/api/role', { method: 'POST', body: { role: '测试鱼', apply: 'immediate' } });
      assert.equal(again.json.refresh.woke, 1, '会话仍算没读到');
      assert.equal(st.pendingWakeReason, 'roleRefresh', '同一个待发唤醒，没有排第二个');
      clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; st.pendingWakeReason = null;
    } finally { await new Promise((r) => server.close(r)); }
  });
});
