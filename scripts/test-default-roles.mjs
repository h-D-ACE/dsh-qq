// 恢复默认人格。全部离线、假数据（夹具里的假号 123 / 456）。
//   ① 模块：发布包自带的默认人格存在且是合法角色卡、状态（在 / 被删 / 改过）、恢复（被删 → 放回；改过 → 先备份再恢复；
//      本来就是原版 → 什么都不做）、备份最多留 10 份、不是默认人格的拒绝；
//   ② 端到端：控制台接口列出状态、恢复当前启用的人格时按生效方式处理；AI 的令牌调不了。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DEFAULT_ROLES_DIR, listDefaultRoles, readDefaultRole, defaultRoleStatus, restoreDefaultRole, ROLE_BACKUP_KEEP } from '../src/default-roles.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';

test('① 模块', () => {
  const names = listDefaultRoles();
  assert.ok(names.includes('小鲸鱼'), '发布包自带小鲸鱼');
  for (const n of names) {
    const text = readDefaultRole(n);
    assert.ok(text.trim().length > 100, `${n} 不是空卡`);
    assert.ok(Buffer.byteLength(text, 'utf8') < 64 * 1024, `${n} 没超过人格大小上限`);
  }
  assert.equal(readDefaultRole('不存在的'), null);
  assert.equal(readDefaultRole('../package'), null, '不能借名字读到别的文件');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-defroles-'));
  try {
    const rolesDir = path.join(dir, 'roles');
    const backupDir = path.join(dir, 'state', 'role-backups');
    fs.mkdirSync(rolesDir);
    const write = (n, c) => fs.writeFileSync(path.join(rolesDir, `${n}.md`), c + '\n');
    let t = Date.parse('2026-10-26T01:00:00Z');
    const now = () => t;

    assert.deepEqual(defaultRoleStatus({ rolesDir }).find((x) => x.name === '小鲸鱼'), { name: '小鲸鱼', exists: false, modified: false });
    let r = restoreDefaultRole({ name: '小鲸鱼', rolesDir, backupDir, write, now });
    assert.deepEqual([r.created, r.unchanged, r.backup], [true, false, null], '被删了：放回');
    assert.equal(fs.readFileSync(path.join(rolesDir, '小鲸鱼.md'), 'utf8').trim(), readDefaultRole('小鲸鱼').trim());
    assert.equal(defaultRoleStatus({ rolesDir }).find((x) => x.name === '小鲸鱼').modified, false);

    r = restoreDefaultRole({ name: '小鲸鱼', rolesDir, backupDir, write, now });
    assert.equal(r.unchanged, true, '本来就是原版：什么都不做');
    assert.ok(!fs.existsSync(backupDir), '也不备份');

    fs.writeFileSync(path.join(rolesDir, '小鲸鱼.md'), '我改乱了\r\n');
    assert.equal(defaultRoleStatus({ rolesDir }).find((x) => x.name === '小鲸鱼').modified, true);
    r = restoreDefaultRole({ name: '小鲸鱼', rolesDir, backupDir, write, now });
    assert.match(r.backup, /^小鲸鱼-\d{8}-\d{6}\.md$/);
    assert.equal(fs.readFileSync(path.join(backupDir, r.backup), 'utf8'), '我改乱了\r\n', '改过的那份原样备份');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(backupDir, r.backup)).mode & 0o777, 0o600);
    assert.equal(defaultRoleStatus({ rolesDir }).find((x) => x.name === '小鲸鱼').modified, false, '已恢复成原版');

    for (let i = 0; i < ROLE_BACKUP_KEEP + 3; i += 1) {
      t += 1000;
      fs.writeFileSync(path.join(rolesDir, '小鲸鱼.md'), `第 ${i} 次改\n`);
      restoreDefaultRole({ name: '小鲸鱼', rolesDir, backupDir, write, now });
    }
    assert.equal(fs.readdirSync(backupDir).length, ROLE_BACKUP_KEEP, `备份最多留 ${ROLE_BACKUP_KEEP} 份`);
    assert.ok(fs.readdirSync(backupDir).some((f) => fs.readFileSync(path.join(backupDir, f), 'utf8').includes(`第 ${ROLE_BACKUP_KEEP + 2} 次改`)), '留的是最新的');

    assert.throws(() => restoreDefaultRole({ name: '猫娘', rolesDir, backupDir, write, now }), /不是发布包自带的默认人格/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.ok(fs.existsSync(DEFAULT_ROLES_DIR));
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

test('② 端到端：控制台恢复默认人格', async () => {
  const h = await bridgeHarness({ files: { 'roles/小鲸鱼.md': '被改乱的小鲸鱼\n', 'state/current-role.json': { role: '小鲸鱼', mode: 'active' } } });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const sid = await h.ensureSession(GROUP);
    h.roleRefresh.markSeen(GROUP, sid, h.currentRoleFingerprintV2());

    const list = await call(port, '/api/roles/defaults');
    assert.equal(list.status, 200, list.body);
    const xjy = list.json.defaults.find((d) => d.name === '小鲸鱼');
    assert.deepEqual([xjy.exists, xjy.modified], [true, true], '看得出改过');
    assert.ok(list.json.defaults.some((d) => d.name === '傲娇助手' && !d.exists), '看得出被删了');

    const token = h.getSocialV2State(GROUP).agentToken;
    for (const [p, method] of [['/api/roles/defaults', 'GET'], ['/api/roles/restore-default', 'POST']]) {
      const byAgent = await call(port, p, { method, body: method === 'POST' ? { name: '小鲸鱼' } : undefined, headers: { 'x-agent-call': '1', 'x-agent-token': token } });
      assert.equal(byAgent.status, 403, `AI 调不了 ${p}`);
    }
    assert.equal(fs.readFileSync(path.join(h.temp, 'roles', '小鲸鱼.md'), 'utf8'), '被改乱的小鲸鱼\n', 'AI 那次没改到');

    const r = await call(port, '/api/roles/restore-default', { method: 'POST', body: { name: '小鲸鱼', apply: 'nextWake' } });
    assert.equal(r.status, 200, r.body);
    assert.ok(r.json.backup, '改过的那份备份了');
    assert.equal(fs.readFileSync(path.join(h.temp, 'state', 'role-backups', r.json.backup), 'utf8'), '被改乱的小鲸鱼\n');
    assert.equal(fs.readFileSync(path.join(h.temp, 'roles', '小鲸鱼.md'), 'utf8').trim(), readDefaultRole('小鲸鱼').trim(), '已恢复原版');
    assert.equal(r.json.refresh.apply, 'nextWake', '恢复的是当前人格：按生效方式处理');
    assert.equal(h.roleRefresh.needsRefresh(GROUP, sid, h.currentRoleFingerprintV2()), true, '下次唤醒读到原版');

    const again = await call(port, '/api/roles/restore-default', { method: 'POST', body: { name: '小鲸鱼' } });
    assert.equal(again.json.unchanged, true);

    const put = await call(port, '/api/roles/restore-default', { method: 'POST', body: { name: '傲娇助手' } });
    assert.equal(put.json.created, true, '被删的放回');
    assert.equal(put.json.refresh.notActive, true, '不是当前人格：不唤醒任何会话');
    assert.equal((await call(port, '/api/roles')).json.current, '小鲸鱼', '恢复不会切换人格');

    const bad = await call(port, '/api/roles/restore-default', { method: 'POST', body: { name: '猫娘' } });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
    await h.close();
  }
});

test('③ 控制台：人格页有「恢复默认人格」', () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  assert.match(html, /<summary>恢复默认人格<\/summary>/);
  assert.match(html, /id="roleDefaultsList"/);
  assert.match(html, /\/api\/roles\/restore-default/);
});
