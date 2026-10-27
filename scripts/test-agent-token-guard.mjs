// 会话令牌抄错的识别与恢复。全部离线、假数据（夹具里的假号 123 / 456）。
//   ① 模块：不同位数、近似令牌只认唯一命中、提示不含正确令牌、连错计数与换新、提醒标记；
//   ② 端到端：抄错一位 → 明确提示且照样拒绝；下一次唤醒最前面有【令牌提醒】，送达后清掉；
//      连错 3 次自动换新令牌（旧的立即失效、DSH 会话与记忆不动）；用对了计数清零；
//   ③ 控制台换令牌只给控制台用；二代仿真里被审计拦下的内部输出不再往群里发拦截通知。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { hamming, findNearToken, nearTokenError, tokenNoticeBlock, createTokenMissTracker, ROTATE_AFTER } from '../src/agent-token-guard.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
const promptText = (p) => (Array.isArray(p?.content) ? p.content.map((c) => String(c?.text ?? '')).join('\n') : '');
const flip = (tok, i = Math.floor(tok.length / 2)) => tok.slice(0, i) + (tok[i] === '1' ? '2' : '1') + tok.slice(i + 1);

test('① 模块', () => {
  assert.equal(hamming('abcd', 'abed'), 1);
  assert.equal(hamming('abc', 'abcd'), Infinity);
  assert.equal(hamming('', ''), Infinity);
  const entries = [{ key: 'group:1', token: 'a'.repeat(48) }, { key: 'group:2', token: 'b'.repeat(48) }];
  assert.deepEqual(findNearToken('a'.repeat(47) + 'c', entries), { key: 'group:1', dist: 1 });
  assert.equal(findNearToken('a'.repeat(48), entries), null, '完全相同不算抄错');
  assert.equal(findNearToken('a'.repeat(40) + 'c'.repeat(8), entries), null, '差太多不算');
  const twins = [{ key: 'x', token: 'a'.repeat(48) }, { key: 'y', token: 'a'.repeat(47) + 'b' }];
  assert.equal(findNearToken('a'.repeat(46) + 'cc', twins), null, '两个都接近时不猜');
  const err = nearTokenError(1);
  assert.match(err, /抄错了.*1 位/);
  assert.ok(!/[0-9a-f]{20,}/.test(err), '提示里没有令牌');
  assert.match(tokenNoticeBlock({ rotated: true }), /全新的/);
  assert.match(tokenNoticeBlock(), /抄错了一位/);

  let t = 0;
  const tr = createTokenMissTracker({ rotateAfter: 3, windowMs: 1000, now: () => t });
  assert.equal(tr.record('k').rotate, false);
  assert.equal(tr.record('k').rotate, false);
  assert.equal(tr.record('k').rotate, true, '第 3 次该换新');
  assert.deepEqual(tr.notice('k'), { rotated: false });
  tr.rotated('k');
  assert.equal(tr.count('k'), 0);
  assert.deepEqual(tr.notice('k'), { rotated: true });
  tr.clearNotice('k');
  assert.equal(tr.notice('k'), null);
  tr.record('k'); t += 2000; assert.equal(tr.record('k').count, 1, '窗口外的不算');
  tr.ok('k'); assert.equal(tr.count('k'), 0);
});

const CONSOLE = { 'x-console-token': 'fixture-console-token' };
function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...CONSOLE, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json, body: data }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function withHarness(run) {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  try { await run(h, server.address().port); } finally { await new Promise((r) => server.close(r)); await h.close(); }
}

test('② 端到端：抄错提示、下次唤醒提醒、连错换新、用对清零', async () => {
  await withHarness(async (h, port) => {
    const sid = await h.ensureSession(GROUP);
    const st = h.getSocialV2State(GROUP);
    const real = st.agentToken;
    const q = `/api/socialV2/unread?key=${encodeURIComponent(GROUP)}`;
    const wrong = flip(real);
    const r1 = await call(port, q, { headers: { 'x-agent-call': '1', 'x-agent-token': wrong } });
    assert.equal(r1.status, 403, '抄错的照样拒绝');
    assert.match(r1.json.error, /抄错了（和本会话的令牌有 1 位不一样）/);
    assert.ok(!r1.body.includes(real), '回复里没有正确令牌');

    const prompt = h.buildWakePromptV2(GROUP, 'atMention');
    assert.ok(prompt.startsWith('【令牌提醒 · 桥接提供】'), '下一次唤醒最前面有提醒');
    await h.deliverPrompt(GROUP, '', { wakeReason: 'atMention' });
    assert.match(promptText(h.calls.prompts.filter((p) => p.sessionId === sid).at(-1)), /令牌提醒/);
    assert.ok(!h.buildWakePromptV2(GROUP, 'atMention').includes('令牌提醒'), '送达后清掉');

    await call(port, q, { headers: { 'x-agent-call': '1', 'x-agent-token': wrong } });
    assert.equal(st.agentToken, real, '第 2 次还不换');
    const r3 = await call(port, q, { headers: { 'x-agent-call': '1', 'x-agent-token': wrong } });
    assert.equal(r3.status, 403);
    assert.notEqual(st.agentToken, real, `连错 ${ROTATE_AFTER} 次换新令牌`);
    assert.equal(h.state.sessions[GROUP], sid, 'DSH 会话不动');
    assert.match(h.buildWakePromptV2(GROUP, 'atMention'), /^【令牌提醒[^\n]*全新的/);
    const old = await call(port, q, { headers: { 'x-agent-call': '1', 'x-agent-token': real } });
    assert.equal(old.status, 403, '旧令牌立即失效');
    const ok = await call(port, q, { headers: { 'x-agent-call': '1', 'x-agent-token': st.agentToken } });
    assert.notEqual(ok.status, 403, '新令牌可用');
    assert.equal(h.tokenMiss.count(GROUP), 0, '用对了计数清零');
  });
});

test('③ 控制台换令牌只给控制台；二代里不往群里发拦截通知', async () => {
  await withHarness(async (h, port) => {
    await h.ensureSession(GROUP);
    const st = h.getSocialV2State(GROUP);
    const before = st.agentToken;
    const byAgent = await call(port, '/api/socialV2/rotate-token', { method: 'POST', body: { key: GROUP }, headers: { 'x-agent-call': '1', 'x-agent-token': before } });
    assert.equal(byAgent.status, 403, 'AI 不能自己换');
    assert.equal(st.agentToken, before);
    const ok = await call(port, '/api/socialV2/rotate-token', { method: 'POST', body: { key: GROUP } });
    assert.equal(ok.status, 200, ok.body);
    assert.notEqual(st.agentToken, before);
    const missing = await call(port, '/api/socialV2/rotate-token', { method: 'POST', body: { key: 'group:999' } });
    assert.equal(missing.status, 404);
  });
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /if \(cfg\.security\?\.interceptNotify !== false && currentMode !== 'reserved2'\) \{\s*\n\s*await sendToQQ\(key, '⚠️ 本条回复因疑似包含敏感信息/, '二代仿真里被拦的内部输出不发拦截通知');
});
