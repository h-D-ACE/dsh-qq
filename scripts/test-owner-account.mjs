// 管理员私聊里的账号门面操作（PR #4 重做，src/owner-account.js + bridge.js /api/socialV2/account）的离线测试。
//   ① 模块：参数校验、确认矩阵、确认码、额度、记录、门面人格、改写输出清理；
//   ② 认人：群会话的令牌冒充管理员私聊 key 一律 403，且一个 OneBot 动作都不会发出（原 PR 的漏洞）；
//   ③ 确认：默认先发预览给管理员、模型拿不到确认码；管理员回复「确认 码」后才执行；「你叫它做」/「它主动做」分开；补收不算「你叫它做」；
//   ④ 审计、额度、评论撤销窗口、签名改回（控制台）、控制台接口 AI 调不了；
//   ⑤ 撤回（默认关）：只能撤自己发的；云语音：默认关、令牌校验在合成之前；
//   ⑥ MCP / 控制台接线。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCOUNT_ACTIONS, ACCOUNT_TOOL_FLAGS, normalizeAccountConfig, needsConfirm, validateAccountAction, onebotCallFor,
  parseAccountReply, createPendingRegistry, createAccountQuota, createAccountHistory, resolveAccountPersona,
  cleanRewriteOutput, safeImageUrl, buildConfirmText, UGC_RIGHT_LABEL,
} from '../src/owner-account.js';
import { edgeTtsVersionOk, normalizeSpeakOptions, edgeTtsCandidates } from '../src/tts-cloud.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'private:123';
const GROUP = 'group:456';
const CONSOLE = { 'x-console-token': 'fixture-console-token' };
const ALL_ON = Object.fromEntries([...ACCOUNT_TOOL_FLAGS].map((f) => [f, true]));

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: encodeURI(pathname), method, headers: { 'content-type': 'application/json', ...CONSOLE, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json, body: data }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

let selfLongNick = '旧签名';
async function withBridge(run, { tools = ALL_ON, account: accountCfg = {}, botRaw = null } = {}) {
  const h = await bridgeHarness({
    config: { socialV2: { tools, account: accountCfg } },
    botRaw: botRaw ?? ((action) => (action === 'get_stranger_info' ? { nick: '旧昵称', longNick: selfLongNick } : action === 'get_login_info' ? { user_id: 999 } : {})),
    files: { 'roles/甲鱼.md': '# 甲鱼\n说话很凶。', 'state/current-role.json': { role: '甲鱼', mode: 'active' } },
  });
  h.setMode('reserved2');
  await h.ensureSession(OWNER);
  await h.ensureSession(GROUP);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const agent = (key) => ({ 'x-agent-call': '1', 'x-agent-token': h.getSocialV2State(key).agentToken });
  const account = (key, action, params, tokenKey = key) => call(port, '/api/socialV2/account', { method: 'POST', headers: agent(tokenKey), body: { key, action, params } });
  const raws = () => (h.calls.raw ?? []).map((r) => r.action);
  const ownerDms = () => h.calls.sent.filter((m) => m.kind === 'private' && String(m.id) === '123').map((m) => String(m.text));
  try {
    await run({ h, port, agent, account, raws, ownerDms });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const codeIn = (text) => (/确认 (\d{6})/.exec(text) ?? /撤销 (\d{6})/.exec(text) ?? [])[1];

test('① 模块：校验、确认矩阵、确认码、额度、记录、门面人格', () => {
  const acct = normalizeAccountConfig({});
  // 参数校验
  assert.equal(validateAccountAction('post', { content: '' }, acct).ok, false);
  assert.equal(validateAccountAction('post', { content: 'x'.repeat(301) }, acct).ok, false);
  assert.equal(validateAccountAction('post', { content: '今天好困' }, acct).params.ugc_right, 4, '默认好友可见');
  assert.equal(validateAccountAction('post', { content: 'a', ugc_right: 2 }, acct).ok, false);
  assert.equal(validateAccountAction('post', { content: 'a', ugc_right: 16 }, acct).ok, false, '部分好友可见要给 QQ 号');
  assert.equal(validateAccountAction('post', { content: 'a', ugc_right: 128 }, acct).ok, false, '部分好友不可见也要给 QQ 号');
  assert.equal(validateAccountAction('post', { content: 'a', ugc_right: 64 }, acct).params.ugc_right, 64, '仅自己可见');
  assert.equal(UGC_RIGHT_LABEL[128], '部分好友不可见', '128 不是「指定人可见」（对照 NapCat 实现）');
  // 实测发现：「仅对我可见」模型会选 16 + 管理员 QQ，预览必须写明是哪些人
  const only = validateAccountAction('post', { content: 'a', ugc_right: 16, target_uins: ['10001'] }, acct);
  assert.match(buildConfirmText({ action: 'post', params: only.params, code: '123456', ttlSeconds: 600, trigger: 'owner' }), /部分好友可见：10001/);
  assert.equal(validateAccountAction('post', { content: 'a', ugc_right: 1 }, normalizeAccountConfig({ allowPublic: false })).ok, false);
  for (const img of ['/etc/passwd', 'C:\\Users\\x\\a.png', 'file:///a.png', 'http://example.com/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png', 'https://[::1]/a.png']) {
    assert.equal(validateAccountAction('post', { content: 'a', images: [img] }, acct).ok, false, `配图「${img}」应被拒`);
  }
  assert.equal(safeImageUrl('https://img.example.com/a.png'), true);
  assert.equal(validateAccountAction('comment', { tid: 'x', target_uin: 'abc', content: 'hi' }, acct).ok, false);
  assert.equal(validateAccountAction('comment', { tid: '../x', target_uin: '10001', content: 'hi' }, acct).ok, false);
  assert.equal(validateAccountAction('nickname', { nickname: 'a\nb' }, acct).ok, false);
  assert.equal(validateAccountAction('signature', { signature: 'x'.repeat(81) }, acct).ok, false);
  assert.equal(validateAccountAction('nope', {}, acct).ok, false);
  // 「正在输入」的对象由桥接定，不收模型给的 user_id
  const [act, params] = onebotCallFor('inputStatus', validateAccountAction('inputStatus', { user_id: '55555' }, acct).params, { ownerQQ: 123 });
  assert.equal(act, 'set_input_status');
  assert.equal(params.user_id, '123');

  // 确认矩阵：默认全部要确认；两个开关分开
  for (const a of ['post', 'deletePost', 'comment', 'signature', 'nickname']) {
    assert.equal(needsConfirm(a, 'owner', acct), true);
    assert.equal(needsConfirm(a, 'proactive', acct), true);
  }
  assert.equal(needsConfirm('like', 'proactive', acct), false, '点赞不需要确认');
  const mixed = normalizeAccountConfig({ confirm: { signature: { owner: false }, post: { proactive: false } } });
  assert.equal(needsConfirm('signature', 'owner', mixed), false);
  assert.equal(needsConfirm('signature', 'proactive', mixed), true);
  assert.equal(needsConfirm('post', 'owner', mixed), true);
  assert.equal(needsConfirm('post', 'proactive', mixed), false);
  assert.equal(normalizeAccountConfig({ limits: { post: 999 } }).limits.post, 100);

  // 确认码
  assert.deepEqual(parseAccountReply('确认 123456'), { verb: 'confirm', code: '123456' });
  assert.deepEqual(parseAccountReply('取消123456'), { verb: 'cancel', code: '123456' });
  assert.deepEqual(parseAccountReply('撤销 123456'), { verb: 'undo', code: '123456' });
  assert.equal(parseAccountReply('确认 1234'), null, '4 位码是模式切换的，不归这里');
  assert.equal(parseAccountReply('好的确认 123456'), null);
  let t = 1000;
  const reg = createPendingRegistry({ now: () => t, maxPending: 2 });
  const c1 = reg.add({ action: 'post' }, 60_000);
  assert.match(c1, /^\d{6}$/);
  reg.add({ action: 'post' }, 60_000);
  assert.throws(() => reg.add({ action: 'post' }, 60_000), /等管理员确认/);
  assert.ok(reg.takeForConfirm(c1));
  assert.equal(reg.takeForConfirm(c1), null, '同一个码只能用一次');
  const c3 = reg.add({ action: 'post' }, 60_000);
  t += 61_000;
  assert.equal(reg.takeForConfirm(c3), null, '过期作废');

  // 额度：按日历日
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-account-test-'));
  try {
    let day = '2026-11-01';
    const q = createAccountQuota({ file: path.join(dir, 'q.json'), dayOf: () => day });
    assert.equal(q.allowed('post', 1), true);
    q.bump('post');
    assert.equal(q.allowed('post', 1), false);
    assert.equal(q.allowed('post', 0), false, '上限 0 = 不允许');
    day = '2026-11-02';
    assert.equal(q.allowed('post', 1), true, '换日清零');
    const hist = createAccountHistory({ file: path.join(dir, 'h.json') });
    const it = hist.add({ action: 'signature', text: '新', previous: '旧', restorable: true });
    assert.equal(createAccountHistory({ file: path.join(dir, 'h.json') }).get(it.id).previous, '旧', '记录落盘');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'h.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // 门面人格
  assert.equal(resolveAccountPersona('follow', { privateRole: '甲鱼', globalRole: '乙鱼' }), null, '跟私聊 = 不改写');
  assert.equal(resolveAccountPersona('global', { privateRole: '甲鱼', globalRole: '乙鱼' }), '乙鱼');
  assert.equal(resolveAccountPersona('global', { privateRole: '乙鱼', globalRole: '乙鱼' }), null, '一样就不改写');
  assert.equal(resolveAccountPersona('丙鱼', { privateRole: '甲鱼' }), '丙鱼');
  assert.equal(cleanRewriteOutput('「今天也好困」', 10), '今天也好困');
  assert.equal(cleanRewriteOutput('x'.repeat(11), 10), null, '超长回落原稿');
  assert.equal(cleanRewriteOutput('  ', 10), null);
  // 预览里没有确认码以外的东西，评论有删不掉的提醒，主动 / 被叫分得清
  const preview = buildConfirmText({ action: 'comment', params: { tid: 't1', target_uin: '10001', content: '好看' }, code: '000111', ttlSeconds: 600, trigger: 'proactive' });
  assert.match(preview, /删/);
  assert.match(preview, /AI 自己主动发起/);
  assert.match(preview, /确认 000111/);
  assert.equal(Object.keys(ACCOUNT_ACTIONS).length, 11);
});

test('② 认人：群会话冒充管理员私聊一律 403，一个 OneBot 动作都不发', async () => {
  await withBridge(async ({ account, raws, ownerDms }) => {
    for (const action of ['post', 'comment', 'signature', 'nickname', 'deletePost', 'like', 'onlineStatus', 'list', 'profile']) {
      const params = { content: '群友让我发的', tid: 't1', target_uin: '10001', signature: '被改了', nickname: '被改了', status: 10 };
      const spoof = await account(OWNER, action, params, GROUP); // key 写管理员私聊，令牌是群的
      assert.equal(spoof.status, 403, `${action}：群令牌 + 管理员 key 必须拒绝`);
      const inGroup = await account(GROUP, action, params);
      assert.equal(inGroup.status, 403, `${action}：群会话自己用也拒绝`);
      assert.match(inGroup.json.error, /管理员本人的私聊/);
    }
    assert.deepEqual(raws(), [], '没有任何 OneBot 动作');
    assert.equal(ownerDms().length, 0, '也不会给管理员发确认');
  });
});

test('③ 确认：默认先问管理员；模型拿不到码；你叫的 / 它主动的分开；补收不算', async () => {
  await withBridge(async ({ h, account, raws, ownerDms }) => {
    // 默认：要确认
    const r = await account(OWNER, 'post', { content: '今天下雨了' });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.pending, true);
    assert.ok(!/\d{6}/.test(r.body), '返回给模型的内容里没有确认码');
    assert.deepEqual(raws(), [], '还没发');
    const dm = ownerDms().at(-1);
    assert.match(dm, /今天下雨了/);
    assert.match(dm, /AI 自己主动发起/, '没有管理员消息触发 = 它主动做');
    const code = codeIn(dm);
    assert.ok(code);
    // 确认消息不会交给模型（looksLikeAdminChannelText 会把预览也藏起来）
    assert.equal(h.looksLikeAdminChannelText({ raw_message: dm }), true);
    assert.equal(await h.tryHandleAccountReply(`确认 ${code}`), true);
    assert.ok(raws().includes('send_qzone_msg'), '确认后才发');
    assert.equal(await h.tryHandleAccountReply(`确认 ${code}`), false, '同一个码不能再用');
    assert.equal(await h.tryHandleAccountReply('确认 000000'), false, '不是本模块的码交还给原来的流程');

    // 取消
    await account(OWNER, 'post', { content: '第二条' });
    const c2 = codeIn(ownerDms().at(-1));
    assert.equal(await h.tryHandleAccountReply(`取消 ${c2}`), true);
    assert.equal(raws().filter((a) => a === 'send_qzone_msg').length, 1, '取消的没发');
  }, { account: { limits: { post: 10 } } });

  await withBridge(async ({ h, account, raws, ownerDms }) => {
    // 「你叫它做」免确认，「它主动做」仍要确认
    h.noteAccountTurnTrigger(OWNER, 'private', { unread: [{ isOwner: true }] });
    assert.equal(h.accountTriggerFor(OWNER), 'owner');
    const direct = await account(OWNER, 'signature', { signature: '新签名' });
    assert.equal(direct.json.done, true, direct.body);
    assert.ok(raws().includes('set_self_longnick'));
    // 补收的消息不算
    h.noteAccountTurnTrigger(OWNER, 'private', { unread: [{ isOwner: true, backfill: true }] });
    assert.equal(h.accountTriggerFor(OWNER), 'proactive');
    // 定时唤醒不算
    h.noteAccountTurnTrigger(OWNER, 'timeout', { unread: [{ isOwner: true }] });
    assert.equal(h.accountTriggerFor(OWNER), 'proactive');
    const pro = await account(OWNER, 'signature', { signature: '它自己想改的' });
    assert.equal(pro.json.pending, true);
    assert.match(ownerDms().at(-1), /AI 自己主动发起/);
    // 群会话的唤醒不会给管理员私聊记「你叫它做」
    h.noteAccountTurnTrigger(GROUP, 'private', { unread: [{ isOwner: true }] });
    assert.equal(h.accountTurnTrigger.has(GROUP), false);
  }, { account: { confirm: { signature: { owner: false, proactive: true } } } });
});

test('④ 审计、额度、评论撤销、签名改回、控制台接口', async () => {
  await withBridge(async ({ h, port, agent, account, raws, ownerDms }) => {
    // 审计：正文里带会话令牌
    const leak = await account(OWNER, 'post', { content: `看看这个 ${h.getSocialV2State(GROUP).agentToken}` });
    assert.equal(leak.status, 403);
    assert.match(leak.json.error, /敏感/);
    // 额度
    h.noteAccountTurnTrigger(OWNER, 'private', { unread: [{ isOwner: true }] });
    assert.equal((await account(OWNER, 'post', { content: '一' })).json.done, true);
    const over = await account(OWNER, 'post', { content: '二' });
    assert.equal(over.status, 429);
    // 评论：免确认时也有撤销窗口
    const cm = await account(OWNER, 'comment', { tid: 't1', target_uin: '10001', content: '好看' });
    assert.equal(cm.json.scheduled, true, cm.body);
    const undo = codeIn(ownerDms().at(-1));
    assert.equal(await h.tryHandleAccountReply(`撤销 ${undo}`), true);
    await new Promise((r) => setTimeout(r, 1300));
    assert.ok(!raws().includes('comment_qzone'), '撤销后不会发出');
    const cm2 = await account(OWNER, 'comment', { tid: 't1', target_uin: '10001', content: '真好看' });
    assert.equal(cm2.json.scheduled, true);
    await new Promise((r) => setTimeout(r, 1300));
    assert.ok(raws().includes('comment_qzone'), '等待结束后发出');

    // 签名：记下旧值，控制台一键改回
    assert.equal((await account(OWNER, 'signature', { signature: '新签名' })).json.done, true);
    const list = await call(port, '/api/account');
    assert.equal(list.status, 200);
    const sig = list.json.history.find((x) => x.action === 'signature');
    assert.equal(sig.previous, '旧签名');
    const byAgent = await call(port, '/api/account/restore', { method: 'POST', headers: agent(OWNER), body: { id: sig.id } });
    assert.equal(byAgent.status, 403, 'AI 调不了控制台接口');
    const cfgByAgent = await call(port, '/api/account/config', { method: 'POST', headers: agent(OWNER), body: { confirm: { post: { owner: false, proactive: false } } } });
    assert.equal(cfgByAgent.status, 403, 'AI 改不了确认开关');
    const restored = await call(port, '/api/account/restore', { method: 'POST', body: { id: sig.id } });
    assert.equal(restored.status, 200, restored.body);
    assert.deepEqual(h.calls.raw.filter((x) => x.action === 'set_self_longnick').at(-1).params, { longNick: '旧签名' });
    // 实测发现：原签名为空时也要能改回（清空签名），不能被「签名不能为空」挡住
    selfLongNick = '';
    assert.equal((await account(OWNER, 'signature', { signature: '测试中' })).json.done, true);
    const emptySig = (await call(port, '/api/account')).json.history.find((x) => x.action === 'signature' && x.text === '测试中');
    assert.equal(emptySig.previous, '');
    assert.equal(emptySig.restorable, true);
    const restoredEmpty = await call(port, '/api/account/restore', { method: 'POST', body: { id: emptySig.id } });
    assert.equal(restoredEmpty.status, 200, restoredEmpty.body);
    assert.deepEqual(h.calls.raw.filter((x) => x.action === 'set_self_longnick').at(-1).params, { longNick: '' });
    selfLongNick = '旧签名';

    // 控制台改设置：人格卡必须存在
    assert.equal((await call(port, '/api/account/config', { method: 'POST', body: { persona: '../secret' } })).status, 400);
    const saved = await call(port, '/api/account/config', { method: 'POST', body: { persona: '甲鱼', limits: { post: 2 } } });
    assert.equal(saved.status, 200, saved.body);
    assert.equal(saved.json.config.persona, '甲鱼');
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).socialV2.account.limits.post, 2);
  }, { account: { limits: { post: 1 }, commentDelaySeconds: 1, confirm: { post: { owner: false }, comment: { owner: false }, signature: { owner: false } } } });

  // 工具开关没开：拒绝
  await withBridge(async ({ account, raws }) => {
    const r = await account(OWNER, 'post', { content: 'x' });
    assert.equal(r.status, 403);
    assert.deepEqual(raws(), []);
  }, { tools: {} });
});

test('⑤ 撤回只能撤自己的；云语音默认关、先验令牌', async () => {
  await withBridge(async ({ h, port, agent, raws }) => {
    const st = h.getSocialV2State(GROUP);
    st.mySentMessageIds = [111];
    const foreign = await call(port, '/api/socialV2/recall', { method: 'POST', headers: agent(GROUP), body: { key: GROUP, messageId: 222 } });
    assert.equal(foreign.status, 403, '别人的消息撤不了');
    const own = await call(port, '/api/socialV2/recall', { method: 'POST', headers: agent(GROUP), body: { key: GROUP, messageId: 111 } });
    assert.equal(own.status, 200, own.body);
    assert.ok(raws().includes('delete_msg'));
    // 云语音：令牌不对，直接拒绝（不会去合成）
    const sp = await call(port, '/api/socialV2/speak', { method: 'POST', headers: agent(GROUP), body: { key: OWNER, text: '你好' } });
    assert.equal(sp.status, 403);
  }, { tools: { recall: true, speak: true } });

  await withBridge(async ({ port, agent }) => {
    const off = await call(port, '/api/socialV2/recall', { method: 'POST', headers: agent(GROUP), body: { key: GROUP, messageId: 111 } });
    assert.equal(off.status, 403, '撤回默认关');
    const sp = await call(port, '/api/socialV2/speak', { method: 'POST', headers: agent(GROUP), body: { key: GROUP, text: '你好' } });
    assert.equal(sp.status, 403, '云语音默认关');
  }, { tools: {} });

  assert.equal(edgeTtsVersionOk('edge-tts 7.3.1'), true);
  assert.equal(edgeTtsVersionOk('7.2.7'), false);
  assert.equal(edgeTtsVersionOk('8.0.0'), true);
  assert.throws(() => normalizeSpeakOptions({ voice: 'zh-CN-Xiaoyi; rm -rf /' }), /音色/);
  assert.throws(() => normalizeSpeakOptions({ rate: '--write-media=/tmp/x' }), /语速/);
  assert.equal(normalizeSpeakOptions({}).voice, 'zh-CN-XiaoyiNeural');
  assert.ok(edgeTtsCandidates({ env: {}, platform: 'darwin' }).every((c) => !path.isAbsolute(c.cmd)), '不写死绝对路径');
});

test('⑥ 接线：MCP 只转发、默认不注册；默认值；控制台', () => {
  const mcp = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public/console.html'), 'utf8');
  for (const action of ['send_qzone_msg', 'delete_qzone_msg', 'comment_qzone', 'like_qzone', 'set_self_longnick', 'set_qq_profile', 'set_online_status', 'set_input_status']) {
    assert.ok(!mcp.includes(`'${action}'`), `MCP 不直接调 ${action}`);
  }
  assert.ok(!/spawnSync|child_process/.test(mcp), 'MCP 侧不起子进程');
  for (const flag of [...ACCOUNT_TOOL_FLAGS, 'recall', 'speak']) {
    assert.match(mcp, new RegExp(`if \\(cfg\\.socialV2\\?\\.tools\\?\\.${flag} === true\\)`), `${flag} 显式开启才注册`);
    assert.equal((bridge.match(new RegExp(`\\b${flag}: false`, 'g')) || []).length, 2, `${flag} 在两份默认表里都是 false`);
    assert.ok(html.includes(`data-v2-tool="${flag}"`), `控制台有 ${flag} 开关`);
  }
  assert.ok(!/\brecall: true/.test(bridge), '撤回不再默认开');
  assert.match(bridge, /if \(await tryHandleAccountReply\(ownerText\)\) \{ rememberAdminMessageId/);
  assert.match(bridge, /noteAccountTurnTrigger\(key, reason, st\);/);
  assert.ok(html.includes('id="accountGroup"'));
  assert.ok(html.includes('data-account-confirm'));
});
