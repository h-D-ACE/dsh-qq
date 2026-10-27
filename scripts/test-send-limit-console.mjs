// 发言上限放到控制台里能直接改，被拦时看得见。全部离线、假数据（夹具里的假号 123 / 456）。
//   ① 端到端：超过每分钟上限 → AI 收到 429 和说明（是桥接的上限、不是 QQ 的）；日志只记一次、控制台状态里有最近 24 小时的次数；
//      控制台改上限后马上生效；AI 的令牌拿不到这份状态；
//   ② 控制台：总览页有「发言上限」卡片。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
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

test('① 被发言上限拦下：AI 知道原因、控制台看得见、改了马上生效', async () => {
  const h = await bridgeHarness({ config: { socialV2: { send: { maxSendPerMinute: 2, maxSendPerHour: 60, burstIntervalMinMs: 0, burstIntervalMaxMs: 0, longGapProbability: 0, gapBaseMs: 0, gapPerCharMs: 0 } } } });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    await h.ensureSession(GROUP);
    const token = h.getSocialV2State(GROUP).agentToken;
    const send = (text) => call(port, '/api/socialV2/send-message', { method: 'POST', headers: { 'x-agent-call': '1', 'x-agent-token': token }, body: { key: GROUP, token, messages: [text] } });

    assert.equal((await call(port, '/api/status')).json.sendLimit, null, '没被拦过');
    for (const t of ['一', '二']) assert.notEqual((await send(t)).status, 429, `第 ${t} 条能发`);
    const third = await send('三');
    assert.equal(third.status, 429, '超过每分钟 2 条');
    assert.match(third.json.error, /桥接的发言上限，不是 QQ 的限制/, 'AI 知道是哪一层拦的');
    await send('四');

    const st = (await call(port, '/api/status')).json.sendLimit;
    assert.equal(st.count, 2, '控制台看得到最近 24 小时被拦了几次');
    assert.equal(st.lastKey, GROUP);
    assert.equal(h.sendLimitSummaryV2().count, 2);
    const asAgent = await call(port, '/api/status', { headers: { 'x-agent-call': '1', 'x-agent-token': token } });
    assert.equal(asAgent.json.sendLimit, undefined, 'AI 拿不到这份状态');

    const saved = await call(port, '/api/socialV2/config', { method: 'POST', body: { send: { maxSendPerMinute: 10, maxSendPerHour: 100 } } });
    assert.equal(saved.status, 200, saved.body);
    assert.equal(saved.json.config.send.maxSendPerMinute, 10);
    assert.notEqual((await send('五')).status, 429, '改了上限马上生效');
  } finally {
    await new Promise((r) => server.close(r));
    await h.close();
  }
});

test('② 控制台：总览页有「发言上限」卡片', () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const sec = html.slice(html.indexOf('<section id="section-sendlimit"'), html.indexOf('</section>', html.indexOf('<section id="section-sendlimit"')));
  assert.match(sec, /data-page="overview"/);
  for (const id of ['sendLimitMin', 'sendLimitHour', 'sendLimitSave', 'sendLimitHits']) assert.ok(sec.includes(`id="${id}"`), id);
  assert.match(html, /renderSendLimitHits\(s\.sendLimit\)/, '状态刷新时显示被拦次数');
});
