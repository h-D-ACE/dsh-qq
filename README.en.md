# QQ ↔ DeepSeek Harness Bridge (qq-bridge-enhanced)

**Supported systems: Windows · macOS · Linux** (qq-bridge-enhanced v1.1.1 · repository <https://github.com/h-D-ACE/dsh-qq>)

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> **qq-bridge-enhanced v1.1.1** ([h-D-ACE/dsh-qq](https://github.com/h-D-ACE/dsh-qq)) — a fork of [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) v0.2.0-r3 (with the upstream r4 fixes merged in; origin and licensing in [NOTICE.md](NOTICE.md)).
> It turns one QQ account into an "AI group member" driven by DeepSeek Harness (DSH) agents, and runs on **Windows, macOS and Linux**.
> Most documentation is in Chinese: the step-by-step deployment guide is [docs/DSH_DEPLOYMENT.md](docs/DSH_DEPLOYMENT.md), the changelog is [CHANGELOG.md](CHANGELOG.md),
> and the documentation index is [docs/README.md](docs/README.md).
> Issues and release downloads: [Issues](https://github.com/h-D-ACE/dsh-qq/issues) · [Releases](https://github.com/h-D-ACE/dsh-qq/releases).

QQ friends/groups become DSH conversations, and agent replies (including questions and tool approvals) are sent back to QQ.

## What's in v1.x

| Feature | In one line | Doc (Chinese) |
| --- | --- | --- |
| **Windows + macOS + Linux** | Windows / Linux use SnowLuma 2.x or NapCat as the QQ backend, macOS uses NapCat; all three have a no-window way to start | [DSH_DEPLOYMENT.md](docs/DSH_DEPLOYMENT.md) |
| **Interface platform** | `interface-platform/` (in this repo): a unified access layer between the bridge and QQ backends. Discovers accounts from the backend's folder, can serve SnowLuma and NapCat at the same time, and leaves room for WeChat / Discord / KOOK connectors later | [interface-platform/README.md](interface-platform/README.md) |
| **Control center** | One local web page for the bridge, the interface platform and the QQ backends: start/stop buttons (QQ backends are only ever started by you), version and update checks, the NapCat login QR code shown right on the page, an overall status bar | [CONTROL_CENTER.md](docs/guides/CONTROL_CENTER.md) |
| Cross-group identity | People are identified by QQ number only — same person, different group nicknames, still one person; same nickname, different numbers, never merged | [CONTINUITY.md](docs/guides/CONTINUITY.md) |
| Layered person memory | Group / private / global layers; by default only "this is the same person" is shared across groups, and visibility is enforced by the program when memory is injected | same |
| Member-join awareness | New members, known people joining another group, and returning members are recognised separately; existing members are not treated as newcomers on first deployment | same |
| Owner admin channel | Private chat `/mode agent L1~L3` → confirmation code → (TOTP for L3) → switch; `/panic` falls back at once | [ADMIN_CHANNEL.md](docs/guides/ADMIN_CHANNEL.md) |
| Permission tiers | L0 group member / L1 read-only agent / L2 workspace read-write / L3 full access with per-action approval; there is no approval-free mode | same |
| Approvals, fallback, audit | Numbered approvals `#n` with the real command arguments; idle high-privilege sessions fall back after 30 minutes; every change is reported to the owner; hash-chained audit log | same |
| Mode switches keep memory (v1.0.3) | Entering agent mode puts the group / private chat sessions to sleep instead of archiving them; after fallback they resume as-is. The new agent session gets a handover of the recent private chat (owner private only, redacted; since v1.1.0 it can also include the AI's long-term notes from that chat). High-privilege sessions are still archived | [ADMIN_CHANNEL.md](docs/guides/ADMIN_CHANNEL.md) |
| Scheduled tasks (v1.1.0) | Send a fixed message, or have the AI say something, at set times in a chosen time zone: daily / weekly / workdays / monthly / random N times / cron and more, with a live preview of the next 5 runs. Also from the owner's private chat via `/remind` or by asking the AI; group targets need the owner's confirmation | [SCHEDULER.md](docs/guides/SCHEDULER.md) |
| Scheduled silence (v1.1.0) | Time ranges (several, each with its own switch, chosen days and time zone) during which the AI is not woken at all, to save tokens; messages are still recorded, and conversations that addressed the AI get one wake when the range ends. One click fills in DeepSeek's peak hours | [SILENCE.md](docs/guides/SILENCE.md) |
| Persona changes take effect (v1.1.0) | In simulation mode (`reserved2`), switching or editing the persona now reaches running conversations at their next wake (or immediately, if you choose), without recreating sessions; memory and group rules are untouched | [roles/README.md](roles/README.md) |
| Long-session compaction (v1.1.1) | When a simulation conversation's last step read more than a threshold (300k tokens by default; adjustable from 50k to 800k in the console, or leave it to DSH at about 800k), the bridge compacts it once while idle. The slang table and sticker block are only injected in full when they change. Measured: group A went from 679k to 33k tokens per step | [CONFIGURATION.md](docs/guides/CONFIGURATION.md) |
| Token mis-copy recovery (v1.1.1) | When the AI mis-copies its session token by one or two characters it gets a clear hint; after 3 misses the bridge issues a fresh token (session and memory untouched). Audited internal output in simulation mode no longer posts an interception notice to the group | [CHANGELOG.md](CHANGELOG.md) |
| Usability (v1.1.1) | Scheduled silence can wake only on @ / private messages; "Restore default persona" in the console (the edited copy is backed up first); edit the send limits on the overview page and see how often they were hit; one click to have the AI describe stickers | [SILENCE.md](docs/guides/SILENCE.md) |
| Quoted merged forwards (v1.0.3) | Quoting an older merged forward no longer stalls the message for 30 s; the AI can open the quoted forward (nested ones too), results are cached | [CHANGELOG.md](CHANGELOG.md) |
| DSH model picker | Provider / model / reasoning effort as three linked selects fed by DSH's own model catalog, applied from the next message without a restart; warns about third-party providers (chat content leaves DeepSeek), turns images into text for models that can't see images, and marks unpriced models as estimated | [CONFIGURATION.md](docs/guides/CONFIGURATION.md) |
| DSH 0.2.1 | Works with DSH 0.2.0-rc.2 and 0.2.1 (v1.1.1 was tested on the 0.2.1-rc.2 desktop app); the 0.2.1 desktop app's random port is detected automatically, and the bridge follows it after DSH restarts | [DSH_020_ADAPTATION.md](docs/guides/DSH_020_ADAPTATION.md) |

## Deployment (no-window launchers)

You need: Node.js ≥ 22.13; the DSH desktop app or CLI (0.2.0-rc.2 / 0.2.1) with a model account configured inside DSH; and a QQ backend that **you** install and log in to —
**Windows**: SnowLuma (full build) or NapCat.Shell; **macOS**: QQ for Mac + the [NapCat Mac installer](https://github.com/NapNeko/NapCat-Mac-Installer/releases);
**Linux** (x64 / arm64): SnowLuma 2.x full build (`…-linux-x64.tar.gz` / `…-linux-arm64.tar.gz`, needs the Linux QQ client on the machine) or NapCat;
NapCat needs a WebSocket server enabled in its WebUI at `127.0.0.1:3001`. This project never downloads or installs a QQ backend.

**One-time install** (in a terminal, in the project folder):

| Step | Windows (PowerShell) | macOS / Linux (Terminal) |
| --- | --- | --- |
| Dependencies | `npm ci` | `npm ci` |
| Config file | `Copy-Item config.example.json config.json` | `cp config.example.json config.json` |
| Edit config | Fill in `ownerQQ`, `allow.groups` / `allow.private`, `dsh.provider` ([fields](docs/guides/CONFIGURATION.md)) | same |
| Install into DSH | `node scripts\setup-dsh.mjs`, then **restart DSH** | `node scripts/setup-dsh.mjs`, then **restart DSH** |
| No-window launcher | `control-center-hidden.vbs` is included | **macOS**: double-click `control-center.command` once - the first run creates "QQ Bridge 控制中心.app" and selects it in Finder (or run `npm run mac-app`)<br>**Linux**: `npm run linux-service -- --enable` creates and starts a systemd user service (runs in the background, starts at login) |

You don't fill in `snowluma.*` (the backend address and token) by hand — "接入桥接" (link bridge) below writes it for you.
Optional: `npm run test:audit` (offline self-check), `npm run admin:totp-setup` (TOTP for L3).

**First start:**

1. Double-click the no-window launcher (Windows: `control-center-hidden.vbs`; macOS: "QQ Bridge 控制中心.app"). The control center opens in your browser.
   On macOS the system asks once whether "QQ Bridge 控制中心" may access data from other apps — click **Allow** (it reads NapCat's config inside QQ's container).
   Linux: once the service is running, open `http://127.0.0.1:3099/#t=<contents of state/control-center-token>` (on a desktop, the "QQ Bridge 控制中心" launcher also works);
   on a server, forward the port first with `ssh -L 3099:127.0.0.1:3099 <server>`.
2. **接口平台 (Interface platform) → 概览 (Overview)**: click "开启" (turn on) on a backend card:
   - Windows / Linux · SnowLuma: first pick the SnowLuma folder under "接入实例 → 本机 SnowLuma 程序" with "浏览…", then "开启 SnowLuma"; scan the QR code in SnowLuma's WebUI the first time;
   - NapCat: "开启 NapCat" (on Windows / Linux, pick the launch file first in "管理 NapCat 程序 → NapCat 设置"; on Linux also pick the NapCat folder); when a scan is needed, the QR code appears right on the card.
3. **接口平台 → 设置 (Settings)**: click "接入桥接" (link bridge).
4. **桥接 (Bridge)** tab: click "启动桥接" (start bridge). Done when the status bar is all green (interface platform "1 账号就绪 · 桥接已接入", QQ "在线 <bot>", DSH "已就绪").

**Every day:** double-click the launcher → turn on the backend → start the bridge. To quit, use "退出控制中心" at the top right of the page (it also stops the bridge,
the interface platform and the QQ backend it started). After updating or moving the project, run `npm run mac-app` again on macOS, or `npm run linux-service -- --enable` on Linux.
Don't start the bridge with `start.bat` / `npm start` while the control center is also running it.

The full guide for a DSH agent (checks, expected output, common errors, update / backup / rollback) is **[docs/DSH_DEPLOYMENT.md](docs/DSH_DEPLOYMENT.md)**.

## Architecture

```
QQ client (bot account)
   ⇅  SnowLuma (Windows / Linux) or NapCat (macOS / Windows / Linux) — OneBot v11 WebSocket (default 3001)
Interface platform (127.0.0.1:3120; OneBot-compatible entry /onebot/v11/ws)
   ⇅
qq-bridge (bridge console 127.0.0.1:3100)  ──►  DSH Web API (desktop app or `dsh web`)
   ▲                                                   │
   └──────── agent replies / questions / approvals ────┘

Control center 127.0.0.1:3099 manages the bridge, the interface platform and the local QQ backend programs.
```

- **QQ side**: `@snowluma/sdk` provides the OneBot v11 WebSocket client; through the interface platform the bridge works the same with SnowLuma or NapCat.
- **DSH side**: session Cookie minted offline from the persistent local signing key, `/api/<namespace>/<method>` slash RPC, and `/api/remote.mux` + `session/follow`
  event stream; verified on DSH 0.2.0-rc.2 and 0.2.1. The per-session model comes from `config.json`'s `dsh.model` (default `deepseek-flash`).
- **Agent tools**: three bundled MCP servers expose a restricted QQ toolset (`qq_status`, `qq_get_group_history`, `qq_send_group_message`, `qq_reply`, …),
  a read-only host probe, and a read-only `web_search` / `web_fetch` pair with SSRF protection. The AI has no tool that starts or stops a QQ backend, and no privilege-escalation tool.
- **Bridge console** (`http://127.0.0.1:3100`, opened from the control center with the token filled in): mode switching, personas, scheduled tasks, silence (manual and scheduled), whitelist/admin settings,
  slang library (candidates split into "to research" / "researched"), memory, stickers, and token usage & cost
  (see [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)).

## Features (inherited from upstream)

- Bridges QQ group/private messages to DSH agent sessions; whitelist/blacklist access control, fail-closed by default.
- Social simulation mode ("simulated group member", `reserved2`) with full simulated-group-member tooling.
- Space-based message splitting for more natural multi-message replies.
- Sensitive-text audit prevents paths/credentials from being sent to QQ.
- Slang / network-expression learning with human confirmation; lightweight memory; sticker library.

## Security notes

- `config.json`, `state/` and `interface-platform/state/` are **never committed or released**; the repository only ships `config.example.json`.
- MCP send tools enforce whitelist checks and reject CQ-code injection; the audit layer filters local paths, credentials and tokens.
- Simulation sessions get **no local execution tools at all**: the preset's `qq-tool-restrict` row hides them at registration time and a runtime allowlist rejects anything outside the QQ MCP namespaces.
- Mode and permission changes are only executed by the bridge itself (owner admin channel with confirmation codes, TOTP for L3); full access is never mapped to DSH's approval-free `danger-full-access`.
- The control center, bridge console and interface platform listen on loopback only and each uses its own token.
- See [RULES.md](RULES.md) and [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md).

## Repository layout

```
qq-bridge-enhanced/            # the cloned folder is named dsh-qq
  config.example.json        # sanitized config template (the real config.json is never in the repo)
  control-center-hidden.vbs  # Windows no-window launcher (control-center.bat = with a small window)
  control-center.command     # macOS launcher in Terminal; `npm run mac-app` builds the no-window app
  interface-platform/        # the interface platform (own package.json, tests and state/)
  src/                       # bridge core, MCP servers, control center (src/launcher/), feature modules (scheduler/, silence-schedule.js, role-refresh.js, …)
  public/                    # control center and bridge console web pages
  dsh/agent-presets/         # DSH agent preset templates; plugins/ holds the generated DSH bundles
  roles/                     # persona cards
  scripts/                   # setup, tests and helper scripts
  docs/                      # documentation (index: docs/README.md; folder map: docs/FOLDER_MAP.md)
  state/                     # runtime data (not in repo)
```

The standalone **voice sender tool** lives outside this repository (sibling folder `../voice-tool/`); its tests are skipped when it is absent.

## Testing

`npm run test:audit` runs the offline regression suite (no credentials, DSH, QQ or network): 63 scripts. On macOS and Linux, `test-console-encoding.mjs` fails by design
(it checks the Windows console's `chcp`), so expect 62/63 there. The interface platform has its own suite: `cd interface-platform && npm test`.
Test list and conventions: [docs/guides/TESTING.md](docs/guides/TESTING.md). `npm run self-test` runs a DSH-side link test (needs DSH, no QQ).

## Compliance

SnowLuma and NapCat are independent third-party projects, not affiliated with Tencent/QQ, and are not distributed with this project. This project is for learning and
technical research only; please follow the relevant terms and the QQ User Agreement.
