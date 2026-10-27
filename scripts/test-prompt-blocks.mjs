// 不常变的大块只在变化时完整注入（黑话表、表情包策略与常用表情）。全部离线、假数据。
//   ① 模块：指纹、第一次完整、没变只给一行、内容变 / 会话换 / 满 N 次 / 满 M 小时 / forget 后重新完整、持久化 0600 不存内容；
//   ② 端到端：第一次唤醒完整给 → 第二次只给一行 → 改了表情说明重新完整给；引导唤醒总是完整；
//      群规则照样每次都在；没有计划的旧调用方（测试里直接 buildWakePromptV2）照旧完整给。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockFingerprint, createBlockTracker, BLOCK_REFS } from '../src/prompt-blocks.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
const promptText = (p) => (Array.isArray(p?.content) ? p.content.map((c) => String(c?.text ?? '')).join('\n') : '');

test('① 模块', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocks-'));
  try {
    const file = path.join(dir, 'state', 'prompt-blocks.json');
    let t = 1000;
    const tr = createBlockTracker({ file, refreshEvery: 3, refreshMs: 10_000, now: () => t });
    const A = '【黑话表】甲：乙';
    let d = tr.decide(GROUP, 's1', 'slang', A);
    assert.equal(d.full, true, '第一次完整');
    tr.delivered(GROUP, 's1', 'slang', d);
    d = tr.decide(GROUP, 's1', 'slang', A);
    assert.equal(d.full, false, '没变只给一行');
    tr.delivered(GROUP, 's1', 'slang', d);
    assert.equal(tr.decide(GROUP, 's1', 'slang', A + '改').full, true, '内容变了');
    assert.equal(tr.decide(GROUP, 's2', 'slang', A).full, true, '会话换了');
    tr.delivered(GROUP, 's1', 'slang', tr.decide(GROUP, 's1', 'slang', A));
    tr.delivered(GROUP, 's1', 'slang', tr.decide(GROUP, 's1', 'slang', A));
    assert.equal(tr.decide(GROUP, 's1', 'slang', A).full, true, '满 3 次强制完整');
    tr.delivered(GROUP, 's1', 'slang', tr.decide(GROUP, 's1', 'slang', A));
    t += 11_000;
    assert.equal(tr.decide(GROUP, 's1', 'slang', A).full, true, '满 10 秒强制完整');
    tr.delivered(GROUP, 's1', 'slang', tr.decide(GROUP, 's1', 'slang', A));
    tr.forget(GROUP);
    assert.equal(tr.decide(GROUP, 's1', 'slang', A).full, true, 'forget 后完整');
    assert.equal(tr.decide(GROUP, 's1', 'slang', '').empty, true, '没有内容');
    tr.delivered(GROUP, 's1', 'sticker', tr.decide(GROUP, 's1', 'sticker', 'X'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('黑话'), '不存内容');
    assert.equal(createBlockTracker({ file, now: () => t }).decide(GROUP, 's1', 'sticker', 'X').full, false, '重启后读回');
    assert.equal(blockFingerprint('a'), blockFingerprint('a'));
    assert.match(BLOCK_REFS.slang, /qq_slang_query/);
    assert.match(BLOCK_REFS.sticker, /qq_list_stickers/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('② 端到端：完整 → 一行 → 改了重新完整；引导总完整；群规则每次都在', async () => {
  const stickers = [{ id: 'st1', resId: 'st1', url: 'https://public.invalid/a.png', md5: 'st1', desc: '开心小猫', localNote: '', tags: ['开心'], usage: '' }];
  const h = await bridgeHarness({ files: { 'state/stickers.json': stickers }, config: { socialV2: { sticker: { enabled: true, syncTtlMs: 3600000 } } } });
  try {
    h.setMode('reserved2');
    const sid = await h.ensureSession(GROUP);
    h.roleRefresh.markSeen(GROUP, sid, h.currentRoleFingerprintV2());
    h.getSocialV2State(GROUP).ownerRules = [{ id: 1, text: '本群语气软一点', at: 1 }];
    const last = () => promptText(h.calls.prompts.filter((p) => p.sessionId === sid).at(-1));

    await h.deliverPrompt(GROUP, '', { wakeReason: 'atMention' });
    assert.match(last(), /【表情包策略/, '第一次完整给表情块');
    assert.ok(last().includes('开心小猫'));
    await h.deliverPrompt(GROUP, '', { wakeReason: 'atMention' });
    assert.ok(last().includes(BLOCK_REFS.sticker), '第二次只给一行');
    assert.ok(!last().includes('【表情包策略'), '不再重复整块');
    assert.ok(last().includes('本群语气软一点'), '群规则每次都在');

    h.getStickerEntries()[0].tags = ['开心', '新标签'];
    await h.deliverPrompt(GROUP, '', { wakeReason: 'atMention' });
    assert.match(last(), /【表情包策略/, '表情标签改了：重新完整给');

    h.promptBlocks.forget(GROUP);
    await h.deliverPrompt(GROUP, '', { wakeReason: 'bootstrap' });
    assert.match(last(), /【表情包策略/, '引导唤醒总是完整');

    assert.match(h.buildWakePromptV2(GROUP, 'atMention'), /【表情包策略/, '没有计划的调用方照旧完整给');
  } finally { await h.close(); }
});
