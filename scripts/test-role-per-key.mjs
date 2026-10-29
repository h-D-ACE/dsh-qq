// 按会话（群 / 私聊）分别设置人格卡。全部离线、假数据（夹具里的假号 123 / 456、假角色卡）。
//   ① 模块：老状态文件不变、byKey 命中 / 未命中 / null 三种、非法 key 忽略、别名归一、路径穿越拒绝、改名 / 删除跟随；
//   ② 注入：各会话拿到自己的卡（二代唤醒的【当前角色】、一代角色提示、qq_get_prompt），null 的会话不挂卡，
//      byKey 里的穿越名字读不到 roles/ 外的文件；
//   ③ 刷新：只给卡真的变了的会话安排读卡唤醒，不误唤醒其它会话；改某张卡只影响用它的会话；
//      控制台接口（列表 / 单独设置 / 删除 / 改名），AI 的令牌调不了；
//   ④ QQ 命令：/role 名字 / off / default 只改当前会话，全局不动；不是管理员发的不生效；
//   ⑤ 控制台页面有「按会话设置人格」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  canonicalConversationKey, safeRoleName, resolveRoleFile, normalizeRoleState, serializeRoleState,
  roleNameFor, roleSourceFor, withRoleForKey, renameRoleEverywhere, removeRoleEverywhere, roleInUse, roleAssignments,
} from '../src/role-per-key.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
const OWNER = 'private:123';
const SELF = 999999;
const CARD_A = '# 角色卡：甲鱼\n你是甲鱼，说话很凶。';
const CARD_B = '# 角色卡：乙鱼\n你是乙鱼，说话软软的。';
const CONSOLE = { 'x-console-token': 'fixture-console-token' };
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

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

test('① 模块：回落规则、非法 key、路径穿越、改名删除', () => {
  // 老状态文件（没有 byKey）原样可用，写回去也还是老格式
  const old = normalizeRoleState({ role: '甲鱼', mode: 'active' });
  assert.equal(roleNameFor(old, GROUP), '甲鱼');
  assert.equal(roleSourceFor(old, GROUP), 'global');
  assert.deepEqual(Object.keys(serializeRoleState(old)).join(','), 'role,mode', '没有 byKey 时不写这个字段');
  assert.equal(normalizeRoleState(null).role, null);
  assert.equal(normalizeRoleState({ mode: 'silent' }).mode, 'silent');

  // 命中 / 未命中 / null
  const s = normalizeRoleState({ role: '甲鱼', mode: 'active', byKey: { [GROUP]: '乙鱼', [OWNER]: null } });
  assert.equal(roleNameFor(s, GROUP), '乙鱼', '命中');
  assert.equal(roleNameFor(s, 'group:789'), '甲鱼', '未命中回落全局');
  assert.equal(roleNameFor(s, OWNER), null, 'null = 不挂卡，不回落全局');
  assert.equal(roleSourceFor(s, OWNER), 'off');
  assert.equal(roleNameFor(s, undefined), '甲鱼', '不传 key 用全局');

  // 非法 key 忽略、别名归一
  const bad = normalizeRoleState({ role: null, byKey: { 'group:abc': '乙鱼', 'group:0': '乙鱼', 'channel:1': '乙鱼', 'group:-5': '乙鱼', 'group:0789': '乙鱼', [GROUP]: 42 } });
  assert.deepEqual(Object.keys(bad.byKey).join(','), 'group:789', '只留合法 key，前导零去掉；值不是字符串的丢掉');
  assert.equal(roleNameFor(bad, 'group:0789'), '乙鱼', '查询时别名也归一');
  assert.equal(canonicalConversationKey(' private:00123 '), OWNER);
  assert.equal(canonicalConversationKey('group:1.5'), null);
  assert.equal(canonicalConversationKey('__proto__'), null);
  assert.equal(Object.keys(normalizeRoleState({ byKey: JSON.parse('{"__proto__": "乙鱼", "constructor": "乙鱼"}') }).byKey).length, 0, '原型污染键不进来');

  // 路径穿越：全局和 byKey 走同一条校验，解析结果永远在 roles/ 里
  const dir = path.join(os.tmpdir(), 'roles-x');
  for (const evil of ['../../etc/passwd', '..\\..\\Windows\\win', '/abs/path', 'C:\\x', '..', '.', '']) {
    const f = resolveRoleFile(dir, evil);
    assert.ok(f === null || (f.startsWith(path.resolve(dir) + path.sep) && path.dirname(f) === path.resolve(dir)), `「${evil}」不能跑出 roles/`);
  }
  assert.equal(resolveRoleFile(dir, '..'), null);
  assert.equal(safeRoleName(123), null);
  const trav = normalizeRoleState({ role: '../x', byKey: { [GROUP]: '../../secret' } });
  assert.ok(!trav.role.includes('/') && !trav.byKey[GROUP].includes('/'), '读回来的名字里没有路径分隔符');

  // 设置
  let t = withRoleForKey(old, GROUP, 'role', '乙鱼');
  assert.equal(roleNameFor(t, GROUP), '乙鱼');
  assert.equal(t.role, '甲鱼', '全局不动');
  t = withRoleForKey(t, GROUP, 'off');
  assert.equal(roleNameFor(t, GROUP), null);
  t = withRoleForKey(t, 'group:0456', 'default');
  assert.equal(roleSourceFor(t, GROUP), 'global', '回到全局（别名也能定位）');
  assert.throws(() => withRoleForKey(old, 'group:x', 'off'), /会话格式/);
  assert.throws(() => withRoleForKey(old, GROUP, 'role', '../'), /不合法/);
  assert.throws(() => withRoleForKey(old, GROUP, 'xx'), /use/);

  // 改名 / 删除跟随
  const rn = renameRoleEverywhere(s, '乙鱼', '丙鱼');
  assert.equal(roleNameFor(rn.state, GROUP), '丙鱼');
  assert.deepEqual(rn.changedKeys.join(','), GROUP);
  assert.equal(rn.globalChanged, false);
  const rm = removeRoleEverywhere(s, '乙鱼');
  assert.equal(roleSourceFor(rm.state, GROUP), 'off', '单独用被删的卡 → 不挂卡，不会突然换成全局那张');
  assert.equal(rm.state.role, '甲鱼');
  assert.equal(removeRoleEverywhere(s, '甲鱼').state.role, null, '全局用的被删 → 清空');

  // 有没有人在用 / 控制台列表
  assert.equal(roleInUse(s, '乙鱼'), true);
  assert.equal(roleInUse(s, '甲鱼'), true);
  assert.equal(roleInUse(normalizeRoleState({ role: null, byKey: { [GROUP]: null } }), '甲鱼', [GROUP]), false);
  const list = roleAssignments(s, [GROUP, 'group:789', 'bad'], (n) => n !== '乙鱼');
  assert.deepEqual(list.map((x) => `${x.key}=${x.source}:${x.role}:${x.missing}`).join(' | '), `group:456=key:乙鱼:true | group:789=global:甲鱼:false | private:123=off:null:false`);
});

async function withHarness(run, files = {}) {
  const h = await bridgeHarness({
    files: {
      'roles/甲鱼.md': CARD_A,
      'roles/乙鱼.md': CARD_B,
      'state/current-role.json': { role: '甲鱼', mode: 'active' },
      ...files,
    },
  });
  try {
    h.setMode('reserved2');
    await run(h);
  } finally {
    await h.close();
  }
}
const writeRoleFile = (h, obj) => fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify(obj));
const readRoleFile = (h) => JSON.parse(fs.readFileSync(path.join(h.temp, 'state/current-role.json'), 'utf8'));

test('② 注入：各会话拿到自己的卡；不挂卡的会话没有角色；穿越名字读不到外面的文件', async () => {
  await withHarness(async (h) => {
    const gsid = await h.ensureSession(GROUP);
    await h.ensureSession(OWNER);
    // 老状态文件：两个会话都用全局卡
    assert.match(h.buildWakePromptV2(GROUP, 'timeout'), /【当前角色】甲鱼/);
    assert.match(h.buildWakePromptV2(OWNER, 'timeout'), /【当前角色】甲鱼/);
    assert.equal(h.currentRoleFingerprintV2(GROUP), h.currentRoleFingerprintV2(), '没有单独设置时指纹和以前一样（升级后不会误判换卡）');

    writeRoleFile(h, { role: '甲鱼', mode: 'active', byKey: { [GROUP]: '乙鱼' } });
    assert.ok(h.currentRoleHintV2(GROUP).includes('说话软软的'), '群用乙鱼');
    assert.ok(h.currentRoleHintV2(OWNER).includes('说话很凶'), '私聊跟全局');
    assert.ok(h.currentRoleHint(GROUP).includes('说话软软的'), '一代 / 聊天模式的角色提示也按会话');
    assert.match(h.buildWakePromptV2(GROUP, 'timeout'), /【当前角色】乙鱼/);
    assert.match(h.buildWakePromptV2(OWNER, 'timeout'), /【当前角色】甲鱼/);
    // 来回切几次缓存也不串
    for (let i = 0; i < 3; i += 1) {
      assert.ok(h.currentRoleHintV2(OWNER).includes('甲鱼'));
      assert.ok(h.currentRoleHintV2(GROUP).includes('乙鱼'));
    }

    // qq_get_prompt：AI 读到的是自己会话的卡，记下的也是这个会话的指纹
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    try {
      const token = h.getSocialV2State(GROUP).agentToken;
      const got = await call(port, `/api/socialV2/prompt?key=${GROUP}`, { headers: { 'x-agent-call': '1', 'x-agent-token': token } });
      assert.equal(got.status, 200, got.body);
      assert.equal(got.json.role.name, '乙鱼');
      assert.ok(got.json.role.hint.includes('说话软软的'));
      assert.equal(h.roleRefresh.needsRefresh(GROUP, gsid, h.currentRoleFingerprintV2(GROUP)), false, '读卡后记为已读（按会话的指纹）');
    } finally { await new Promise((r) => server.close(r)); }

    // null：这个会话不挂任何卡
    writeRoleFile(h, { role: '甲鱼', mode: 'active', byKey: { [GROUP]: null } });
    assert.equal(h.currentRoleHintV2(GROUP), '');
    assert.equal(h.currentRoleHint(GROUP), '');
    assert.ok(!h.buildWakePromptV2(GROUP, 'timeout').includes('【当前角色】'), '没有【当前角色】行');
    assert.match(h.buildWakePromptV2(OWNER, 'timeout'), /【当前角色】甲鱼/, '别的会话不受影响');

    // byKey 里写穿越路径：roles/ 外面的文件读不进来
    fs.writeFileSync(path.join(h.temp, 'secret.md'), '机密内容 SECRET-XYZ');
    fs.writeFileSync(path.join(h.temp, 'state', 'secret.md'), '机密内容 SECRET-XYZ');
    for (const evil of ['../secret', '../state/secret', '..\\secret']) {
      writeRoleFile(h, { role: null, mode: 'active', byKey: { [GROUP]: evil } });
      assert.ok(!h.currentRoleHintV2(GROUP).includes('SECRET-XYZ'), `「${evil}」读不到 roles/ 外的文件`);
      assert.ok(!h.currentRoleHint(GROUP).includes('SECRET-XYZ'));
    }
  });
});

test('③ 刷新只针对卡变了的会话；控制台接口；AI 调不了', async () => {
  await withHarness(async (h) => {
    const gsid = await h.ensureSession(GROUP);
    const osid = await h.ensureSession(OWNER);
    h.roleRefresh.markSeen(GROUP, gsid, h.currentRoleFingerprintV2(GROUP));
    h.roleRefresh.markSeen(OWNER, osid, h.currentRoleFingerprintV2(OWNER));
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const clearWake = (key) => { const st = h.getSocialV2State(key); clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; st.pendingWakeReason = null; };
    try {
      // AI 的令牌调不了单独设置
      const token = h.getSocialV2State(GROUP).agentToken;
      const byAgent = await call(port, '/api/roles/assign', { method: 'POST', headers: { 'x-agent-call': '1', 'x-agent-token': token }, body: { key: GROUP, use: 'role', role: '乙鱼' } });
      assert.equal(byAgent.status, 403, 'AI 改不了自己的人格');
      assert.equal(readRoleFile(h).byKey, undefined, '那次没写进去');

      // 非法输入
      for (const body of [{ key: 'group:abc', use: 'off' }, { key: GROUP, use: '乱写' }, { key: GROUP, use: 'role', role: '不存在的鱼' }]) {
        const r = await call(port, '/api/roles/assign', { method: 'POST', body });
        assert.equal(r.status, 400, JSON.stringify(body));
      }

      // 先改全局卡、选「下次唤醒」：私聊也成了「还没读到新卡」
      const pre = await call(port, '/api/roles/update', { method: 'POST', body: { name: '甲鱼', content: CARD_A + '\n先改一句。', apply: 'nextWake' } });
      assert.equal(pre.json.refresh.pending, 2, '两个会话都跟全局，都要重读');
      assert.ok(!h.getSocialV2State(OWNER).pendingWakeReason, '下次唤醒：不马上叫');

      // 给群单独换卡，选「立即」：只唤醒保存的这个群，不顺带叫醒同样没读新卡的私聊
      const r = await call(port, '/api/roles/assign', { method: 'POST', body: { key: GROUP, use: 'role', role: '乙鱼', apply: 'immediate' } });
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.role, '乙鱼');
      assert.equal(r.json.refresh.woke, 1, '只唤醒一个会话');
      assert.equal(h.getSocialV2State(GROUP).pendingWakeReason, 'roleRefresh');
      assert.ok(!h.getSocialV2State(OWNER).pendingWakeReason, '私聊没被唤醒（它等自己的下次唤醒）');
      assert.ok(h.buildWakePromptV2(OWNER, 'timeout').startsWith('【角色卡已更新'), '私聊下次唤醒照样带新卡');
      h.roleRefresh.markSeen(OWNER, osid, h.currentRoleFingerprintV2(OWNER));
      assert.equal(readRoleFile(h).role, '甲鱼', '全局不动');
      assert.ok(h.buildWakePromptV2(GROUP, 'timeout').startsWith('【角色卡已更新'), '群下一次唤醒带新卡');
      assert.ok(!h.buildWakePromptV2(OWNER, 'timeout').includes('【角色卡已更新'), '私聊不带');
      clearWake(GROUP);
      h.roleRefresh.markSeen(GROUP, gsid, h.currentRoleFingerprintV2(GROUP));

      // 列表
      const list = await call(port, '/api/roles');
      const a = Object.fromEntries(list.json.assignments.map((x) => [x.key, x]));
      assert.equal(a[GROUP].source, 'key');
      assert.equal(a[GROUP].role, '乙鱼');
      assert.equal(a[OWNER].source, 'global');
      assert.equal(list.json.current, '甲鱼');

      // 改「乙鱼」的内容：只有用它的群需要重读
      const up = await call(port, '/api/roles/update', { method: 'POST', body: { name: '乙鱼', content: CARD_B + '\n新加一句。', apply: 'immediate' } });
      assert.equal(up.status, 200, up.body);
      assert.ok(!up.json.refresh.notActive, '有会话在用，算在用的人格');
      assert.equal(up.json.refresh.woke, 1);
      assert.ok(!h.getSocialV2State(OWNER).pendingWakeReason, '改乙鱼不唤醒用甲鱼的私聊');
      clearWake(GROUP);
      h.roleRefresh.markSeen(GROUP, gsid, h.currentRoleFingerprintV2(GROUP));

      // 改全局「甲鱼」：群单独用乙鱼，不受影响
      const upA = await call(port, '/api/roles/update', { method: 'POST', body: { name: '甲鱼', content: CARD_A + '\n改一下。', apply: 'immediate' } });
      assert.equal(upA.json.refresh.woke, 1);
      assert.equal(h.getSocialV2State(OWNER).pendingWakeReason, 'roleRefresh', '私聊跟全局，要重读');
      assert.ok(!h.getSocialV2State(GROUP).pendingWakeReason, '群没被唤醒');
      clearWake(OWNER);

      // 改名跟随、删除改成不挂卡
      const rn = await call(port, '/api/roles/rename', { method: 'POST', body: { from: '乙鱼', to: '丙鱼' } });
      assert.equal(rn.status, 200, rn.body);
      assert.equal(readRoleFile(h).byKey[GROUP], '丙鱼');
      const del = await call(port, '/api/roles/delete', { method: 'POST', body: { name: '丙鱼' } });
      assert.equal(del.status, 200, del.body);
      assert.equal(readRoleFile(h).byKey[GROUP], null, '单独用的卡被删 → 这个群不挂卡');
      assert.equal(readRoleFile(h).role, '甲鱼');

      // 回到默认
      const back = await call(port, '/api/roles/assign', { method: 'POST', body: { key: GROUP, use: 'default' } });
      assert.equal(back.json.source, 'global');
      assert.equal(readRoleFile(h).byKey, undefined, '没有单独设置了，文件回到老格式');

      // 全局切换 / 静默开关不会冲掉各会话的单独设置
      await call(port, '/api/roles/assign', { method: 'POST', body: { key: GROUP, use: 'off' } });
      await call(port, '/api/role', { method: 'POST', body: { role: '甲鱼' } });
      await call(port, '/api/role-mode', { method: 'POST', body: { mode: 'silent' } });
      await call(port, '/api/role-mode', { method: 'POST', body: { mode: 'active' } });
      assert.equal(readRoleFile(h).byKey[GROUP], null, '单独设置还在');
    } finally { await new Promise((r) => server.close(r)); }
  });
});

test('④ QQ 命令 /role 只改当前会话', async () => {
  await withHarness(async (h) => {
    let mid = 100;
    const say = (user, t) => h.handleIncoming('group', 456, {
      post_type: 'message', message_type: 'group', group_id: 456, user_id: user, self_id: SELF, message_id: mid += 1, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text: t } }], raw_message: t, sender: { user_id: user, card: '某人', nickname: '某人' },
    }, h.cfg);
    const lastReply = () => String(h.calls.sent.filter((x) => x.kind === 'group').at(-1)?.text ?? '');

    await say(123, '/role 乙鱼');
    await settle();
    assert.equal(readRoleFile(h).byKey[GROUP], '乙鱼', '本群换卡');
    assert.equal(readRoleFile(h).role, '甲鱼', '全局不动');
    assert.match(lastReply(), /本会话已切换角色：乙鱼/);

    await say(123, '/role');
    await settle();
    assert.match(lastReply(), /本会话单独用「乙鱼」/);

    await say(123, '/role off');
    await settle();
    assert.equal(readRoleFile(h).byKey[GROUP], null, '本群不挂卡');
    assert.equal(h.roleNameForKey(OWNER), '甲鱼', '私聊不受影响');

    await say(123, '/role 不存在的鱼');
    await settle();
    assert.match(lastReply(), /不存在/);
    assert.equal(readRoleFile(h).byKey[GROUP], null, '没改');

    await say(123, '/role default');
    await settle();
    assert.equal(readRoleFile(h).byKey, undefined, '回到全局默认');

    // 不是管理员：/role 不生效
    await say(777, '/role 乙鱼');
    await settle();
    assert.equal(readRoleFile(h).byKey, undefined, '群友改不了');
  });
});

test('⑤ 控制台：人格页有「按会话设置人格」', () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const i = html.indexOf('<details class="settings-group" id="roleAssignGroup">');
  assert.ok(i > html.indexOf('<section id="section-persona"'), '在人格与角色页里');
  const sec = html.slice(i, html.indexOf('</details>', i));
  for (const id of ['roleAssignList', 'roleAssignKey', 'roleAssignNewUse', 'roleAssignAdd', 'roleAssignMsg']) assert.ok(sec.includes(`id="${id}"`), id);
  assert.match(html, /api\('\/api\/roles\/assign', 'POST'/);
  assert.match(html, /renderRoleAssignments\(r\)/, '刷新人格列表时一起刷新');
  assert.match(html, /page === 'persona' && typeof refreshRoleAssignments === 'function'/, '进入人格页自动刷新');
  assert.match(html, /currentConsolePage === 'persona' && !document\.hidden\) refreshRoleAssignments\(\)/, '停在人格页定时刷新');
  assert.match(html, /box\.contains\(document\.activeElement\)\) return/, '正在操作下拉框时不打断');
  assert.match(html, /const roleAssignDirty = new Map\(\)/, '没保存的选择单独记着');
  assert.match(html, /textContent = '未保存'/, '标出未保存');
  assert.ok(sec.includes('name="roleAssignApply"'), '按会话设置有自己的一组生效方式');
  assert.match(html, /function roleAssignBody\(key, value\) \{\n  const apply = roleAssignApplyMode\(\);/, '保存时只看这一组');
});
