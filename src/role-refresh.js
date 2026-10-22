// 角色卡变更后让二代仿真会话重新读卡。
//
// 背景（用户反馈）：二代仿真的会话只在新建后的引导唤醒里调用一次 qq_get_prompt 读完整角色卡，
// 之后每次唤醒只有一行「【当前角色】名字」。控制台切换人格、或改了当前人格的内容以后，
// 正在跑的会话一直按旧卡说话，直到会话重建 —— 看起来就像「切换失败」。
//
// 做法：按「会话 + 角色卡指纹」记下每个 QQ 会话最后读到的是哪一版卡。
// - 读到的时机：AI 自己调用 qq_get_prompt 成功；或者桥接把新卡写进唤醒提示并被 DSH 接受。
// - 指纹对不上（换了人格、改了内容、清除了人格）或会话换了：下一次唤醒把新卡全文放在提示最前面。
// - 控制台切换时选「立即」：桥接对还没读到新卡的会话各安排一次唤醒（roleRefresh），不用等下一条消息。
// 只记会话 ID 和指纹，不存卡片内容。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 切换人格时的生效方式。 */
export const ROLE_APPLY_MODES = ['nextWake', 'immediate'];

export function normalizeApplyMode(value) {
  return value === 'immediate' ? 'immediate' : 'nextWake';
}

/** 角色卡指纹：角色名 + 实际注入给二代的卡片文字。没有角色时也有固定指纹（清除人格同样要通知）。 */
export function roleFingerprint(name, hint) {
  return crypto.createHash('sha256').update(`${String(name ?? '')}\n${String(hint ?? '')}`).digest('hex').slice(0, 16);
}

/**
 * 唤醒提示最前面的「角色卡已更新」块。
 * @param {{ name?: string|null, hint?: string }} opts
 */
export function buildRoleRefreshBlock({ name = null, hint = '' } = {}) {
  const card = String(hint ?? '').trim();
  if (!card) {
    return '【角色卡已更新 · 桥接提供】管理员清除了当前角色：从现在起不再扮演之前读到的角色卡，只按仿真提示词行动；群规则和你的记忆不变。不要在聊天里提起这件事。';
  }
  const label = name ? `（当前角色：${name}）` : '';
  return [
    `【角色卡已更新 · 桥接提供】管理员更新了你的角色卡${label}。下面是新的完整角色卡：从现在起说话以它为准，之前读到的旧版角色卡作废；群规则和你的记忆不变，本次不用再调用 qq_get_prompt 读卡。不要在聊天里提起换卡这件事。`,
    '〔角色卡开始〕',
    card,
    '〔角色卡结束〕',
  ].join('\n');
}

function normalizeEntries(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw)) {
    if (!/^(group|private):\d+$/.test(key) || !v || typeof v !== 'object') continue;
    const sessionId = String(v.sessionId ?? '');
    const fp = String(v.fp ?? '');
    if (!sessionId || !/^[0-9a-f]{16}$/.test(fp)) continue;
    out[key] = { sessionId, fp, at: Number(v.at) || 0 };
  }
  return out;
}

/**
 * 每个 QQ 会话最后读到的角色卡版本（持久化，0600）。
 * @param {{ file: string, now?: () => number, onError?: (e: Error) => void }} opts
 */
export function createRoleRefreshTracker({ file, now = Date.now, onError = () => {} } = {}) {
  let entries = {};
  try {
    entries = normalizeEntries(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') onError(error);
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      onError(error);
    }
  }
  return {
    /** 这个会话还没读到这一版卡（没有记录 / 会话换了 / 指纹变了）。 */
    needsRefresh(key, sessionId, fp) {
      if (!sessionId) return false;
      const rec = entries[key];
      return !rec || rec.sessionId !== String(sessionId) || rec.fp !== fp;
    },
    /** 记下：这个会话已经读到这一版卡。 */
    markSeen(key, sessionId, fp) {
      if (!/^(group|private):\d+$/.test(String(key)) || !sessionId || !/^[0-9a-f]{16}$/.test(String(fp))) return;
      const rec = entries[key];
      if (rec && rec.sessionId === String(sessionId) && rec.fp === fp) return;
      entries[key] = { sessionId: String(sessionId), fp, at: now() };
      save();
    },
    /** 从一组会话里挑出还没读到这一版卡的（控制台「立即」用）。sessions = { key: sessionId }。 */
    stale(sessions, fp) {
      return Object.entries(sessions ?? {})
        .filter(([key, sid]) => this.needsRefresh(key, sid, fp))
        .map(([key]) => key);
    },
    get(key) { return entries[key] ? { ...entries[key] } : null; },
    size: () => Object.keys(entries).length,
  };
}
