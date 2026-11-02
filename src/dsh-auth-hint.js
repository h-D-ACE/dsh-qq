// DSH 鉴权失败（HTTP 401）时给用户的诊断提示。
//
// 背景（issue 反馈）：桥接用 DSH 数据目录里 `.credentials.yaml` 的会话签名密钥在本机铸造 Cookie。
// 数据目录默认是 ~/.dsh；DSH 实际用的若是别的目录（自己设了 DSH_HOME、第三方桌面壳等），
// 桥接读到的就是另一份（或陈旧的）密钥，所有请求都 401，事件流也是连上就断、一帧都没有。
// 以前日志只说「事件流协议/版本不匹配」，把人引到了错误的方向。
//
// 本模块只读文件是否存在，不读、不输出任何密钥内容；路径里的用户目录显示成 ~。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 同一条提示的最短间隔（DSH 不可用期间每 5 秒探活一次，不能每次都刷一大段）。 */
export const AUTH_HINT_INTERVAL_MS = 10 * 60 * 1000;

/** 错误是不是 DSH 的 401。 */
export function isDshAuthError(error) {
  const msg = String(error?.message ?? error ?? '');
  return /HTTP 401\b/.test(msg) || /\bunauthori[sz]ed\b/i.test(msg);
}

/** 显示用路径：用户目录换成 ~，避免日志里带出用户名。 */
export function displayPath(p, home = os.homedir()) {
  const s = String(p ?? '');
  if (home && (s === home || s.startsWith(home + path.sep) || s.startsWith(home + '/'))) return '~' + s.slice(home.length);
  return s;
}

/**
 * 可能是 DSH 数据目录的其它位置（存在 .credentials.yaml 才算）。
 * 只列已知会出现的位置：默认的 ~/.dsh，以及反馈里见过的 Windows 第三方桌面壳目录。
 */
export function candidateDshHomes({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const out = [path.join(home, '.dsh')];
  if (platform === 'win32' && env.APPDATA) out.push(path.join(env.APPDATA, 'dsh-desktop', 'harness'));
  return out;
}

/**
 * 生成 401 的诊断提示（多行文字）。
 * @param {{ dshHome: string, env?: object, platform?: string, home?: string, exists?: (p: string) => boolean }} opts
 */
export function buildDshAuthHint({ dshHome, env = process.env, platform = process.platform, home = os.homedir(), exists = fs.existsSync } = {}) {
  const current = path.resolve(String(dshHome));
  const credFile = path.join(current, '.credentials.yaml');
  const fromEnv = Boolean(env.DSH_HOME && String(env.DSH_HOME).trim());
  const lines = [];
  lines.push('⚠️ DSH 拒绝了桥接的登录凭据（HTTP 401），所以请求全部失败、事件流连上就断。这不是 DSH 版本或协议的问题。');
  if (!exists(credFile)) {
    lines.push(`  · 桥接在 ${displayPath(credFile, home)} 没找到 DSH 的凭据文件。`);
  } else {
    lines.push(`  · 桥接读的是 ${displayPath(credFile, home)}，但它和正在运行的 DSH 对不上：多半是 DSH 实际用的是另一个数据目录。`);
  }
  lines.push(`  · 当前数据目录：${displayPath(current, home)}（${fromEnv ? '来自环境变量 DSH_HOME' : '默认值，没有设置 DSH_HOME'}）。`);
  const others = candidateDshHomes({ env, platform, home })
    .map((p) => path.resolve(p))
    .filter((p) => p !== current && exists(path.join(p, '.credentials.yaml')));
  for (const p of others) lines.push(`  · 发现另一个有凭据的目录：${displayPath(p, home)}，DSH 可能用的是它。`);
  lines.push('  怎么办：把环境变量 DSH_HOME 设成 DSH 实际的数据目录（里面有 .credentials.yaml 和 profiles 文件夹），然后重启控制中心；');
  lines.push(platform === 'win32'
    ? '    Windows：setx DSH_HOME "<目录>"，再关掉并重新打开控制中心（setx 只对之后新开的程序生效）。'
    : '    macOS / Linux：export DSH_HOME="<目录>" 后再启动控制中心（Linux 服务写进服务的环境变量）。');
  lines.push('  改了目录以后还要重跑 node scripts/setup-dsh.mjs 并重启 DSH：preset 和 MCP 工具要装进 DSH 实际用的那个目录。详见 docs/guides/DSH_SETUP.md「常见问题」。');
  return lines.join('\n');
}

/**
 * 限频：同一条提示 AUTH_HINT_INTERVAL_MS 内只出一次。
 * @param {{ now?: () => number, intervalMs?: number }} opts
 */
export function createAuthHintGate({ now = Date.now, intervalMs = AUTH_HINT_INTERVAL_MS } = {}) {
  let lastAt = -Infinity;
  let lastFailAt = -Infinity;
  return {
    /** 记一次 401；返回这次要不要出提示。 */
    fail() {
      const t = now();
      lastFailAt = t;
      if (t - lastAt < intervalMs) return false;
      lastAt = t;
      return true;
    },
    /** 最近 windowMs 内有没有 401（事件流「一帧都没有」时用来判断真正原因）。 */
    recentlyFailed(windowMs = 2 * 60 * 1000) { return now() - lastFailAt <= windowMs; },
    /** 恢复正常后清掉，下次再 401 立刻提示。 */
    reset() { lastAt = -Infinity; lastFailAt = -Infinity; },
  };
}
