// 按会话（群 / 私聊）分别设置人格卡。
//
// state/current-role.json 原来只有 { role, mode }，所有会话共用一张卡。现在加一个可选的 byKey：
//   { "role": "小鲸鱼", "mode": "active", "byKey": { "group:123": "傲娇助手", "group:456": null } }
// - 会话不在 byKey 里（或者老文件根本没有 byKey）→ 用全局 role，老状态文件原样可用，不用迁移；
// - byKey[key] 是人格名 → 这个会话用这张卡；
// - byKey[key] === null → 这个会话不挂任何角色卡（不是回落到全局）。
// mode（手动静默）仍然是全局的。
//
// 安全：
// - 这个文件用户可以直接编辑，读的时候一律重新校验：人格名只留中文 / 字母 / 数字 / 下划线 / 横线，
//   解析后的文件必须在 roles/ 目录里（防 {"role":"../.."} 这类路径穿越）；全局 role 和 byKey 的值走同一条校验；
// - 键只接受规范化的 group:<正整数> / private:<正整数>，去掉前导零，别名（group:0123）和非法键一律忽略；
// - 只有桥接代码（控制台、管理员的 /role 命令）写这个文件，AI 没有任何能改人格的工具。

import path from 'node:path';

/** byKey 最多记这么多会话，防止被手改的文件撑爆。 */
export const ROLE_BY_KEY_MAX = 500;

/** 会话 key 规范化：只接受 group:正整数 / private:正整数，去掉前导零。不合法返回 null。 */
export function canonicalConversationKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

/** 人格名清洗：只留中文 / 字母 / 数字 / 下划线 / 横线；清洗后为空返回 null。 */
export function safeRoleName(name) {
  if (typeof name !== 'string') return null;
  const s = name.replace(/[^\w一-鿿-]/g, '');
  if (!s || s.includes('..')) return null;
  return s;
}

/** 人格名 → roles/ 目录里的文件路径；名字不合法或解析到目录外返回 null（不检查文件是否存在）。 */
export function resolveRoleFile(rolesDir, name) {
  const safe = safeRoleName(name);
  if (!safe) return null;
  const base = path.resolve(rolesDir);
  const resolved = path.resolve(base, `${safe}.md`);
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

/** 读到的角色状态规范化：{ role: 名字|null, mode: 'active'|'silent', byKey: { key: 名字|null } }。 */
export function normalizeRoleState(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const byKey = {};
  const src = r.byKey && typeof r.byKey === 'object' && !Array.isArray(r.byKey) ? r.byKey : {};
  for (const [k, v] of Object.entries(src)) {
    if (Object.keys(byKey).length >= ROLE_BY_KEY_MAX) break;
    const key = canonicalConversationKey(k);
    if (!key) continue;
    if (v === null) { byKey[key] = null; continue; }
    const name = safeRoleName(v);
    if (name) byKey[key] = name;
  }
  return { role: safeRoleName(r.role), mode: r.mode === 'silent' ? 'silent' : 'active', byKey };
}

/** 写盘用：没有 byKey 时不写这个字段，保持老格式。 */
export function serializeRoleState(state) {
  const s = normalizeRoleState(state);
  const out = { role: s.role, mode: s.mode };
  if (Object.keys(s.byKey).length) out.byKey = s.byKey;
  return out;
}

/** 这个会话的设置来源：'key'（单独指定了卡）/ 'off'（单独关掉）/ 'global'（跟全局）。 */
export function roleSourceFor(state, key) {
  const k = canonicalConversationKey(key);
  const byKey = state?.byKey ?? {};
  if (!k || !Object.hasOwn(byKey, k)) return 'global';
  return byKey[k] === null ? 'off' : 'key';
}

/** 这个会话实际用哪张卡（null = 不挂卡）。key 不合法或没传时用全局。 */
export function roleNameFor(state, key) {
  const k = canonicalConversationKey(key);
  const byKey = state?.byKey ?? {};
  if (k && Object.hasOwn(byKey, k)) return byKey[k];
  return state?.role ?? null;
}

/**
 * 给一个会话设卡，返回新状态（不改原对象）。
 * @param {'default'|'off'|'role'} use default = 跟全局；off = 不挂卡；role = 用 name 这张卡
 */
export function withRoleForKey(state, key, use, name = null) {
  const k = canonicalConversationKey(key);
  if (!k) throw new Error('会话格式应为 group:群号 或 private:QQ号');
  const s = normalizeRoleState(state);
  const byKey = { ...s.byKey };
  if (use === 'default') delete byKey[k];
  else if (use === 'off') byKey[k] = null;
  else if (use === 'role') {
    const n = safeRoleName(name);
    if (!n) throw new Error('人格名不合法');
    byKey[k] = n;
  } else throw new Error('use 只能是 default / off / role');
  if (!Object.hasOwn(s.byKey, k) && Object.keys(byKey).length > ROLE_BY_KEY_MAX) throw new Error(`单独设置人格的会话最多 ${ROLE_BY_KEY_MAX} 个`);
  return { ...s, byKey };
}

/** 人格改名：全局和各会话里引用旧名的都跟着改。返回 { state, changedKeys }。 */
export function renameRoleEverywhere(state, from, to) {
  const s = normalizeRoleState(state);
  const changedKeys = [];
  const byKey = {};
  for (const [k, v] of Object.entries(s.byKey)) {
    if (v === from) { byKey[k] = to; changedKeys.push(k); } else byKey[k] = v;
  }
  return { state: { ...s, role: s.role === from ? to : s.role, byKey }, globalChanged: s.role === from, changedKeys };
}

/**
 * 人格被删：全局用它的清空；单独指定它的会话改成「不挂卡」（和全局被删时的行为一致，
 * 不会突然换成全局那张别的卡）。返回 { state, globalCleared, changedKeys }。
 */
export function removeRoleEverywhere(state, name) {
  const s = normalizeRoleState(state);
  const changedKeys = [];
  const byKey = {};
  for (const [k, v] of Object.entries(s.byKey)) {
    if (v === name) { byKey[k] = null; changedKeys.push(k); } else byKey[k] = v;
  }
  return { state: { ...s, role: s.role === name ? null : s.role, byKey }, globalCleared: s.role === name, changedKeys };
}

/** 有没有会话在用这张卡：全局是它，或者有会话单独指定了它（keys 是已知会话，用来判断跟全局的会话）。 */
export function roleInUse(state, name, keys = []) {
  if (!name) return false;
  if (state?.role === name) return true;
  if (Object.values(state?.byKey ?? {}).includes(name)) return true;
  return keys.some((k) => roleNameFor(state, k) === name);
}

/**
 * 控制台「按会话设置」列表：已知会话（有 DSH 会话的 + byKey 里有的）各用哪张卡。
 * @param {object} state 规范化后的角色状态
 * @param {string[]} keys 已知会话
 * @param {(name: string) => boolean} exists 人格文件是否存在
 */
export function roleAssignments(state, keys, exists = () => true) {
  const all = new Set();
  for (const k of [...(keys ?? []), ...Object.keys(state?.byKey ?? {})]) {
    const c = canonicalConversationKey(k);
    if (c) all.add(c);
  }
  return [...all].sort().map((key) => {
    const source = roleSourceFor(state, key);
    const role = roleNameFor(state, key);
    return { key, source, role, missing: !!role && !exists(role) };
  });
}
