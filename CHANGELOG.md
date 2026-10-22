# CHANGELOG

本仓库（qq-bridge-enhanced）基于上游 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) `v0.2.0-r3`。
上游更早的版本历史见 [docs/guides/DSH_020_ADAPTATION.md](docs/guides/DSH_020_ADAPTATION.md) 与上游 Release 页面。

## v1.1.0 —— 2026-10-22

新功能版本：**定时任务**（按时区到点发消息或叫 AI 来说）、**定时静默**（按时间段让 AI 停下来省 token）；**切换 / 修改人格在二代仿真里真正生效**（以前要等会话重建）；切到 agent 时可以带上私聊长期记忆。
发布说明：[docs/release/RELEASE_NOTES_v1.1.0.md](docs/release/RELEASE_NOTES_v1.1.0.md)。

### 升级注意（从 v1.0.3）
- 沿用 `config.json`、`state/`、`interface-platform/state/`；执行 `npm ci`，重启控制中心（桥接和接口平台都要重启才会用上新代码）。
- **要重启一次 DSH**：新的 MCP 工具 `qq_schedule_*` 由 DSH 启动的 MCP 服务注册，只重启桥接时 AI 还看不到它们。preset 没有变化，不需要重跑 `setup-dsh.mjs`。
- 新增的状态文件（都在 `state/` 里、0600）：`scheduler.json`（定时任务）、`silence-schedule.json`（定时静默）、`role-seen.json`（各会话读到的角色卡版本，只存指纹）。没有旧数据格式变化。
- 升级后第一次唤醒，已有的二代会话会各收到一次当前角色卡（之前没有读卡记录），之后只在换卡时再给。

### 修复：二代仿真切换 / 修改人格后会话仍用旧角色卡
- 用户反馈：控制台切换人格后，群里 AI 的语气没变，像是「切换失败」。原因是二代仿真的会话只在建立时的引导唤醒里调用一次 `qq_get_prompt` 读完整角色卡，之后每次唤醒只有一行「【当前角色】名字」；切换、清除或修改当前人格都要等会话重建才生效。
- 现在桥接按「会话 + 角色卡指纹」记下每个会话读到的是哪一版卡（AI 调用 `qq_get_prompt`，或唤醒提示带着新卡被 DSH 接受时记下；只存指纹，不存内容）。
  指纹对不上时，下一次唤醒把新卡全文放在提示最前面，并说明旧卡作废；记忆、群规则和会话都不动。引导唤醒不重复给。
- 控制台「人格与角色 → 切换当前启用的人格」新增生效方式：**下次唤醒时重新读卡**（默认）/ **立即切换**（马上给还没读到新卡的会话各安排一次 `roleRefresh` 唤醒；已读到的跳过，定时静默中的等静默结束）。切换后显示有几个会话会读到新卡。
- 「编辑人格提示词」的保存按钮下方也有同样的生效方式（只对当前启用的人格起作用；编辑其它人格不影响任何会话）。两处选项各管各的按钮，两处都点也只会让每个会话读一次：已读到新卡的会话自动跳过，还在合并窗口里的读卡唤醒不会重复排。
- 升级后第一次唤醒，已有的二代会话会各收到一次当前角色卡（之前没有读卡记录）。
- 聊天模式 / 一代仿真每条消息都注入角色卡，本来就立即生效，不受影响。`roles/README.md` 里「下一条消息即生效」的说法按模式分开写清楚。
- 新模块 `src/role-refresh.js`；新测试 `scripts/test-role-refresh.mjs`。

### 新功能：定时静默（运行总览 → 静默开关）
- 按时间段自动让 AI 停下来省 token：多个时间段，各带开关；哪些天 = 每天 / 工作日 / 周末 / 自选（可跳过法定节假日）；跨午夜以开始那天为准；带 UTC 偏移的时区下拉。
  说明见 [docs/guides/SILENCE.md](docs/guides/SILENCE.md)。
- 「一键填入 DeepSeek 高峰时段」取自价目表（北京时间工作日 09:00–12:00、14:00–18:00，跳过节假日），不重复添加。
- 静默期间默认：**停止一切唤醒**（原来的手动静默只拦发送、AI 仍被定时唤醒去思考，照样花钱）、群消息照样记进未读、结束时给被直接找过的会话补一次唤醒、
  定时任务「叫 AI 来说」暂停（任务可单独设「静默时段内：照常执行」，预览会标出会跳过的那几次）、固定文字照发、管理员私聊不受影响（可勾选一起静默）。
- 手动开关优先；定时静默期间点「恢复正常」= 这一段临时恢复，下一段照常。`/api/status` 带上静默来源，卡片显示「静默中 · 定时（名称），到 HH:mm」。
- 静默开关卡片改成整行宽的普通布局（原来的紧凑两栏会把新面板挤在一栏里）。
- 定时任务页面的「群消息免打扰」改名为「定时任务免打扰」，并注明只拦定时任务发往群的消息、不影响 AI 平时被 @ 时回复。
- 新模块 `src/silence-schedule.js`；新测试 `scripts/test-silence-schedule.mjs`；控制台离线夹具接入真实的静默模块。

### 改进：切到 agent 时可以带上私聊长期记忆
- 用户反馈：切到 agent L2 后「没有 qq-chat-v2 的记忆」。交接原本只带最近的私聊往来；现在可以把二代仿真里 AI 在管理员私聊记下的话题 / 想说的话 / 印象一并交接给 agent（最多 1500 字，逐行脱敏；只取管理员私聊，不含任何群）。
- 开关在控制台「二代仿真 → 工具开关」的「切到 agent 时带上私聊长期记忆」（`socialV2.tools.handoverMemory`，默认开）。同一处补上了定时任务工具 `qq_schedule_*` 的开关。
- 文档补充：桥接重启时 agent 会话按安全规则回落归档；交接记录从升级到 v1.0.3 后才开始记。
- `test-mode-handover.mjs` 新增 ⑥。

### 新功能：定时任务（第一阶段）
- 桥接控制台「聊天行为」下新增「定时任务」页面：总开关、默认时区（出厂北京时间）、AI 登记开关、可改的安全限制（留空恢复默认）、任务列表（启用 / 试发 / 编辑 / 删除）、
  新建与编辑表单（实时预览接下来 5 次）、执行记录。说明见 [docs/guides/SCHEDULER.md](docs/guides/SCHEDULER.md)。
- 重复方式：一次性 / 每天 / 每周 / 工作日 / 每月几号 / 每月第几个周几 / 每年 / 特殊日期 / 每隔 N 天 / 每隔 N 分钟 / 每天随机几次 / 每月随机几次 / **高级：cron 表达式**（只能在控制台设置）；
  都可以加开始 / 结束日期、排除日期、跳过法定节假日、共执行几次后停止。随机时刻按「任务 + 日期」确定，重启不重抽。
- 内容：固定文字（桥接直接发；发给管理员时任何模式都能发）或叫 AI 来说（唤醒那个会话自己的 AI，提示里带上【定时任务】）。
- 发送对象：管理员私聊、白名单好友、白名单群，可多选。时区按任务计算，与机器时区无关；时区下拉列出全部时区并带当前 UTC 偏移（如「Asia/Shanghai（UTC+8，北京时间）」），时间文字也带偏移。
- 安全：总开关和限制只能在控制台 / 管理员命令里改；AI 只能在管理员私聊里用 `qq_schedule_*` 登记，默认只能发给管理员私聊，发往群的要开关并且先暂停待确认；
  登记后桥接另发确认；限额（任务数、每任务 / 每天 / 每群条数、最小间隔）、定时任务免打扰（只拦定时任务发往群的消息）、固定时间随机偏移、错过补发窗口；新建 / 修改 / 删除写入审计日志。
- 管理员私聊命令 `/remind`（桥接直接处理，不进模型）。
- 新模块 `src/scheduler/`（time / schedule / engine / commands / notes）；新 MCP 工具 `qq_schedule_create / list / update / delete`（工具开关 `socialV2.tools.schedule`，默认开）。
- 新测试 `scripts/test-scheduler.mjs`；控制台离线夹具接入真实的调度引擎（假发送）。
- 已知限制：「工作日」不含调休上班的周末（内置节假日表只有放假日）；农历日期、AI 没发出时的备用文字、导出 / 导入留到第二阶段。

## v1.0.3 —— 2026-10-21

在 v1.0.2 的基础上的修复版本：**切换 agent 等级不再失忆**；引用一条（较早的）合并转发时，AI 能看到并打开里面的内容，这条消息也不再卡 30 秒；普通图片不再被误当成表情。
发布说明：[docs/release/RELEASE_NOTES_v1.0.3.md](docs/release/RELEASE_NOTES_v1.0.3.md)。

### 升级注意（从 v1.0.2）
- 沿用 `config.json`、`state/`、`interface-platform/state/`；执行 `npm ci`，重启控制中心（桥接和接口平台都要重启才会用上新代码）。没有数据格式变化，不需要重跑 `setup-dsh.mjs`。

### 修复：切换 agent L1~L3 / 自动回落后 AI「失忆」（设计缺陷）
- 现象（用户反馈）：切到 agent 会自动回落到二代仿真，回落又把 DSH 会话归档，「一用 L2 就几乎失忆」。原因：每次模式 / 级别切换，桥接把**所有**会话退役归档再新建，
  连从没挂过工具的群聊会话也一起归档；新会话里也没有任何「刚才聊到哪了」。
- 新模块 `src/mode-handover.js`：
  - **聊天会话休眠复用**：进 closed-agent 时，非 closed-agent 建的、带明确 preset 的会话（qq-chat / qq-chat-v2）不归档，只停在途工作、撤销映射、轮换令牌，
    记进 `sessions.json` 的 `dormantSessions`；回到同一模式、同一 preset 时原样复用（DSH 侧已不存在则新建）。过期（`admin.dormantMaxMs`，默认 24 小时）、
    模式 / preset 不同、不再被允许、`/reset`、清空工作区时归档。群会话恢复后第一条消息带一句休眠提示。
  - **owner 私聊交接**：`state/admin/owner-transcript.json` 记 owner 私聊往来（最多 60 条，0600，路径 / 凭据打码；只记 owner 发的和模型真正发出去的，
    管理通道命令 / 确认码 / TOTP 本来就不交给模型、不会进来）。owner 会话因切换换新时注入最近往来，从休眠恢复时注入 agent 期间的往来，标明「不是新指令」；不含任何群聊原文。
  - 高权限会话不休眠：agent 会话回落、`/panic`、L1→L2 仍然停掉并归档。
  - 休眠保留「已引导 / 已看过的消息」：恢复后按正常原因唤醒，不再重发一遍首次引导（`【引导唤醒】`、初始提示词）、不把看过的消息重新喂一遍；休眠作废归档时才清，下一个新会话照常引导。（本机实测发现：恢复后曾多发一次引导唤醒。）
- 新配置 `admin.hibernateChatSessions`（默认 true）、`admin.dormantMaxMs`、`admin.handover`（默认 true）；文档 `ADMIN_CHANNEL.md` 新增「切换不失忆」。
- 新测试 `scripts/test-mode-handover.mjs`；测试夹具补注入 `role-card.js`（以前 agent 模式下 owner 私聊这条路径在夹具里跑不通）。

### 修复：引用合并转发时内容丢失、整条消息卡 30 秒
- 现象：群友引用一条（较早的）合并转发，AI 只看到「[引用消息]」，这条消息也晚了 30 秒才进未读。实测 macOS NapCat 4.18 读这种消息 `get_msg` / `get_forward_msg` 都要约 76 秒，而 SDK 和接口平台都只等 30 秒。
- 新模块 `src/quote-forward.js`：慢取缓存（后台长超时 120 秒、并发去重、成功缓存、失败短暂负缓存）与「最多等一会儿」。
- 收消息时引用解析最多等 4 秒（同一条消息里只解析一次，判断「是否引用机器人」复用结果），等不到先放带 id 的占位文字；原消息后台取到后缓存。
- 被引用消息里的合并转发 id 在归属校验通过后登记为本会话可见，并记到这条消息的 `forwardIds` 上；跨群 / 跨私聊的不登记。
- `qq_get_message_detail` 对加载中的 id 返回 `pending:true` 和「稍后再查」；工具说明同步更新。
- 读合并转发走缓存（30 分钟、最多 200 条），嵌套预览并行、各自最多等 30 秒，还在加载的标出来；MCP 端超时改为 180 秒。
- 发送引用时「加载中」不算确认目标归属（仍最多等 30 秒，和以前一样）。
- 接口平台：`get_msg` / `get_forward_msg` 用 `limits.slowReadTimeoutMs`（默认 120 秒），其它动作仍按 `requestTimeoutMs`（30 秒）。
- 新测试 `scripts/test-quote-forward.mjs`。

### 修复：文件名是 32 位哈希的普通图片被误当成表情
- 普通 QQ 图片的文件名本身就是 32 位哈希（`<32 位 HEX>.jpg`），旧的「从文件名推 emoji_id」规则会把它们当成表情：先去拼一个必然 404 的表情 CDN 地址，日志也错标成「表情获取失败」（实测：引用的合并转发里那张普通图片，`sub_type=0`）。
- 现在只有真的是表情才按表情处理：`kind=sticker`（mface 市场表情）、带 `emoji_id`、`sub_type=1`，或市场表情特有的「两位前缀-32 位 hex」文件名（前缀必须等于 id 的前两位，例如 `f9-f96b….gif`）。
- `test-media-search.mjs` 新增回归：哈希文件名的普通图片先走 get_image、失败时只试消息自带的链接、不拼表情 CDN；真表情的四种情况仍先走 CDN。

## v1.0.2 —— 2026-10-20

在 v1.0.1 的基础上：换 SnowLuma 目录（例如升级到 2.x）时，新目录缺数据会先提醒迁移；补充 SnowLuma WebUI 登录相关的常见问题；
修复 Windows 实机部署 v1.0.1 时发现的问题（Release ZIP 中文文件名乱码、重置会话清不掉等待租约等）；黑话研究未确认的 AI 推测显示在控制台；控制台可以选择 DSH 的提供方 / 模型 / 思考强度（GitHub issue #1）。
发布说明：[docs/release/RELEASE_NOTES_v1.0.2.md](docs/release/RELEASE_NOTES_v1.0.2.md)。

### 控制台选择 DSH 模型（提供方 / 模型 / 思考强度），保存即生效（GitHub issue #1）
- 「DSH 模型与思考强度」卡片改为提供方、模型、思考强度三个联动下拉，外加「看图能力」。选项全部来自 DSH 的模型目录（`session.modelCatalog`），不另维护清单，
  在 DSH 里配好的其它提供方桥接也能用；目录读不到时只显示当前配置和内置档位，并标注「目录不可用」。保存后对已有会话的下一条消息生效，不用重启桥接。
- 默认值不变：`deepseek-official` / `deepseek-flash` / `max`（DSH 桌面版 0.2.1 的 `deepseek-account` 同样按 DeepSeek 自家处理）。
- 服务端硬校验：提供方 / 模型不在目录里 → 400；档位不在该模型公布的列表里 → 400（附上支持的档位）；目录读不到 → 503 且不写 `config.json`。
  无档位的模型强度下拉置灰，`selectModel` 不带 `reasoningEffort`；配置里的档位该模型不支持时交给模型默认并记一条日志。
- **`off` 档放开**：档位以目录为准，选「关闭思考」时提示二代仿真的工具调用、读群判断和人格一致性可能变差。
- **不能看图的模型自动把图片改成文字**：目录不公布 `inputModalities`，所以看图能力用「已知表 + 未知」表达（`dsh.vision`：`auto` / `yes` / `no`）。
  `auto` 下只有核实过的 `deepseek-flash` 收图；其它模型的聊天图片、表情改成「[图片1：当前模型 … 不能看图，已省略]」（不下载图片），
  工具查询图片只返回文字，表情图 / 形象图对 AI 拒绝返回——避免整条消息报 `UNSUPPORTED_CONTENT` / `MODEL_DOES_NOT_SUPPORT_IMAGES`。
- **第三方提供方提示隐私**：选中非 DeepSeek 自家的提供方时提示「QQ 聊天内容会发给它处理」，第一次保存前再确认一次。
- 价格表只覆盖 DeepSeek 自家价目：其它模型（含第三方的同名模型）在下拉里标「价格未覆盖」，花费按 Flash 估算并标「估算」。
- 安全：`POST /api/dsh/model` 只有控制台能调（agent token 白名单本来就不含 `/api/dsh/*`），QQ 里的 AI 和私聊管理通道都改不了模型。
- 实现：新模块 `src/dsh-model.js`（目录 60 秒缓存与并发去重、校验、selectModel 参数、看图判断、提示文案、图片降级），`bridge.js` 只做接线；旧接口 `POST /api/dsh/effort` 保留并同样按目录校验。
- 新测试 `scripts/test-dsh-model.mjs`（模块 + 桥接接口端到端 + 图片降级）；`test-audit-bridge` 的 agent token 拒绝清单加上 `POST /api/dsh/model`；控制台离线夹具与 `test-console-ui` 改为新流程（夹具里的第三方提供方是虚构的）。
- 文档：`CONFIGURATION.md` 新增模型选择一节；`DSH_020_ADAPTATION.md` 更新 `off` 档与桌面版提供方名的说明。

### 黑话研究：未确认的 AI 推测显示在控制台
- 词条新增 `lastGuess`（`{ meaning, usage, example, at }`）：研究结果未确认时保存 AI 的推测，只给控制台看。旧词库没有这个字段，读入为 `null`，不需要迁移。
- 控制台「候选词-待研究」卡片显示「AI 推测（未确认，时间）」与「采用为含义」按钮：只把推测填进编辑框的空栏位，保存仍由管理员点，保存后词条仍是候选（移到「已研究」）。
- 安全：推测不写 meaning / usage / example，不算「已研究」，不能凭它确认；`buildSlangContext` 与给 AI 的 `publicSlangEntry` 都是字段白名单，不含 `lastGuess`；`GET /api/slang` 本来就拒绝 agent token；接口不接受外部写入 `lastGuess`；重新研究时也不把上次的推测喂回去。
- 研究确认、管理员填了含义、单条 / 批量确认时清空；再次研究仍未确认时覆盖为最新推测（没给推测则保留上一次）。
- 新测试 `scripts/test-slang-guess.mjs`；控制台离线夹具加一条带推测的演示候选。

### 修复（来自 Windows 实机部署 v1.0.1 的反馈）
- **Release ZIP 中文文件名在 Windows 上乱码、解压失败**（`roles/小鲸鱼.md`、`roles/傲娇助手.md`、`assets/deepseek娘.png`）：macOS 自带的 zip 不设「文件名是 UTF-8」标志，
  Windows 的解压按旧代码页解读。发布脚本改用自己的 ZIP 实现（`scripts/zip-utf8.mjs`，只依赖 Node 自带的 zlib）：每个条目都带 UTF-8 标志，`.command` / `.sh` 保留可执行位，
  三个系统生成的包一致，不再依赖系统的 zip / tar。v1.0.0、v1.0.1 的包都有这个问题。
- **黑话研究日志口径**：以前打印「已更新 N 条」用的是解析到的条数，未确认（不写库）的也算进去，管理端以为研究成功、词库却没变。
  现在分别报「写入 / 解析 / 未确认」，未确认的仍不写库，但把 AI 的推测（前 120 字）写进日志，方便判断该手填还是换关键词重研。
- **重置会话清不掉 `qq_wait_for_messages` 的等待租约**：控制台 / 控制中心的「重置会话」、QQ 里的 `/reset`、二代仿真全量重置都漏了清租约，
  新会话被旧租约挡住最长 15 分钟（「该会话已有一个等待中的 qq_wait_for_messages」）。现在三处都调用完整清理，归一后的会话 key 也一并清。
- **接口平台里默认生成的 SnowLuma 实例标红**（从 v0.4.x 升级时平台第一次启动，`snowluma-main` 既没有目录也没有令牌）：控制中心知道 SnowLuma 目录时自动替它补上，
  连接器按账号读令牌；用户自己配过令牌的实例不动。
- **两个测试在 Windows 上失败**：接口平台测试用 `URL.pathname` 当路径（Windows 上是 `/C:/…`）；生成 Linux 服务文件时用了平台相关的 `path.join`（Windows 上变成反斜杠）。
  都改为 `fileURLToPath` / `path.posix`，另外两处同样写法一并修正，并加回归测试禁止再用 `URL.pathname` 当路径。
- 部署文档：第 13 节补「换目录后必做」清单（先重置会话再删旧目录、重启 MCP、工具开关改后重置会话、带上 `interface-platform/state/`、SnowLuma 换目录走更新助手、不要双击旧目录的启动器），常见错误补四条。
- 新测试 `scripts/test-deploy-fixes.mjs`，`test-platform.mjs` 加 ⑧（自动补 SnowLuma 目录）。
- 测试夹具 `audit-bridge-harness.mjs` 的临时目录先取 realpath：macOS 默认临时目录是软链接，`test-audit-bridge` / `test-voice` 的语音库路径断言在真实 Mac 上会失败（只改测试，语音库的 symlink 防护不变）。

### 升级注意（从 v1.0.1）
- 沿用 `config.json`、`state/`、`interface-platform/state/`；执行 `npm ci`，重启控制中心。没有数据格式变化，不需要重跑 `setup-dsh.mjs`。

### 换 SnowLuma 目录前提醒迁移数据
- 在控制中心换到新的 SnowLuma 目录时，如果新目录里既没有账号配置（`config/onebot_<QQ号>.json`）也没有 WebUI 密码（`config/webui.json`），而旧目录有，**先不切换**，提醒用「更新助手」迁移：
  直接换过去 SnowLuma 会当成全新安装——生成新的随机 WebUI 密码（浏览器里保存的旧密码失效）、要重新扫码登录、重新开 OneBot WebSocket。确认框里点「去迁移（推荐）」会打开更新助手并填好新目录；坚持不迁移要再确认一次才切换。
- 背景：SnowLuma 1.14 与 2.x 的 `webui.json` 格式、密码规则完全相同，升级本身不会让密码失效；失效通常是新目录没带上旧的 `config/`（或旧版从没改过初始密码，每次启动都会重新生成）。

### 文档：SnowLuma WebUI 登录的常见问题
- 部署文档「常见错误」补三条：升级后旧密码登录不了（新目录没带上 `config/`，或初始密码从没改过）；
  输对密码也登不进、提示「登录尝试过多」（SnowLuma 同一地址 5 次输错锁 15 分钟，锁定期间正确密码也被拒，重启 SnowLuma 或等 15 分钟即解除；`localhost` 与 `127.0.0.1` 分开计数）；
  改密码提示「新密码不得与旧密码相同」（说明填的当前密码就是现在存着的密码，直接用它登录）。


在 v1.0.0 的基础上**增加 Linux 支持**（Windows、macOS 原有行为不变），适配 SnowLuma 2.x，DSH 探活更稳，macOS 第一次运行自动生成无窗口启动 App。
发布说明：[docs/release/RELEASE_NOTES_v1.0.1.md](docs/release/RELEASE_NOTES_v1.0.1.md)。

### 升级注意（从 v1.0.0）
- 沿用 `config.json`、`state/`、`interface-platform/state/`；执行 `npm ci`，重启控制中心（桥接、接口平台随之重启）。preset 没有变化，不需要重跑 `setup-dsh.mjs`。
- 用 SnowLuma 2.x 的 **Lite 版**需要本机 Node 24+；**完整版**自带 Node，不受影响。账号配置格式与 1.14 相同，可以用控制中心的「更新助手」把 `config/`、`data/` 迁移到新版本目录。
- Linux：`npm run linux-service -- --enable` 生成并启动 systemd 用户服务（见部署文档 10.1）。

### macOS：第一次运行自动生成无窗口启动 App
- 第一次双击 `control-center.command` 时，如果仓库根目录还没有「QQ Bridge 控制中心.app」，会自动生成（同 `npm run mac-app`）并在访达里选中它；这一次仍在终端里运行，以后双击 App 即可。生成失败只提示、不影响启动；设 `QQ_BRIDGE_NO_MAC_APP=1` 可关闭。
- App 仍然不入库、不进 Release 包（下载来的未签名 App 会被 macOS 拦下，本机生成的不会）。

### Linux 支持（增量，Windows / macOS 行为不变）
- **SnowLuma 2.x**（2.0 起正式支持 Linux x64 / arm64；账号配置的位置与格式与 1.14 相同，接口平台的账号发现和桥接的令牌自愈不用改）：
  控制中心识别 Windows（`launcher.bat`、自带 `node.exe`）与 Linux（`launcher.sh`、自带 `./node`）两种发行包；Linux 用 `bash ./launcher.sh` 启动。
  读 `package.json` 的 `engines.node`（2.x 是 `>=24`）与 `release.json` 的目标平台：Lite 版本机 Node 不够、或发行包与本机平台 / 架构不符时，不启动并写明原因。
  检查更新按本机系统与架构建议完整版（`win-x64.zip` / `linux-x64.tar.gz` / `linux-arm64.tar.gz`）。
- 控制中心页面：Linux 上也列「本机 SnowLuma 程序」、可「开启 SnowLuma」；Node 要求按发行包显示。
- Linux 的「浏览…」：有 zenity 用 zenity，否则 kdialog；都没有（服务器）时手动填路径。
- **NapCat 在 Linux**：启动文件可选 `.sh` 脚本（用 bash 运行）或可执行文件；版本从启动文件旁的 `package.json` 读；更新提示 Linux 安装方式。
- **Linux 无窗口启动**：`npm run linux-service`（`-- --enable` 直接启用）生成 systemd 用户服务（`--no-open`、崩溃自动重启、`KillMode=mixed` 先让控制中心按顺序停子进程）与桌面启动项。
- 新测试 `scripts/test-linux-support.mjs`（含 Windows / macOS 原有行为不变的断言）。

### DSH 探活更稳：不再「失败一次就报不可用」
- 桥接每 5 秒探活一次 DSH；现在**连续 2 次**（约 10 秒）失败才判定「DSH 不可用」并让 QQ 消息入队。DSH 很忙时偶尔一次没及时回应（例如本机满负载渲染时），不再刷出误报；偶发失败一次只在恢复时记一笔「DSH 探活偶发失败 1 次（原因），已恢复」。
- 端口重新识别不受影响：第一次失败就开始（DSH 0.2.1 换端口后照样很快跟上）。
- 日志写明失败次数和原因：超时 / 连接被拒（DSH 没在运行或换了端口）/ 连接被中断 / 鉴权失败 / HTTP 状态 / 其他。新模块 `src/lib/dsh-health.js`，测试 `scripts/test-dsh-health.mjs`。

## v1.0.0 —— 2026-10-19

第一个正式版本：支持 **Windows 与 macOS**；新增**接口平台**（桥接经它接入 QQ 后端，可同时接 SnowLuma 与 NapCat）；
控制中心统一管理桥接、接口平台与 QQ 后端（两边都有无窗口启动入口）；兼容 DSH 0.2.0-rc.2 与 0.2.1；增量合入上游 r4 的修复。
发布说明：[docs/release/RELEASE_NOTES_v1.0.0.md](docs/release/RELEASE_NOTES_v1.0.0.md)。

### 升级注意（从 v0.4.2）
- 沿用 `config.json` 与 `state/`；执行 `npm ci`，**重跑 `node scripts/setup-dsh.mjs` 并重启 DSH**（preset 去掉了 `{{cwd}}`，DSH 0.2.1 需要）。
- 想经接口平台收发：控制中心 → 接口平台 → 开启后端 →「设置 → 接入桥接」→ 重启桥接。不接入时桥接照旧直连 SnowLuma。
- macOS：`npm run mac-app` 生成无窗口启动 App；第一次读 NapCat 配置时允许「访问其他 App 的数据」。
- 更新 / 备份时把 `interface-platform/state/`（接口平台的实例配置与令牌）一起带上。
- 接口平台的版本号与项目统一（1.0.0），只在 `interface-platform/package.json` 一处维护；`test-platform` 检查两者一致。英文 README 同步更新。
- 发布包（`npm run release:zip`）默认输出到仓库外、与仓库同级的 `release/` 文件夹（历次版本都放在这里，不占仓库目录）；`--out` 可改。

### macOS 无窗口启动、NapCat 扫码、日志用词
- 新增 `npm run mac-app`：在本机生成「QQ Bridge 控制中心.app」（对应 Windows 的 `control-center-hidden.vbs`）：没有终端窗口和 Dock 图标，后台启动控制中心并打开页面；再次双击重新打开页面；页面上退出控制中心后 App 随之退出。生成的 .app 不入库。
- NapCat 登录二维码直接显示在控制中心：NapCat 由控制中心启动、未登录且生成了新二维码时，开启卡提示、程序区显示二维码（`GET /api/napcat/qrcode`，需令牌、文件位置固定、只给 PNG），登录后自动消失。NapCat 日志里同时插入二维码小图，换新后旧图标「已过期」；下载日志不含图片数据。
- NapCat 程序区更好找：开启卡上加「管理 NapCat 程序 →」；接口平台没运行时实例列表里也有「本机 NapCat 程序」。
- 桥接日志按实际后端称呼：经接口平台时写「QQ 后端（经接口平台 · NapCat 4.18.38）已连接」，不再一律写「SnowLuma 已连接」（`src/lib/qq-backend-label.js`）。
- 离线测试：`test-qq-backend-label.mjs`、`test-mac-app.mjs`，`test-napcat-manage.mjs` 补二维码。

### NapCat 管理：版本、检查更新、目录与启动文件
- 控制中心的 NapCat 程序区显示版本（运行中由 NapCat 经 `get_version_info` 自报；Windows 也可从安装文件读）、「检查更新」（只读 GitHub 最新 Release，只提示不下载）、「打开下载页」（macOS → Mac 安装器）。
- 新增「NapCat 设置」：QQ.app（macOS）/ 启动文件（Windows）、NapCat 目录、快速登录 QQ 号，带校验；改目录同步给接口平台的 NapCat 实例。不用再手改 `state/control-center.json`。
- 「浏览…」改用系统原生窗口模块 `src/launcher/pick-dialog.mjs`：macOS 用 osascript，Windows 用 PowerShell；标题与路径经 argv / 环境变量传入，不拼进脚本。只接受固定用途（`/api/pick`）。SnowLuma 的「浏览…」在 macOS 上也能用。
- 接口平台：链路连上后调用一次 `get_version_info`，在链路快照里给出 `backend: { appName, appVersion, protocolVersion }`。
- 离线测试 `scripts/test-napcat-manage.mjs`（接入 test:audit）。

### 接口平台并入仓库
- `interface-platform/` 从与桥接平行的目录搬进本仓库，作为独立子程序（自己的 `package.json`、测试与 `state/`）；`state/` 不入库，发布包随 `git ls-files` 自动包含平台。
- 控制中心默认按 `<仓库>/interface-platform` 找平台，旧布局（同级 `../interface-platform`）仍然认；`platformDir` 与 `QQ_BRIDGE_PLATFORM_DIR` 不变。
- `test-platform.mjs` 找不到平台改为失败（不再跳过），新增 ⑥：桥接与平台互不导入对方的模块、`.gitignore` 排除平台 `state/`。
- 离线测试用 `QQ_BRIDGE_NAPCAT_HOME` 指向假目录，不再读真实 NapCat 目录（macOS 上那会弹「访问其他 App 的数据」并卡住测试）。`.DS_Store` 加入 `.gitignore`。

### 控制中心：状态栏与桥接控制台入口
- 底栏 DSH 指示以桥接自己的连通结论（dshReady）为准，不再因为控制中心没探到 DSH 0.2.1 的随机端口而显示「不可达」；总体徽章同步。
- 底栏「SnowLuma」改为「接入后端」：走接口平台时列出平台里各实例（如「NapCat 已连接」），桥接直连时才显示直连的 SnowLuma；版本行只在选了 SnowLuma 目录时显示其版本。
- 「打开桥接控制台」从顶栏移到桥接卡片（启动桥接与重启之间），点击时自动带上桥接控制台令牌（经控制中心鉴权的 POST 取得，控制中心页面不保存）；旁边保留「手动输入令牌」。
- 桥接控制台的令牌页会先用本机浏览器里上次保存的令牌自动试一次，失效或走手动入口时才弹窗。
- 桥接控制台黑话库：「候选词」拆成「候选词-待研究」和「候选词-已研究」两栏（有含义 / 用法 / 示例之一即为已研究，标签上显示条数）；只是页面分栏，数据仍是候选，确认 / 拒绝 / 研究接口不变。
- 新增 macOS 启动入口 `control-center.command`（双击在终端里打开）。从其他 App 里启动时，macOS 会以那个 App 的名义反复询问「访问其他 App 的数据」。
- 接口平台：账号目录**读不了**（权限 / macOS 隐私保护）不再被当成「账号从目录消失」而断开链路，保留现有链路并在实例上报 `discoveryError`；只有目录里真的没了才关。
  控制中心底栏「接入后端」改按真实链路（open）判断，读不到目录时显示原因。NapCat 自动登录设置的读取缓存 10 分钟，不再每次刷新都读沙盒容器。
- NapCat 卡片识别 NapCat 自己的自动登录设置（`config/webui.json` 的 `autoLoginAccount`，只读）。

### NapCat 下 AI 收藏表情
- NapCat 的 `add_custom_face` 只接受本地文件路径（`base64://` 会报 ENAMETOOLONG），回执也不含 emoji_id。现在 base64 被拒且网关识别为 NapCat 时，
  把桥接已校验的表情字节写进桥接自建的临时文件（随机名、0600，macOS 放在 QQ 沙盒容器的 tmp，用完即删）再交给它；按 MD5 在收藏列表里找到刚收藏的表情，
  备注改用 NapCat 的 `set_custom_face_desc`。SnowLuma 的行为不变；消息里的原始 URL / AI 给的路径仍然不会交给网关。临时目录可用 `socialV2.sticker.collect.tempDir` 指定。

### 兼容 DSH 桌面版 0.2.1-rc.2（同时保持兼容 0.2.0-rc.2）
- **preset 不再使用 `{{cwd}}`**：0.2.1 的提示词变量只剩 provider / model，`suffix: Your working directory is {{cwd}}.` 会让每一轮直接报错
  （`unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`）。5 个 preset 都不再覆盖 suffix，改用当前 DSH 版本自带的默认后缀；已重新生成 bundle patch。
- **自动发现 DSH 随机端口**：0.2.1 桌面版每次启动监听一个随机回环端口（不再写死 19387）。`dsh.baseUrl` 留空时，固定端口连不上就查 DSH 桌面版进程的监听端口
  （macOS `lsof`，Windows `netstat` + `tasklist`），再用未登录 401 的特征文字确认是 DSH；DSH 不可用期间桥接每 10 秒重新识别，DSH 重启换端口后自动跟上。
- **macOS 识别桌面版**：Mac 上没有 `~/.dsh/dsh-runtimes`，改读 App 包 Info.plist 的版本号；之前 DSH 还没起来时会被误判成命令行版（3080）。
- Windows 上的 `netstat`/`tasklist` 发现路径只做了离线解析测试，尚未在 Windows 实机验证。

### 合入上游 Derpyu520/qq-bridge v0.2.0-r4（增量合并，本仓库的增强功能全部保留）
- **回合判忙租约**：回合只按「起始时间 + 15 分钟租约」判忙，turn/end 丢失或 DSH 重启丢回合时不再永久卡在「会话繁忙」（上游 #11/#19/#23/#26；本机 Mac 部署曾复现）。
  本仓库另在控制台 `/api/socialV2/state` 增加只读的 `busy` 诊断字段。
- **DSH 设置 user 层优先**：控制台切的模式不再被 5 秒轮询改回去（上游 #22）；DSH 设置页 ownerQQ 留空不再抹掉 config.json 的值。保留本仓库 v0.3.0 管理控制器的外部模式判定。
- **机器人身份写进唤醒提示词**（昵称 + QQ 号，上游 #29），不再把 @自己 当成 @别人；引用旧消息里的昵称不算被叫到。
- **会话初始提示词**：控制台为每个会话预写圈子主题/氛围（`state/initial-prompts.json`），只在首次唤醒注入；AI 读不到也改不了。
- **图片/表情链路**：safe-fetch 校验全部 DNS 结果 + IPv4 优先 + 逐地址切换（修 AAAA 先返回时每次白等 20 秒）；表情优先走 CDN、按 emoji_id/文件名推 gxh 地址兜底；
  落库保留 kind/emojiId/summary/subType。图片识别上限改为 `socialV2.media`（默认 8MB / 64MP / 5 张）。本仓库的表情上限 `socialV2.sticker.maxBytes`（10MB）照旧单独生效。
- **联网搜索**：新增 `src/web-search.js`，优先复用 DSH 的 DeepSeek 联网搜索，Bing RSS 兜底（配置 `webSearch`）。
- **稳定性**：`qq_wait_for_messages` 改走 `node:http` 长轮询（绕开 undici 300 秒 headersTimeout）、DSH 控制调用统一 15 秒超时、事件流重连指数退避；SnowLuma 对象形态的 error 拆出详情记日志。
- **体检修复**：`/api/send/*` 失败路径的 ReferenceError、MCP 对象 error 显示成 `[object Object]`、md-to-plain 的 ReDoS 与「2 * 3 * 4」被当斜体删掉、表情/黑话按码点截断不切坏 emoji、搜索空结果提示被缓存吞掉。
- 测试：移植上游 `test-audit-regressions`、`test-issue-regressions`、`test-media-search`、`test-v2-initial-prompt`，并接入 `test:audit`。
- 未合入：上游各包的版本号（本仓库保持自己的版本号）。

### 新增
- **接口平台 M1**（仓库内的独立子程序 `interface-platform/`，零依赖，Windows / macOS 通用；桥接与控制中心只经 HTTP 接口与它通信）：统一管理接入实例、账号、事件与发送，后端是可替换的连接器。
  本轮提供 QQ 的 SnowLuma 连接器（Windows）与 NapCat 连接器（macOS / Windows，连接用户自己安装的 NapCat；macOS 上已实机验证收发），都按目录自动发现每个账号；统一数据接口（`/v1`，SSE 事件流 + 带状态的发送请求）、
  管理接口（`/v1/admin`，与数据令牌分离）和 OneBot v11 兼容入口（过渡层：桥接只改配置即可经过平台）。见 interface-platform/README.md 与 interface-platform/docs/CONTRACT.md。
  **M1 不是完整交付**：Mac 原生 QQ（M3）、完整功能矩阵（M4）尚未实现；Windows 上经接口平台的实机链路尚未验收。
- **控制中心改为顶部大标签**：「桥接」「接口平台」两个标签，切换只改变显示、不启停任何模块；接口平台页有概览、接入实例、账号、日志、设置。
  SnowLuma 的目录选择、启停、更新助手移到「接口平台 → 接入实例」，仍然只由用户亲手点击。
- **管理员私聊跨群查看与群长期规则**（`socialV2.tools.ownerGroupAccess`，默认关闭）：管理员本人私聊的 AI 可以只读查看白名单群的消息和记忆（`qq_owner_peek_group`），并给群设长期规则（`qq_owner_group_rule`，由桥接写进群会话记忆、每次唤醒注入）；群里发言仍走托付，会话隔离不变。
- **`socialV2.sticker.maxBytes`**（默认 10MB，范围 256KB～40MB）：收藏 / 发送表情的单张大小上限单独可配；图片识别（含 `qq_get_sticker_image`）改用上游 r4 的 `socialV2.media.maxBytes`（默认 8MB）。
- **`snowluma.viaPlatform`**：「接入桥接」一键把桥接端点改为平台兼容入口（原值备份在 `state/platform-link-backup.json`，可「恢复直连」）；
  开启后 token 自愈不再扫描 SnowLuma 目录、不跟随发现到的端点，避免绕过平台直连。

## v0.4.2 —— 2026-10-17

### 新增
- **管理员私聊托付群会话**（`qq_ask_group_session`，默认关闭，开关 `socialV2.tools.ownerRelay`）：在私聊里让 AI「去某个群说两句」时，
  私聊会话不能直接往群里发（会话令牌只能发到自己的会话，以前会报「令牌不对」）。现在它可以把这件事托付给那个群**自己的**会话，
  由群会话看着群里的上下文自己组织语言发言；会话隔离不变。只有管理员私聊能托付，目标必须是白名单群，有限频、审计和私聊通知。
  见 docs/guides/CONFIGURATION.md。

### 修复
- 控制台「切换当前启用的人格」的下拉列表被折叠面板裁掉、看不到下面的人格：列表改为在页面里展开，面板跟着变高，人格多时可以滚动。

## v0.4.1 —— 2026-10-16

根据第一次真实部署（DSH 桌面版 + SnowLuma + 新 QQ 号）的报告修复。

### 修复
- **SnowLuma 握手被拒后永远连不上**：有的 SnowLuma 版本拒绝 WS 握手时只触发 `error`、不触发 `close`，
  SDK 的重连和桥接的 token 自愈都挂在 `close` 上，结果一直不连。现在 `error` 时（未连接）也触发自愈，
  并新增**连接看门狗**（`src/lib/ws-watchdog.mjs`）：未连接时按 10 秒起、最长 60 秒的退避重试，连上即停。
- **AI 出错时无从排查**：回合出错 / 消息未被接受时，原来只把一句话发到 QQ、不写日志，而且错误里带 credential 字样
  会被整条替换成「含敏感信息，已隐藏」。现在（`src/lib/agent-errors.mjs`）：日志写**错误码 + 脱敏后的详情**；
  QQ 上显示错误码（群聊等审计会话不显示原文）；缺凭据 / 余额不足 / 模型不可用这类**配置错误**私聊提醒 owner（30 分钟限频）。

### 改进：DSH 桌面版开箱即用
- `dsh.baseUrl` 默认留空 = **自动识别**：桌面版固定端口 `19387`，命令行版 `3080`（`src/lib/dsh-endpoint.mjs`）；
  桥接、控制中心状态栏、`probe:permission`、`self-test` 都用同一套识别。显式填写的地址照用（已有配置不受影响）。
- `setup-dsh.mjs` 自动识别 profile（桌面版 `desktop` / 命令行版 `web`），`dsh` 不在 PATH 时自动使用桌面版自带的 `dsh.cmd`
  安装 profile bundle。
- `control-center.bat` 找不到 Node.js 时给出提示并暂停；`control-center-hidden.vbs` 弹窗提示，不再静默失败。

### 控制台
- 「切换当前启用的人格」输入框：获得焦点时列出已有人格，输入时按**开头**过滤（不区分大小写），点击或 ↑↓ + 回车填入；仍可手动输入。

### 文档
- 部署指南：桌面版的 profile / 端口 / `dsh.cmd` 位置；新增「配置 DSH 模型凭据」一节（API Key → `deepseek-official`，
  账号登录 → `deepseek-account`）；装好或更换 Node 后要重跑 setup；DSH 沙箱可能不允许在工作区写可执行文件；
  `reasoningEffort` 的快慢取舍；「1006 正常」的说明补上 non-101 的情况；常见错误表新增三条。

### 升级注意
- 已经在 `config.json` 里写了 `dsh.baseUrl` 的保持不变即可；想用自动识别就改成 `""`。
- 新增离线测试 `test-snowluma-reconnect` / `test-agent-errors` / `test-dsh-endpoint`，`test:audit` 现为 40 个脚本。

## v0.4.0 —— 2026-10-16

### 新增：控制中心（docs/guides/CONTROL_CENTER.md）
- 一个只监听本机的网页（`control-center.bat` / `control-center-hidden.vbs` / `npm run control-center`，默认 `127.0.0.1:3099`），
  左侧是桥接的终端输出与固定命令集，右侧是 SnowLuma，底部是整体状态（桥接 / SnowLuma / QQ 账号与接收链路 / DSH / 模式级别 / 版本）。
- 桥接与 SnowLuma 作为控制中心的子进程运行：按钮启动、停止（桥接先保存状态再退出）、桥接崩溃自动重启（可关）；
  日志可过滤、只看错误、暂停、下载，显示前抹掉令牌与凭据，同时写入 `state/logs/`。
- SnowLuma：用 Windows 文件夹选择框选择你自己解压的目录（不放进项目），显示版本与完整版/Lite 版、已配置账号；
  **只在你点击时**按原样运行它自带的 `launcher.bat`；打开它的 WebUI（它禁止被嵌入，所以在新标签页打开）；
  检查 GitHub 上的最新版本；**更新助手**：你下载解压新版本后，备份并迁移 `config/`、`data/` 到新目录并切换（不下载、不替换它的程序文件）。
- 选择 SnowLuma 目录时自动同步 `config.json` 的 `snowluma.homeDir`。
- 桥接新增 `POST /api/admin/shutdown`（优雅退出，仅控制台令牌）；`/api/status` 增加 `botAccount` 与 `version`。

### 规则变更（经维护者确认）
- 允许**由用户亲手点击**控制中心按钮启动/停止 SnowLuma；仍然不自动启动、不下载、不安装、不修改 SnowLuma，
  桥接/MCP/AI 依旧没有任何启停 SnowLuma 的途径。`LICENSE` 第三方说明与 L6 测试已同步（新增 `scripts/test-control-center.mjs`）。
- `.gitignore` 与发布脚本排除 SnowLuma 目录与安装包。

### 文档
- 部署指南补充**桌面版 DSH** 的路径（版本检测、端口、bundle 安装的替代办法），仓库地址改为 h-D-ACE/dsh-qq，日常启动改为控制中心。

## v0.3.0 —— 2026-10-16

适配：DSH `@deepseek-ai/dsh@0.2.0-rc.2`（未变），SnowLuma ≥ 1.14.20（对照 1.14.22 源码），Node.js ≥ 22.13。

### 新增：人际连续性（docs/guides/CONTINUITY.md）
- 全局人物库 `state/social/people.json`：以 QQ 号为唯一主键，按群记录群名片/昵称及变更历史、成员关系、认识程度；
  同名不同号绝不合并，小号关联只能由管理员标注。
- 分层记忆：群内 / 私聊 / 全局三个作用域；共享策略 `none` / `identity`（默认）/ `shared`，群级可调严；
  **可见范围在注入时由程序过滤**，私聊来源记忆任何策略下都不外流；AI 申请的跨群共享需管理员批准。
- 二代唤醒提示词新增【在场人物】小节（只含本轮出现的人，有字数上限）。
- 成员事件：处理 `group_increase` / `group_decrease` / `group_card` / `group_recall`；入群按「陌生 / 别处认识 / 回归」分类，
  写入二代消息流并按配置唤醒（不强制欢迎）；事件去重；连上 SnowLuma 后成员名单对账（首次部署不把老成员当新人，补记断线期间的入退群）。
- 跨群受控查询（默认关闭，有向链接 + 能力授权，只返回统计/成员关系，不返回内容）。
- 新 MCP 工具：`qq_get_person`、`qq_note_person`、`qq_cross_group_query`。
- 旧版 `memberImpressions`（按名字）迁移：唯一映射才导入，其余待人工确认。

### 新增：owner 私聊管理通道（docs/guides/ADMIN_CHANNEL.md）
- 权限级别 L0（群友）/ L1（只读 Agent）/ L2（工作区读写）/ L3（高权限，TOTP + 每次审批）；不存在免审批的完全访问。
- 新 agent preset `qq-agent-readonly`（L1）：工具白名单只有读文件/检索/联网只读，不依赖 Windows 沙箱。
- `setup-dsh.mjs` 在 DSH profile 中加入权限预设 `qq-full-ask`（danger-full-access + ask）；桥接绝不使用内置的 `danger-full-access`（never）。
- closed-agent 会话按级别用 `commands/execute "/permission <预设>"` 钉住权限，钉不上就丢弃会话；高权限期间每分钟核对，被外部改动即告警 + 紧急关闭。
- 模式切换：确定性命令（`/mode`、`/level`、`/panic`、`/cancel`）+ 固定句式自然语言 + AI 工具 `qq_request_mode_change`（只能登记）；
  升级需确认码（一次性、2 分钟、绑定申请、并发互不覆盖），L3 另需 TOTP（RFC 6238，防重放，失败锁定）；降级与紧急关闭一步完成。
- 确认消息、管理命令、审批回复在交给模型之前被桥接拦截；群里的模式/权限命令一律拒绝；特权斜杠命令不再透传。
- 审批增强：全局编号 `#n`、展示按 callId 关联的实际参数（抹凭据）、多个并发互不覆盖、旧编号无效、超时自动拒绝。
- 自动回落：闲置超时 / 最长时长；重启不继承高权限。
- 统一变更通知（前后模式、级别、来源、时间、结果）与哈希链审计日志 `state/admin/audit.jsonl`。
- 外部变更检测：DSH 设置里的模式提权默认回退并告警；`ownerQQ` 变更告警（高权限时紧急关闭）。
- 管理通道人物命令：`/whois`、`/people`、`/person …`、`/note`、`/share`、`/review`、`/say`、`/audit`。
- 控制台：closed-agent 级别选择（L3 需输入 TOTP）、管理状态、紧急关闭按钮；`/api/admin/*`、`/api/people*` 管理接口（AI 令牌不可达）。
- 新脚本：`npm run admin:totp-setup`、`npm run probe:permission`、`npm run probe:member-events`、`npm run release:zip`。

### 安全加固（发布前独立安全审查后修订）
- **L2/L3 改用桥接自带的运维 preset**（`qq-agent-workspace` / `qq-agent-full`）+ 审批闸门 `qq-approval-gate`（`tools/pre-execute` 返回 ask）：
  核实发现 rc.2 的审批只在越过沙箱时触发，danger-full-access 下永远不会弹审批；DSH 默认 standard preset 还带审批策略固定为 never 的子代理。
- 运维 Agent 的文件工具不能读取 `state/`、`config.json`、`~/.dsh/.credentials.yaml`（`protected-paths.mjs`）。
- 控制台 API 不再接受 `?token=`（只用于打开页面）；高权限期间与回落后 10 分钟内控制台不能提权。
- 降级 / `/panic` 无条件退役运维会话并作废其审批；失效会话的审批回复一律拒绝。
- 执行层拒绝来自非确认来源的真实提权；`admin.allowL3=false` 在执行层也生效；外部变更在 alert 模式下最多按 L1 接受；启动校验完成前拒绝申请。
- 权限核对 fail-closed（返回格式无法识别或连续失败 → 紧急回落）。
- 审批编号跨重启连续；管理通道的消息不能被「引用」或 `qq_get_message_detail` 读回模型；入群事件里的名片先清理再进提示词。
- `setup-dsh.mjs`：已有用户 permission 覆盖时不再替用户加回 danger-full-access；桥接使用的三个预设强制为 ask（只收紧）。

### 变更（与上游行为不同的地方）
- 控制台 `POST /api/mode` 改经管理控制器：closed-agent 未指定级别时为 L2；L3 要 `totp`。closed-agent 不再使用 DSH 默认 preset（控制台的 preset 下拉只在 `admin.allowCustomAgentPreset=true` 时生效）。
- 控制台/DSH 设置/QQ 的所有模式变更都会私聊通知 owner。
- **未经授权的 closed-agent 不再能建会话**；从上游升级时若停在 closed-agent，首次启动回落到 `reserved2` 并告警。
- 审批不再使用「每个会话一个挂起槽」（新审批不会再自动拒绝旧审批）。
- 群友会话建好后额外钉 `read-only` 权限预设（纵深防御，`admin.pinChatReadOnly`）。
- 移除上游附带的 `@snowluma/mcp` 工具目录快照 `_snowluma-catalog.json`（无代码引用；不再入库）。
- QQ 号/群号校验放宽为 1~12 位正整数（原来不校验长度的地方保持兼容）。

### 修复（上游在 GitHub 源码包上的离线回归失败）
- `start.bat` / `restart.bat` 恢复 CRLF，并用 `.gitattributes` 固定。
- `test-preset-prompt` 不再依赖检出时的行尾；`test-preset-local-tools` 在未安装 DSH 时跳过工具名对账、
  不把可选第三方 bundle 的工具名当假名；补公开版 `docs/guides/VOICE.md`（原文件被 .gitignore 排除但被测试依赖）。

### 升级注意
- 必须重跑 `node scripts/setup-dsh.mjs` 并重启 DSH（新 preset 与权限预设）。
- `state/` 可直接沿用；新增 `state/social/`、`state/admin/`。
- 需要 L3 时先在本机运行 `npm run admin:totp-setup`。
