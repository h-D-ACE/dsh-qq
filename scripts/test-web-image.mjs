// 搜图并发送（管理员私聊专用，默认关闭）。全部离线、假数据：假的搜索结果页、内存里的 1×1 PNG，不联网、不连 QQ。
//   ① 模块：搜索词清洗、严格安全搜索、结果页解析（去重、丢掉 explicit 缩略图、只认 http/https）、给 AI 的列表不含网址、
//      候选过期与「看过」标记、每小时上限；
//   ② 端到端：管理员私聊搜图 → 没看过不能发 → 预览（图进 AI 视觉上下文）→ 发送（图片消息段、记进最近消息）；
//   ③ 闸门：默认关闭；只认管理员私聊、二代仿真、有效令牌；不能看图时不能预览；编号不存在；MCP 只在开关为 true 时注册。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {
  cleanImageQuery as cleanQuery, bingImageUrl, bingImageUrls, searchBingImages, parseBingImages, imageCandidatesText as candidatesText, createImageCandidateStore, createImageHourlyLimiter as createHourlyLimiter, IMAGE_QUERY_MAX,
} from '../src/web-image.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
const m = (o) => `<a class="iusc" style="x" m="${JSON.stringify(o).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" href="#">`;
const PAGE = [
  m({ murl: 'https://img.example.com/corgi1.jpg', turl: 'https://ts1.mm.bing.net/th?id=1', purl: 'https://www.pics.example.com/a', t: '可爱的<b>柯基</b>\n笑' }),
  m({ murl: 'https://img.example.com/bad.jpg', turl: 'https://ts1.explicit.bing.net/th?id=2', purl: 'https://x.example.com', t: '不适宜' }),
  m({ murl: 'https://img.example.com/corgi1.jpg', turl: 'https://ts2.mm.bing.net/th?id=3', purl: 'https://dup.example.com', t: '重复' }),
  m({ murl: 'javascript:alert(1)', turl: 'file:///etc/passwd', purl: 'https://y.example.com', t: '非法地址' }),
  m({ murl: 'https://img.example.com/corgi2.png', turl: 'https://ts3.mm.bing.net/th?id=4', purl: 'https://blog.example.org/p', t: '柯基跑步' }),
].join('\n');

test('① 模块：清洗、安全搜索、解析、列表、候选与限额', () => {
  assert.equal(cleanQuery('  柯基\n可爱 '), '柯基 可爱');
  assert.equal(Array.from(cleanQuery('长'.repeat(200))).length, IMAGE_QUERY_MAX);
  assert.equal(cleanQuery(''), '');
  const u = new URL(bingImageUrl('柯基'));
  assert.equal(u.hostname, 'cn.bing.com');
  assert.equal(u.searchParams.get('adlt'), 'strict', '严格安全搜索');

  const list = parseBingImages(PAGE);
  assert.equal(list.length, 2, 'explicit、重复、非法地址都去掉');
  assert.equal(list[0].title, '可爱的柯基 笑', '去标签、单行化');
  assert.equal(list[0].site, 'pics.example.com');
  assert.equal(list[1].imageUrl, 'https://img.example.com/corgi2.png');

  let t = 1000;
  const store = createImageCandidateStore({ ttlMs: 60_000, now: () => t });
  const cands = store.set('private:123', '柯基', list);
  assert.deepEqual(cands.map((c) => c.n), [1, 2]);
  const text = candidatesText('柯基', cands);
  assert.match(text, /1\. 可爱的柯基 笑（来源：pics\.example\.com）/);
  assert.ok(!/https?:\/\//.test(text), '给 AI 的列表里没有任何网址');
  assert.equal(store.get('private:123', 1).previewed, false);
  store.markPreviewed('private:123', 1);
  assert.equal(store.get('private:123', 1).previewed, true);
  assert.equal(store.get('private:123', 9), null);
  assert.equal(store.get('group:456', 1), null, '候选按会话隔离');
  t += 61_000;
  assert.equal(store.get('private:123', 1), null, '过期');
  assert.match(candidatesText('x', []), /没有搜到/);

  const lim = createHourlyLimiter(2, { now: () => t });
  assert.equal(lim.take('k'), '');
  assert.equal(lim.take('k'), '');
  assert.match(lim.take('k'), /每小时最多 2 次/);
  t += 3600_001;
  assert.equal(lim.take('k'), '', '一小时后恢复');
});

const CONSOLE = { 'x-console-token': 'fixture-console-token' };
function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...CONSOLE, 'x-agent-call': '1', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json, body: data }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withHarness(run, { webImage = true, vision = 'yes', fetch: fakeGatewayFetch } = {}) {
  const fetched = { pages: [], images: [] };
  const h = await bridgeHarness({
    config: { dsh: { authToken: 'fixture-only', vision }, socialV2: { tools: { webImage } } },
    globals: {
      safeFetch: async (url) => { fetched.pages.push(url); return { url, statusCode: 200, truncated: false, body: PAGE }; },
      safeFetchBuffer: async (url) => { fetched.images.push(url); return { url, statusCode: 200, buffer: PNG }; },
      ...(fakeGatewayFetch ? { fetch: fakeGatewayFetch } : {}),
    },
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  try {
    await run(h, server.address().port, fetched);
  } finally {
    await new Promise((r) => server.close(r));
    await h.close();
  }
}
const OWNER = 'private:123';
const tok = (h, key) => ({ 'x-agent-token': h.getSocialV2State(key).agentToken });
const q = (o) => new URLSearchParams(o).toString();

test('② 端到端：搜图 → 没看过不能发 → 预览 → 发送', async () => {
  await withHarness(async (h, port, fetched) => {
    const s = await call(port, `/api/socialV2/image-search?${q({ key: OWNER, query: '柯基 可爱' })}`, { headers: tok(h, OWNER) });
    assert.equal(s.status, 200, s.body);
    assert.equal(s.json.count, 2);
    assert.match(fetched.pages[0], /adlt=strict/);
    assert.ok(!/https?:\/\//.test(s.json.text), '返回给 AI 的文字里没有网址');
    assert.ok(s.json.candidates.every((c) => !('imageUrl' in c) && !('thumbUrl' in c)), '候选里不带地址');

    const early = await call(port, '/api/socialV2/image-send', { method: 'POST', headers: tok(h, OWNER), body: { key: OWNER, n: 1 } });
    assert.equal(early.status, 409, '没看过不能发');
    assert.match(early.json.error, /还没看过/);

    const p = await call(port, `/api/socialV2/image-preview?${q({ key: OWNER, n: 1 })}`, { headers: tok(h, OWNER) });
    assert.equal(p.status, 200, p.body);
    assert.equal(p.json.image.data, PNG.toString('base64'));
    assert.equal(fetched.images.at(-1), 'https://ts1.mm.bing.net/th?id=1', '预览先取缩略图');

    const sent = await call(port, '/api/socialV2/image-send', { method: 'POST', headers: tok(h, OWNER), body: { key: OWNER, n: 1 } });
    assert.equal(sent.status, 200, sent.body);
    assert.equal(sent.json.sent, 1);
    assert.equal(fetched.images.at(-1), 'https://img.example.com/corgi1.jpg', '发送取原图');
    const out = h.calls.http.find((c) => c.url.endsWith('/send_private_msg'));
    assert.ok(out, '走 OneBot 私聊发送');
    assert.equal(out.body.user_id, 123);
    assert.equal(out.body.message[0].type, 'image');
    assert.equal(out.body.message[0].data.file, 'base64://' + PNG.toString('base64'));
    assert.equal(h.getSocialV2State(OWNER).recentMessages.at(-1).text, '[图片:可爱的柯基 笑]');

    const missing = await call(port, `/api/socialV2/image-preview?${q({ key: OWNER, n: 9 })}`, { headers: tok(h, OWNER) });
    assert.equal(missing.status, 404, '编号不存在');
  });
});

test('③ 闸门：默认关闭；只认管理员私聊 + 二代仿真 + 有效令牌；不能看图不能预览', async () => {
  await withHarness(async (h, port) => {
    const r = await call(port, `/api/socialV2/image-search?${q({ key: OWNER, query: '柯基' })}`, { headers: tok(h, OWNER) });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /默认关闭/);
  }, { webImage: false });

  await withHarness(async (h, port, fetched) => {
    const group = await call(port, `/api/socialV2/image-search?${q({ key: 'group:456', query: '柯基' })}`, { headers: tok(h, 'group:456') });
    assert.equal(group.status, 403);
    assert.match(group.json.error, /只能在管理员私聊里用/);
    const noTok = await call(port, `/api/socialV2/image-search?${q({ key: OWNER, query: '柯基' })}`);
    assert.equal(noTok.status, 403, '没有令牌');
    const badTok = await call(port, `/api/socialV2/image-search?${q({ key: OWNER, query: '柯基' })}`, { headers: tok(h, 'group:456') });
    assert.equal(badTok.status, 403, '别的会话的令牌不行');
    h.setMode('chat');
    const chat = await call(port, `/api/socialV2/image-search?${q({ key: OWNER, query: '柯基' })}`, { headers: tok(h, OWNER) });
    assert.equal(chat.status, 403);
    h.setMode('reserved2');
    const empty = await call(port, `/api/socialV2/image-search?${q({ key: OWNER, query: '  ' })}`, { headers: tok(h, OWNER) });
    assert.equal(empty.status, 400);
    assert.equal(fetched.pages.length, 0, '被拒的请求都没去搜');
  });

  await withHarness(async (h, port) => {
    await call(port, `/api/socialV2/image-search?${q({ key: OWNER, query: '柯基' })}`, { headers: tok(h, OWNER) });
    const p = await call(port, `/api/socialV2/image-preview?${q({ key: OWNER, n: 1 })}`, { headers: tok(h, OWNER) });
    assert.equal(p.status, 409);
    assert.match(p.json.error, /不能看图/);
    const s = await call(port, '/api/socialV2/image-send', { method: 'POST', headers: tok(h, OWNER), body: { key: OWNER, n: 1 } });
    assert.equal(s.status, 409, '没法预览也就没法发');
  }, { vision: 'no' });

  const mcp = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  assert.match(mcp, /if \(cfg\.socialV2\?\.tools\?\.webImage === true\) \{\s*\n\s*server\.tool\(\s*\n\s*'qq_search_images'/, 'MCP 只在开关为 true 时注册');
});

test('④ 网关回执超时：结果未知，提示 AI 先问再重发', async () => {
  const gatewayTimeout = async () => ({ ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 1200, wording: 'Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg' }) });
  await withHarness(async (h, port) => {
    await call(port, `/api/socialV2/image-search?${q({ key: OWNER, query: '柯基' })}`, { headers: tok(h, OWNER) });
    await call(port, `/api/socialV2/image-preview?${q({ key: OWNER, n: 1 })}`, { headers: tok(h, OWNER) });
    const s = await call(port, '/api/socialV2/image-send', { method: 'POST', headers: tok(h, OWNER), body: { key: OWNER, n: 1 } });
    assert.equal(s.status, 504);
    assert.equal(s.json.unknown, true);
    assert.match(s.json.error, /可能已经发出去了.*不要马上重发/);
  }, { fetch: gatewayTimeout });
});

test('⑤ 搜索地址依次尝试：结果页是骨架页时改用异步接口，再不行换 www', async () => {
  const urls = bingImageUrls('柯基');
  assert.equal(urls.length, 3);
  assert.ok(urls.every((u) => new URL(u).searchParams.get('adlt') === 'strict'), '每个地址都是严格安全搜索');
  assert.match(urls[1], /\/images\/async\?/);
  assert.equal(new URL(urls[2]).hostname, 'www.bing.com');
  const seen = [];
  const r1 = await searchBingImages('柯基', async (u) => { seen.push(u); return seen.length === 1 ? '<html>骨架页，没有结果</html>' : PAGE; });
  assert.equal(r1.list.length, 2);
  assert.equal(r1.tried, 2, '第一个是骨架页，第二个拿到结果就停');
  const r2 = await searchBingImages('柯基', async () => '<html></html>');
  assert.equal(r2.list.length, 0);
  assert.equal(r2.tried, 3);
  assert.equal(r2.error, null, '都是空结果：没搜到，不算失败');
  const r3 = await searchBingImages('柯基', async () => { throw new Error('网络断了'); });
  assert.match(r3.error.message, /网络断了/, '都失败：带上错误');
});
