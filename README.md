# QQ ↔ DeepSeek Harness 桥接

**支持系统：Windows · macOS · Linux**（qq-bridge-enhanced v1.1.2 · 仓库 <https://github.com/h-D-ACE/dsh-qq>）

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> 🗂️ 文档索引见 **[docs/README.md](docs/README.md)**；仓库目录/脚本命名约定见 **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**。
>
> 🔒 QQ 会话的权限边界与安全承诺见 **[RULES.md](RULES.md)**。
>
> 🎤 独立的「发语音」工具已拆到仓库上一级的 **`../voice-tool/`**（命令行 `voice-cli.mjs` / 图形界面 `voice-gui.mjs`），不再依赖 qq-bridge 运行。

把 QQ 消息接入 DSH agent：QQ 好友/群发来的消息会变成 DSH 会话里的用户消息，agent 的回复（含提问、工具审批）会发回 QQ。

---

## 🆕 增强版（qq-bridge-enhanced v1.1.2）—— 支持 Windows、macOS、Linux

> 本仓库（<https://github.com/h-D-ACE/dsh-qq>）是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) v0.2.0-r3 的二次开发版本（来源与授权见 [NOTICE.md](NOTICE.md)），已合并上游 r4 的修复。
> 原版的全部功能（消息桥接、多群白名单、reserved2 二代仿真、QQ 自主工具、人格、控制台、安全守卫、令牌统计、MCP、SnowLuma 健康检查）保持不变；
> 下文「架构」之后的内容沿用上游文档并按本仓库现状更新过，仍然适用（部署请以本节和 [docs/DSH_DEPLOYMENT.md](docs/DSH_DEPLOYMENT.md) 为准）。
> 问题反馈与 Release 下载请到本仓库：[Issues](https://github.com/h-D-ACE/dsh-qq/issues) · [Releases](https://github.com/h-D-ACE/dsh-qq/releases)。

| 新功能 | 一句话 | 文档 |
| --- | --- | --- |
| **Windows + macOS + Linux** | Windows / Linux 用 SnowLuma 2.x 或 NapCat，macOS 用 NapCat；三个系统都有无窗口启动方式 | [DSH_DEPLOYMENT.md](docs/DSH_DEPLOYMENT.md) |
| **接口平台** | 仓库里的 `interface-platform/`：桥接和 QQ 后端之间的统一接入层，按后端目录自动发现账号，可同时接 SnowLuma 与 NapCat；为以后接微信 / Discord / KOOK 留好接口 | [interface-platform/README.md](interface-platform/README.md) |
| **控制中心** | 一个本地网页管理桥接、接口平台和 QQ 后端：按钮启停（QQ 后端只由你点击启动）、版本与更新检查、NapCat 扫码二维码直接显示、整体状态栏 | [CONTROL_CENTER.md](docs/guides/CONTROL_CENTER.md) |
| 跨群认人 | 只认 QQ 号：同一个人在不同群换了群名片也能认出来；同名不同号绝不合并 | [CONTINUITY.md](docs/guides/CONTINUITY.md) |
| 分层人物记忆 | 群内 / 私聊 / 全局；默认只跨群共享「是同一个人」，可见范围在注入时由程序过滤 | 同上 |
| 入群感知 | 新人、熟人进新群、退群回归分别识别并唤醒 AI；首次部署不把老成员当新人 | 同上 |
| 跨群协作 | 默认关闭；有向授权，只给统计不给内容 | 同上 |
| owner 管理通道 | 私聊 `/mode agent L1~L3` → 确认码 →（L3 再加 TOTP）→ 切换；`/panic` 一键回落 | [ADMIN_CHANNEL.md](docs/guides/ADMIN_CHANNEL.md) |
| 权限分级 | L0 群友 / L1 只读 Agent / L2 工作区读写 / L3 完全访问但每次审批；不存在免审批模式 | 同上 |
| 审批增强 | 编号 `#n`、展示真实命令参数、并发不覆盖、超时自动拒绝 | 同上 |
| 自动回落与审计 | 高权限闲置 30 分钟回落；每次变更私聊通知；哈希链审计日志 | 同上 |
| 切换不失忆（v1.0.3） | 切到 agent 时群和私聊原来的会话休眠、回落后原样接着用；agent 会话能接上私聊话题（桥接注入交接，只含私聊、已脱敏；v1.1.0 起可选带上私聊长期记忆）；高权限会话照常归档 | [ADMIN_CHANNEL.md](docs/guides/ADMIN_CHANNEL.md) |
| 控制台选模型 | 提供方 / 模型 / 思考强度三个联动下拉，选项来自 DSH 模型目录，保存即生效；第三方提供方提示隐私、不能看图的模型自动把图片转文字 | [CONFIGURATION.md](docs/guides/CONFIGURATION.md) |
| 定时任务（v1.1.0） | 按时区到点发消息或叫 AI 来说；每天 / 每周 / 工作日 / 每月 / 随机几次 / cron 等重复方式，实时预览接下来 5 次；也能在管理员私聊里用 `/remind` 或让 AI 登记，发往群的要你确认 | [SCHEDULER.md](docs/guides/SCHEDULER.md) |
| 定时静默（v1.1.0） | 按时间段（可多段、可选哪些天和时区）让 AI 停止一切唤醒省 token；消息照记，结束后给被直接找过的会话补一次唤醒；一键填入 DeepSeek 高峰时段 | [SILENCE.md](docs/guides/SILENCE.md) |
| 人格切换即时生效（v1.1.0） | 二代仿真里切换 / 修改人格后，下一次唤醒（或选「立即」马上）把新卡交给各会话，不用等会话重建；记忆和群规则不动 | [roles/README.md](roles/README.md) |
| 长会话自动压缩（v1.1.1） | 二代会话上一步读的上下文超过阈值（默认 30 万 token，控制台可调 5～80 万，或交给 DSH 自己约 80 万时压）就在空闲时压缩一次；黑话表、表情块只在变化时完整注入。实测群 A 每步从 679k 降到 33k | [CONFIGURATION.md](docs/guides/CONFIGURATION.md) |
| 令牌抄错自动恢复（v1.1.1） | AI 把会话令牌抄错一两位时给出明确提示，连错 3 次自动换新令牌（不动会话和记忆）；二代里被拦的内部输出不再往群里发拦截通知 | [CHANGELOG.md](CHANGELOG.md) |
| 易用性（v1.1.1） | 定时静默可选「只在被 @ 或私聊时唤醒」；控制台「恢复默认人格」（改过的先备份）；总览页直接改发言上限、看被拦了几次；一键让 AI 看图补表情说明 | [SILENCE.md](docs/guides/SILENCE.md) |
| 按会话设置人格卡（v1.1.2） | 每个群 / 私聊可以单独用一张卡或不挂卡，没单独设置的跟随全局；管理员在 QQ 里发 `/role 名字` / `/role off` / `/role default` 只改当前会话；换卡只唤醒卡真的变了的会话 | [roles/README.md](roles/README.md) |
| 断线补收（v1.1.2） | 电脑睡眠、NapCat 重启等导致和 QQ 断开过，恢复后用历史消息接口补收错过的消息（带原始时间，AI 知道是迟到的）；补收到的命令和确认码一律不执行；拉取失败会重试 | [CONFIGURATION.md](docs/guides/CONFIGURATION.md) |
| 引用合并转发（v1.0.3） | 引用一条较早的合并转发时不再卡住整条消息；AI 能打开引用里的转发（含嵌套），读取结果缓存 | [CHANGELOG.md](CHANGELOG.md) |
| DSH 0.2.1 | 兼容 DSH 0.2.0-rc.2 与 0.2.1（v1.1.2 在 0.2.1-rc.2 桌面版上实测）；0.2.1 桌面版的随机端口自动识别、DSH 重启后自动跟上 | [DSH_020_ADAPTATION.md](docs/guides/DSH_020_ADAPTATION.md) |

### 部署（无窗口版）

需要：Node.js ≥ 22.13、DSH 桌面版或命令行版（0.2.0-rc.2 / 0.2.1，先在 DSH 里配好模型账号）、你自己安装并能登录的 QQ 后端
（**Windows**：SnowLuma 完整版或 NapCat.Shell；**macOS**：Mac 版 QQ + [NapCat Mac 安装器](https://github.com/NapNeko/NapCat-Mac-Installer/releases)；
**Linux**（x64 / arm64）：SnowLuma 2.x 完整版（`…-linux-x64.tar.gz` / `…-linux-arm64.tar.gz`，需要本机能运行 Linux 版 QQ）或 NapCat；
NapCat 要在它的 WebUI 里开启 WebSocket 服务端 `127.0.0.1:3001`）。本项目不下载、不安装 QQ 后端。

**第一次安装**（在项目目录的终端里，只做一次）：

| 步骤 | Windows（PowerShell） | macOS / Linux（终端） |
| --- | --- | --- |
| 装依赖 | `npm ci` | `npm ci` |
| 写配置 | `Copy-Item config.example.json config.json` | `cp config.example.json config.json` |
| 改配置 | 填 `ownerQQ`、`allow.groups` / `allow.private`、`dsh.provider`（[字段说明](docs/guides/CONFIGURATION.md)） | 同左 |
| 装到 DSH | `node scripts\setup-dsh.mjs`，然后**重启 DSH** | `node scripts/setup-dsh.mjs`，然后**重启 DSH** |
| 无窗口入口 | 已自带 `control-center-hidden.vbs` | **macOS**：双击一次 `control-center.command`，第一次运行会自动生成「QQ Bridge 控制中心.app」并在访达里选中它（也可以手动 `npm run mac-app`）<br>**Linux**：`npm run linux-service -- --enable`，生成并启动 systemd 用户服务（后台常驻、登录自动启动） |

`snowluma.*`（连接 QQ 后端的地址、令牌）不用手填，下面「接入桥接」会自动写好。可选：`npm run test:audit` 离线自检、`npm run admin:totp-setup`（L3 的 TOTP）。

**第一次启动**：

1. 双击无窗口入口（Windows：`control-center-hidden.vbs`；macOS：「QQ Bridge 控制中心.app」），浏览器打开控制中心。
   macOS 第一次会问「“QQ Bridge 控制中心”想访问其他 App 的数据」——点**允许**（要读 QQ 容器里的 NapCat 配置，只问一次）。
   Linux：服务启动后打开 `http://127.0.0.1:3099/#t=<state/control-center-token 的内容>`（有桌面时也可以双击「QQ Bridge 控制中心」启动项）；
   服务器上从别的电脑访问，先 `ssh -L 3099:127.0.0.1:3099 <服务器>` 转发。
2. **接口平台 → 概览**，在后端卡片上点「开启」：
   - Windows / Linux · SnowLuma：先在「接入实例 → 本机 SnowLuma 程序」里「浏览…」选中 SnowLuma 目录，再点「开启 SnowLuma」，第一次在它的 WebUI 里扫码；
   - NapCat：点「开启 NapCat」（Windows / Linux 先在「管理 NapCat 程序 → NapCat 设置」里选启动文件，Linux 再选 NapCat 目录）；要扫码时卡片上直接显示二维码。
3. **接口平台 → 设置**，点「接入桥接」。
4. **桥接** 标签点「启动桥接」。底部状态栏全绿（接口平台「1 账号就绪 · 桥接已接入」、QQ「在线 <机器人>」、DSH「已就绪」）即完成。

**日常**：双击无窗口入口 → 开启后端 → 启动桥接；退出用页面右上角「退出控制中心」（会一起停掉桥接、接口平台和它启动的 QQ 后端）。
更新项目或挪了目录后，macOS 重新运行一次 `npm run mac-app`，Linux 重新运行一次 `npm run linux-service -- --enable`。不要同时用 `start.bat` / `npm start` 和控制中心启动桥接。

给 DSH agent 执行的逐步部署说明（含检查命令、预期输出、常见错误、更新 / 备份 / 回滚）：**[docs/DSH_DEPLOYMENT.md](docs/DSH_DEPLOYMENT.md)**。
配置字段：[docs/guides/CONFIGURATION.md](docs/guides/CONFIGURATION.md)。测试：[docs/guides/TESTING.md](docs/guides/TESTING.md)。
变更：[CHANGELOG.md](CHANGELOG.md)。发布：[docs/release/PUBLISHING.md](docs/release/PUBLISHING.md)。

> ⚠️ 与上游的行为差异：控制台/DSH 设置/QQ 的模式变更都会通知 owner；未经管理通道授权的 closed-agent 不能建会话
>（从上游升级时若停在 closed-agent，会回落到 reserved2 并告警）；审批改为编号制。详见 CHANGELOG「变更」。
> 下文「完整启动流程（从零开始）」按「桥接直连 SnowLuma」写，那条路仍然可用，但推荐用上面的控制中心 + 接口平台。

---

> ⚠️ **当前版本 `v1.1.2`，适配 DSH 0.2.0-rc.2 与 0.2.1**（0.2.1-rc.2 桌面版上实测；协议面逐项核对：`npm run verify:adaptation`）。
> 鉴权用 `~/.dsh` 里持久化的浏览器会话签名密钥**离线铸造 Cookie**（DSH 0.1.7 起进程启动 token 只存在于内存、不再落盘）；
> agent preset 是 `@deepseek-ai/dsh-agent-preset` Cordis 行（由 `setup-dsh.mjs` 写入，旧的 `~/.dsh/.agent-presets/` 目录机制已废）。
> DSH 0.2.0 时的适配改动（会话待处理队列解析、QQ 安全守卫的工具名单对账等）见 [docs/guides/DSH_020_ADAPTATION.md](docs/guides/DSH_020_ADAPTATION.md)。
>
> 更老的 DSH 不受支持：**DSH `0.1.1-rc.2` 及更早**请用上游 tag
> [`v0.1.0`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.0)；**DSH 0.1.5-rc.1** 用
> [`v0.1.5`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.5)；**DSH 0.1.7-rc.2** 用
> [`v0.1.7`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.7)（这些是原版仓库的旧版本，本仓库不再维护）。
>
> 本仓库默认分支 `main` **就是**最新版本，`git clone https://github.com/h-D-ACE/dsh-qq.git` 直接拿到，无需切换分支；也可以下载 [Release ZIP](https://github.com/h-D-ACE/dsh-qq/releases)。

```
QQ 消息 ──► SnowLuma / NapCat（OneBot v11 WS，可经接口平台）──► 本桥接进程 ──► DSH Web API（命令行版 127.0.0.1:3080 / 桌面版自动识别）
                                                ▲                      │
                                                └── agent 回复/提问/审批 ┘
```

## 项目展示

📽️ [AI 仿真群友 - 项目介绍视频](https://github.com/Derpyu520/qq-bridge/releases/download/v0.1.5/project-intro.mp4)（约 11 MB，原版仓库 v0.1.5 的 Release 附件）

> 视频由原版仓库的 **Release 附件**托管，不在本仓库里——只想安装桥接的人不必再下载这 11 MB。内容是原版的功能介绍，增强版新增的功能见上面的表格。

## 架构

- **QQ 侧**：`@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11 WebSocket 客户端，自动重连）
- **DSH 侧**：适配 DSH 0.1.2 起引入、**0.2.0-rc.2 上逐项复核、0.2.1 上沿用**的协议——用本机持久化签名密钥铸造会话 Cookie 鉴权、`/api/<namespace>/<method>` 斜杠 RPC、`/api/remote.mux` + `session/follow` 事件流（`session/control` 的队列读 `value.projections[<id>].values.inbox`，另有一元 `session/projections` 主路径）；复用 `AbstractApiClient` 传输层但不再依赖旧版 zod value schema。会话模型由桥接按 `config.json` 的 `dsh.model` 逐会话 `session.selectModel` 固定（默认 `deepseek-flash` = DeepSeek-V41-Flash，多模态）
- **agent 自主收发 QQ**：DSH 的 MCP 客户端（`~/.dsh/profiles/web/cordis.patch.yml` 配置）接入三个 MCP server：
  - `snowluma`（桥接自带 `src/mcp-snowluma-safe.js`）：QQ 动作**安全子集**（查状态/查群/查消息/发消息，发送强制白名单；发送工具支持可选 `replyToMessageId` 引用回复）
  - `snowluma-host`（桥接自带 `src/mcp-host-server.js`）：**只有** `snowluma_status`（只读探活 `get_login_info`）。
    ⚠️ **v0.1.5 起移除了 `start_snowluma` / `stop_snowluma`**（以及 `snowluma.allowProcessControl` 配置项）——
    原因是 **SnowLuma EULA §5.4** 规定「将其并入第三方安装包或 Docker 镜像、**通过自动化脚本部署**」
    须事先取得书面授权，而原生组件属专有组件。本程序**只探测、不部署**：SnowLuma 的安装、启动与扫码
    始终由你自己完成（详见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)）。
  - `web-search-safe`（桥接自带 `src/mcp-web-search-safe.js`）：只读 `web_search` / `web_fetch`（带 SSRF 防护），供 agent 查网络用语/资料。
    ⚠️ 它会把**搜索关键词发给 Bing**、并按模型决定抓取公网 URL；**黑话学习默认开启**，会拿群聊里提取的词条去搜。
    数据出机清单见 [LICENSE](LICENSE) 的「数据出机清单」，不需要就关掉黑话自动研究（`slang.autoResearch`）。
- **会话模型**：每个 QQ 会话（私聊/群）对应一个独立的 DSH 会话，统一归组到「QQ 聊天」工作区（不再散落未分组）；映射持久化在 `state/sessions.json`
- **性格定制**：QQ 会话默认使用 `qq-chat` agent preset，`reserved2` 使用 `qq-chat-v2`。DSH 0.1.7 起 preset 不再是 `~/.dsh/.agent-presets/<名>/` 目录，而是 `plugins/qq-agent-presets/` bundle 生成并插入 profile 的一条 `@deepseek-ai/dsh-agent-preset` 行（重启 DSH 后生效）；人格与默认 DSH 一致（coding agent），仅附加 QQ 场景规则；**角色扮演**是可选机制——由控制台或管理端设置 `state/current-role.json` 注入（群友无法更改）
- **本地控制台**：桥接自带 Web 控制台 `http://127.0.0.1:3100`——左侧按操作任务分为「运行总览 / 会话与审批 / 人格与角色 / 二代仿真 / 一代仿真 / 黑话词库 / 定时任务 / 令牌与花费 / 访问与安全 / 调试与运维 / 工具参考」十一个页面，右上角搜索框可跨页定位任意功能项；支持**浅色 / 深色双主题**（顶栏一键切换，未选择时跟随系统）；切换运行模式（chat / closed-agent / reserved / reserved2）、设置角色、静默开关（含定时静默时间段）、查看活动日志、修改管理员/控制台令牌，全部即时生效；访问需要令牌（`config.json` 的 `consoleToken`，未配置时自动生成并打印在启动日志；控制台内可手动修改或重新生成）
  - **令牌与花费看板**：实时显示 AI 的 token 消耗与折算金额（元），可下钻到**每个群 / 每个好友 / 每一轮对话**（轮次、步数、缓存命中/未命中输入、输出、命中率、花费、峰谷时段），并有**按时间的消耗走势图**（24 小时 / 3 天 / 7 天 / 30 天，柱子按高峰/空闲着色，一眼看出什么时候烧得凶、哪几个小时是 2 倍价）。累计总量取自 DSH 的 `tokenUsage` 投影（精确，含桥接启动前的历史），逐轮明细由 `assistant/message` 的 `usage` 折叠而来；金额按 DeepSeek 官方价目表折算并区分**高峰 / 空闲时段**（高峰单价为空闲的 2 倍，已内置中国法定节假日）。详见 [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)
  - **人格（角色扮演）管理**：列表点选即可载入查看/编辑提示词，支持新建、保存修改、改名（自动重命名文件）、另存为副本、删除；超过注入上限或含一代专用指令会实时提示；切换或保存当前人格时可选二代仿真里「下次唤醒时重新读卡」或「立即」生效
  - **两层提示词可分别查看与修改**：「仿真提示词」（预设内置，管行为与协议，保存后同步到 DSH，需重启生效）与「人格提示词」（`roles/*.md`，管人设与语气，保存即生效：聊天 / 一代仿真下一条消息生效，二代仿真下一次唤醒或立即生效）；仿真层保存前做安全不变量校验与自动备份，可一键还原
  - **DSH 模型与思考强度**：提供方 / 模型 / 思考强度三个下拉联动，选项来自 DSH 的模型目录（能用上 DSH 里配好的其它提供方），保存后下一条消息生效；默认仍是 `deepseek-flash` + `max`。换到第三方提供方会提示隐私，不能看图的模型自动把图片改成文字，价格未覆盖的模型标「估算」；控制台会明示该设置同时写入 DSH 全局默认（`~/.dsh/settings.yaml`）
- **运行模式**：
  - `chat`：白名单群 + 白名单私聊 → qq-chat 安全聊天
  - `closed-agent`：仅私聊 owner（config.json 的 ownerQQ，可在控制台设置）→ 完整工具（默认用 DSH 自己声明的默认 preset，即 `standard`；可在控制台「closed-agent preset」下拉改为任意 DSH preset），可在 QQ 上操控 DSH
  - `reserved`（一代仿真）：仿真群友，观望/活跃/试探/退场状态机，选择性参与、按空格分句发送、主动收尾
  - `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后 DSH 默认）：文本不自动转发，AI 通过 `qq_get_unread_messages` / `qq_send_message` 等工具自主看消息、发言、等待、设置唤醒/潜水；DSH 端使用 `qq-chat-v2` preset
- **交互增强**：
  - agent 通过 `ask_user_question` 提问时，问题会转发到 QQ，回复即自动应答
  - agent 请求工具审批时，转发到 QQ，回复「通过」/「拒绝」即可决策
  - 支持 DSH 斜杠命令（如 `/model`）与 `/reset`（重置会话上下文）
  - 群聊引用/回复会解析成「被引用人 + 原文」注入 DSH（如 `[引用 Derp：El Psy Kongroo是啥]机关的走狗`），让 AI 判断这句话是对谁说的，不会把群友之间引用第三方的对话误当成指向自己；引用机器人自己时会被视为必回
  - MCP 发送工具支持可选 `replyToMessageId`，并新增专用 `qq_reply` 工具：AI 可以先用 `qq_get_group_history` 拿到真实消息 id，再引用/回复某条消息（是否允许 AI 主动使用由人格/策略决定；桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - 一代仿真模式（`reserved`）下，AI 可以只输出 `[SILENT]` 表示“潜水/不接话”，桥接会静默不发送
  - 一代仿真模式（`reserved`）按空格分句：AI 用空格表示拆成多条消息；中英文/数字之间的空格也会被当成分条信号，不想分条就不要加空格（`reserved2` 不适用，分条请用 `qq_send_message` 数组）

## 前置条件

1. 运行中的 DeepSeek Harness（0.2.0-rc.2 或 0.2.1；命令行版默认 `http://127.0.0.1:3080`，桌面版端口自动识别）
2. 运行中的 SnowLuma（或 NapCat，推荐经控制中心 + 接口平台接入），且配置好 OneBot WebSocket 与 HTTP API（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，`accessToken` 视配置填写）
3. Node.js ≥ 22.13

## 安装与配置

```bash
npm install        # 安装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug）
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址；留空（默认）= 自动识别：桌面版 0.2.0 固定 `http://127.0.0.1:19387`、0.2.1 每次启动换随机端口（自动跟上），命令行版 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` / `dsh.vision` | DSH 会话使用的模型 / 推理强度 / 看图能力；建议在控制台「DSH 模型与思考强度」里选（选项来自 DSH 模型目录，保存即生效），说明见 [CONFIGURATION.md](docs/guides/CONFIGURATION.md)（选择失败只打日志，不阻塞启动） |
| `dsh.authToken` | DSH launch token（进程启动凭据）。**通常应留空**：留空时桥接用 `~/.dsh/.credentials.yaml` 里持久化的签名密钥**离线铸造**会话 Cookie，不依赖任何进程期状态（DSH 0.1.7 起启动 token 只存在于内存、日志里那条是上一个进程的陈旧值，换 Cookie 只会 401）。只有显式填了才会优先走 token 交换 |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段，当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.followDiscoveredEndpoint` | 默认 `true`。换 QQ 账号后 token 与端口都会变，桥接会自愈：重新发现并**跟随** SnowLuma 的端点（同时写回 `config.json`）。**想跑第二个实例 / 指向另一份 SnowLuma 安装（多账号、测试）时设为 `false`** —— 那时只自愈 token，绝不动 URL，也不写回 URL。详见「已知行为」 |
| `snowluma.silenceWarnMs` | 上游静默告警阈值（毫秒），默认 `600000`（10 分钟）。已连接但这么久没收到任何事件包（含心跳）时打警告；这只是**提示**，不确定性的判断交给 `good` |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 安装目录（用于 token/端点自发现）。⚠️ 桥接**不会**启动或停止 SnowLuma（见 `LICENSE`） |
| `agentPreset` | QQ 会话使用的 DSH agent preset，默认 `qq-chat`（改性格见下文） |
| `socialV2.agentPreset` | `reserved2` 模式使用的 DSH agent preset，默认 `qq-chat-v2` |
| `workspaceTitle` | QQ 会话在 DSH 界面中的归组名称，默认「QQ 聊天」 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组）；留空且 `allowAllWhenEmpty: true` 时放行全部 |
| `deny.*` | 黑名单，优先于白名单 |
| `ackMessage` | 消息投递后的立即回复，空字符串关闭 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 控制台访问令牌；留空时启动自动生成并保存到 `state/console-token` |

> ⚠️ `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」——把 agent 接入 QQ 等于把账号控制权交给了模型，建议先填白名单。

### DSH 端安装（必做：装 preset + 挂 MCP）

桥接和控制台能跑起来还不够，DSH 端还需要安装两个聊天 preset（`qq-chat` / `qq-chat-v2`）并挂载 MCP。**单机新装同样必须执行这一步**（不是只有「另一台设备」才需要），装完还要**重启 DSH**：

```bash
node scripts/setup-dsh.mjs
```

> 全新环境下脚本会把 DSH 默认模式设为 **`reserved2`（二代仿真）**，并创建本地 `state/mode.json` 兜底；这样 AI 使用 `qq_send_message` 等工具收发消息时，DSH 会自动使用 `qq-chat-v2` 模式。如果本机已存在旧的 `state/mode.json` 或 DSH 设置值，脚本会保留不覆盖。之后可在**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部按钮切换模式，控制台会同时写入 DSH 设置与本地兜底文件。

详细步骤见 **[docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

共 6 步。DSH 已安装并运行，缺的是 SnowLuma 本体 + 桥接侧的 DSH 端安装（**第 2、3 步最容易漏，漏了 QQ 上会毫无反应**）：

1. **DSH**（已运行，无需操作）
   命令行版确认 `http://127.0.0.1:3080` 能打开；桌面版开着即可（端口由桥接自动识别）。

2. **装桥接并复制配置**
   ```bash
   git clone https://github.com/h-D-ACE/dsh-qq.git
   cd dsh-qq
   npm ci
   ```
   Windows CMD 用 `copy config.example.json config.json`，其他平台用 `cp config.example.json config.json`。
   **示例模板里 `allow.private` / `allow.groups` 是空数组**——空白名单 + `allowAllWhenEmpty: false` 时桥接不响应任何消息（这是刻意的 fail-closed 默认值）。白名单在第 5 步填。

3. **装 DSH 端（preset + MCP），然后重启 DSH**
   ```bash
   node scripts/setup-dsh.mjs
   ```
   装完**必须重启 DSH**——preset 与 MCP 只在 DSH 启动时加载。
   跳过这步桥接不会崩，但群聊会话拿不到 `qq-chat` preset，桥接会**拒绝建会话**（有意的安全设计：绝不回退到带 bash/文件工具的默认 preset），表现同样是 QQ 上没反应。

4. **下载并解压 SnowLuma**
   - 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版，自带 Node 运行时；Lite 版需本机 Node 22.13+）
   - 解压到任意目录（例如 `C:\SnowLuma`），双击 `launcher.bat`

5. **首次引导（WebUI）+ 填写桥接配置**
   - 打开启动日志里的 WebUI 地址（README 写的是 `http://localhost:5099`，以你启动日志里实际打印的为准）
   - 用**启动日志中的初始密码**登录，按引导：同意条款 → 设置密码 → 接入 QQ 进程（扫码登录）
   - 在 WebUI 里配置 OneBot 连接：开启 **WebSocket 服务端** 和 **HTTP API**，分别记下**端口**（默认 WS `3001`、HTTP `3000`）和 **accessToken**（若配置了）
   - 回到 `config.json` 填好 `snowluma` 段，并把 `allow.private` / `allow.groups` 换成**你自己的 QQ 号 / 群号**：

     ```json
     "snowluma": {
       "wsUrl": "ws://127.0.0.1:3001",
       "httpUrl": "http://127.0.0.1:3000",
       "accessToken": "你在 WebUI 里配置的 token（没配置就留空）"
     }
     ```

   `wsUrl` 是 OneBot **WebSocket** 端口，`httpUrl` 是 OneBot **HTTP API** 端口（不要填成同一个 WS 端口，否则 MCP 工具会报 HTTP 426）。

6. **启动桥接**
   ```bash
   npm start          # 前台运行（崩溃不自动重启）
   ```
   看到 `SnowLuma 已连接` 即成功；然后 QQ 上给机器人账号发条消息测试。
   Windows 想要「崩溃自动重启」请改用 `start.bat`（见下节）。

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（自动杀旧实例 → 清理锁 → 重新启动守护）
- **重启 DSH 通常不需要动桥接**：每 5 秒探活，DSH 不可用期间收到的 QQ 消息在桥接进程内排队（最多 50 条/会话，满后丢最旧项），恢复后尝试补投。桥接进程退出会丢失内存队列；断线期间已经结束的回复暂不保证补发。
- 修改 `config.json` 后重启桥接生效；人格（`roles/*.md`、当前角色）在控制台里改即生效，不用重启（二代仿真里下一次唤醒或选「立即」时生效）；修改 `dsh/agent-presets/`（改完要跑 `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch）或 MCP 配置后重启 DSH 生效

日志示例：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 新会话 private:12345678 -> sess_xxxx
12:00:02 [bridge] 已投递 private:12345678: 你好
12:00:20 [bridge] agent 回复 (private:12345678) 42 字
```

## 自测（不需要 SnowLuma / QQ）

离线回归（使用临时目录和模拟服务，不读取真实配置、不发 QQ 消息）：

```bash
npm run test:audit
```

reserved2 的 token 开销优化、消息水位协议、升级及回退说明（该专项分析为本地文档，未随仓库发布。）专项离线回归可运行 `npm run test:token`，已包含在上面的完整回归中。

控制台「令牌与花费」看板的账本与价目表回归（峰谷分时、幂等折叠、基线合并、压缩与容错）：

```bash
npm run test:tokens        # 单元测试
npm run test:console-ui    # 离线浏览器回归（含看板渲染与逐轮下钻）
```

本轮审查与修复明细为本地审计文档，未随仓库发布。升级后会为没有权限元数据的历史映射重建一次 QQ 会话；模式或 preset 变化也会自动重建，避免保留旧权限。旧历史仍在 DSH 中。

验证 DSH 侧链路是否打通（会创建一个独立测试会话，不影响现有会话）：

```bash
npm run self-test
```

预期输出：连接成功 → 测试会话创建 → prompt 被接受 → 打印 agent 回复。

## 目录结构

```
qq-bridge-enhanced/      # 克隆下来的目录名是 dsh-qq
  config.example.json   # 配置模板（脱敏占位符；真实 config.json 不入库）
  README.md / README.en.md / RULES.md   # 根目录只留这三个文档，其余全在 docs/
  docs/
    README.md           # 文档索引（每篇一句话 + 是否仍然有效）
    FOLDER_MAP.md       # 目录结构与 scripts/ 命名约定
    guides/             # 面向使用者/运维的说明（配置、部署、管理通道、定时任务、定时静默、语音、令牌看板……完整列表见 docs/README.md）
    release/            # 发布说明与发布流程
    （design/ research/ audits/ 是本地开发文档，不随仓库发布）
  audio/                # 语音库（自己建，不入库）：把准备好的音频放这里，AI 可作 QQ 语音发出（用法见 docs/guides/VOICE.md）
  dsh/agent-presets/    # qq-chat / qq-chat-v2 的 DSH agent preset 模板
  plugins/qq-mode-console  # DSH 插件：注册 qq-mode 设置命名空间（仅 host 半，UI 卡片未实现）
  plugins/qq-agent-presets # DSH preset bundle（setup-dsh.mjs 装进 DSH）
  interface-platform/   # 接口平台：桥接与 QQ 后端之间的统一接入层
  roles/                # 人格（角色卡）
  src/
    bridge.js           # 主程序（只负责接线；新功能都是 src/ 下的独立模块，如 scheduler/、silence-schedule.js、role-refresh.js、mode-handover.js）
    launcher/           # 控制中心
    dsh-client.js       # Node 版 DSH API 客户端（WS 下行）
    md-to-plain.js      # Markdown → QQ 纯文本
    self-test.js        # DSH 侧自测
  scripts/              # 测试/运维脚本（含 postinstall 的 patch-snowluma-sdk.mjs）
    patch-snowluma-sdk.mjs  # 修补 SDK 的 ESM 打包 bug（postinstall 自动执行）
  state/                # 运行时数据（不入库）
```

> 🎤 **独立的「发语音」工具不在这里**：它是仓库上一级的 [`../voice-tool/`](../voice-tool/)（`voice-cli.mjs` /
> `voice-gui.mjs` / `public/voice.html` / `发语音.cmd`）。图形界面双击上一级的「发语音-图形界面.cmd」。
> 它只依赖 SnowLuma，共享内核仍由本仓库 `src/voice-core.js` / `src/snowluma-conn.js` 提供（单一实现）。
>
> ```bash
> cd ../voice-tool
> node voice-cli.mjs status     # 账号/token 自动发现 + 连通性
> node voice-cli.mjs list       # 可发的群聊/私聊 + 语音库
> node voice-cli.mjs            # 交互菜单
> node voice-gui.mjs            # 图形界面（本地小服务 + 浏览器 UI）
> ```

## SnowLuma 版本与上游健康（「连上了但收不到消息」）

「注入」在这个技术栈里只发生在一处：**SnowLuma 用原生组件挂进 QQ 客户端进程**（它自己日志里叫
`[Hook]`，载体是安装目录的 `native/snowluma-win32-x64.{dll,node}`）。**本桥接没有任何原生/注入面**
（依赖全为纯 JS，源码里没有 `.dll` / `.node` / FFI / 进程注入），也不启动、不控制 SnowLuma 或 QQ ——
所以「QQ 注入失败」不可能是本桥接造成的。但**桥接过去无法把这个失败讲清楚**，于是它经常被误报成
「qq-bridge 的问题」。现在桥接会主动把上游健康报出来。

### 已知行为：连上了 ≠ 收得到

SnowLuma 的 `[Hook]` 会退化：它的进程和 OneBot WebSocket **都还活着**，但收不到 QQ 侧的数据。
它自己的日志长这样：

```
WARN [Hook] receive path stale: PID=… UIN=… silentFor=136193ms; reporting good=false
WARN [Hook] process enumeration timed out after 4000ms (worker abandoned)
```

这时桥接这边**一切正常**：WebSocket 通、日志打过 `SnowLuma 已连接`、控制台没有异常，但群里一条消息都不来。
桥接现在对此做两件事：

1. **主信号**：每 30 秒一次的 `meta_event/heartbeat` 载荷里的 `status.good`（SnowLuma 对「QQ → 原生 hook → 我」这条**接收链路**的自评，静默约 105 秒后翻 `false`）。心跳是 SnowLuma 自己的定时器无条件发的，所以这条信号免费且及时，且不需要较新的运行时。
   兜底：每 60 秒问一次 `get_status`（`{online, good}`）。加分项：`bot_status`（账号会话上下线，**SnowLuma 1.14.20 才真的有**）+「距最近一个事件包的时长」（只能证明进程/WS 还活着，**不能**证明收得到 QQ 数据 —— 心跳会一直来）。
   > ⚠️ **不要用 `get_login_info` 取 `good`**：它只返回 `{user_id, nickname}`，而 SDK 不校验 data 载荷 ⇒ 不会报错、`good` 永远是 `null`、这条判断变成永不触发的死代码。（v0.2.1 的第一版实现正是这么写错的。）
2. 判定退化时：日志打**明确指向 SnowLuma `[Hook]`** 的警告、控制台「运行总览」出现 `SnowLuma 上游` 卡片、
   「访问与安全」页出现告警条，`GET /api/status` 的 `snowluma` 字段给出 `degraded` / `good` / `hint`。

排查顺序：控制台看 `SnowLuma 上游` 卡片 → 看 SnowLuma 的 `logs/snowluma-*.log` 里的 `[Hook]` 行 → 再考虑升级 SnowLuma（**升级不换原生组件，见下**）。

### 版本要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| SnowLuma **运行时**（QQ 网关本体） | **1.14.20 已实测**（1.14.9 亦兼容） | **实测记录（2026-10-03，SnowLuma 1.14.20 + QQ 在线）**：包 SHA256 与官方发布摘要一致；心跳 `status.good=true`／`interval=30000`；桥接走完「首次 1006 → 自愈 WS token → 已连接」；收到群消息（`lastPacketKind: message/group`）；完整往返成功（唤醒 → DSH 建会话挂 `qq-chat-v2` → 工具发送 1/1 条 → 实际发出两条回复）。 ⚠️ **升级运行时不会更换注入用的原生组件**：实测 `native/snowluma-win32-x64.{dll,node}` 与 `websocket-win32-x64.node` 在 **1.14.9 与 1.14.20 之间逐字节完全相同**（三方对比：官方 1.14.9 包 == 本机安装 == 官方 1.14.20 包），变的只有 `index.mjs`（+414 KB）等 JS 层。所以**升级能带来 OneBot 事件流水线、收发与新区块链路上的修复（`bot_status`、markdown 带 text、事件种类订阅更全），但不会修「原生 hook 挂不上 QQ」这类问题** —— 那种要走 SnowLuma 自己的排查。**升级 SnowLuma 是使用者自己的事**：本桥接只探测、不部署（见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)） |
| `@snowluma/sdk` / `@snowluma/mcp`（本仓库依赖） | 已钉 `^1.14.20` | 客户端库；OneBot v11 是稳定契约，新库可连旧运行时（本项目实测：库 1.14.20 + 运行时 1.14.9 可正常收发） |
| `bot_status`（账号上下线） | **1.14.20 有；1.14.9 没有** | 逐一核对的只有这两个版本：`bot_status` 在 1.14.9 的 `index.mjs` 里出现 **0** 次、1.14.20 里 **3** 次（带 `sub_type`/`user_id`）。**具体从哪个版本引入未逐版核对**。桥接对老运行时**优雅降级**：订阅不到就只靠心跳 `good` 与 `get_status` |

### 已知行为：HTTP token 与 WS token 是**两个不同的值**

SnowLuma 同一个账号的 **HTTP token（默认 3000 端口）与 WebSocket token（默认 3001 端口）并不相同**
（实测；`snowluma.accessToken` 里通常只能存一个 —— 存的是 HTTP 那个）。因此：

- **桥接每次启动的首次 WS 连接几乎必然失败一次**（日志里 `SnowLuma 连接断开（code=1006）` →
  `SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）`），随后自愈重新发现 WS token、
  重连成功，才打出 `SnowLuma 已连接`。**这条序列是正常的，不是故障。**
  有的 SnowLuma 版本握手被拒时不发 close、只记一行 `SnowLuma 错误: … non-101 status code`，
  这时由 v0.4.1 的连接看门狗兜底（10 秒起、最长 60 秒间隔重试并顺带自愈 token），同样会恢复。
- 真正会一直连不上的情况：**自愈无从下手** —— `snowluma.homeDir` 没配 / 被移动 / 读不到
  SnowLuma 的 `config/onebot_<QQ号>.json`，或权限不足。这时日志里会有 `token 自愈失败`，
  而 QQ 侧表现为**完全收不到消息**。先确认 `homeDir` 指向真正的 SnowLuma 安装目录。

### 已知行为：端点自愈会覆盖你写的 `wsUrl`

换 QQ 账号后 OneBot 端口与 token 都会变，所以桥接在连不上时会自愈：重新发现 SnowLuma 的端点并
**写回 `config.json`**。这在主场景下是对的，但它不区分「配置里是个过期值」和「你就是要指向别处」——
想跑第二个实例或指向另一份 SnowLuma 安装时会连错账号。要关掉：

```json
"snowluma": { "followDiscoveredEndpoint": false }
```

关掉后**只自愈 token**（换账号仍能恢复），绝不动 URL、也不写回 URL。

## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 `socialV2.send.maxMessageChars`（默认 500 字，可用 `social.maxReplyChars` 调整）自动按句读/URL 边界分段
- 图片及部分表情可以通过安全下载接入多模态模型；语音/视频以及无法取得图片字节的消息仍使用占位文本
- **发**语音是支持的（独立工具的图形界面 / 命令行 / AI 工具，见 `docs/README.md` 的文档索引）；但**收**到的语音目前只显示占位文本，不做语音转写入上下文
- **AI 发网上的图默认关闭**（`socialV2.tools.webImage`）：打开后只在管理员私聊里能「找一张 xxx 的图发我」，必须先看图再发，图由桥接安全下载；搜索词会发给 Bing
- **AI 发语音默认关闭**（`socialV2.voice.enabled` 与 `tools.sendVoice` 默认 `false`）：先把音频放进 `audio/`，在 `config.json` 里打开 `socialV2.voice.enabled`、在控制台「二代仿真 → 工具开关」勾上 `qq_send_voice`，再重启 DSH；AI 只能发语音库里现成的音频，不能把任意文字念出来（没有文字转语音）；你自己发语音不受这个开关影响
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
