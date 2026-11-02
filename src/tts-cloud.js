// QQ 语音 TTS（云）—— Microsoft Edge TTS（来自 PR #4，qjjer）
//
// ⚠️ 隐私：要念的文字会发给微软的服务器。所以这个功能默认关闭（socialV2.tools.speak），控制台开关旁写明了这一点。
// ⚠️ 这是逆向出来的非公开接口，随时可能失效。
// ⚠️ 版本要求：edge-tts ≥ 7.3.0。7.2.x 及更早会一直 403：微软把 SEC_MS_GEC_VERSION 从 "1-" 改成了 "2-"，
//    Sec-MS-GEC 也换成了改过初始状态的 SHA256（PR 作者实测：7.2.7 → 403；7.3.1 → 正常）。
//
// 调用方式：走 edge-tts 命令行（python -m edge_tts 或 edge-tts），不依赖 Python 绑定。
// 和原 PR 的区别：
// - 由桥接在校验会话令牌、审计文字之后才调用（原 PR 在 MCP 侧、令牌校验之前就合成）；
// - 全部异步（原来的 spawnSync 最长会把进程卡住 120 秒），命令行只探测一次并缓存；
// - 不写死 Windows 路径：按 PATH 找 python3 / python / py / edge-tts，可用 EDGE_TTS_CMD 指定；
// - 产物写进语音库的 tts/ 子目录，自动清理旧文件。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const MAX_SPEAK_CHARS = 200;
export const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';
/** tts/ 子目录最多留多少个文件、留多久。 */
export const TTS_KEEP_FILES = 30;
export const TTS_KEEP_MS = 24 * 60 * 60 * 1000;

const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}(?:-[a-z]+)?-[A-Za-z]+Neural$/;
const RATE_RE = /^[+-]\d{1,3}%$/;
const PITCH_RE = /^[+-]\d{1,3}Hz$/;

function run(cmd, args, { timeoutMs = 20000, exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error });
    });
  });
}

/** 从 `--version` 输出里取版本号，判断是否 ≥ 7.3。 */
export function edgeTtsVersionOk(versionText) {
  const m = /(\d+)\.(\d+)/.exec(String(versionText ?? ''));
  if (!m) return false;
  const major = Number(m[1]); const minor = Number(m[2]);
  return major > 7 || (major === 7 && minor >= 3);
}

/** 命令行候选（不写死任何系统的绝对路径）。 */
export function edgeTtsCandidates({ env = process.env, platform = process.platform } = {}) {
  const out = [];
  if (env.EDGE_TTS_CMD) out.push({ cmd: env.EDGE_TTS_CMD, args: [] });
  const pythons = platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const p of pythons) out.push({ cmd: p, args: ['-m', 'edge_tts'] });
  out.push({ cmd: 'edge-tts', args: [] });
  return out;
}

let detected = null; // { at, value }
const DETECT_CACHE_MS = 10 * 60 * 1000;

/** 找到可用的 edge-tts（缓存 10 分钟；找不到也缓存，避免每次都起一串子进程）。 */
export async function detectEdgeTts({ exec, env, platform, now = Date.now, force = false } = {}) {
  if (!force && detected && now() - detected.at < DETECT_CACHE_MS) return detected.value;
  let value = null;
  for (const c of edgeTtsCandidates({ env, platform })) {
    const r = await run(c.cmd, [...c.args, '--version'], { timeoutMs: 8000, exec });
    if (r.ok) { value = { ...c, version: (r.stdout || r.stderr).trim().split(/\r?\n/)[0] }; break; }
  }
  detected = { at: now(), value };
  return value;
}

export function resetEdgeTtsCache() { detected = null; }

/** 校验音色 / 语速 / 音调参数（这些值会成为命令行参数，必须是白名单格式）。 */
export function normalizeSpeakOptions({ voice, rate, pitch } = {}, { defaultVoice = DEFAULT_VOICE } = {}) {
  const v = String(voice ?? '').trim() || defaultVoice;
  if (!VOICE_RE.test(v)) throw new Error('音色名格式不对（例如 zh-CN-XiaoyiNeural）');
  const out = { voice: v };
  if (rate != null && String(rate).trim()) {
    if (!RATE_RE.test(String(rate).trim())) throw new Error('语速格式应为 +10% / -10%');
    out.rate = String(rate).trim();
  }
  if (pitch != null && String(pitch).trim()) {
    if (!PITCH_RE.test(String(pitch).trim())) throw new Error('音调格式应为 +2Hz / -2Hz');
    out.pitch = String(pitch).trim();
  }
  return out;
}

/** 清理 tts/ 子目录：超过保留时间或超过数量的旧文件删掉。 */
export function pruneTtsDir(dir, { now = Date.now(), keepFiles = TTS_KEEP_FILES, keepMs = TTS_KEEP_MS } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => /^speak-[\w-]+\.mp3$/.test(n))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch { return 0; }
  let removed = 0;
  files.forEach((f, i) => {
    if (i >= keepFiles || now - f.t > keepMs) {
      try { fs.rmSync(path.join(dir, f.n), { force: true }); removed += 1; } catch {}
    }
  });
  return removed;
}

/**
 * 合成一段话成 mp3，写进 <语音库>/tts/。返回 { name（相对语音库）, file, bytes, voice, version }。
 * @param {string} text
 * @param {{ libraryDir: string, voice?: string, rate?: string, pitch?: string, defaultVoice?: string, exec?: Function, now?: () => number }} opts
 */
export async function synthesizeSpeech(text, { libraryDir, voice, rate, pitch, defaultVoice, exec, now = Date.now } = {}) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('要念的文字不能为空');
  if (body.length > MAX_SPEAK_CHARS) throw new Error(`文字太长（${body.length} 字），一条语音最多 ${MAX_SPEAK_CHARS} 字；长内容请分几条发`);
  const opts = normalizeSpeakOptions({ voice, rate, pitch }, { defaultVoice: defaultVoice || DEFAULT_VOICE });
  const ed = await detectEdgeTts({ exec, now });
  if (!ed) throw new Error('没找到 edge-tts。请先安装并确认版本 ≥ 7.3.0：python -m pip install --upgrade edge-tts（装好后约 10 分钟内会被识别）');
  if (!edgeTtsVersionOk(ed.version)) throw new Error(`当前 edge-tts ${ed.version} 太旧，会被微软拒绝（403）。请升级：python -m pip install --upgrade edge-tts`);

  const dir = path.join(libraryDir, 'tts');
  fs.mkdirSync(dir, { recursive: true });
  pruneTtsDir(dir, { now: now() });
  const stamp = new Date(now()).toISOString().replace(/[-:T.Z]/g, '').slice(0, 17);
  const name = `speak-${stamp}-${Math.random().toString(36).slice(2, 6)}.mp3`;
  const full = path.join(dir, name);
  const args = [...ed.args, '--voice', opts.voice, '--text', body, '--write-media', full];
  if (opts.rate) args.push(`--rate=${opts.rate}`);
  if (opts.pitch) args.push(`--pitch=${opts.pitch}`);

  const r = await run(ed.cmd, args, { timeoutMs: 60000, exec });
  let size = 0;
  try { size = fs.statSync(full).size; } catch {}
  if (!r.ok || size < 500) {
    try { fs.rmSync(full, { force: true }); } catch {}
    const err = ((r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-1)[0] || '无输出')
      .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]+/g, '<路径>');
    const hint = /403|Invalid response status/i.test(r.stderr) ? '（403 通常是 edge-tts 版本太旧，请升级）' : '';
    // 只回报最后一行错误：完整输出里可能带本机路径
    throw new Error(`edge-tts 合成失败：${err.slice(0, 160)}${hint}`);
  }
  return { name: `tts/${name}`, file: full, bytes: size, voice: opts.voice, version: ed.version };
}
