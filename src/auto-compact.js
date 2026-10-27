// QQ 会话上下文太长时自动压缩（DSH 的 /compact）。
//
// 背景（实测）：二代仿真的 QQ 会话一直不重建，历史越攒越长；每一步模型都要把整段历史重读一遍。
// 群 A 每一步要读 50～67 万 token：缓存命中率 99%，但光「命中缓存」一项就占了花费的三分之二。
// DSH 自带的自动压缩按模型上下文窗口的 80% 触发，deepseek-flash 的窗口很大，要到约 80 万 token 才压。
//
// 这里在桥接侧补一道更早的门槛：某个会话最近一步读的 token 超过阈值（默认 30 万），
// 就在这一轮结束、会话空闲后执行一次 /compact。DSH 会把较早的历史换成一条摘要，近期对话原样保留。
// 冷却：同一个会话两次自动压缩至少隔 2 小时（失败也算，避免反复重试）。
// 压缩后桥接会在下一次唤醒重新完整给出黑话表、表情块和角色卡（见 bridge.js 的 compactConversation）。

/**
 * 阈值能调的范围。上限 80 万：deepseek-flash 的窗口是 100 万，DSH 自己在约 80 万（窗口的 80%）时就会压缩，
 * 桥接的阈值再往上设也不会更晚——要「等 DSH 自己压」就直接关掉桥接的提前压缩（enabled=false）。
 */
export const COMPACT_THRESHOLD_MIN = 50_000;
export const COMPACT_THRESHOLD_MAX = 800_000;
/** DSH 自己大约在多少 token 时压缩（给控制台的说明用；实际以 DSH 按模型窗口算出来的为准）。 */
export const DSH_COMPACT_APPROX = 800_000;

export const COMPACT_DEFAULTS = Object.freeze({
  enabled: true,
  thresholdTokens: 300_000,
  cooldownMinutes: 120,
  idleDelayMs: 20_000,
});

/** 规范化 socialV2.compact 配置；非法值回到默认。 */
export function normalizeCompactConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, min, max, d) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : d);
  return {
    enabled: c.enabled !== false,
    thresholdTokens: Math.round(num(c.thresholdTokens, COMPACT_THRESHOLD_MIN, COMPACT_THRESHOLD_MAX, COMPACT_DEFAULTS.thresholdTokens)),
    cooldownMinutes: num(c.cooldownMinutes, 10, 24 * 60, COMPACT_DEFAULTS.cooldownMinutes),
    idleDelayMs: Math.round(num(c.idleDelayMs, 0, 600_000, COMPACT_DEFAULTS.idleDelayMs)),
  };
}

/** 一步读了多少 token（命中 + 未命中 + 写缓存）。usage 是归一化后的桶。 */
export function inputTokensOf(b) {
  if (!b || typeof b !== 'object') return 0;
  return (Number(b.cacheHit) || 0) + (Number(b.cacheMiss) || 0) + (Number(b.cacheWrite) || 0);
}

/**
 * 要不要压缩。
 * @returns {{ compact: boolean, reason: string }}
 */
export function decideCompact({ inputTokens, lastAttemptAt = 0, now = Date.now(), config }) {
  const c = normalizeCompactConfig(config);
  if (!c.enabled) return { compact: false, reason: '自动压缩已关闭' };
  if (!(inputTokens > c.thresholdTokens)) return { compact: false, reason: '没超过阈值' };
  if (lastAttemptAt && now - lastAttemptAt < c.cooldownMinutes * 60_000) return { compact: false, reason: '冷却中' };
  return { compact: true, reason: `上一步读了 ${Math.round(inputTokens / 1000)}k token（阈值 ${Math.round(c.thresholdTokens / 1000)}k）` };
}

/**
 * 控制台改压缩设置。mode = 'early'（桥接提前压缩，thresholdWan 万 token）或 'dsh'（交给 DSH 自己压，约 80 万）。
 * 不合法抛 Error（给人看的原因）。返回要写进 config.json 的 socialV2.compact。
 */
export function compactConfigFromConsole(current, { mode, thresholdWan } = {}) {
  const base = normalizeCompactConfig(current);
  if (mode === 'dsh') return { ...base, enabled: false };
  if (mode !== 'early') throw new Error('压缩方式只能是「提前压缩」或「交给 DSH」');
  const wan = Number(thresholdWan);
  const min = COMPACT_THRESHOLD_MIN / 10_000; const max = COMPACT_THRESHOLD_MAX / 10_000;
  if (!Number.isFinite(wan) || wan < min || wan > max) throw new Error(`压缩阈值要在 ${min}～${max} 万 token 之间（DSH 自己约 ${DSH_COMPACT_APPROX / 10_000} 万时就会压）`);
  return { ...base, enabled: true, thresholdTokens: Math.round(wan * 10_000) };
}
