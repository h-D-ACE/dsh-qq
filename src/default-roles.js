// 恢复默认人格：把发布包自带的原版角色卡放回 roles/。
//
// 背景（用户反馈）：一般用户很容易把默认人格改坏或误删，之前只能自己去仓库里找原文件。
// 原版角色卡的一份只读副本放在 assets/default-roles/（随发布包发，用户不该去改它）；
// roles/ 下的同名文件是用户可以随便改的那份。
//
// 恢复时如果 roles/ 里已有同名文件且内容不同，先把它备份到 state/role-backups/（每个人格最多留 10 份），
// 免得「恢复」把用户辛苦改的内容直接冲掉。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ROLES_DIR = fileURLToPath(new URL('../assets/default-roles/', import.meta.url));
export const ROLE_BACKUP_KEEP = 10;

const norm = (text) => String(text ?? '').replace(/\r\n/g, '\n').trim();

/** 发布包自带的默认人格名（按文件名排序）。 */
export function listDefaultRoles(dir = DEFAULT_ROLES_DIR) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

export function readDefaultRole(name, dir = DEFAULT_ROLES_DIR) {
  if (!listDefaultRoles(dir).includes(String(name))) return null;
  return fs.readFileSync(path.join(dir, `${name}.md`), 'utf8');
}

/** 每个默认人格现在的状态：exists = roles/ 里还在不在；modified = 内容和原版不一样。 */
export function defaultRoleStatus({ dir = DEFAULT_ROLES_DIR, rolesDir }) {
  return listDefaultRoles(dir).map((name) => {
    const file = path.join(rolesDir, `${name}.md`);
    if (!fs.existsSync(file)) return { name, exists: false, modified: false };
    let current = '';
    try { current = fs.readFileSync(file, 'utf8'); } catch {}
    return { name, exists: true, modified: norm(current) !== norm(readDefaultRole(name, dir)) };
  });
}

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把一个默认人格恢复成原版。
 * @returns {{ name, created: boolean, unchanged: boolean, backup: string|null }}
 *   created = roles/ 里原来没有（被删了）；unchanged = 本来就是原版，什么都没做；backup = 改过的那份备份到了哪（文件名）。
 */
export function restoreDefaultRole({ name, dir = DEFAULT_ROLES_DIR, rolesDir, backupDir, write, now = Date.now }) {
  const original = readDefaultRole(name, dir);
  if (original === null) throw new Error(`「${name}」不是发布包自带的默认人格`);
  const file = path.join(rolesDir, `${name}.md`);
  const exists = fs.existsSync(file);
  let backup = null;
  if (exists) {
    const current = fs.readFileSync(file, 'utf8');
    if (norm(current) === norm(original)) return { name, created: false, unchanged: true, backup: null };
    fs.mkdirSync(backupDir, { recursive: true });
    backup = `${name}-${stamp(now())}.md`;
    fs.writeFileSync(path.join(backupDir, backup), current, { encoding: 'utf8', mode: 0o600 });
    pruneBackups(backupDir, name);
  }
  write(name, norm(original));
  return { name, created: !exists, unchanged: false, backup };
}

function pruneBackups(backupDir, name) {
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}-\\d{6}\\.md$`);
  const files = fs.readdirSync(backupDir).filter((f) => re.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - ROLE_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(backupDir, f)); } catch {}
  }
}
