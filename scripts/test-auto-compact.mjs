// QQ 会话上下文太长时自动压缩（DSH 的 /compact）。全部离线、假数据（假 DSH，不发任何模型请求）。
//   ① 模块：配置规范化、读了多少 token、是否压缩（关闭 / 未超阈值 / 冷却 / 超阈值）；
//   ② 端到端：回合结束且超过阈值 → 空闲后执行 /compact → 下次唤醒重新完整给表情块与角色卡；
//      冷却期内不再压；会话忙时不压；没超阈值不压；非二代模式不压；
//   ③ 手动压缩接口只给控制台用；
//   ④ 控制台改压缩方式（提前压缩填几万 / 交给 DSH）：校验、写进 config.json、马上按新阈值判断、AI 改不了；
//   ⑤ 控制台卡片。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeCompactConfig, inputTokensOf, decideCompact, COMPACT_DEFAULTS, compactConfigFromConsole, COMPACT_THRESHOLD_MIN, COMPACT_THRESHOLD_MAX } from '../src/auto-compact.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('① 模块', () => {
  assert.deepEqual(normalizeCompactConfig({}), { ...COMPACT_DEFAULTS });
  assert.equal(normalizeCompactConfig({ thresholdTokens: 10 }).thresholdTokens, COMPACT_DEFAULTS.thresholdTokens, '太小的阈值回到默认');
  assert.equal(normalizeCompactConfig({ thresholdTokens: 200_000 }).thresholdTokens, 200_000);
  assert.equal(normalizeCompactConfig({ enabled: false }).enabled, false);
  assert.equal(inputTokensOf({ cacheHit: 100, cacheMiss: 20, cacheWrite: 5, output: 999 }), 125, '不算输出');
  const cfg = { thresholdTokens: 100_000, cooldownMinutes: 60 };
  assert.equal(decideCompact({ inputTokens: 90_000, config: cfg }).compact, false);
  assert.equal(decideCompact({ inputTokens: 150_000, config: cfg }).compact, true);
  assert.match(decideCompact({ inputTokens: 150_000, config: cfg }).reason, /150k/);
  assert.equal(decideCompact({ inputTokens: 150_000, lastAttemptAt: 1_000, now: 1_000 + 30 * 60_000, config: cfg }).compact, false, '冷却中');
  assert.equal(decideCompact({ inputTokens: 150_000, lastAttemptAt: 1_000, now: 1_000 + 61 * 60_000, config: cfg }).compact, true);
  assert.equal(decideCompact({ inputTokens: 999_999, config: { enabled: false } }).compact, false);
});

async function withHarness(run, compact = { thresholdTokens: 100_000, idleDelayMs: 0, cooldownMinutes: 60 }) {
  const h = await bridgeHarness({ config: { socialV2: { compact } } });
  h.setMode('reserved2');
  try { await run(h); } finally { await h.close(); }
}
// DSH 的 usage 字段：cacheReadTokens = 命中，inputTokens = 未命中（见 model-prices.js 的 normalizeUsage）
const usageEvent = (hit, miss) => ({ type: 'assistant/message', data: { usage: { cacheReadTokens: hit, inputTokens: miss, outputTokens: 10 } } });
const compactCalls = (h) => h.calls.commands.filter((c) => c.line === '/compact');

test('② 端到端：超过阈值 → 空闲后压缩 → 重新完整给关键内容；冷却 / 忙 / 未超 / 非二代都不压', async () => {
  await withHarness(async (h) => {
    const sid = await h.ensureSession(GROUP);
    h.recordSessionUsage(sid, usageEvent(140_000, 2_000));
    assert.ok(h.sessionLastInput.get(sid) >= 140_000, '记下最近一步读了多少');
    h.roleRefresh.markSeen(GROUP, sid, h.currentRoleFingerprintV2());
    h.promptBlocks.delivered(GROUP, sid, 'sticker', h.promptBlocks.decide(GROUP, sid, 'sticker', 'X'));

    h.maybeAutoCompact(GROUP, sid);
    await settle();
    assert.equal(compactCalls(h).length, 1, '执行了 /compact');
    assert.equal(compactCalls(h)[0].sessionId, sid);
    assert.equal(h.promptBlocks.get(GROUP), null, '下次唤醒重新完整给表情块和黑话表');
    assert.equal(h.roleRefresh.needsRefresh(GROUP, sid, h.currentRoleFingerprintV2()), true, '下次唤醒重新给角色卡');

    h.recordSessionUsage(sid, usageEvent(150_000, 0));
    h.maybeAutoCompact(GROUP, sid);
    await settle();
    assert.equal(compactCalls(h).length, 1, '冷却期内不再压');
  });

  await withHarness(async (h) => {
    const sid = await h.ensureSession(GROUP);
    h.recordSessionUsage(sid, usageEvent(50_000, 0));
    h.maybeAutoCompact(GROUP, sid);
    await settle();
    assert.equal(compactCalls(h).length, 0, '没超阈值不压');

    h.recordSessionUsage(sid, usageEvent(200_000, 0));
    h.v2TurnStartAt.set(sid, Date.now());
    h.maybeAutoCompact(GROUP, sid);
    await settle();
    assert.equal(compactCalls(h).length, 0, '会话正忙不压');
    h.v2TurnStartAt.delete(sid);

    h.setMode('chat');
    h.maybeAutoCompact(GROUP, sid);
    await settle();
    assert.equal(compactCalls(h).length, 0, '非二代模式不压');
  });

  await withHarness(async (h) => {
    const sid = await h.ensureSession(GROUP);
    h.recordSessionUsage(sid, usageEvent(900_000, 0));
    h.maybeAutoCompact(GROUP, sid);
    await settle();
    assert.equal(compactCalls(h).length, 0, '关掉后不压');
  }, { enabled: false });
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

test('③ 手动压缩接口只给控制台', async () => {
  await withHarness(async (h) => {
    await h.ensureSession(GROUP);
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    try {
      const token = h.getSocialV2State(GROUP).agentToken;
      const byAgent = await call(port, '/api/session/compact', { method: 'POST', body: { key: GROUP }, headers: { 'x-agent-call': '1', 'x-agent-token': token } });
      assert.equal(byAgent.status, 403, 'AI 不能自己压缩');
      const ok = await call(port, '/api/session/compact', { method: 'POST', body: { key: GROUP } });
      assert.equal(ok.status, 200, ok.body);
      assert.equal(compactCalls(h).length, 1);
      const missing = await call(port, '/api/session/compact', { method: 'POST', body: { key: 'group:999' } });
      assert.equal(missing.status, 404);
    } finally { await new Promise((r) => server.close(r)); }
  });
});

test('④ 控制台改压缩方式：提前压缩（填几万）或交给 DSH', async () => {
  assert.deepEqual([COMPACT_THRESHOLD_MIN, COMPACT_THRESHOLD_MAX], [50_000, 800_000]);
  assert.equal(normalizeCompactConfig({ thresholdTokens: 900_000 }).thresholdTokens, COMPACT_DEFAULTS.thresholdTokens, '超过 80 万没意义（DSH 自己约 80 万就压了），回到默认');
  assert.deepEqual(compactConfigFromConsole({}, { mode: 'early', thresholdWan: 40 }), { ...COMPACT_DEFAULTS, thresholdTokens: 400_000 });
  assert.equal(compactConfigFromConsole({ thresholdTokens: 400_000 }, { mode: 'dsh' }).enabled, false);
  assert.equal(compactConfigFromConsole({ thresholdTokens: 400_000 }, { mode: 'dsh' }).thresholdTokens, 400_000, '交给 DSH 时记住原来填的数');
  for (const bad of [4, 81, 'abc', undefined]) assert.throws(() => compactConfigFromConsole({}, { mode: 'early', thresholdWan: bad }), /5～80 万/);
  assert.throws(() => compactConfigFromConsole({}, { mode: 'later' }), /压缩方式/);

  await withHarness(async (h) => {
    const sid = await h.ensureSession(GROUP);
    h.recordSessionUsage(sid, usageEvent(420_000, 1_000));
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    try {
      const got = await call(port, '/api/compact/config');
      assert.equal(got.status, 200, got.body);
      assert.deepEqual([got.json.mode, got.json.thresholdTokens], ['early', 100_000]);
      assert.equal(got.json.sessions.find((x) => x.key === GROUP).inputTokens, 421_000, '看得到每个会话上一步读了多少');

      const token = h.getSocialV2State(GROUP).agentToken;
      const byAgent = await call(port, '/api/compact/config', { method: 'POST', body: { mode: 'dsh' }, headers: { 'x-agent-call': '1', 'x-agent-token': token } });
      assert.equal(byAgent.status, 403, 'AI 改不了');

      const set = await call(port, '/api/compact/config', { method: 'POST', body: { mode: 'early', thresholdWan: 50 } });
      assert.equal(set.status, 200, set.body);
      assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).socialV2.compact.thresholdTokens, 500_000, '写进 config.json');
      h.maybeAutoCompact(GROUP, sid);
      await settle(30);
      assert.equal(compactCalls(h).length, 0, '42 万 < 新阈值 50 万：不压');

      const dsh = await call(port, '/api/compact/config', { method: 'POST', body: { mode: 'dsh' } });
      assert.equal(dsh.json.mode, 'dsh');
      h.recordSessionUsage(sid, usageEvent(780_000, 0));
      h.maybeAutoCompact(GROUP, sid);
      await settle(30);
      assert.equal(compactCalls(h).length, 0, '交给 DSH：桥接不提前压');

      const bad = await call(port, '/api/compact/config', { method: 'POST', body: { mode: 'early', thresholdWan: 100 } });
      assert.equal(bad.status, 400);
      assert.match(bad.json.error, /5～80 万/);
    } finally { await new Promise((r) => server.close(r)); }
  });
});

test('⑤ 控制台：令牌与花费页有「上下文压缩」卡片', () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const sec = html.slice(html.indexOf('<section id="section-compact"'), html.indexOf('</section>', html.indexOf('<section id="section-compact"')));
  assert.match(sec, /data-page="usage"/);
  for (const v of ['early', 'dsh']) assert.ok(sec.includes(`name="compactMode" value="${v}"`), v);
  assert.match(sec, /id="compactWan" min="5" max="80"/);
  assert.match(sec, /id="compactSave"/);
});
