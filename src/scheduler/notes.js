// 「叫 AI 来说」的定时任务到点时，交给目标会话的那段说明。
// 和管理员托付一样：任何原因的唤醒都会带上它（唤醒原因可能在合并窗口里被升级成「私聊」等），
// 在最终投递时才取走；过期（默认 30 分钟没投出去）就丢弃，不会隔很久再冒出来。

export function createScheduledNoteStore({ now = Date.now, ttlMs = 30 * 60_000, maxPerKey = 5 } = {}) {
  const notes = new Map(); // key -> [{ taskId, name, instruction, whenText, expiresAt }]
  const alive = (key) => {
    const list = (notes.get(key) ?? []).filter((n) => n.expiresAt > now());
    if (list.length) notes.set(key, list); else notes.delete(key);
    return list;
  };
  return {
    add(key, note) {
      const list = alive(key).filter((n) => n.taskId !== note.taskId);
      list.push({ ...note, expiresAt: now() + ttlMs });
      notes.set(key, list.slice(-maxPerKey));
    },
    peek: (key) => alive(key),
    take(key) { const list = alive(key); notes.delete(key); return list; },
    size: () => notes.size,
  };
}

/** 注入唤醒提示词末尾的块（来自管理员的登记，不是群友消息）。 */
export function scheduledPromptBlock(items) {
  if (!items.length) return '';
  const lines = items.map((x) => `#${x.taskId}「${x.name}」（${x.whenText}）：${x.instruction}`);
  return `【定时任务】（管理员事先登记、桥接到点转交；不是群友消息）\n${lines.join('\n')}\n`
    + '请用发送工具，按此刻会话里的气氛用你自己的话完成；不要说「这是定时任务」「管理员让我发的」，也不要发送会话令牌。'
    + '如果此刻明显不合适（比如大家在吵架、在聊很严肃的事），可以晚一点或这次不做，安静收尾即可。\n';
}

/** 非二代模式（聊天 / agent）直接投递的提示词。 */
export function scheduledDirectPrompt(note) {
  return `【定时任务 · 桥接提供】管理员事先登记的定时任务 #${note.taskId}「${note.name}」到点了（${note.whenText}）。\n要你做的事：${note.instruction}\n`
    + '请直接回复要发的内容（你的回复会发到这个会话里）；不要说「这是定时任务」，也不要提到会话令牌。';
}
