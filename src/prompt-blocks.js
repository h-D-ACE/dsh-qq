// 唤醒提示里「不常变的大块」只在变化时完整注入。
//
// 背景（用户反馈 + 实测）：二代仿真每次唤醒都会把黑话表（约 1000 字）、表情包策略与常用表情列表（约 1000 字）
// 原样再塞一遍。这些文字会永久留在会话历史里，会话又一直不重建，于是历史越来越长；每一步都要把整段历史重读一遍，
// 实测群 A 每一步要读 50 万 token 左右，大头就是这样攒出来的。
//
// 做法：按「会话 + 块名 + 内容指纹」记下每个会话上次完整拿到的是哪一版。
//   · 内容没变 → 只放一行「和上次一样」，并说明需要时用哪个工具查；
//   · 内容变了 / 会话换了 / 距上次完整给出满 N 次唤醒或 M 小时 / 刚压缩过上下文（forget）→ 重新完整给一次。
// 只存指纹，不存内容。群规则、角色卡等不在这里（规则按设计每次都注入；角色卡由 role-refresh.js 管）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 满多少次唤醒强制完整给一次（防止早先那次完整内容被 DSH 压缩掉后 AI 只剩一句「和上次一样」）。 */
export const REFRESH_EVERY_WAKES = 30;
/** 满多久强制完整给一次。 */
export const REFRESH_EVERY_MS = 12 * 3600_000;

export function blockFingerprint(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}

/** 没变时代替完整内容的一行。 */
export const BLOCK_REFS = {
  slang: '【群聊黑话表】和上次一样，没有变化（需要时用 qq_slang_query 查）。',
  sticker: '【表情包】策略和常用表情都和上次一样（完整列表用 qq_list_stickers 查，没备注的先 qq_get_sticker_image 看图）。',
};

const KEY_RE = /^(group|private):\d+$/;

function normalize(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw)) {
    if (!KEY_RE.test(key) || !v || typeof v !== 'object' || !v.sessionId || typeof v.blocks !== 'object') continue;
    const blocks = {};
    for (const [name, b] of Object.entries(v.blocks)) {
      if (!b || !/^[0-9a-f]{16}$/.test(String(b.fp))) continue;
      blocks[name] = { fp: b.fp, at: Number(b.at) || 0, wakes: Math.max(0, Number(b.wakes) || 0) };
    }
    out[key] = { sessionId: String(v.sessionId), blocks };
  }
  return out;
}

/**
 * @param {{ file: string, refreshEvery?: number, refreshMs?: number, now?: () => number, onError?: (e) => void }} opts
 */
export function createBlockTracker({ file, refreshEvery = REFRESH_EVERY_WAKES, refreshMs = REFRESH_EVERY_MS, now = Date.now, onError = () => {} } = {}) {
  let entries = {};
  try { entries = normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (error) { if (error?.code !== 'ENOENT') onError(error); }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) { onError(error); }
  }
  return {
    /** 这次要不要完整给。返回 { full, fp }。text 为空时 full=false（没有内容可给）。 */
    decide(key, sessionId, name, text) {
      const fp = blockFingerprint(text);
      if (!String(text ?? '').trim()) return { full: false, fp, empty: true };
      const rec = entries[key];
      const b = rec && rec.sessionId === String(sessionId) ? rec.blocks[name] : null;
      const full = !b || b.fp !== fp || b.wakes >= refreshEvery || now() - b.at >= refreshMs;
      return { full, fp };
    },
    /** 这次唤醒已送达：完整给的记下指纹并清零计数，只放了一行的计数 +1。 */
    delivered(key, sessionId, name, { full, fp, empty }) {
      if (!KEY_RE.test(String(key)) || !sessionId || empty) return;
      let rec = entries[key];
      if (!rec || rec.sessionId !== String(sessionId)) rec = entries[key] = { sessionId: String(sessionId), blocks: {} };
      if (full) rec.blocks[name] = { fp, at: now(), wakes: 0 };
      else if (rec.blocks[name]) rec.blocks[name].wakes += 1;
      save();
    },
    /** 会话上下文被压缩 / 重置后：下次全部完整给。 */
    forget(key) {
      if (entries[key]) { delete entries[key]; save(); }
    },
    get: (key) => (entries[key] ? JSON.parse(JSON.stringify(entries[key])) : null),
  };
}
