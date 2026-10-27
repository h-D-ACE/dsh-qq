# DSH_DEPLOYMENT.md —— 给部署 agent 的完整部署说明（qq-bridge-enhanced）

> **读者**：之后负责部署本项目的 DSH agent（或任何没有参与开发的人）。
> **约定**：每一步都写明「在哪个目录执行 / 前置条件 / 预期结果」。命令分 **Windows（PowerShell）** 与 **macOS（终端 zsh）** 两套，
> 只有一套的地方表示两边相同。**不要猜测配置字段**——所有字段都在本文第 7 节与
> [guides/CONFIGURATION.md](guides/CONFIGURATION.md) 里有说明；没写到的字段保持模板默认值。
> 仓库：https://github.com/h-D-ACE/dsh-qq
>
> **硬性边界（部署 agent 必须遵守）**
> 1. **不要**下载、安装、启动 QQ 后端（SnowLuma / NapCat），也**不要**登录 QQ —— 这些必须由用户本人完成（QQ 登录需要用户扫码；
>    SnowLuma 的 EULA 禁止用自动化脚本部署它的专有组件）。控制中心页面上的「启动 SnowLuma」「启动 NapCat」「开启 SnowLuma / NapCat」
>    按钮**只给用户本人点**，部署 agent 不要通过任何方式（浏览器自动化、调用 `/api/snowluma/*`、`/api/napcat/*`、`/api/backends/*`、页面命令）触发它们。
>    第 4 节只告诉你如何**检查**用户是否已准备好。
> 2. **不要**读取、打印或修改 `~/.dsh/.credentials.yaml` 的内容；桥接自己会读它来鉴权。
> 3. **不要**在 QQ 里替用户回复确认码或 TOTP 动态码；**不要**把 TOTP 秘密发到任何聊天或日志。
> 4. 遇到本文没有覆盖的错误：停下来把完整报错告诉用户，不要自行改源码或改 DSH 内部文件。

---

## 0. 速览

| 项 | 值 |
| --- | --- |
| 项目 | qq-bridge-enhanced：QQ ↔ DeepSeek Harness（DSH）桥接，把一个 QQ 账号变成 DSH agent 驱动的「AI 群友」。基于上游 Derpyu520/qq-bridge v0.2.0-r3（已合并 r4 的修复） |
| 操作系统 | **Windows 10/11 x64**、**macOS**（Apple Silicon / Intel）或 **Linux**（x64 / arm64，桌面或无图形界面的服务器） |
| QQ 后端 | **Windows**：SnowLuma（推荐，完整版 `…-win-x64.zip`）或 NapCat（NapCat.Shell）；**macOS**：NapCat（用 NapCat Mac 安装器装进 Mac 版 QQ）。都由用户自行下载、安装、登录；**Linux**：SnowLuma 2.x（`…-linux-x64.tar.gz` / `…-linux-arm64.tar.gz`）或 NapCat |
| 接口平台 | 仓库里的 `interface-platform/`：桥接和 QQ 后端之间的统一接入层，由控制中心启停。桥接经它收发（「接入桥接」后） |
| Node.js | **≥ 22.13**（推荐 22 LTS 的最新小版本）。注意 SnowLuma 2.x 的 **Lite 版需要 Node 24+**（用本机 Node 运行）；用完整版（自带 Node）就不受影响 |
| DSH | 桌面版或命令行版，**0.2.0-rc.2 或 0.2.1**。0.2.1 桌面版每次启动用随机端口，桥接与控制中心会自动找到它 |
| 日常启动（无窗口） | Windows：双击 `control-center-hidden.vbs`；macOS：双击本机生成的「QQ Bridge 控制中心.app」（第 10 节）；Linux：`npm run linux-service` 生成 systemd 用户服务（后台常驻、登录自动启动） |
| 端口 | 控制中心 `127.0.0.1:3099`；桥接控制台 `3100`；接口平台 `3120`；DSH 命令行版 `3080` / 桌面版 0.2.0 `19387`、0.2.1 随机（自动识别）；OneBot WS 默认 `3001`；SnowLuma WebUI `5099`；NapCat WebUI `6099` |

新功能一句话：按 QQ 号跨群认人、分层人物记忆、入群感知、owner 私聊管理通道（确认码 + TOTP 的模式/权限切换、编号审批、自动回落）、
把桥接 / 接口平台 / QQ 后端合到一个本地网页里的**控制中心**，以及 macOS + NapCat 支持。
完整说明见 [guides/CONTINUITY.md](guides/CONTINUITY.md)、[guides/ADMIN_CHANNEL.md](guides/ADMIN_CHANNEL.md)、[guides/CONTROL_CENTER.md](guides/CONTROL_CENTER.md)。

## 1. 系统架构与依赖

```
QQ 客户端（机器人号）
   ⇅  SnowLuma（Windows，WebUI 5099）或 NapCat（macOS / Windows，WebUI 6099）—— OneBot v11 正向 WebSocket（默认 3001）
接口平台 interface-platform（127.0.0.1:3120，按后端目录自动发现账号；OneBot 兼容入口 /onebot/v11/ws）
   ⇅  OneBot v11（数据令牌）
桥接 node src/bridge.js（桥接控制台 127.0.0.1:3100；state/ 运行时数据不入库）
   ⇅  DSH Web API（离线铸造 Cookie 鉴权）
DSH（桌面版 desktop profile / 命令行版 web profile）
  ├─ agent preset：qq-chat / qq-chat-v2（群友，无本地工具）/ qq-agent-readonly（L1）/ qq-agent-workspace（L2）/ qq-agent-full（L3）
  ├─ MCP：mcp-snowluma（src/mcp-snowluma-safe.js）、mcp-snowluma-host、mcp-web-search-safe
  └─ 权限预设：read-only / workspace-write / qq-full-ask

控制中心 127.0.0.1:3099（本仓库）管理上面的桥接、接口平台和本机的 QQ 后端程序：
  · 桥接、接口平台：页面按钮启停（部署 agent 可以点）；
  · SnowLuma / NapCat 程序：**只在用户亲手点击时**启动（见文首硬性边界）。
```

npm 依赖见 `package.json`（`@modelcontextprotocol/sdk`、`@snowluma/sdk`、`@snowluma/mcp`、`@deepseek-ai/dsh-host-apiproxy`、`js-yaml`、`zod` 等），
`npm ci` 安装；`postinstall` 会修补本地 `node_modules/@snowluma/sdk` 的 ESM 打包问题（只改本地副本）。接口平台零运行时依赖。

## 2. 前置检查

**执行目录**：任意。

```
node --version          # 预期：v22.13.0 或更高
npm --version           # 预期：10.x 或更高
git --version           # 仅在用 git clone 方式获取时需要
```

不满足时请用户安装 Node.js 22，然后**重新打开**终端：
- Windows：https://nodejs.org 下载 22 LTS，安装时勾选「Add to PATH」；
- macOS：`brew install node@22`（Homebrew），或从 https://nodejs.org 下载安装包。

> **装好或更换 Node 之后，第 8 节的 `node scripts/setup-dsh.mjs` 必须（重新）运行一次**：DSH 的 MCP 配置里记录的是
> Node 的绝对路径，Node 换了位置而不重跑，DSH 里的 QQ 工具会全部启动失败。

## 3. 确认 DSH

先判断用户用的是哪种 DSH 和版本。

**Windows（PowerShell）**

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes\*\runtime.json" -ErrorAction SilentlyContinue | ForEach-Object { (Get-Content $_ -Raw | ConvertFrom-Json).desktopVersion }
(Get-Command dsh -ErrorAction SilentlyContinue).Source
```

**macOS**

```bash
defaults read "/Applications/DeepSeek Harness.app/Contents/Info" CFBundleShortVersionString
command -v dsh
```

- 有桌面版版本号（`0.2.0-rc.2` 或 `0.2.1…`）→ **桌面版**，不要再装命令行版去替代它。让用户打开 DSH 桌面版。
  - 桌面版使用 **`desktop` profile**（`~/.dsh/profiles/desktop`）。0.2.0 固定监听 `127.0.0.1:19387`，**0.2.1 每次启动换一个随机端口**；
    桥接、控制中心、`probe:permission`、`setup-dsh` 都会**自动识别**（0.2.1 按进程找监听端口：Windows 用 `tasklist`/`netstat`，macOS 用 `lsof`），
    DSH 重启换了端口后桥接也会自动跟上。`dsh.baseUrl` 保持模板里的空字符串即可。
  - 桌面版的 `dsh` 命令不在 PATH 里（Windows：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`；
    macOS：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`）；第 8 节的脚本会自动找到它，不需要另装命令行版。
- 只有 `dsh` 命令 → 命令行版，用 `dsh --version` 确认版本（0.2.0-rc.2 或 0.2.1）。
- 都没有 → 请用户装桌面版；或装命令行版：

```
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
dsh --version            # 预期输出包含 0.2.1-rc.2（0.2.0-rc.2 也支持）
dsh web                  # 会占用当前终端窗口，保持它开着；另开一个终端继续
```

  预期：日志中出现 Web 服务监听 `127.0.0.1:3080`。

> 桌面版与命令行版共用 `~/.dsh`，但 profile 不同：桌面版 `profiles/desktop`，命令行版 `profiles/web`。用户自定义过数据目录时，
> 后续命令前设置环境变量 `DSH_HOME=<该目录>`（PowerShell：`$env:DSH_HOME = "<该目录>"`）。

## 3.5 配置 DSH 的模型凭据（由用户操作）

DSH 必须有可用的模型凭据，否则机器人收到消息后回复「⚠️ AI 处理出错（错误码 MISSING_CREDENTIAL）」，
桥接日志里是 `⚠️ 回合出错 … [MISSING_CREDENTIAL] llm-deepseek: no API key for provider route "deepseek-official"`。

两种方式二选一，**由用户在 DSH 界面里完成**（部署 agent 不要读取或写入凭据文件，也不要让用户把 Key 发到聊天里）：

| 方式 | 在 DSH 里怎么做 | `config.json` 的 `dsh.provider` |
| --- | --- | --- |
| DeepSeek API Key（按量计费，platform.deepseek.com 申请） | 设置 → 模型 / Provider → 填 API Key | `deepseek-official`（模板默认） |
| DeepSeek 账号登录 | 设置里用 DeepSeek 账号登录 | `deepseek-account` |

`dsh.provider` 与实际配置的方式不一致时同样会报 `MISSING_CREDENTIAL`。配置完后在 DSH 自己的聊天界面发一句话，能正常回复即可。

## 4. 检查 QQ 后端（只检查，不安装、不启动）

**全部由用户本人完成**；部署 agent 只做检查、向用户要信息。

### 4.1 Windows：SnowLuma（推荐）

用户从 https://github.com/SnowLuma/SnowLuma/releases 下载**完整版** `SnowLuma-v<版本>-win-x64.zip`（不是 `-lite`），
解压到一个**项目目录之外**的文件夹（例如 `D:\SnowLuma`）。第 10 节里用户在控制中心选择这个目录并亲手点「开启 SnowLuma」，
第一次在 SnowLuma 的 WebUI（`http://127.0.0.1:5099/`）里扫码登录**机器人 QQ**，并开启 OneBot **WebSocket 服务端**与 **HTTP API**。
（Release ZIP 里**不包含** SnowLuma 的任何文件。）

需要向用户要的信息：**SnowLuma 解压目录**（第 10 节在页面里选择即可，不用写进配置）。

### 4.1b Linux：SnowLuma（2.0 起正式支持）

用户下载与机器架构匹配的**完整版** `SnowLuma-v<版本>-linux-x64.tar.gz` 或 `…-linux-arm64.tar.gz`（`uname -m` 输出 `aarch64` 就选 arm64），
解压到项目目录之外（例如 `/opt/snowluma`）。SnowLuma 在 Linux 上接入的是本机运行的 Linux 版 QQ，需要先装好并能登录。
第 10 节在控制中心「接入实例 → 本机 SnowLuma 程序」里选这个目录（有桌面时「浏览…」会弹出系统的选择窗口；服务器上直接填路径），
由用户点「开启 SnowLuma」——控制中心按发行包自带的 `./launcher.sh` 运行它。第一次在 WebUI（`http://127.0.0.1:5099/`，账号 `admin`，密码见 SnowLuma 日志）
里同意协议、扫码登录机器人 QQ、开启 OneBot WebSocket 服务端。
- 发行包和本机不匹配（例如在 Linux 上选了 Windows 包、x64 包放到 arm64 机器上）时，控制中心不会启动，并写明需要哪个包；
- Lite 版而本机 Node 低于 24 时同样不会启动，并提示改用完整版或升级 Node。

### 4.2 macOS：NapCat

1. 用户安装 Mac 版 QQ，再用 **NapCat Mac 安装器**（https://github.com/NapNeko/NapCat-Mac-Installer/releases）安装 NapCat，
   在安装器里点「切换程序入口为 NapCat」。控制中心**不会**替用户修改 QQ。
2. 第一次由用户启动（第 10 节控制中心里亲手点「开启 NapCat」，或自己启动）并扫码登录**机器人 QQ**。
3. 用户在 NapCat 的 WebUI（`http://127.0.0.1:6099/webui`，登录令牌打印在 NapCat 日志里）→ 网络配置 → 新建 **WebSocket 服务端**：
   主机 `127.0.0.1`、端口 `3001`、启用（令牌可留空，接口平台会从 NapCat 的配置文件读到）。
4. 可选：在 NapCat 里开启**自动登录**（`webui.json` 的 `autoLoginAccount`），以后启动不用扫码。

NapCat 的配置在 QQ 的沙盒容器里：`~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config/onebot11_<QQ号>.json`。
**部署 agent 不要从自己的终端去读这个目录**：macOS 会把读取算在启动读取程序的 App 头上，并弹出「访问其他 App 的数据」的授权窗；
这一步交给控制中心（由用户双击的 App 启动）去读。

### 4.3 Windows：NapCat（可选，代替 SnowLuma）

用户下载 `NapCat.Shell.Windows.OneKey.zip`（https://github.com/NapNeko/NapCatQQ/releases）解压，按 NapCat 文档启动并扫码登录，
在它的 WebUI 里开启 WebSocket 服务端（`127.0.0.1:3001`）。第 10 节在控制中心「NapCat 设置」里选择它的**启动文件**（.bat / .exe）和 NapCat 目录。

### 4.3b Linux：NapCat（可选）

按 NapCat 官方文档在 Linux 上安装（官方安装脚本或 Docker），扫码登录后在它的 WebUI 里开启 WebSocket 服务端（`127.0.0.1:3001`）。
无图形界面的服务器上，NapCat 文档里通常是一条 `xvfb-run … qq --no-sandbox` 的启动命令：把它写进一个 `.sh` 脚本，
在控制中心「NapCat 设置」里把**启动文件**选成这个脚本、把 **NapCat 目录**选成含 `config/onebot11_<QQ号>.json` 的目录
（Linux 没有默认位置；不选目录时接口平台只按 `ws://127.0.0.1:3001` 无令牌连接）。也可以自己启动 NapCat，接口平台照样能连。

### 4.4 检查（后端运行并登录后）

```
# Windows
Test-NetConnection 127.0.0.1 -Port 3001   # 预期 TcpTestSucceeded : True
# macOS
nc -z 127.0.0.1 3001 && echo OK          # 预期 OK
```

端口不通 → 告诉用户「请先启动 QQ 后端并登录 QQ，开启 OneBot WebSocket 服务端」，然后等待；**不要尝试启动它**。

## 5. 获取 qq-bridge-enhanced

二选一。下文把解压/克隆后的目录称为 **`<BRIDGE>`**。**路径里不要有中文或空格**（避免批处理与路径编码问题）。
接口平台就在 `<BRIDGE>/interface-platform/` 里，不需要单独获取。

> 由 DSH agent 部署时：DSH 的沙箱可能**不允许在工作区里写入可执行文件或解压 ZIP**（报 EPERM / 拒绝访问）。
> 遇到时请用户**手动创建**目标文件夹（必要时手动解压），再让 agent 在其中继续后面的步骤。

**方式 A：Release ZIP（推荐）**——到 https://github.com/h-D-ACE/dsh-qq/releases 下载最新的 `qq-bridge-enhanced-v<版本>.zip`
和同名 `.sha256`，校验后解压：

```powershell
# Windows（在想放置的父目录执行；把 <版本> 换成实际版本号）
(Get-FileHash .\qq-bridge-enhanced-v<版本>.zip -Algorithm SHA256).Hash.ToLower()   # 应与 .sha256 文件里的值一致
Expand-Archive .\qq-bridge-enhanced-v<版本>.zip -DestinationPath .
cd .\qq-bridge-enhanced-v<版本>
```

```bash
# macOS
shasum -a 256 qq-bridge-enhanced-v<版本>.zip     # 应与 .sha256 文件里的值一致
unzip qq-bridge-enhanced-v<版本>.zip && cd qq-bridge-enhanced-v<版本>
```

**方式 B：git**

```
git clone https://github.com/h-D-ACE/dsh-qq.git qq-bridge-enhanced
cd qq-bridge-enhanced
```

预期：`<BRIDGE>` 下能看到 `package.json`、`src/bridge.js`、`config.example.json`、`interface-platform/`、
`control-center-hidden.vbs`（Windows）、`scripts/build-mac-app.mjs`（macOS）、`docs/DSH_DEPLOYMENT.md`。

## 6. 安装依赖与离线自检

**执行目录**：`<BRIDGE>`。

```
npm ci
npm run test:audit
```

预期：
- `npm ci` 末尾有 `[patch-snowluma] … 修补了 N 个文件` 与 `added … packages`；
- `npm run test:audit` 最后一行 `Audit suite: N/N scripts passed.`（不需要 QQ、DSH 或网络）。
  - **macOS 上 `test-console-encoding.mjs` 会失败**（它检查 Windows 控制台的 `chcp`，Mac 上没有这个命令），显示为 `N-1/N`——这是已知情况，可以继续；
  - 会打印 `⏭ 跳过：未找到 DSH 工具包` 等跳过项——正常（没指定 DSH 安装目录时跳过工具名对账）。

其他任何 FAILED：停止部署，把失败脚本的输出发给用户。

## 7. 配置 config.json

**执行目录**：`<BRIDGE>`。

```powershell
# Windows
Copy-Item config.example.json config.json
notepad config.json
```

```bash
# macOS
cp config.example.json config.json
open -e config.json
```

**必须修改的字段**（其余保持默认）：

| 字段 | 填什么 | 来源 |
| --- | --- | --- |
| `ownerQQ` | 管理员（用户本人）的 QQ 号，**数字**，例如 `12345678` | 问用户 |
| `allow.groups` | 允许机器人参与的群号数组，例如 `["10001","20002"]` | 问用户 |
| `allow.private` | 允许私聊的 QQ 号数组；**建议把 ownerQQ 也放进去**（否则 owner 只能用管理命令，不能和 AI 私聊） | 问用户 |
| `dsh.provider` | API Key 方式 `deepseek-official`（默认）；账号登录方式 `deepseek-account` | 第 3.5 节 |
| `dsh.model` | DSH 里可用的模型 id；不确定就保持 `deepseek-flash` | DSH 设置页 |
| `dsh.baseUrl` | **保持空字符串 `""`** = 自动识别（含 0.2.1 的随机端口）；只有 DSH 跑在别的机器/固定端口时才填 | 第 3 节 |

**`snowluma.*`（连接 QQ 后端的地址和令牌）不用手填**：第 10 节在控制中心点「接入桥接」时，会自动改成接口平台的入口
（`snowluma.viaPlatform: true`），原值备份在 `state/platform-link-backup.json`。

> `dsh.reasoningEffort` 默认 `max`（思考最充分、回复最慢）。群聊嫌慢可以改成 `high`：通常明显更快，日常聊天质量差别不大。
> 模型和思考强度都可以部署好之后在桥接控制台「DSH 模型与思考强度」里改（选项来自 DSH 的模型目录，保存即生效），不用手改这里。

**建议确认的安全字段**（模板默认值已经是安全的）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `continuity.sharePolicy` | `identity` | 跨群只共享「是同一个人 + 管理员设定的称呼」；`none` 不共享；`shared` 再共享管理员批准的记忆 |
| `continuity.groups` | 模板里有两个**示例群号**（10001/20002） | **请删掉示例条目**，或改成用户真实群号的 `label`/`sharePolicy` |
| `admin.enabled` | `true` | owner 私聊管理通道 |
| `admin.idleTimeoutMs` | `1800000`（30 分钟） | 高权限闲置自动回落 |
| `admin.allowL3` | `true` | 允许 L3；**但未配置 TOTP 时 L3 一律拒绝** |
| `crossGroup.enabled` | `false` | 跨群查询，默认关闭；模板里的 `links` 只是示例 |
| `consoleToken` | `""` | 留空 = 首次启动自动生成并写入 `state/console-token` |

`allowAllWhenEmpty` 必须保持 `false`。完整字段表：[guides/CONFIGURATION.md](guides/CONFIGURATION.md)。

校验 JSON 语法：

```
node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('config.json OK')"
```

## 8. DSH 侧安装（preset、MCP、权限预设）

**执行目录**：`<BRIDGE>`。**前置**：第 3 节确认了 DSH（运行与否均可），第 7 节完成。

```
node scripts/setup-dsh.mjs
```

预期输出包含：
- `preset patch …` 五行：`qq-chat` / `qq-chat-v2`（群友）、`qq-agent-readonly`（L1）、`qq-agent-workspace`（L2）、`qq-agent-full`（L3）
- `cordis.patch.yml: 权限预设已更新 … qq-full-ask`（再次运行时为「已是最新（含 qq-full-ask）」）
- `cordis.patch.yml: MCP 条目已同步`
- 开头一行 `未指定 profile，自动选择 desktop（…）` 或 `… web（…）`——桌面版应为 desktop
- `dsh plugin --profile <profile> install: OK`（桌面版会自动使用它自带的 `dsh` 命令），或者提示失败（见下）
- 最后 `Done. Restart DSH …`

**`dsh plugin … install` 提示失败时**：profile 的 bundle 依赖需要装一次，否则 DSH 启动时会报 `cannot resolve profile bundle`。按顺序尝试：
1. 先直接重启 DSH 桌面版，看它能否正常启动、`npm run probe:permission`（下面）是否通过——通过就不用再做什么；
2. 不行的话，用桌面版自带的命令手动执行一次：
   ```bat
   :: Windows（cmd.exe）
   "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop install
   ```
   ```bash
   # macOS
   "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop install
   ```
   预期：命令正常结束、没有报错。然后重启 DSH 桌面版。仍然失败时把完整输出交给用户。

然后**重启 DSH**：桌面版退出后重新打开；命令行版在运行 `dsh web` 的窗口按 `Ctrl+C`，再执行 `dsh web`。

> profile 自动识别（有 `profiles/desktop` 或检测到桌面版 → desktop，否则 web）；要强制指定：`node scripts/setup-dsh.mjs <profile名>`。
> 以后移动了 `<BRIDGE>` 目录，必须重跑本步骤（MCP 里记录的是绝对路径）。

**验证（需要 DSH 正在运行）**：

```
npm run probe:permission
```

预期最后一行：`✅ 权限预设与 /permission 行为符合 v0.3.0 的假设`。它会建一个临时会话测试 `/permission`，
确认 `read-only` / `workspace-write` / `qq-full-ask` 与三个运维 preset 都已加载，并确认通过普通消息发送的
`/permission` 文本**不会**改变权限。出现 ❌ 时：**不要启用 closed-agent**，把输出发给用户（群友模式仍可正常使用）。
DSH 地址自动识别；DSH 跑在别的机器/固定端口时，先设置环境变量 `DSH_BASE_URL=http://127.0.0.1:<端口>` 再运行。

## 9. （可选，L3 需要）配置 TOTP 二次认证

**执行目录**：`<BRIDGE>`。**必须由用户本人在电脑前操作**——秘密只显示在本机终端。

```
npm run admin:totp-setup
```

预期：打印 `已生成 TOTP 秘密` 和一个 Base32 密钥 / `otpauth://` URI。让用户把它添加到手机验证器
（Google Authenticator / Microsoft Authenticator 等，「输入设置密钥」→ 基于时间）。然后自检：

```
node scripts/admin-totp-setup.mjs --verify <验证器上显示的6位数>
```

预期：`✅ 动态码正确`。**部署 agent 不要读取、复述或记录这个秘密**。不配置 TOTP 时 L3 不可用，其余功能不受影响。

## 10. 启动（控制中心，无窗口）

**执行目录**：`<BRIDGE>`。**前置**：DSH 运行中（第 8 节已重启）；QQ 后端已按第 4 节准备好。
**启动控制中心不会自动启动桥接、接口平台或 QQ 后端**，都要在页面上点。

### 10.1 打开控制中心

| 系统 | 由用户双击 | 说明 |
| --- | --- | --- |
| Windows | `control-center-hidden.vbs` | 没有窗口，只打开浏览器页面 |
| macOS | 「QQ Bridge 控制中心.app」 | 本机生成，不入库：第一次双击 `control-center.command` 时会自动生成并在访达里选中它（这一次仍在终端里运行）；也可以在 `<BRIDGE>` 里运行 `npm run mac-app`。挪了目录或更新后，删掉旧 App 再双击一次 `control-center.command`（或重跑 `npm run mac-app`）。没有窗口、没有 Dock 图标；再次双击重新打开页面 |
| Linux | `npm run linux-service` 生成的 systemd 用户服务 | 在 `<BRIDGE>` 里运行一次 `npm run linux-service -- --enable`：写入 `~/.config/systemd/user/qq-bridge-control-center.service` 并启动；以后登录自动运行（不登录也要运行：`sudo loginctl enable-linger $USER`）。日志：`journalctl --user -u qq-bridge-control-center -f`。有桌面时还会生成「QQ Bridge 控制中心」启动项，双击打开页面。服务器上从别的电脑访问：`ssh -L 3099:127.0.0.1:3099 <服务器>` 后打开 `http://127.0.0.1:3099/#t=<state/control-center-token 的内容>` |

预期：浏览器自动打开 `http://127.0.0.1:3099/`（地址里带 `#t=…` 页面令牌；令牌保存在 `state/control-center-token`）。
**macOS**：第一次读 NapCat 配置时，系统会弹「“QQ Bridge 控制中心”想访问其他 App 的数据」，**请用户点允许**（只需一次）。
拒绝的话接口平台读不到账号目录（实例卡片上显示「读不到账号目录」）。

部署 agent 需要在终端里启动时可以用 `npm run control-center`（日常请用上面的无窗口方式；macOS 上从终端启动时授权会算在终端头上）。

### 10.2 开启 QQ 后端（用户点击）

页面顶部有两个大标签「桥接」「接口平台」。进入 **接口平台 → 概览**，每个后端一张开启卡：

- **Windows / Linux · SnowLuma**：先到 **接入实例 → 本机 SnowLuma 程序**，点「浏览…」选中第 4.1 节的解压目录 →「使用这个目录」；
  回到概览，**用户点「开启 SnowLuma」**（会启动接口平台、启动 SnowLuma、在平台里建实例并连接）。
  第一次点「打开 SnowLuma WebUI」扫码登录、开启 OneBot WS 与 HTTP。
- **macOS / Windows / Linux · NapCat**：Windows / Linux 先点 NapCat 卡片上的「管理 NapCat 程序 →」→「NapCat 设置」，选好启动文件和 NapCat 目录并保存
  （macOS 默认位置一般不用改）；**用户点「开启 NapCat」**（会启动接口平台、启动 NapCat、建实例并连接）。
  需要扫码时卡片上会提示「📱 NapCat 正在等你扫码登录」，点「查看登录二维码 →」用手机 QQ 扫。

预期：概览里「就绪账号」变成 `1 / 1`；开启卡显示账号「收发就绪」。

### 10.3 接入桥接并启动

1. **接口平台 → 设置 → 桥接接入**，点「**接入桥接**」（部署 agent 可以点）：把 `config.json` 的 `snowluma.*` 改成接口平台的入口，原值备份。
2. 切到 **桥接** 标签，点「**启动桥接**」（部署 agent 可以点，或在页面命令行输入 `bridge start`）。桥接日志预期出现（顺序可能不同）：
   - `DSH 地址自动识别：http://127.0.0.1:<端口>`
   - `QQ 后端（经接口平台 · NapCat <版本>） 已连接：ws://127.0.0.1:3120/onebot/v11/ws`（SnowLuma 时显示 SnowLuma）
   - `机器人昵称: <昵称>`
   - `DSH 已就绪（模式: reserved2）`
   - `群 <群号> 成员对账：首次建档，共 N 人（全部标为 listed，不当新人）`
   - `控制台未配置 consoleToken，已自动生成：xxxxxx…`
3. 底部状态栏：桥接「运行」、接口平台「1 账号就绪 · 桥接已接入」、接入后端「NapCat 已连接」（或 SnowLuma）、
   QQ「在线 <机器人昵称>（<机器人QQ>）」、DSH「已就绪」；顶部「总体：正常」。**确认 QQ 这一项显示的是机器人号**，不是用户的主号。

### 10.4 日常

- 启动：双击无窗口入口 → 页面上开启后端 → 启动桥接。
- 退出：页面右上角「退出控制中心」——先停桥接、接口平台和由控制中心启动的 QQ 后端，再退出（macOS 的 App 随之退出）。
- 接入桥接后**接口平台必须保持运行**，机器人才能收发。
- **不要同时**用 `start.bat` / `npm start` 和控制中心启动桥接（桥接是单实例，第二个会立即退出）。

控制中心的完整说明见 [guides/CONTROL_CENTER.md](guides/CONTROL_CENTER.md)。

## 11. 检查运行状态

**执行目录**：`<BRIDGE>`。

```powershell
# Windows
$token = Get-Content .\state\console-token
Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/status" -Headers @{ "x-console-token" = $token } | Select-Object mode, level, dshReady
Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/admin/status" -Headers @{ "x-console-token" = $token } | Select-Object -ExpandProperty text
```

```bash
# macOS
T=$(cat state/console-token)
curl -s -H "x-console-token: $T" http://127.0.0.1:3100/api/status | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['mode'],d['level'],d['dshReady'])"
curl -s -H "x-console-token: $T" http://127.0.0.1:3100/api/admin/status | python3 -c "import json,sys;print(json.load(sys.stdin)['text'])"
```

预期：`mode = reserved2`、`level = L0`、`dshReady = True`；admin status 文本里有「TOTP：已配置/未配置」「人物库：N 人」，
`auditChain.ok = True`。桥接控制台：控制中心「桥接」卡片里点「打开桥接控制台 ↗」（自动带令牌）。

## 12. 功能验证（在真实 QQ 环境，由用户配合）

下面每一项都写了「用户做什么 → 预期看到什么」。部署 agent 负责指导与核对日志，**不代替用户在 QQ 里操作**。

1. **基础聊天**：用户在白名单群 @机器人 → 机器人以群友身份回复（reserved2 模式下由 AI 自主决定，可能有几秒到几十秒延迟）。
2. **跨群认人**：同一个朋友在两个白名单群用**不同群名片**各说一句话 → 控制台 `GET /api/people?qq=<朋友QQ>` 显示
   一条人物记录，`groups` 下有两个群各自的 `card`。用户私聊机器人发 `/whois <朋友QQ>` → 回复列出两个群的名片。
3. **改名保持身份**：朋友改群名片后再说一句话 → `/whois` 显示「曾用 …」。
4. **新成员入群**：一个机器人从没见过的号加入白名单群 → 群内事件流出现 `[入群] … 第一次见到的人`，
   AI 可能打招呼也可能不打（不强制欢迎）。桥接日志有 `[reserved2] 计划唤醒 group:<群号>（memberJoin:stranger）`。
5. **熟人加入另一个群**：第 2 步里的朋友加入另一个白名单群 → 日志 `memberJoin:knownElsewhere`；
   AI 可以认出 TA，但**不会**说出第一个群里的聊天内容（默认 `sharePolicy=identity`）。
6. **管理通道 · 查询**：用户私聊机器人发 `/mode` → 回复当前模式/权限/TOTP 状态。发 `/admin` → 命令列表。
7. **管理通道 · 切到运维 Agent（L1）**：用户私聊发 `/mode agent L1` → 机器人回复「申请 #n … 回复『确认 XXXX』」；
   用户回复 `确认 XXXX` → 收到「🔔 模式已变更：reserved2 → closed-agent … 来源：QQ 管理通道（申请 + 确认码）」。
   此时群聊暂停响应，私聊由只读运维 Agent 接管（只能读文件/检索，不能执行命令）。
8. **降级 / 紧急关闭**：用户发 `/panic` → 立即回到 `reserved2 / L0` 并收到变更通知。
9. **非 owner 无效**：让另一个号在群里发 `/permission danger-full-access` 或 `确认 1234` → 机器人回复
   「管理命令仅管理员可用」，模式不变。
10. **（已配 TOTP）L3**：`/level L3` → 回复要求「确认 XXXX <6位动态码>」；带上验证器动态码确认后切到 L3；
    之后 agent 除读取外的每次操作都会弹「🔐 审批 #n … 参数：…」，回复 `通过 #n` 才执行一次。
    **L2 闸门实测**（重要，开发时无法离线验证）：在 L2 下让 Agent「执行 dir（macOS：ls）看看当前目录」→ 必须先收到「🔐 审批 #n」；
    如果命令没经审批就执行了，立刻 `/panic` 并停用 closed-agent（`admin.enabled=false`），把日志发给维护者。
11. **自动回落**：保持 L1~L3 不操作 30 分钟 → 收到「来源：自动回落（闲置超时）」通知。
12. **审计**：私聊发 `/audit 20` → 列出最近的申请/确认/变更记录，且「审计哈希链：完整」。
13. **定时任务**（v1.1.0）：桥接控制台「定时任务」新建一个几分钟后的一次性任务、发给管理员私聊、内容选固定文字 → 到点收到；
    或者私聊发 `/remind add in 10m 喝水` → 桥接回复登记成功与具体时间，10 分钟后收到。执行记录里显示「已发送」。
14. **人格生效**（v1.1.0）：控制台「人格与角色 → 切换当前启用的人格」选「立即切换」后点「设置」 → 页面显示「已唤醒 N 个会话重新读卡」，
    桥接日志有 `唤醒 …（roleRefresh）`，AI 不会为换卡专门发言；之后它的说话方式按新卡。
15. **上下文压缩**（v1.1.1）：控制台「令牌与花费 → 上下文压缩」能看到每个会话上一步读了多少；某个会话超过阈值后，
    这一轮结束约 20 秒，桥接日志出现 `[compact] 已压缩 … 的上下文（自动：…）`，下一轮它每步读的 token 明显变少。

每一项的离线等价测试都在 `npm run test:audit` 里；**第 1~15 项本身需要部署后集成验证**。
SnowLuma 事件载荷可用 `npm run probe:member-events -- 300` 实测（只读，输出默认打码；不要外传 `--raw` 输出）。

## 13. 更新版本

**执行目录**：`<BRIDGE>` 的父目录。

1. 在控制中心点「退出控制中心」（停止桥接、接口平台和由它启动的 QQ 后端）。
2. 备份（见第 14 节）。
3. 下载新版本 ZIP 解压到**新目录**（不要覆盖解压到旧目录），把旧目录的这些复制过去：
   `config.json`、整个 `state/`、**`interface-platform/state/`**（接口平台的实例配置与令牌），以及 `audio/`、自定义 `roles/*.md`（如有）。
4. 在新目录执行 `npm ci` → `npm run test:audit` → `node scripts/setup-dsh.mjs` → 重启 DSH；macOS 再执行 `npm run mac-app` 重新生成 App。
   然后按第 10 节启动。
5. 阅读新版 `CHANGELOG.md` 里的「升级注意」。

**换了程序目录之后，这几样各自独立，缺一处就会出现「配置改了没生效」「工具表里没有新工具」「回合直接出错」**（来自 Windows 实机升级的记录）：

| 要做的 | 为什么 |
| --- | --- |
| **重置会话**（控制台「会话与审批」里重置，或 `POST /api/session/reset {"key":"<会话>"}`；QQ 里管理员发 `/reset`） | DSH 会话创建时记下了**旧目录**的绝对路径（`state/agents`）作为工作目录；旧目录被删或改名后，每一轮都报 `working-directory: directory does not exist`。**先重置会话，再删旧目录** |
| 让 MCP 进程重启（重启 DSH；或结束 `mcp-*.js` 进程，DSH 会自动重新拉起） | QQ 工具是 MCP 进程**启动时**按 `config.json` 注册的；`setup-dsh` 把 MCP 指到新目录，但已经在跑的进程还是旧代码 |
| 改了工具开关（如 `socialV2.tools.ownerRelay`）后再重置一次会话 | 会话的工具清单是**创建时的快照**，老会话看不到新工具 |
| 复制 `interface-platform/state/` | 平台令牌和实例配置在这里；没带上平台会重新生成令牌，桥接经平台连接时要重新「接入桥接」 |
| 换了 SnowLuma 目录：在控制中心「更换目录」并用「更新助手」迁移 | 控制中心会同步 `snowluma.homeDir` 与接口平台的 SnowLuma 实例；手改的话 `config.json` 与 `state/control-center.json` 两处都要改 |
| （可选）对照 `config.example.json` 看看新版有没有新配置项 | 没写的新配置项一律按默认值运行，不补也能用；想改默认行为时再加 |

旧目录的启动器（`control-center-hidden.vbs` 等）不要再双击：它会和新目录抢 3099 端口，隐藏窗口里的报错看不到，表现为「双击没反应」。确认新目录正常后把旧目录改名或移走。

> 从只有桥接 + SnowLuma 直连的旧版本升级：旧版 `config.json` 里的 `snowluma.*` 照常可用（直连）；要改走接口平台，按第 10.2～10.3 节开启后端并「接入桥接」。
> 想回到直连：「接口平台 → 设置 → 恢复直连」按备份还原。
>
> 从上游 v0.2.0-r3 升级到 v0.3.0+：`state/` 可直接沿用。首次启动会把旧版二代记忆里「按名字」存的群友印象
> 按 QQ 号迁移进人物库（只迁移能唯一对应到 QQ 号的；其余在 `/review` 里待人工确认），旧数据保留不删。
> 如果旧版停在 `closed-agent`，首次启动会**回落到 reserved2 并发告警通知**——这是有意的（高权限必须重新经确认码开启）。

## 14. 备份与恢复

**备份**（执行目录：`<BRIDGE>`，建议桥接停止时做）：

```powershell
# Windows
$stamp = Get-Date -Format yyyyMMdd-HHmmss
New-Item -ItemType Directory -Force ..\qq-bridge-backup | Out-Null
Compress-Archive -Path .\config.json, .\state, .\interface-platform\state -DestinationPath "..\qq-bridge-backup\qq-bridge-$stamp.zip"
```

```bash
# macOS
mkdir -p ../qq-bridge-backup
zip -r "../qq-bridge-backup/qq-bridge-$(date +%Y%m%d-%H%M%S).zip" config.json state interface-platform/state
```

备份里含聊天缓存、人物库、TOTP 秘密与令牌：**按敏感数据保管，不要上传到网盘公开目录或 GitHub**。
另外，人物库与管理状态文件自带滚动备份：`state/social/backups/`、`state/admin/backups/`（最多 7 份）。
`state/social/people.json` 损坏时桥接会自动改名留证（`.corrupt-<时间>`）并从最近备份恢复。

**恢复**：退出控制中心 → 把备份 ZIP 里的 `config.json`、`state/`、`interface-platform/state/` 解压覆盖回 `<BRIDGE>` → 启动。

## 15. 回滚

回滚到上一个版本：退出控制中心 → 用旧版本目录（或重新解压旧版 ZIP）→ 把当前的 `config.json`、`state/` 复制回去 →
在旧目录执行 `node scripts/setup-dsh.mjs`（让 DSH 的 preset/MCP 指回旧目录）→ 重启 DSH → 启动桥接。
旧版本没有接口平台时：先在新版本里「恢复直连」（或把 `config.json` 的 `snowluma.viaPlatform` 删掉、填回 SnowLuma 的 WS/HTTP 地址和令牌），再回滚。

回滚到上游 v0.2.0-r3 的注意事项：
- 旧版不认识 `state/social/`、`state/admin/`，会忽略它们（不会损坏）；
- DSH profile 里 v0.3.0 加的 `qq-full-ask` 权限预设与 `qq-agent-readonly` preset 会残留但无害；
- v0.3.0 写过的 JSON 状态文件带 `version` 字段，若将来用**更旧的 v0.3.x** 读到**更新结构**的文件，会拒绝加载并提示（不会覆盖）。

## 16. 常见错误

| 现象 | 原因 / 处理 |
| --- | --- |
| QQ 回复「AI 处理出错（错误码 MISSING_CREDENTIAL）」 | DSH 没配置模型凭据或 `dsh.provider` 不匹配，见第 3.5 节 |
| 双击无窗口入口没有反应 / 提示找不到 Node.js | 没装 Node 或不在常见位置：装 Node 22 后**重新运行第 8 节 setup**；macOS 再 `npm run mac-app` |
| macOS 反复弹「××想访问其他 App 的数据」 | 控制中心是从别的 App（终端、编辑器、AI 工具）里启动的，授权算在那个 App 头上：改用「QQ Bridge 控制中心.app」启动，允许一次 |
| 接口平台实例显示「读不到账号目录」/ 0 账号 | macOS 上拒绝了「访问其他 App 的数据」：系统设置 › 隐私与安全性里允许「QQ Bridge 控制中心」，或重新打开 App 后点允许。已连上的账号不受影响 |
| 升级 SnowLuma 后 WebUI 旧密码登录不了，要用日志里的临时密码 | 新目录没带上旧的 `config/`（被当成全新安装，`webui.json` 是新生成的），或旧版从没改过初始密码（`mustChangePassword: true` 时每次启动都会重新生成）。用控制中心「更新助手」把旧目录的 `config/`、`data/` 迁移过去；临时密码登录后在 WebUI 里改成正式密码，以后重启就不会再变 |
| SnowLuma WebUI 输对密码也登不进，提示「登录尝试过多，请 N 秒后重试」 | 同一地址 5 次输错后锁 15 分钟，锁定期间**正确密码也会被拒**。等 15 分钟或重启 SnowLuma 即解除（计数只在内存里）。注意 `localhost` 和 `127.0.0.1` 算两个地址；用控制中心「打开 SnowLuma WebUI」打开的固定是同一个 |
| WebUI 改密码提示「新密码不得与旧密码相同」 | 说明你填的「当前密码」就是现在存着的密码——直接用它登录即可。只想“重新设成这个密码”时，先改成另一个密码，再改回来（只比较这一次的新旧密码，不记历史） |
| 回合出错 `working-directory: directory does not exist: "<旧目录>\state\agents"` | 删除 / 改名了旧的项目目录，而老的 DSH 会话还记着旧目录：重置这些会话（第 13 节表格第一行） |
| 机器人说「还有个等待没结束」，日志反复「该会话已有一个等待中的 qq_wait_for_messages」 | 等待租约残留（最长 15 分钟）。v1.0.2 起重置会话会一并清掉；更早的版本重启桥接即可 |
| 双击 `control-center-hidden.vbs` 没反应 | 多半双击的是**旧目录**的启动器（和正在运行的新目录抢端口，隐藏窗口看不到报错）；只用当前目录的启动器，排障时用 `control-center.bat` 看输出 |
| Windows 解压 Release ZIP 失败 / 中文文件名乱码（`roles/小鲸鱼.md` 等） | v1.0.0、v1.0.1 的包缺「文件名是 UTF-8」标志；v1.0.2 起已修复。旧包可以用 7-Zip 解压，或从仓库直接获取 |
| 开启卡上一直「等你扫码」 | NapCat 登录态失效：用手机 QQ 扫卡片上「查看登录二维码 →」里的码（约 2 分钟换一次） |
| 底部 DSH 显示「不可达」但机器人能回复 | DSH 0.2.1 换了随机端口而控制中心还没刷新：以桥接的「已就绪」为准；仍有疑问时重启控制中心 |
| 日志反复 `… 连接断开（code=1006）` | 后端没开 WebSocket 服务端、令牌不一致或还没登录；接口平台 / 桥接会自动重连，持续出现再检查第 4 节 |
| `npm run test:audit` 有 FAILED | macOS 上只有 `test-console-encoding.mjs` 是已知失败；其他失败停止部署，把该脚本输出给用户。不要改测试 |
| 启动报「桥接只能运行一个实例」/ 退出码 2 | 已有一个桥接在跑：先退出另一个（控制中心或 `start.bat` 窗口） |
| QQ 上完全没反应，日志显示已连接 | 后端收不到 QQ 数据，见 README「SnowLuma 版本与上游健康」；不是桥接问题 |
| 日志 `⛔ 群聊/仿真会话缺少 preset` | 第 8 节没做或没重启 DSH：重跑 `node scripts/setup-dsh.mjs` 并重启 DSH |
| `/mode agent L1` 回复「切换失败：L1 需要 agent preset qq-agent-readonly」 | 同上；用 `npm run probe:permission` 确认 |
| `/level L3` 回复「需要 TOTP」 | 第 9 节未做；或用 `admin.allowL3=false` 禁用了 L3 |
| L3 切换失败「DSH 中没有权限预设 qq-full-ask」 | 第 8 节的 setup 没生效或 DSH 未重启；桥接**不会**退回到免审批的 danger-full-access |
| 收到「🚨 告警：检测到不是经 QQ 管理通道/控制台发起的模式变更」 | 有人在 DSH 设置里直接改了 `qq-mode`。默认已自动回退；确认是否本人操作 |
| 收到「运维 Agent 会话的权限被外部改成了 …」或「无法确认 … 实际权限」 | 有人在 DSH Web 界面改了 owner 会话的权限，或 DSH 返回异常；已自动紧急关闭 |
| 控制台切 closed-agent 报「冷却中」/「高权限期间控制台不能再提权」 | 有意的安全限制（防止高权限 Agent 用本机读到的令牌给自己提权）；等 10 分钟或用 QQ 管理通道申请 + 确认 |
| 控制台脚本带 `?token=` 调 API 得到 401 | API 只认请求头 `x-console-token`（`?token=` 只用于打开页面） |
| 发消息报 HTTP 426 | 直连时 `snowluma.httpUrl` 填成了 WS 端口（经接口平台时由「接入桥接」自动填写，不会出现） |
| 发消息报 401 | 令牌不一致：经接口平台时重新点「接入桥接」；直连时见 docs/guides/DSH_SETUP.md「常见问题」 |
| DSH 侧 401 | `DSH_HOME` 指向错误；`npm run test:dsh-auth` 定位 |
| 解压后路径里有中文导致批处理乱码 | 换一个纯英文路径重新解压 |
| 桥接控制台 `http://127.0.0.1:3100` 打不开 | 端口被占用（`consolePort` 改别的值）或桥接没在运行 |

更多上游问题见 [guides/DSH_SETUP.md](guides/DSH_SETUP.md) 的「常见问题」。
