// 管理员私聊命令 /remind：由桥接解析执行，不交给模型。默认发给管理员自己的私聊。
//
//   /remind                         帮助
//   /remind list                    列出任务
//   /remind del 3 | on 3 | off 3 | run 3
//   /remind add daily 06:00[,22:00] 早上好
//   /remind add once 2026-10-22 09:00 交报告
//   /remind add in 30m|2h|1d 喝水
//   /remind add weekly 1,3,5 08:00 健身
//   /remind add workdays 18:00 下班打卡
//   /remind add monthly 1,15,-1 20:00 交房租          （-1 = 每月最后一天）
//   /remind add random 3 09:00-22:00 ai 随便跟我聊一句
// 内容前加 ai 表示「叫 AI 来说」，否则是固定文字。

import { fmtDate, fmtTime, zonedParts } from './time.js';

export const REMIND_HELP = [
  '定时任务（只有你能用，桥接直接处理）：',
  '/remind list —— 列出任务',
  '/remind add daily 06:00 早上好',
  '/remind add once 2026-10-22 09:00 交报告',
  '/remind add in 30m 喝水（m 分钟 / h 小时 / d 天）',
  '/remind add weekly 1,3,5 08:00 健身（1=周一）',
  '/remind add workdays 18:00 下班打卡',
  '/remind add monthly 1,15,-1 20:00 交房租（-1=最后一天）',
  '/remind add random 3 09:00-22:00 ai 随便跟我聊一句',
  '内容前加 ai = 叫 AI 来说；不加 = 固定文字。默认发给你的私聊，发到群请用控制台。',
  '/remind del 3 · /remind on 3 · /remind off 3 · /remind run 3（立即试一次）',
].join('\n');

const TIME_LIST = /^\d{1,2}:\d{2}(,\d{1,2}:\d{2})*$/;

function body(rest) {
  const m = /^ai\s+([\s\S]+)$/i.exec(rest.trim());
  return m ? { kind: 'ai', instruction: m[1].trim() } : { kind: 'text', text: rest.trim() };
}

/**
 * 解析 /remind 命令。不是 /remind 返回 null；格式错返回 { error }。
 * @param {string} text
 * @param {{ now: number, tz: string }} ctx 用于把「in 30m」换算成具体时刻
 */
export function parseRemindCommand(text, { now = Date.now(), tz = 'Asia/Shanghai' } = {}) {
  const raw = String(text ?? '').trim();
  const m = /^\/(remind|提醒|定时)(?:\s+([\s\S]*))?$/i.exec(raw);
  if (!m) return null;
  const args = (m[2] ?? '').trim();
  if (!args || /^(help|帮助)$/i.test(args)) return { action: 'help' };
  const [verb, ...restParts] = args.split(/\s+/);
  const v = verb.toLowerCase();
  if (['list', 'ls', '列表'].includes(v)) return { action: 'list' };
  if (['del', 'rm', 'delete', '删除', 'on', 'off', 'run'].includes(v)) {
    const id = Number(restParts[0]);
    if (!Number.isInteger(id) || id <= 0) return { error: `要写任务编号，例如 /remind ${v} 3` };
    const action = { del: 'delete', rm: 'delete', delete: 'delete', 删除: 'delete', on: 'enable', off: 'disable', run: 'run' }[v];
    return { action, id };
  }
  if (!['add', '加', '新建'].includes(v)) return { error: `不认识的子命令「${verb}」。发 /remind 看用法` };
  const tokens = restParts;
  const type = (tokens[0] ?? '').toLowerCase();
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };
  try {
    let schedule; let rest;
    switch (type) {
      case 'daily':
      case 'workdays':
        need(TIME_LIST.test(tokens[1] ?? ''), `时间写成 06:00（多个用逗号），例如 /remind add ${type} 06:00 早上好`);
        schedule = { type, times: tokens[1].split(',') }; rest = tokens.slice(2).join(' '); break;
      case 'once':
        need(/^\d{4}-\d{2}-\d{2}$/.test(tokens[1] ?? '') && /^\d{1,2}:\d{2}$/.test(tokens[2] ?? ''), '写成 /remind add once 2026-10-22 09:00 内容');
        schedule = { type: 'once', date: tokens[1], time: tokens[2] }; rest = tokens.slice(3).join(' '); break;
      case 'in': {
        const d = /^(\d+)(m|h|d)$/i.exec(tokens[1] ?? '');
        need(d, '写成 /remind add in 30m 内容（m 分钟 / h 小时 / d 天）');
        const ms = Number(d[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[d[2].toLowerCase()];
        need(ms >= 60_000 && ms <= 400 * 86_400_000, '时间要在 1 分钟到 400 天之间');
        const p = zonedParts(now + ms, tz);
        schedule = { type: 'once', date: fmtDate(p), time: fmtTime(p) }; rest = tokens.slice(2).join(' '); break;
      }
      case 'weekly':
        need(/^[1-7](,[1-7])*$/.test(tokens[1] ?? '') && TIME_LIST.test(tokens[2] ?? ''), '写成 /remind add weekly 1,3,5 08:00 内容（1=周一）');
        schedule = { type: 'weekly', weekdays: tokens[1].split(',').map(Number), times: tokens[2].split(',') }; rest = tokens.slice(3).join(' '); break;
      case 'monthly':
        need(/^-?\d{1,2}(,-?\d{1,2})*$/.test(tokens[1] ?? '') && TIME_LIST.test(tokens[2] ?? ''), '写成 /remind add monthly 1,15,-1 20:00 内容（-1=最后一天）');
        schedule = { type: 'monthly', days: tokens[1].split(',').map(Number), times: tokens[2].split(',') }; rest = tokens.slice(3).join(' '); break;
      case 'random': {
        const w = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(tokens[2] ?? '');
        need(/^\d+$/.test(tokens[1] ?? '') && w, '写成 /remind add random 3 09:00-22:00 内容');
        schedule = { type: 'dailyRandom', count: Number(tokens[1]), window: [w[1], w[2]], minGapMin: 60 }; rest = tokens.slice(3).join(' '); break;
      }
      default:
        return { error: `不认识的重复方式「${tokens[0] ?? ''}」。发 /remind 看用法` };
    }
    const content = body(rest);
    if (!(content.text || content.instruction)) return { error: '最后要写上要发的内容' };
    return { action: 'add', task: { name: (content.text || content.instruction).slice(0, 20), schedule, ...content } };
  } catch (error) {
    return { error: error.message };
  }
}

/** /remind list 的回复。 */
export function formatTaskList(tasks) {
  if (!tasks.length) return '还没有定时任务。发 /remind 看怎么添加，或者在控制台的「定时任务」页面添加。';
  return ['定时任务：', ...tasks.map((t) => {
    const state = t.pendingConfirm ? '待你确认' : (t.enabled ? '启用' : '暂停');
    const what = t.kind === 'ai' ? `叫 AI：${t.instruction}` : `文字：${t.text}`;
    return `#${t.id} [${state}] ${t.scheduleText} → ${what.slice(0, 40)}${t.nextRunText ? `；下次 ${t.nextRunText}` : ''}`;
  })].join('\n');
}
