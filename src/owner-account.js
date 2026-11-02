// 管理员私聊里的「账号门面」操作：QQ 空间（说说 / 评论 / 点赞 / 读动态）、个性签名、昵称、在线状态、正在输入。
//
// 来自 PR #4（qjjer）的功能，按项目的安全约定重做：
// - 认人由桥接做：工具调用必须带会话令牌，桥接用令牌确定真实会话，只有管理员本人的私聊会话能用；
//   群聊会话里不管谁怎么要求都会被拒（原 PR 只检查模型自己填的 key，可以被冒充）。本模块不碰这一层，
//   只提供纯逻辑，判定在 bridge.js 的 /api/socialV2/account。
// - 别人看得到、会长期留着的操作（发说说、删说说、评论、改签名、改昵称）默认要管理员回复确认码；
//   「你叫它做」和「它主动做」各有一个开关，可分别设成免确认。
// - 每日次数上限、操作记录；改签名 / 昵称前存下旧值，控制台一键改回；评论删不掉，确认后再等一段时间才真正发出，期间可撤销。
// - 可选「账号门面人格」：说说 / 评论 / 签名 / 昵称按指定人格卡改写（由桥接的专用写作会话完成）。
//
// 本模块只做校验、确认码、额度、记录这些纯逻辑和状态文件，不发网络请求。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 每个动作：用哪个工具开关、对应的 OneBot 动作、是否需要确认（可配置）、是否有正文可改写、额度键。 */
export const ACCOUNT_ACTIONS = {
  post:         { flag: 'qzonePost',       label: '发说说',     confirmable: true,  rewrite: 'content',   quota: 'post' },
  deletePost:   { flag: 'qzonePost',       label: '删说说',     confirmable: true,  rewrite: null,        quota: 'deletePost' },
  comment:      { flag: 'qzoneComment',    label: '评论说说',   confirmable: true,  rewrite: 'content',   quota: 'comment' },
  like:         { flag: 'qzoneLike',       label: '点赞说说',   confirmable: false, rewrite: null,        quota: 'like' },
  list:         { flag: 'qzoneRead',       label: '读自己的说说', confirmable: false, rewrite: null,      quota: null },
  feeds:        { flag: 'qzoneRead',       label: '读空间动态', confirmable: false, rewrite: null,        quota: null },
  profile:      { flag: 'qzoneRead',       label: '读自己的资料', confirmable: false, rewrite: null,      quota: null },
  signature:    { flag: 'setSignature',    label: '改个性签名', confirmable: true,  rewrite: 'signature', quota: 'signature' },
  nickname:     { flag: 'setNickname',     label: '改昵称',     confirmable: true,  rewrite: 'nickname',  quota: 'nickname' },
  onlineStatus: { flag: 'setOnlineStatus', label: '改在线状态', confirmable: false, rewrite: null,        quota: null },
  inputStatus:  { flag: 'setInputStatus',  label: '显示正在输入', confirmable: false, rewrite: null,      quota: null },
};

/** 这些工具开关默认全部关闭（bridge.js 的 socialV2.tools 默认表里也是 false）。 */
export const ACCOUNT_TOOL_FLAGS = ['qzonePost', 'qzoneComment', 'qzoneLike', 'qzoneRead', 'setSignature', 'setNickname', 'setOnlineStatus', 'setInputStatus'];

/** 开关 → 工具名（提示词里的「可用工具」列表用）。 */
export const ACCOUNT_TOOL_NAMES = {
  qzonePost: 'qq_qzone_post / qq_qzone_delete',
  qzoneComment: 'qq_qzone_comment',
  qzoneLike: 'qq_qzone_like',
  qzoneRead: 'qq_qzone_list / qq_qzone_feeds / qq_my_profile',
  setSignature: 'qq_set_signature',
  setNickname: 'qq_set_nickname',
  setOnlineStatus: 'qq_set_online_status',
  setInputStatus: 'qq_set_input_status',
};

export const CONFIRMABLE_ACTIONS = Object.keys(ACCOUNT_ACTIONS).filter((a) => ACCOUNT_ACTIONS[a].confirmable);

// 可见范围（对照 NapCat 4.18 send_qzone_msg 的实现核实）：注意 128 是「部分好友**不可见**」，不是「指定人可见」。
export const UGC_RIGHT_LABEL = { 1: '所有人可见', 4: '好友可见', 16: '部分好友可见', 64: '仅自己可见', 128: '部分好友不可见' };
export const UGC_RIGHTS = [1, 4, 16, 64, 128];

export const LIMITS = { postChars: 300, commentChars: 120, signatureChars: 80, nicknameChars: 24, maxImages: 9, maxTargets: 50 };

export const DEFAULT_ACCOUNT = Object.freeze({
  // 'follow' = 跟私聊当前的人格卡（不改写）；'global' = 全局默认人格；其它字符串 = 指定人格卡名
  persona: 'follow',
  // owner：你在私聊里叫它做时要不要确认；proactive：它自己主动（定时 / 主动冒泡 / 补收）时要不要确认
  confirm: Object.fromEntries(CONFIRMABLE_ACTIONS.map((a) => [a, { owner: true, proactive: true }])),
  limits: { post: 3, deletePost: 10, comment: 5, like: 30, signature: 5, nickname: 3 },
  commentDelaySeconds: 120,
  confirmTtlSeconds: 600,
  allowPublic: true,
  defaultUgcRight: 4,
});

const clampInt = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
};

/** 规范化 config.json 的 socialV2.account（缺省字段取默认值，非法值回落）。 */
export function normalizeAccountConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const persona = typeof r.persona === 'string' && r.persona.trim() ? r.persona.trim().slice(0, 64) : 'follow';
  const confirm = {};
  for (const a of CONFIRMABLE_ACTIONS) {
    const c = r.confirm?.[a] ?? {};
    confirm[a] = { owner: c.owner !== false, proactive: c.proactive !== false };
  }
  const limits = {};
  for (const [k, d] of Object.entries(DEFAULT_ACCOUNT.limits)) limits[k] = clampInt(r.limits?.[k], 0, 100, d);
  return {
    persona,
    confirm,
    limits,
    commentDelaySeconds: clampInt(r.commentDelaySeconds, 0, 600, DEFAULT_ACCOUNT.commentDelaySeconds),
    confirmTtlSeconds: clampInt(r.confirmTtlSeconds, 60, 3600, DEFAULT_ACCOUNT.confirmTtlSeconds),
    allowPublic: r.allowPublic !== false,
    defaultUgcRight: [1, 4, 64].includes(Number(r.defaultUgcRight)) ? Number(r.defaultUgcRight) : DEFAULT_ACCOUNT.defaultUgcRight,
  };
}

/** 这次要不要先问管理员。trigger：'owner'（这次唤醒由管理员本人的消息触发）或 'proactive'（其它一切）。 */
export function needsConfirm(action, trigger, acct) {
  if (!ACCOUNT_ACTIONS[action]?.confirmable) return false;
  const c = acct?.confirm?.[action] ?? { owner: true, proactive: true };
  return trigger === 'owner' ? c.owner !== false : c.proactive !== false;
}

const TID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UIN_RE = /^[1-9]\d{4,11}$/;

function str(v) { return String(v ?? '').trim(); }

/** 说说配图只收公网 https 图片地址：本机路径会让 QQ 后端读本机文件（可能把不该外传的文件发到空间）。 */
export function safeImageUrl(u) {
  let url;
  try { url = new URL(String(u)); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const h = url.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return false; // 不收 IP 字面量
  return true;
}

/**
 * 校验并规范化参数（不信任模型传参）。
 * @returns {{ ok: true, params: object, text: string } | { ok: false, error: string }}
 *   text 是要对外发布、需要审计 / 可改写的正文（没有正文时为 ''）。
 */
export function validateAccountAction(action, input = {}, acct = DEFAULT_ACCOUNT) {
  const p = input && typeof input === 'object' ? input : {};
  switch (action) {
    case 'post': {
      const content = str(p.content);
      if (!content) return { ok: false, error: '说说正文不能为空' };
      if (content.length > LIMITS.postChars) return { ok: false, error: `正文太长（${content.length} 字），上限 ${LIMITS.postChars} 字` };
      const images = Array.isArray(p.images) ? p.images.map(str).filter(Boolean) : [];
      if (images.length > LIMITS.maxImages) return { ok: false, error: `图片最多 ${LIMITS.maxImages} 张` };
      if (images.some((u) => !safeImageUrl(u))) return { ok: false, error: '配图只接受公网 https 图片地址（不接受本机路径、内网地址或 IP）' };
      const right = p.ugc_right == null ? acct.defaultUgcRight : Number(p.ugc_right);
      if (!UGC_RIGHTS.includes(right)) return { ok: false, error: 'ugc_right 只能是 1（所有人）/ 4（好友）/ 16（部分好友可见）/ 64（仅自己）/ 128（部分好友不可见）' };
      if (right === 1 && acct.allowPublic === false) return { ok: false, error: '配置不允许公开发布说说，请用 4（好友可见）' };
      const targets = Array.isArray(p.target_uins) ? p.target_uins.map(str) : [];
      if (right === 16 || right === 128) {
        if (!targets.length) return { ok: false, error: 'ugc_right 为 16（这些人可见）或 128（这些人不可见）时必须给出 target_uins' };
        if (targets.length > LIMITS.maxTargets || targets.some((t) => !UIN_RE.test(t))) return { ok: false, error: `target_uins 必须是 QQ 号，最多 ${LIMITS.maxTargets} 个` };
      }
      const params = { content, ugc_right: right };
      if (images.length) params.images = images;
      if (right === 16 || right === 128) params.target_uins = targets;
      return { ok: true, params, text: content };
    }
    case 'deletePost': {
      const tid = str(p.tid);
      if (!TID_RE.test(tid)) return { ok: false, error: 'tid 格式不对（从 qq_qzone_list 拿）' };
      return { ok: true, params: { tid }, text: '' };
    }
    case 'comment': {
      const tid = str(p.tid); const target = str(p.target_uin); const content = str(p.content);
      if (!TID_RE.test(tid)) return { ok: false, error: 'tid 格式不对（从 qq_qzone_feeds / qq_qzone_list 拿）' };
      if (!UIN_RE.test(target)) return { ok: false, error: 'target_uin 必须是 QQ 号' };
      if (!content) return { ok: false, error: '评论不能为空' };
      if (content.length > LIMITS.commentChars) return { ok: false, error: `评论太长（${content.length} 字），上限 ${LIMITS.commentChars} 字` };
      return { ok: true, params: { tid, target_uin: target, content }, text: content };
    }
    case 'like': {
      const tid = str(p.tid); const target = str(p.target_uin);
      if (!TID_RE.test(tid)) return { ok: false, error: 'tid 格式不对' };
      if (!UIN_RE.test(target)) return { ok: false, error: 'target_uin 必须是 QQ 号' };
      return { ok: true, params: { tid, target_uin: target, unlike: p.action === 'unlike' }, text: '' };
    }
    case 'list':
    case 'feeds':
      return { ok: true, params: { limit: clampInt(p.limit, 1, 30, 10) }, text: '' };
    case 'profile':
      return { ok: true, params: {}, text: '' };
    case 'signature': {
      const signature = str(p.signature);
      if (!signature) return { ok: false, error: '签名不能为空' };
      if (signature.length > LIMITS.signatureChars) return { ok: false, error: `签名太长（${signature.length} 字），上限 ${LIMITS.signatureChars} 字` };
      return { ok: true, params: { signature }, text: signature };
    }
    case 'nickname': {
      const nickname = str(p.nickname);
      if (!nickname) return { ok: false, error: '昵称不能为空' };
      if (nickname.length > LIMITS.nicknameChars) return { ok: false, error: `昵称太长（${nickname.length} 字），上限 ${LIMITS.nicknameChars} 字` };
      if (/[\r\n]/.test(nickname)) return { ok: false, error: '昵称不能换行' };
      return { ok: true, params: { nickname }, text: nickname };
    }
    case 'onlineStatus': {
      const status = Number(p.status);
      if (!Number.isInteger(status) || status < 1 || status > 100) return { ok: false, error: 'status 必须是状态码（如 10 在线 / 30 离开 / 40 隐身 / 50 忙碌）' };
      return { ok: true, params: { status, ext_status: clampInt(p.ext_status, 0, 100000, 0), battery_status: clampInt(p.battery_status, 0, 100, 0) }, text: '' };
    }
    case 'inputStatus':
      return { ok: true, params: { event_type: p.event_type === 0 ? 0 : 1 }, text: '' };
    default:
      return { ok: false, error: `未知操作：${String(action).slice(0, 32)}` };
  }
}

/** 改写后的正文放回参数里。 */
export function withRewrittenText(action, params, text) {
  const field = ACCOUNT_ACTIONS[action]?.rewrite;
  return field ? { ...params, [field]: text } : params;
}

/** 正文（审计 / 预览用）。 */
export function actionText(action, params) {
  const field = ACCOUNT_ACTIONS[action]?.rewrite;
  return field ? String(params?.[field] ?? '') : '';
}

/** 动作 → OneBot 调用（动作名沿用 PR #4，对应 NapCat 的扩展接口）。 */
export function onebotCallFor(action, params, { ownerQQ } = {}) {
  switch (action) {
    case 'post': return ['send_qzone_msg', params];
    case 'deletePost': return ['delete_qzone_msg', { tid: params.tid }];
    case 'comment': return ['comment_qzone', { tid: params.tid, target_uin: params.target_uin, content: params.content }];
    case 'like': return [params.unlike ? 'unlike_qzone' : 'like_qzone', { tid: params.tid, target_uin: params.target_uin }];
    case 'list': return ['get_qzone_msg_list', {}];
    case 'feeds': return ['get_qzone_feeds', {}];
    case 'signature': return ['set_self_longnick', { longNick: params.signature }];
    case 'nickname': return ['set_qq_profile', { nickname: params.nickname }];
    case 'onlineStatus': return ['set_online_status', params];
    // 「正在输入」只对管理员本人显示：对象由桥接定（就是这个私聊的对方），不收模型给的 user_id
    case 'inputStatus': return ['set_input_status', { user_id: String(ownerQQ), event_type: params.event_type }];
    default: return null;
  }
}

/** 预览（发给管理员确认用）。不带确认码以外的任何秘密。 */
export function describeAction(action, params) {
  const label = ACCOUNT_ACTIONS[action]?.label ?? action;
  switch (action) {
    case 'post': {
      // 16 / 128 要写明是哪些人，不然管理员看不出「部分好友」指谁
      const who = (params.ugc_right === 16 || params.ugc_right === 128) && params.target_uins?.length
        ? `：${params.target_uins.slice(0, 5).join('、')}${params.target_uins.length > 5 ? ` 等 ${params.target_uins.length} 人` : ''}`
        : '';
      return `${label}（${UGC_RIGHT_LABEL[params.ugc_right] ?? params.ugc_right}${who}${params.images?.length ? `，${params.images.length} 张图` : ''}）：${params.content}`;
    }
    case 'deletePost': return `${label}：tid ${params.tid}`;
    case 'comment': return `${label}（${params.target_uin} 的说说 ${params.tid}）：${params.content}`;
    case 'signature': return `${label}为：${params.signature}`;
    case 'nickname': return `${label}为：${params.nickname}`;
    default: return label;
  }
}

export function buildConfirmText({ action, params, code, ttlSeconds, trigger, draft = null }) {
  const lines = [`【账号操作待确认】AI 想${describeAction(action, params)}`];
  if (draft != null && draft !== actionText(action, params)) lines.push(`（按门面人格改写过，原稿：${draft}）`);
  lines.push(trigger === 'owner' ? '来源：你刚才在私聊里的要求。' : '来源：AI 自己主动发起（不是你刚发消息叫它做的）。');
  if (action === 'comment') lines.push('⚠️ 空间评论发出后没有接口能删，只能你自己在手机上删。');
  lines.push(`确认请回复「确认 ${code}」，不要请回复「取消 ${code}」；${Math.round(ttlSeconds / 60)} 分钟内有效。`);
  return lines.join('\n');
}

/** 管理员私聊里的回复：确认 / 取消（待确认），撤销（评论等待发出期间）。 */
export function parseAccountReply(text) {
  const m = /^\s*(确认|确定|取消|撤销|撤回)\s*(\d{6})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  return { verb: m[1] === '确认' || m[1] === '确定' ? 'confirm' : m[1] === '取消' ? 'cancel' : 'undo', code: m[2] };
}

/**
 * 待确认 / 等待发出的操作（只在内存里：桥接重启后全部作废，宁可让 AI 重新问，也不在重启后执行旧操作）。
 * @param {{ now?: () => number, maxPending?: number }} opts
 */
export function createPendingRegistry({ now = Date.now, maxPending = 5 } = {}) {
  const items = new Map(); // code → item
  function newCode() {
    for (let i = 0; i < 20; i += 1) {
      const c = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      if (!items.has(c)) return c;
    }
    throw new Error('确认码生成失败，请稍后再试');
  }
  function expire() {
    const t = now();
    for (const [c, it] of items) if (it.stage === 'confirm' && it.expiresAt <= t) items.delete(c);
  }
  return {
    /** 登记一条待确认操作，返回确认码。 */
    add(item, ttlMs) {
      expire();
      const pending = [...items.values()].filter((it) => it.stage === 'confirm').length;
      if (pending >= maxPending) throw new Error(`已有 ${pending} 条操作在等管理员确认，先等管理员处理`);
      const code = newCode();
      items.set(code, { ...item, code, stage: 'confirm', createdAt: now(), expiresAt: now() + ttlMs });
      return code;
    },
    /** 取出（并移除）一条待确认操作；过期或不存在返回 null。 */
    takeForConfirm(code) {
      expire();
      const it = items.get(code);
      if (!it || it.stage !== 'confirm') return null;
      items.delete(code);
      return it;
    },
    /** 登记一条「等待发出」的操作（评论的撤销窗口）。 */
    hold(code, item, timer) { items.set(code, { ...item, code, stage: 'hold', timer }); },
    /** 撤销等待发出的操作；返回被撤销的那条或 null。 */
    undo(code) {
      const it = items.get(code);
      if (!it || it.stage !== 'hold') return null;
      items.delete(code);
      return it;
    },
    /** 等待结束、真正发出前移除。 */
    release(code) { const it = items.get(code); if (it?.stage === 'hold') items.delete(code); return it ?? null; },
    has(code) { expire(); return items.has(code); },
    newCode,
    list() { expire(); return [...items.values()].map(({ timer, ...rest }) => rest); },
    size() { expire(); return items.size; },
  };
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}

/**
 * 每日额度（按配置时区的日历日，dayOf(ms) 返回 'YYYY-MM-DD'）。
 * @param {{ file: string, now?: () => number, dayOf: (ms: number) => string, onError?: (e: Error) => void }} opts
 */
export function createAccountQuota({ file, now = Date.now, dayOf, onError = () => {} }) {
  function read() {
    const j = readJson(file, null);
    const day = dayOf(now());
    return j && j.day === day && j.counts && typeof j.counts === 'object' ? j : { day, counts: {} };
  }
  return {
    used(kind) { return Number(read().counts[kind]) || 0; },
    /** 还能不能做（limit 为 0 = 不允许）。 */
    allowed(kind, limit) { return this.used(kind) < limit; },
    bump(kind) {
      const q = read();
      q.counts[kind] = (Number(q.counts[kind]) || 0) + 1;
      try { writeJsonAtomic(file, q); } catch (error) { onError(error); }
      return q.counts[kind];
    },
    snapshot() { return read(); },
  };
}

/**
 * 操作记录（最近 200 条）：发了什么、发在哪、改之前是什么（签名 / 昵称用来一键改回）。
 * @param {{ file: string, now?: () => number, max?: number, onError?: (e: Error) => void }} opts
 */
export function createAccountHistory({ file, now = Date.now, max = 200, onError = () => {} }) {
  let items = (() => { const j = readJson(file, null); return Array.isArray(j?.items) ? j.items : []; })();
  let nextId = items.reduce((m, it) => Math.max(m, Number(it.id) || 0), 0) + 1;
  function save() { try { writeJsonAtomic(file, { items }); } catch (error) { onError(error); } }
  return {
    add(entry) {
      const it = { id: nextId++, at: now(), ...entry };
      items.push(it);
      if (items.length > max) items = items.slice(-max);
      save();
      return it;
    },
    update(id, patch) {
      const it = items.find((x) => x.id === id);
      if (it) { Object.assign(it, patch); save(); }
      return it ?? null;
    },
    get(id) { return items.find((x) => x.id === Number(id)) ?? null; },
    list(limit = 50) { return items.slice(-limit).reverse(); },
  };
}

/** 账号门面人格：要按哪张卡改写。返回卡名，或 null（不改写）。 */
export function resolveAccountPersona(setting, { privateRole = null, globalRole = null } = {}) {
  const s = String(setting ?? 'follow');
  const target = s === 'follow' ? privateRole : s === 'global' ? globalRole : s;
  if (!target || target === privateRole) return null;
  return target;
}

/** 写作会话的提示：只改语气，不改意思；只输出正文。 */
export function buildRewritePrompt({ action, draft, card, roleName, maxChars }) {
  const what = { post: 'QQ 空间说说', comment: 'QQ 空间评论', signature: 'QQ 个性签名', nickname: 'QQ 昵称' }[action] ?? '文字';
  return [
    `你是一个改写助手。下面是一段准备发布的${what}草稿，请按【人格卡】里这个角色的口吻和说话习惯改写。`,
    '规则：只改语气和措辞，不改意思、不增删事实、不加新的人名或链接；不提「AI」「模型」「改写」；',
    `只输出改写后的正文本身，不要引号、解释或前后缀；最多 ${maxChars} 个字${action === 'nickname' ? '，不能换行' : ''}。`,
    `【人格卡：${roleName}】`,
    String(card ?? '').slice(0, 6000),
    '【人格卡结束】',
    '【草稿】',
    String(draft ?? ''),
    '【草稿结束】',
  ].join('\n');
}

/** 清理写作会话的输出：去掉常见的引号 / 前缀，超长或为空返回 null（调用方回落到原稿）。 */
export function cleanRewriteOutput(text, maxChars) {
  let s = String(text ?? '').trim();
  s = s.replace(/^(改写后[:：]?|正文[:：]?)\s*/u, '').trim();
  s = s.replace(/^[「“"'](.*)[」”"']$/su, '$1').trim();
  if (!s || s.length > maxChars) return null;
  return s;
}
