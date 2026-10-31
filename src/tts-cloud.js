// QQ 语音 TTS（云）—— Microsoft Edge TTS
//
// 为什么用 Edge TTS：免费、无需 API Key、中文音色自然（接近真人）。
// ⚠️ 版本要求：必须 edge-tts >= 7.3.0。7.2.x 及更早会一直 403，
//    原因是微软把 DRM 换了：SEC_MS_GEC_VERSION 从 "1-" 改成 "2-"，
//    并且 Sec-MS-GEC 的 SHA256 用的是**改过初始状态**的实现（不再是标准 SHA256）。
//    本机实测：7.2.7 → 403；升级 7.3.1 → 正常。
//
// 调用方式：走 edge-tts 命令行（python -m edge_tts），不依赖 Python 绑定，
// 也避免把 asyncio 硬塞进桥接进程。产物直接写进语音库 audio/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MAX_TOTAL_CHARS = 2000;
// 默认音色：Xiaoyi（女声，Cartoon/Novel，活泼）。用户指定。
// 备选：zh-CN-XiaoxiaoNeural（温暖）、zh-CN-YunxiNeural（男声阳光）、
//       zh-CN-liaoning-XiaobeiNeural / zh-CN-shaanxi-XiaoniNeural（方言）
const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';

/** edge-tts 命令行候选：优先 python -m edge_tts，其次 edge-tts.exe。 */
function edgeTtsCommand() {
  // 除了 PATH 里的名字，也试几个常见绝对路径 —— 有些受限环境里
  // spawnSync('python', ...) 会直接 EPERM，但用绝对路径可以绕过。
  const pythons = ['python', 'python3', 'py',
    path.join(os.homedir(), 'AppData/Local/Programs/Python/Python313/python.exe'),
    path.join(os.homedir(), 'AppData/Local/Programs/Python/Python312/python.exe'),
    'C:/Python313/python.exe'
  ];
  for (const p of pythons) {
    try {
      const r = spawnSync(p, ['-m', 'edge_tts', '--version'], { encoding: 'utf8', timeout: 25000 });
      if (r.status === 0) return { cmd: p, args: ['-m', 'edge_tts'], version: String(r.stdout).trim(), how: `${p} -m edge_tts` };
    } catch {}
  }
  const exes = ['edge-tts',
    path.join(os.homedir(), 'AppData/Local/Programs/Python/Python313/Scripts/edge-tts.exe'),
    path.join(os.homedir(), 'AppData/Local/Programs/Python/Python312/Scripts/edge-tts.exe')
  ];
  for (const e of exes) {
    try {
      const r = spawnSync(e, ['--version'], { encoding: 'utf8', timeout: 25000 });
      if (r.status === 0) return { cmd: e, args: [], version: String(r.stdout).trim(), how: e };
    } catch {}
  }
  return null;
}

/** 语音库目录（config.json 的 socialV2.voice.dir，默认 audio/）。 */
export function audioDir(cfg = {}) {
  const rel = String(cfg?.socialV2?.voice?.dir ?? 'audio').trim() || 'audio';
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

const FF_CANDIDATES = [
  'ffprobe',
  path.join(os.homedir(), 'AppData/Local/Microsoft/WinGet/Links/ffprobe.exe'),
  'C:/ffmpeg/bin/ffprobe.exe'
];

/** 探测语音时长（ffprobe），失败返回 null。 */
export function probeDuration(file) {
  for (const c of FF_CANDIDATES) {
    try {
      const r = spawnSync(c, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', timeout: 10000 });
      if (r.status === 0) {
        const d = Number(String(r.stdout).trim());
        if (Number.isFinite(d)) return d;
      }
    } catch {}
  }
  return null;
}

/**
 * 合成一段话成 mp3，写入语音库。
 * 返回 { file, name, bytes, duration, voice, engine, version }。
 */
export function synthesizeToLibrary(text, { cfg = {}, voice, rate, pitch, volume, namePrefix = 'tts' } = {}) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('要朗读的文字为空');
  if (body.length > MAX_TOTAL_CHARS) {
    throw new Error(`文字太长（${body.length} 字），一条语音最多 ${MAX_TOTAL_CHARS} 字；长内容请分几条发`);
  }

  const ed = edgeTtsCommand();
  if (!ed) {
    throw new Error(
      '没找到 edge-tts。请先安装并确认版本 ≥ 7.3.0：\n'
      + '  python -m pip install --upgrade edge-tts\n'
      + '低版本（7.2.x 及更早）会一直被微软拒绝（403），必须升级。'
    );
  }
  const major = Number((/(\d+)\.(\d+)/.exec(ed.version) ?? [])[1] ?? 0);
  const minor = Number((/(\d+)\.(\d+)/.exec(ed.version) ?? [])[2] ?? 0);
  if (major < 7 || (major === 7 && minor < 3)) {
    throw new Error(
      `当前 edge-tts ${ed.version} 太旧，会被微软拒绝（403）。请升级：\n`
      + '  python -m pip install --upgrade edge-tts'
    );
  }

  const dir = audioDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const safeName = String(namePrefix).replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 20) || 'tts';
  const fileName = `${safeName}-${stamp}.mp3`;
  const full = path.join(dir, fileName);

  const v = String(voice ?? cfg?.socialV2?.voice?.ttsVoice ?? DEFAULT_VOICE).trim() || DEFAULT_VOICE;
  const args = [...ed.args, '--voice', v, '--text', body, '--write-media', full];
  if (rate != null) args.push('--rate', String(rate));
  if (pitch != null) args.push('--pitch', String(pitch));
  if (volume != null) args.push('--volume', String(volume));

  const r = spawnSync(ed.cmd, args, { encoding: 'utf8', timeout: 120000, cwd: ROOT });
  const stderr = String(r.stderr ?? '').trim();
  const stdout = String(r.stdout ?? '').trim();

  if (r.status !== 0 || !fs.existsSync(full) || fs.statSync(full).size < 500) {
    try { fs.rmSync(full, { force: true }); } catch {}
    const hint = /403|Invalid response status/i.test(stderr)
      ? '\n（403 通常是 edge-tts 版本太旧，请 python -m pip install --upgrade edge-tts）'
      : '';
    throw new Error(`edge-tts 合成失败（exit=${r.status}）：${stderr || stdout || '无输出'}${hint}`);
  }

  const size = fs.statSync(full).size;
  return {
    file: full,
    name: fileName,
    bytes: size,
    duration: probeDuration(full),
    voice: v,
    engine: 'edge-tts',
    version: ed.version
  };
}

/** 列出可用中文音色（走 edge-tts 的 --list-voices）。 */
export function listChineseVoices() {
  const ed = edgeTtsCommand();
  if (!ed) return null;
  try {
    const r = spawnSync(ed.cmd, [...ed.args, '--list-voices'], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) return null;
    return String(r.stdout)
      .split(/\r?\n/)
      .filter((l) => /zh-CN|zh-TW|zh-HK/.test(l))
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}
