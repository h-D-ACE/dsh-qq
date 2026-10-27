// 会话令牌「抄错了」的识别与恢复。
//
// 背景（实测）：二代仿真里 AI 调用工具要把唤醒提示里的【会话令牌】（48 位十六进制）原样带上。
// 群 A 的 AI 有一次把其中一位抄错（6 → 1），之后一直照着自己写过的那份错版本抄，
// 工具调用全被「令牌无效」拒绝，持续了将近两天；它在内部输出里提到令牌，又触发了审计拦截。
//
// 这里做三件事（都不放宽校验：抄错的令牌照样拒绝）：
// 1. 识别「只差一两位」的近似令牌 → 返回明确提示（不泄露正确令牌）；
// 2. 记下是哪个会话在抄错 → 下一次唤醒在提示最前面加【令牌提醒】，让它从本条提示逐字复制；
// 3. 短时间内连错几次 → 换一个全新的令牌（新旧完全不同，断掉「照着错版本抄」的循环）。
// 换令牌只影响工具调用的授权，不动 DSH 会话、不动任何记忆。

/** 判定为「抄错」的最大不同位数（48 位里差 1～2 位；再多就当成完全不对）。 */
export const NEAR_MAX_DIST = 2;
/** 连错几次就换新令牌。 */
export const ROTATE_AFTER = 3;
/** 「连错」的统计窗口。 */
export const MISS_WINDOW_MS = 30 * 60_000;

/** 等长字符串的不同位数；不等长返回 Infinity。 */
export function hamming(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (!x || x.length !== y.length) return Infinity;
  let d = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) d += 1;
  return d;
}

/**
 * 在当前各会话的令牌里找「只差一两位」的那个。entries：[{ key, token }]。
 * 只有唯一命中时才返回（两个会话都很接近时不猜）。
 */
export function findNearToken(token, entries, maxDist = NEAR_MAX_DIST) {
  const hits = [];
  for (const e of entries ?? []) {
    const d = hamming(token, e?.token);
    if (d >= 1 && d <= maxDist) hits.push({ key: e.key, dist: d });
  }
  return hits.length === 1 ? hits[0] : null;
}

/** 返回给 AI 的错误提示（不含正确令牌）。 */
export function nearTokenError(dist) {
  return `未授权：会话令牌抄错了（和本会话的令牌有 ${dist} 位不一样）。请从最新一条唤醒提示的【会话令牌】逐字复制，不要沿用之前对话里写过的令牌。`;
}

/** 唤醒提示最前面的提醒。rotated：是否刚换过新令牌。 */
export function tokenNoticeBlock({ rotated = false } = {}) {
  return rotated
    ? '【令牌提醒 · 桥接提供】你之前调用工具时用的会话令牌抄错了，工具调用一直被拒绝；桥接已经给你换了一个**全新的**令牌，就在本条提示的【会话令牌】里。以后只从最新一条唤醒提示里逐字复制，不要再用之前写过的任何令牌。'
    : '【令牌提醒 · 桥接提供】你上次调用工具时用的会话令牌抄错了一位，所以被拒绝。正确的令牌就在本条提示的【会话令牌】里，请逐字复制这一条，不要沿用之前对话里写过的令牌。';
}

/** 每个会话的「抄错」计数与待提醒标记（只在内存里）。 */
export function createTokenMissTracker({ rotateAfter = ROTATE_AFTER, windowMs = MISS_WINDOW_MS, now = Date.now } = {}) {
  const misses = new Map();
  const notices = new Map();
  return {
    /** 记一次抄错；返回 { count, rotate }（rotate=true 表示该换新令牌了）。 */
    record(key) {
      const t = now();
      const arr = (misses.get(key) ?? []).filter((x) => t - x < windowMs);
      arr.push(t);
      misses.set(key, arr);
      if (!notices.has(key)) notices.set(key, { rotated: false });
      return { count: arr.length, rotate: arr.length >= rotateAfter };
    },
    /** 换过新令牌：计数清零，提醒改成「已换新」。 */
    rotated(key) {
      misses.delete(key);
      notices.set(key, { rotated: true });
    },
    /** 这个会话用对了令牌：计数清零（提醒保留到下一次唤醒送达）。 */
    ok(key) { misses.delete(key); },
    notice: (key) => notices.get(key) ?? null,
    clearNotice: (key) => notices.delete(key),
    count: (key) => (misses.get(key) ?? []).length,
  };
}
