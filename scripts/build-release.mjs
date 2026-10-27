#!/usr/bin/env node
// 生成 GitHub Release 用的 ZIP：qq-bridge-enhanced-v<版本>.zip（+ .sha256）。
// 默认放在**仓库外**、与仓库同级的 release/ 文件夹（<仓库>/../release/），不占仓库目录；`--out <目录>` 可改（相对仓库根目录）。
//
// 打包范围：git 仓库里 `git ls-files` 列出的已跟踪文件（天然遵守 .gitignore）；不在 git 仓库里时
// 退回到「遍历目录 + 内置排除清单」。无论哪种方式，打包前都会做敏感文件检查，命中即失败：
// config.json、state/、node_modules/、audio/、*.log、*.bak、TOTP 秘密、控制台令牌、SnowLuma 二进制等。
//
// 压缩用 scripts/zip-utf8.mjs（只依赖 Node 自带的 zlib）：文件名带 UTF-8 标志，Windows 解压中文文件名不乱码。
// 用法：node scripts/build-release.mjs [--out <目录>] [--include-untracked]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip-utf8.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const name = `qq-bridge-enhanced-v${version}`;
const outIdx = process.argv.indexOf('--out');
const outDir = path.resolve(root, outIdx > 0 ? process.argv[outIdx + 1] : path.join('..', 'release'));
fs.mkdirSync(outDir, { recursive: true });

const EXCLUDE_DIRS = new Set(['node_modules', 'state', 'audio', 'dist', '.git', '.npm-cache', '.claude']);
const EXCLUDE_PREFIXES = ['docs/audits/', 'docs/design/', 'docs/legacy/', 'docs/research/'];
const FORBIDDEN = [
  /^config\.json$/,
  /^state\//,
  /(^|\/)node_modules\//,
  /^audio\//,
  /\.log$/,
  /\.bak(-|$)/,
  /(^|\/)totp\.json$/,
  /(^|\/)console-token$/,
  /\.(node|dll|exe)$/i,
  /^_snowluma-catalog\.json$/,
  /^scripts\/privacy-rules\.json$/,
  // SnowLuma 本体（专有组件不得再分发，EULA §5.4）
  /^snowluma\//i,
  /snowluma-win32/i,
  /^SnowLuma[^/]*(\/|\.zip$)/i,
];

// --include-untracked：连同「未跟踪但没被 .gitignore 忽略」的新文件一起打包（还没 git add 时用）。
// 敏感文件检查对它们同样生效。
const includeUntracked = process.argv.includes('--include-untracked');

function listFiles() {
  const args = includeUntracked ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard'] : ['ls-files', '-z'];
  const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (git.status === 0 && git.stdout) {
    return { source: includeUntracked ? 'git ls-files（含未跟踪的新文件）' : 'git ls-files', files: [...new Set(git.stdout.split('\0').filter(Boolean))] };
  }
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (EXCLUDE_DIRS.has(ent.name)) continue;
        if (EXCLUDE_PREFIXES.some((p) => `${rel}/`.startsWith(p))) continue;
        walk(rel);
      } else if (ent.isFile()) {
        files.push(rel);
      }
    }
  };
  walk('');
  return { source: '目录遍历（未检测到 git）', files: files.filter((f) => !FORBIDDEN.some((re) => re.test(f))) };
}

const { source, files } = listFiles();
const bad = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
if (bad.length) {
  console.error(`❌ 打包清单里有不应发布的文件（请从 git 里移除或加入 .gitignore）：\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
for (const must of ['package.json', 'package-lock.json', 'src/bridge.js', 'config.example.json', 'README.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md', 'docs/DSH_DEPLOYMENT.md', 'start.bat', 'scripts/setup-dsh.mjs', 'scripts/test-audit.mjs', 'control-center-hidden.vbs', 'scripts/build-mac-app.mjs', 'interface-platform/package.json', 'interface-platform/src/index.mjs', 'assets/default-roles/小鲸鱼.md']) {
  if (!files.includes(must)) { console.error(`❌ 打包清单缺少必需文件：${must}`); process.exit(1); }
}

// 用自己的 ZIP 实现打包（scripts/zip-utf8.mjs）：文件名一律带 UTF-8 标志，Windows 解压中文文件名不再乱码；
// 也不再依赖系统的 zip / tar.exe，三个系统生成的包一致。可执行脚本（.command / .sh）固定记成 0755。
const zip = path.join(outDir, `${name}.zip`);
fs.rmSync(zip, { force: true });
const entries = [];
for (const rel of files) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) continue; // 已删除但未提交
  const st = fs.statSync(src);
  if (!st.isFile()) continue;
  const exec = /\.(command|sh)$/i.test(rel) || (process.platform !== 'win32' && (st.mode & 0o111));
  entries.push({ name: `${name}/${rel.split(path.sep).join('/')}`, data: fs.readFileSync(src), mtime: st.mtime, mode: exec ? 0o100755 : 0o100644 });
}
fs.writeFileSync(zip, createZip(entries));

const hash = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
fs.writeFileSync(`${zip}.sha256`, `${hash}  ${name}.zip\n`);
console.log(`✅ ${path.relative(root, zip)}（${files.length} 个文件，来源：${source}）`);
console.log(`   SHA-256 ${hash}`);
