// 搜图并发送（管理员私聊专用，默认关闭）：「找一张 xxx 的图发我」。
//
// 流程（三个工具，桥接把关）：
//   1. qq_search_images(query)：桥接去 Bing 图片搜索（严格安全搜索），只把候选的「编号 + 标题 + 来源网站」给 AI；
//      原图地址只留在桥接里，AI 拿不到、也不能自己填网址或本地路径。
//   2. qq_preview_image(n)：桥接下载这张候选的缩略图交给 AI 看（要求当前模型能看图），并记下「看过」。
//   3. qq_send_web_image(n)：只能发**本次搜索里看过的**候选；桥接用安全下载（DNS 固定、逐跳校验、只连公网、
//      限大小与像素、校验文件头）取原图，失败时退回缩略图，再按图片消息发出。
// 只放行管理员私聊、二代仿真、带会话令牌的调用；搜索与发送各有每小时上限。
// 搜索词会发给 Bing（与 web_search 一样，属于数据出机）。

export const IMAGE_QUERY_MAX = 50;
export const IMAGE_CANDIDATES_MAX = 8;
export const IMAGE_CANDIDATE_TTL_MS = 15 * 60_000;
export const IMAGE_SEARCH_PER_HOUR = 20;
export const IMAGE_SEND_PER_HOUR = 10;
export const IMAGE_PREVIEW_MAX_BYTES = 3 * 1024 * 1024;
export const IMAGE_SEND_MAX_BYTES = 10 * 1024 * 1024;

/** 清洗搜索词：单行、去控制字符、限长；空串返回 ''。 */
export function cleanImageQuery(q) {
  return Array.from(String(q ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, IMAGE_QUERY_MAX).join('');
}

/** Bing 图片搜索地址（adlt=strict：严格安全搜索）。 */
export function bingImageUrl(query) {
  const u = new URL('https://cn.bing.com/images/search');
  u.searchParams.set('q', query);
  u.searchParams.set('form', 'HDRSC2');
  u.searchParams.set('first', '1');
  u.searchParams.set('adlt', 'strict');
  return u.toString();
}

/**
 * 依次尝试的搜索地址。实测 Bing 的结果页不稳定：有时跳到 www.bing.com 后返回不带结果的「骨架页」（结果靠脚本再异步加载），
 * 同一个词前后两次也可能一次有一次没有；异步接口 /images/async 大多能直接拿到结果，但个别词也会返回空。
 * 所以按顺序试：普通结果页 → 异步接口 → 换 www.bing.com 的普通结果页，拿到候选就停。
 */
export function bingImageUrls(query) {
  const asyncUrl = new URL('https://www.bing.com/images/async');
  asyncUrl.searchParams.set('q', query);
  asyncUrl.searchParams.set('first', '0');
  asyncUrl.searchParams.set('count', '35');
  asyncUrl.searchParams.set('adlt', 'strict');
  asyncUrl.searchParams.set('mmasync', '1');
  const www = new URL(bingImageUrl(query));
  www.hostname = 'www.bing.com';
  return [bingImageUrl(query), asyncUrl.toString(), www.toString()];
}

/** 搜图：按 bingImageUrls 的顺序试，fetchText(url) 返回页面文字。返回 { list, tried }。 */
export async function searchBingImages(query, fetchText, max = IMAGE_CANDIDATES_MAX) {
  let tried = 0;
  let lastError = null;
  for (const url of bingImageUrls(query)) {
    tried += 1;
    try {
      const list = parseBingImages(await fetchText(url), max);
      if (list.length) return { list, tried };
    } catch (error) {
      lastError = error;
    }
  }
  // 全都没有候选：其中有网络错误就带上它（调用方报「搜图失败」），否则返回空列表（「没搜到」）
  return { list: [], tried, error: lastError };
}

const unescapeHtml = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const httpUrl = (s) => {
  try {
    const u = new URL(String(s ?? ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
};

const oneLine = (s, max) => Array.from(String(s ?? '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('');

/** 解析 Bing 图片搜索结果页：每张候选在 class="iusc" 的 m 属性里（HTML 转义过的 JSON）。 */
export function parseBingImages(html, max = IMAGE_CANDIDATES_MAX) {
  const out = [];
  const seen = new Set();
  for (const m of String(html ?? '').matchAll(/class="iusc"[^>]*?\sm="([^"]+)"/g)) {
    let j;
    try { j = JSON.parse(unescapeHtml(m[1])); } catch { continue; }
    const imageUrl = httpUrl(j.murl);
    const thumbUrl = httpUrl(j.turl);
    if (!imageUrl && !thumbUrl) continue;
    // Bing 把被判为不适宜的缩略图放在 *.explicit.bing.net：直接丢掉
    if (/\bexplicit\.bing\.net$/i.test(thumbUrl ? new URL(thumbUrl).hostname : '')) continue;
    const dedupe = imageUrl || thumbUrl;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    let site = '';
    try { site = new URL(httpUrl(j.purl) || imageUrl || thumbUrl).hostname.replace(/^www\./, ''); } catch {}
    out.push({ imageUrl, thumbUrl, pageUrl: httpUrl(j.purl), title: oneLine(j.t, 40) || '（无标题）', site });
    if (out.length >= max) break;
  }
  return out;
}

/** 给 AI 看的候选列表（不含任何网址）。 */
export function imageCandidatesText(query, list) {
  if (!list.length) return `没有搜到「${query}」的可用图片（或都被安全搜索过滤了）。可以换个说法再搜。`;
  return [
    `「${query}」的图片候选（共 ${list.length} 张）：`,
    ...list.map((c) => `${c.n}. ${c.title}（来源：${c.site || '未知'}）`),
    '想发哪张，先用 qq_preview_image 看一眼，确认内容对、合适，再用 qq_send_web_image 发；看着不对就换一张或换个词重搜。',
  ].join('\n');
}

/** 每个会话最近一次搜索的候选（带编号、过期时间、看过的标记）。 */
export function createImageCandidateStore({ ttlMs = IMAGE_CANDIDATE_TTL_MS, now = Date.now } = {}) {
  const map = new Map();
  const live = (key) => {
    const v = map.get(key);
    if (!v) return null;
    if (now() - v.at > ttlMs) { map.delete(key); return null; }
    return v;
  };
  return {
    set(key, query, items) {
      const list = items.map((c, i) => ({ ...c, n: i + 1, previewed: false }));
      map.set(key, { query, at: now(), list });
      return list;
    },
    get(key, n) {
      const v = live(key);
      return v?.list.find((c) => c.n === Number(n)) ?? null;
    },
    markPreviewed(key, n) {
      const c = this.get(key, n);
      if (c) c.previewed = true;
      return !!c;
    },
    query: (key) => live(key)?.query ?? null,
    clear: (key) => map.delete(key),
  };
}

/** 简单的每小时次数限制。 */
export function createImageHourlyLimiter(limit, { now = Date.now } = {}) {
  const times = new Map();
  return {
    /** 能用就记一次并返回 ''；超了返回原因。 */
    take(key) {
      const t = now();
      const arr = (times.get(key) ?? []).filter((x) => t - x < 3600_000);
      if (arr.length >= limit) { times.set(key, arr); return `每小时最多 ${limit} 次，请稍后再试`; }
      arr.push(t);
      times.set(key, arr);
      return '';
    },
  };
}
