# 控制中心（v0.4.0）：一个网页管理桥接、接口平台与 SnowLuma

> **页面布局已更新（v1.0.0 起）**：顶部有两个大标签「桥接」「接口平台」，切换只改变显示，不会启动、停止或重连任何模块；
> 选中的标签刷新后保留。下文的「左侧：桥接」对应现在的**桥接**标签；「右侧：SnowLuma」移到了**接口平台 → 接入实例 → SnowLuma 实例详情**
> 里（仍然只有你亲手点击才会启停 SnowLuma）。接口平台标签的说明见文末「接口平台标签」一节。

日常运行时，屏幕上只需要：**QQ（机器人号）、DSH、浏览器里的控制中心页面**。
桥接和 SnowLuma 都作为控制中心的子进程在后台运行，它们的终端输出显示在页面里。

## 启动

在项目目录双击其中一个：

| 文件 | 效果 |
| --- | --- |
| `control-center.bat` | 打开一个小命令行窗口（关掉它 = 退出控制中心及其启动的进程），并自动打开浏览器 |
| `control-center-hidden.vbs` | **没有窗口**，只打开浏览器页面；退出用页面右上角的「退出控制中心」 |
| `QQ Bridge 控制中心.app`（macOS，本机生成：第一次双击 `control-center.command` 时自动生成，或 `npm run mac-app`） | **没有窗口**、没有 Dock 图标，只打开浏览器页面；再次双击重新打开页面；退出用页面右上角的「退出控制中心」（App 随之退出）。第一次读 NapCat 配置时 macOS 会以这个 App 的名义问「访问其他 App 的数据」，点**允许**一次即可。App 不入库：换了仓库位置或更新后重新运行 `npm run mac-app` |
| systemd 用户服务（Linux，`npm run linux-service -- --enable` 生成） | 后台常驻、登录后自动启动、崩溃自动重启，不弹浏览器；有桌面时另有「QQ Bridge 控制中心」启动项可双击打开页面。服务器上用 `ssh -L 3099:127.0.0.1:3099` 转发后访问 |
| `control-center.command`（macOS） | 双击在「终端」里打开（关掉终端窗口 = 退出控制中心及其启动的进程）。第一次读 NapCat 配置时 macOS 会问「终端想访问其他 App 的数据」，点**允许**一次即可 |

也可以 `npm run control-center`。页面地址是 `http://127.0.0.1:3099/`（端口可在 `state\control-center.json` 的 `port` 修改，或用环境变量 `QQ_BRIDGE_CONTROL_PORT`）。
重复双击不会开第二个，只会重新打开已有的页面。

**启动控制中心不会启动桥接，也不会启动 SnowLuma**——两者都要你点按钮。没有部署（没有 `config.json`）时也能打开页面，
「桥接」标签会提示缺少配置，点「启动桥接」会在日志里说明原因。

页面令牌保存在 `state\control-center-token`。自动打开的浏览器地址里带着它（`#t=…`，这部分不会发给服务器），
手动输入地址时，页面会提示你粘贴这个文件的内容。

## 左侧：桥接

- **启动 / 重启 / 停止**：停止时先请桥接保存状态再退出，8 秒没退出才强制结束。
- **崩溃自动重启**：桥接异常退出后自动重启（退避 5～30 秒）；配置问题、已有另一个桥接实例时不会反复重启。
- **日志**：过滤、只看错误、暂停滚动、下载、清屏。显示前会抹掉已知令牌和 `password=…` 这类凭据。日志同时写入 `state\logs\bridge-YYYYMMDD.log`。
- **命令行**是固定命令集，不是系统终端，不能执行任意程序：

| 命令 | 作用 |
| --- | --- |
| `help` | 列出命令 |
| `status` | 当前模式、权限级别、TOTP、人物库等 |
| `mode reserved2` / `mode closed-agent L2` / `mode closed-agent L3 <6位动态码>` | 切换模式（与桥接控制台规则相同：高权限期间与回落后 10 分钟内不能提权，L3 要 TOTP） |
| `panic` | 紧急关闭，回到安全模式 |
| `approvals` | 查看待审批（审批只能由 owner 在 QQ 里回复） |
| `audit [条数]` | 最近的管理审计记录 |
| `reconcile` | 立刻重新对账群成员名单 |
| `bridge start\|stop\|restart`、`snowluma start\|stop` | 启停 |
| `clear` | 清空页面显示（不删除日志文件） |

## 右侧：SnowLuma

1. **选择目录**：第一次使用时点「浏览…」，在弹出的 Windows 文件夹选择框里选中你自己下载并解压的 SnowLuma 目录
   （含 `launcher.bat`、`index.mjs` 的那一层），或者直接粘贴路径，再点「使用这个目录」。
   SnowLuma **不需要、也不应该**放进项目目录。选择后会同时把 `config.json` 的 `snowluma.homeDir` 改成这个目录（如果已有 `config.json`）。
2. 选好后显示：版本、**完整版 / Lite 版**（目录里有 `node.exe` 的是完整版）、目录、已配置的机器人账号、WebUI 地址。
3. **启动 / 停止 SnowLuma**：按发行包原样运行它自带的 `launcher.bat`。SnowLuma 退出后**不会**自动重启。
   如果你在外面自己双击了 `launcher.bat`，页面会显示「外部运行中」，此时控制中心不会去停它。
4. **打开 SnowLuma WebUI**：在新标签页打开（SnowLuma 的 WebUI 禁止被嵌入别的页面，所以不能直接嵌入控制中心页面）。
   首次使用在这里扫码登录机器人 QQ、开启 OneBot 的 WebSocket 与 HTTP。
5. **检查更新**：查询 GitHub 上 SnowLuma 的最新版本，并告诉你该下载哪个文件（完整版 `…-win-x64.zip`，不是 Lite）。
6. **更新助手**：
   1. 「打开下载页」，下载新版本，解压到一个**新的**文件夹；
   2. 回到页面，**先停止 SnowLuma**，选择新文件夹，点「迁移数据并切换」；
   3. 控制中心会把当前目录的 `config/`（账号、OneBot 配置、WebUI 密码）和 `data/`（按 QQ 号的数据）**先备份**到
      `state\snowluma-backups\`，再复制到新目录（新目录里如果已有同名文件夹，会改名为 `.before-migrate-<时间>` 保留），
      校验文件数，然后把控制中心和 `config.json` 指向新目录。旧目录原样保留，确认新版本正常后再自己删。
   4. 不迁移 `logs/`（可勾选）；拒绝把新版本「降级」迁移到更旧的版本。

**数据放在哪里**：SnowLuma 的数据在它自己目录的 `config/`、`data/`、`logs/` 里；**AI 的记忆、人物库、会话**在桥接的
`state\` 和 DSH 的 `.dsh` 里，**聊天记录**在 QQ 客户端里——更新 SnowLuma 不会影响后两者。

**为什么不是一键自动更新**：SnowLuma 用户协议 v1.1 §5.4（中文为准）规定「将其并入第三方安装包或 Docker 镜像、
**通过自动化脚本部署**……均须事先取得书面授权」。替你下载、解压、替换它的程序文件就是在用脚本部署它的专有组件，
所以控制中心只搬你的数据，不碰它的程序文件。

## 底部状态栏

桥接（运行时长）· SnowLuma（是否运行、桥接是否连上）· QQ（账号是否在线、接收链路是否正常、**当前登录的机器人账号**）·
DSH（端口是否可达、桥接是否就绪）· 模式 / 权限级别 · 各组件版本。页面顶部还有当前模式徽章、待审批 / 待确认数量和「紧急关闭」按钮；
处于 L1～L3 高权限时会显示红色提示。

## 安全

- 只监听 `127.0.0.1`；只接受本机 Host；写操作只接受 JSON 与同源请求；接口必须带 `x-control-token`。
- 令牌文件在 `state\` 下，运维 Agent 的文件工具读不到（`protected-paths.mjs`）。
- 控制中心能做的事与桥接控制台相同（它就是用控制台令牌调用桥接的管理接口），不会因此多出任何能力；
  QQ 群友会话的 AI 与 MCP 工具没有调用控制中心的途径；L2/L3 运维 Agent 的每条命令都要你审批（不要批准访问 127.0.0.1:3099 或读取 state 的命令）。
- 退出控制中心会先停止它启动的桥接和 SnowLuma（它们的输出管道依附于控制中心）。

## 和 `start.bat` 的关系

`start.bat` 仍然可用（命令行窗口里运行桥接、崩溃自动重启），但**不要同时**用 `start.bat` 和控制中心启动桥接：
桥接是单实例的，第二个会立刻退出。控制中心检测到外部已有桥接时会显示「外部运行中」，并且不会再启动一个。

## 接口平台标签

接口平台（仓库里的独立子程序 `interface-platform/`，有自己的 `package.json`、测试与 `state/`）是桥接和 QQ 后端之间的统一接入层，与桥接相互独立：停止桥接不影响平台和账号在线；停止平台不会停止外部运行的 SnowLuma。

| 子区域 | 内容 |
| --- | --- |
| 概览 | 启动/停止/重启接口平台；核心状态、就绪账号数、异常实例、最近收发时间、桥接路径 |
| 接入实例 | 左侧列表、右侧详情：连接/断开（只影响该实例）、WS 地址 / SnowLuma 目录 / 令牌、上游链路；SnowLuma 实例下方是原来的 SnowLuma 目录、启停、更新助手与日志 |
| 账号 | 健康阶梯（核心运行 → 后端可连接 → 账号已登录 → 收发就绪 → 桥接已启用）、桥接开关（停用后账号仍在线，但不进入 AI 处理） |
| 日志 | 按核心 / 兼容入口 / 实例 / 账号、级别筛选；暂停滚动、清屏（只清显示）、下载 |
| 设置 | 「接入桥接 / 恢复直连」、数据目录、端口、兼容入口地址、版本与支持范围 |

**接入桥接**会把 `config.json` 的 `snowluma.wsUrl/httpUrl/accessToken` 改为平台的 OneBot 兼容入口和数据令牌，并设置 `viaPlatform: true`；
原值备份在 `state/platform-link-backup.json`，「恢复直连」按备份还原。两者都要重启桥接才生效。接入后接口平台必须保持运行，机器人才能收发。

macOS 上请用 `control-center.command` 启动：NapCat 的配置在 QQ 的沙盒容器里，macOS 把读取算在**启动控制中心的程序**头上。
如果是从别的 App（例如 Claude、某个编辑器的内置终端）里启动的，弹窗会以那个 App 的名义反复出现；拒绝后接口平台读不到账号目录，
卡片上会显示「读不到账号目录」（已连上的账号不受影响，平台不会因此断开）。

### NapCat 程序区（接口平台 → 接入实例）

**怎么找到**：「接口平台 → 概览」里 NapCat 开启卡上的「管理 NapCat 程序 →」直接跳过去；或者「接入实例」列表里点 NapCat 实例
（接口平台没运行、或还没有 NapCat 实例时，列表里有一个「本机 NapCat 程序」，在那里也能启停和设置）。

**扫码登录**：NapCat 由控制中心启动、还没登录、并且生成了新的登录二维码时，开启卡上会提示「NapCat 正在等你扫码登录」，
程序区顶部直接显示二维码（`<NapCat 目录>/cache/qrcode.png`，过期后 NapCat 换新的，页面跟着刷新）。登录成功后自动消失。
设了自动登录 / 快速登录、登录态还有效时不会出现。
NapCat 日志里也会在生成二维码的位置插一张能扫的小图（日志里的字符二维码在网页里常常扫不出来）；换新二维码后旧图变灰并标「已过期」，登录后全部标成过期。「下载日志」只写一行文字，不含图片数据。

| 项目 | 说明 |
| --- | --- |
| 版本 | 运行并登录后由 NapCat 自报（接口平台连上时调用一次 OneBot `get_version_info`）；Windows 上没运行时也会从启动文件旁的 `package.json` 读。macOS 上 NapCat 的文件在 QQ 沙盒容器里，不为显示版本去读 |
| 检查更新 | 只读 GitHub `NapNeko/NapCatQQ` 的最新 Release，提示有没有新版本和更新说明，**不下载、不安装**。「打开下载页」：macOS 打开 NapCat Mac 安装器的发布页，Windows 打开 NapCatQQ 的发布页（建议 `NapCat.Shell.Windows.OneKey.zip`） |
| NapCat 设置 | macOS：QQ.app 位置；Windows：NapCat.Shell 的启动文件（.bat / .cmd / .exe）；两者都有 NapCat 目录（含 `config/onebot11_<QQ号>.json`）和可选的快速登录 QQ 号。留空 = 默认位置。保存在 `state/control-center.json`；改目录会同步给接口平台的 NapCat 实例 |
| 浏览… | 弹出系统自带的选择窗口（macOS：`osascript` 的 choose folder / choose file；Windows：PowerShell 的文件夹 / 文件对话框），只在你点击时出现，可能在浏览器窗口后面。SnowLuma 的「浏览…」在 macOS 上也能用了 |

**换 SnowLuma 目录（例如升级到新版本）**：新目录里没有账号配置和 WebUI 密码、旧目录却有时，控制中心会先提醒迁移——
直接换过去 SnowLuma 会当成全新安装：生成新的随机 WebUI 密码（浏览器保存的旧密码失效）、要重新扫码登录、重新开 OneBot WebSocket。
点「去迁移（推荐）」会打开更新助手并填好新目录：停止 SnowLuma 后点「迁移数据并切换」，旧目录的 `config/`（含 `webui.json` 密码）、`data/` 会先备份再复制过去。

Linux 上 SnowLuma（2.0 起）和 NapCat 都可用：SnowLuma 按发行包自带的 `launcher.sh` 启动，发行包与本机平台 / 架构不符、或 Lite 版本机 Node 不够时会直接说明原因；NapCat 在「NapCat 设置」里选 `.sh` 启动脚本和 NapCat 目录。「浏览…」在有 zenity / kdialog 时弹出系统窗口，否则手动填路径。

macOS 上没有 SnowLuma：QQ 经 **NapCat** 接入（自己安装并启动 NapCat、开启 WebSocket 服务端，再在「接入实例」里填 NapCat 配置目录或 WS 地址 + 令牌）；页面上不会出现 SnowLuma 程序区。

控制中心只经平台的 HTTP 管理接口与它通信，不读写平台的文件：平台目录与端口是控制中心自己的设置（`state/control-center.json` 的 `platformDir`，默认仓库内的 `interface-platform/`，旧布局的同级 `../interface-platform` 也认；`platformPort`，默认 3120；也可用环境变量 `QQ_BRIDGE_PLATFORM_DIR`）。控制中心启动平台时，把自己保管的管理令牌（`state/platform-admin-token`）经环境变量交给平台；不是由控制中心启动的平台，它无法管理。平台没运行时，「接入实例」里只列出本机 SnowLuma 程序。

未显示的标签出现错误时，标签上会出现 ⚠ 计数，但不会自动切换过去。固定命令集新增 `platform start|stop|restart`。

