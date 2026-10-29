// 断线期间错过的 QQ 消息：连接恢复后用历史消息接口补收。
//
// 背景（实测）：Mac 合盖睡眠期间（18:51～19:27），群里有人 @ 了 AI 两次，NapCat 醒来后没有把这些消息
// 当作事件推给桥接，AI 也就一直不知道。OneBot 的 get_group_msg_history / get_friend_msg_history
// 能拉到这段时间的消息（字段和消息事件一样），所以连接恢复后由桥接补收一次。
//
// 怎么判断「断过」：NapCat / SnowLuma 每 30 秒发一次心跳。两次事件包之间隔了超过 gapMs（默认 2 分钟），
// 就认为中间断过；最后一次收到事件包的时间会定期写进 state/upstream-seen.json，桥接本身停过 / 睡过也能发现。
//
// 安全：补收的消息只当聊天内容记下，**不执行任何命令、审批、确认码、角色切换**（迟到的命令照样执行很危险）；
// 管理员私聊里补收到的命令只提醒管理员「没有执行，需要的话重发」。
// 太旧的（默认 6 小时以前）只记下不唤醒；只在二代仿真里补收（其它模式会逐条回复旧消息）。

import fs from 'node:fs';
import path from 'node:path';

export const BACKFILL_DEFAULTS = Object.freeze({
  enabled: true,
  gapMs: 120_000,          // 两次事件包隔了这么久，就认为中间断过
  settleMs: 10_000,        // 恢复后等一会儿再补（连接刚恢复时可能还在抖）
  maxAgeMinutes: 360,      // 比这更早的消息只记下，不唤醒 AI
  maxPerConversation: 50,  // 每个会话最多补几条
  lookbackMs: 60_000,      // 从断线前最后一个事件包再往前多看一点，防止边界上的消息漏掉（重复的按消息 ID 去掉）
});

/** 规范化 snowluma.backfill 配置；非法值回到默认。 */
export function normalizeBackfillConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, min, max, d) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : d);
  return {
    enabled: c.enabled !== false,
    gapMs: Math.round(num(c.gapMs, 60_000, 3_600_000, BACKFILL_DEFAULTS.gapMs)),
    settleMs: Math.round(num(c.settleMs, 0, 120_000, BACKFILL_DEFAULTS.settleMs)),
    maxAgeMinutes: num(c.maxAgeMinutes, 5, 7 * 24 * 60, BACKFILL_DEFAULTS.maxAgeMinutes),
    maxPerConversation: Math.round(num(c.maxPerConversation, 1, 100, BACKFILL_DEFAULTS.maxPerConversation)),
    lookbackMs: Math.round(num(c.lookbackMs, 0, 600_000, BACKFILL_DEFAULTS.lookbackMs)),
  };
}

/**
 * 记最后一次收到事件包的时间，发现断档。
 * notePacket() 返回 { since, gapMs }（since = 断档前最后一个事件包的时间）或 null。
 * 时间每 60 秒最多落盘一次（state/upstream-seen.json），桥接重启后第一次收到事件包也能发现断档。
 */
export function createUpstreamGapTracker({ file, gapMs = BACKFILL_DEFAULTS.gapMs, now = Date.now, onError = () => {} } = {}) {
  let last = 0;
  let savedAt = 0;
  try { last = Number(JSON.parse(fs.readFileSync(file, 'utf8'))?.lastPacketAt) || 0; } catch (error) { if (error?.code !== 'ENOENT') onError(error); }
  function save(t) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ lastPacketAt: t }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      savedAt = t;
    } catch (error) { onError(error); }
  }
  return {
    notePacket(threshold = gapMs) {
      const t = now();
      const prev = last;
      last = t;
      const gap = prev ? t - prev : 0;
      if (gap > threshold) { save(t); return { since: prev, gapMs: gap }; }
      if (t - savedAt >= 60_000) save(t);
      return null;
    },
    lastPacketAt: () => last,
  };
}

/** 最近处理过的消息 ID（按会话），用来给补收去重。有界。 */
export function createSeenMessageIds({ max = 500 } = {}) {
  const byKey = new Map();
  return {
    add(key, id) {
      if (id == null || id === '') return;
      let set = byKey.get(key);
      if (!set) { set = new Set(); byKey.set(key, set); }
      set.add(String(id));
      if (set.size > max) for (const old of set) { set.delete(old); if (set.size <= max) break; }
    },
    has: (key, id) => id != null && !!byKey.get(key)?.has(String(id)),
  };
}

/**
 * 补收时不能照常处理的消息：管理命令、确认码 / 动态码、审批回复。
 * 这些消息补收时一律不执行、也不交给 AI（迟到的「确认」「/level L3」照样执行很危险）。
 */
export function isCommandLike(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (t.startsWith('/')) return true;
  if (/^\d{4,8}$/.test(t)) return true; // 确认码 / TOTP
  if (/^#?\d{0,4}\s*(同意|批准|允许|拒绝|驳回|取消|确认|yes|no|y|n|ok)\s*[。.!！]?$/i.test(t)) return true;
  return false;
}

/** 消息纯文字（只看 text 段，用来判断是不是命令）。 */
export function plainTextOf(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message.filter((s) => s?.type === 'text').map((s) => String(s.data?.text ?? '')).join('');
}

/**
 * 从历史消息里挑出要补收的。
 * @param {object[]} messages 历史接口返回的消息（OneBot 消息事件格式，time 单位秒）
 * @param {{ key, since, now, selfId, seen, config }} opts
 * @returns {{ items: object[], skippedCommands: object[] }} items 按时间先后；每条带 ageMs / tooOld
 */
export function selectBackfill(messages, { key, since, now = Date.now(), selfId, seen, config } = {}) {
  const c = normalizeBackfillConfig(config);
  const from = Number(since) - c.lookbackMs;
  const maxAgeMs = c.maxAgeMinutes * 60_000;
  const items = [];
  const skippedCommands = [];
  const uniq = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    const t = Number(m?.time) * 1000;
    if (!Number.isFinite(t) || t < from || t > now + 60_000) continue;
    const self = selfId ?? m?.self_id;
    if (self != null && String(m?.user_id ?? m?.sender?.user_id ?? '') === String(self)) continue; // 自己发的
    const id = m?.message_id ?? m?.real_id;
    if (id != null && (uniq.has(String(id)) || seen?.has(key, id))) continue; // 已经处理过 / 重复
    if (id != null) uniq.add(String(id));
    const ageMs = Math.max(0, now - t);
    const item = { event: m, timeMs: t, ageMs, tooOld: ageMs > maxAgeMs };
    if (isCommandLike(plainTextOf(m?.message ?? m?.raw_message))) skippedCommands.push(item);
    else items.push(item);
  }
  items.sort((a, b) => a.timeMs - b.timeMs);
  return { items: items.slice(-c.maxPerConversation), skippedCommands };
}

/** 「约 37 分钟」「约 2 小时 5 分」。 */
export function describeDuration(ms) {
  const min = Math.max(1, Math.round(Number(ms) / 60_000));
  if (min < 60) return `约 ${min} 分钟`;
  const h = Math.floor(min / 60); const m = min % 60;
  return `约 ${h} 小时${m ? ` ${m} 分` : ''}`;
}

/** 给 AI 的唤醒提示：未读里有补收的消息。 */
export function backfillNoticeBlock({ gapMs, count, earliestAgeMs }) {
  return `【补收 · 桥接提供】桥接和 QQ 断开过${describeDuration(gapMs)}，未读里带 backfill 标记的 ${count} 条是那段时间错过、刚补收回来的`
    + `（最早的${describeDuration(earliestAgeMs)}前）。看 time 判断它们过去多久了；回复时可以自然地说一句刚看到，不要假装是刚发的。`;
}
