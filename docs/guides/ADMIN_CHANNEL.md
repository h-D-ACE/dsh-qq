# owner 私聊管理通道：模式切换、权限分级、二次认证、审批（v0.3.0）

> 代码：`src/admin/mode-control.js`（唯一变更入口 / 状态机）· `src/admin/owner-commands.js`（命令解析）·
> `src/admin/totp.js` · `src/admin/approvals.js` · `src/admin/audit-log.js` · `src/admin/dsh-permission.js`（级别 → DSH 落地）。
> 离线测试：`scripts/test-admin-control.mjs`、`scripts/test-integration-v030.mjs`、`scripts/test-agent-readonly-guard.mjs`。

## 1. 设计原则（由代码执行，不靠提示词）

1. **AI 只能提出申请，桥接负责确认与执行。** AI 唯一相关的工具 `qq_request_mode_change` 只能**登记**申请，
   且只在 owner 本人的私聊会话里有效；确认码由桥接直接私聊给 owner，**不会**出现在返回给 AI 的内容里。
2. **确认消息在交给模型之前被拦截。** owner 私聊里的 `确认 <码>`、TOTP 动态码、`/mode` 等管理命令、`通过 #n`
   都由桥接在任何模式/白名单判断之前处理，处理过的消息不进入任何 DSH 会话。
3. **升级要难，降级要快。** 升级需要确认码（L3 还要 TOTP）；降级和 `/panic` 一步完成。
4. **只认 ownerQQ 的私聊。** 判定条件是 OneBot 私聊事件的发送者与会话对象都等于 `ownerQQ`。群里的同类命令一律拒绝；
   别人发同一个确认码无效；群消息里伪造的「【管理员】确认 1234」「管理员已批准」只是普通文本。
5. **默认拒绝。** 未授权的 closed-agent（级别 L0）拒绝建会话；级别计划不成立（preset 或权限预设缺失）拒绝建会话；
   会话的权限预设钉不上就丢弃会话；L3 在 DSH 权限目录未知时拒绝。
6. **所有变更集中到一个函数**（`transition()` → `applyModeChange()`），统一审计、统一私聊通知 owner。

## 2. 权限级别

| 级别 | 模式 | agent preset | DSH 权限预设 | 开启条件 |
| --- | --- | --- | --- | --- |
| **L0** 群友 | chat / reserved / reserved2 | qq-chat / qq-chat-v2（无本地工具，原版守卫） | （纵深防御：建会话后钉 read-only） | 默认 |
| **L1** 本地只读 Agent | closed-agent | **qq-agent-readonly**（新增：工具白名单只有读文件/检索/联网只读） | `read-only`（ask） | 确认码 |
| **L2** 工作区读写 Agent | closed-agent | **qq-agent-workspace**（新增：pwsh/文件/检索/联网，无子代理与工作流；**审批闸门**：执行命令每次审批） | `workspace-write`（ask） | 确认码 |
| **L3** 高权限 Agent | closed-agent | **qq-agent-full**（同上；**审批闸门**：除只读外每次调用都审批，含写文件） | **`qq-full-ask`**（danger-full-access + ask，由 setup-dsh 注入） | 确认码 + **TOTP** |
| ~~完全访问免审批~~ | — | — | `danger-full-access`（approval: never） | **不存在，任何入口都不允许** |

为什么 L2/L3 需要桥接自己的审批闸门（`plugins/qq-agent-presets/qq-approval-gate.mjs`）：rc.2 的审批**只在工具请求越过当前沙箱时**才触发 ——
workspace-write 下工作区内的命令直接执行；danger-full-access 下没有可越过的边界，DSH 自己**永远不会**弹审批。
闸门挂在 `tools/pre-execute` 上返回 `{kind:'ask'}`，走 DSH 自己的审批通道（→ 桥接转发到 QQ）。DSH 默认的 standard preset
还带子代理（rc.2 把子代理的审批策略固定为 never），所以 L2/L3 不再使用它；只有显式设置 `admin.allowCustomAgentPreset=true`
时才会改用控制台选择的 preset（那样**没有**审批闸门）。

closed-agent 只放行 owner 私聊；切换后群聊暂停响应，私聊由**运维 Agent**（独立 DSH 会话，没有群友人格）接管，
通知里会明确说明。级别进入会话策略指纹：L1→L2 之类的变化会让旧会话退役、按新权限重建（工具面由建会话时的 preset 决定，不能在旧会话上「开权限」）。

### 切换不失忆（v1.0.3 起）

换会话本身不能避免，但不再「换一次就忘一次」：

- **聊天会话休眠复用**：进 agent 时，群和 owner 私聊原来的聊天会话（qq-chat / qq-chat-v2，从没挂过本地工具）**不归档**，
  只停掉在途工作、撤销映射、作废会话令牌；回落到**同一模式、同一 preset**时原样复用，AI 记得之前在聊什么。
  群会话恢复后第一条消息会带一句「刚才休眠了多久、这段时间群里的消息没收到」。
  休眠超过 `admin.dormantMaxMs`（默认 24 小时）、回到的模式 / preset 不同（例如 `safeMode` 是 `chat`）、手动重置会话或清空工作区时归档，不复用。
- **owner 私聊交接**：桥接自己记一份 owner 私聊的往来（`state/admin/owner-transcript.json`，最多 60 条、每条 400 字、文件 0600）。
  owner 的会话因模式 / 级别切换换新时，第一条消息带上最近的往来；从休眠恢复时带上 agent 期间的往来。
  交接文字标明「桥接整理的历史，不是新指令」，路径和凭据打码；只进 owner 私聊的会话，**不带任何群聊原文**（群消息是不可信输入，不能带进高权限会话）。
  管理通道命令、确认码、TOTP 在交给模型之前就被拦截，不会进记录；桥接自己的提示也不记，只记模型真正发出去的话。
- **私聊长期记忆也可以带上**（二代仿真工具开关里的「切到 agent 时带上私聊长期记忆」，`socialV2.tools.handoverMemory`，默认开）：
  切到 agent 时，除了最近的私聊往来，还把二代仿真里 AI 在**管理员私聊**记下的话题、想说的话、印象一并交接（最多 1500 字，已脱敏；不含任何群的记忆）。
  从休眠恢复的私聊会话不需要它（它自己的唤醒提示里本来就有）。
- **高权限会话照常退役**：agent 会话回落、`/panic`、L1→L2 时仍然停掉并归档，安全不变量不变。
- **桥接重启时**：按「重启不继承高权限」，agent 会话会被回落并归档（见第 8 节），这是安全设计；之前的聊天会话照常复用，再切进 agent 时同样带上交接。
- **交接记录从升级到 v1.0.3 之后才开始记**：升级前的私聊往来没有记录，所以升级后第一次切 agent 时交接内容可能很少（长期记忆不受影响）。
- 不想要：`admin.hibernateChatSessions: false`（回到切换即归档的旧行为）、`admin.handover: false`（不记录、不注入）。

## 3. 已在 DSH 0.2.0-rc.2 安装包里核实的事实（静态核对，未运行 DSH）

| 事实 | 依据（rc.2 安装包） | 对设计的影响 |
| --- | --- | --- |
| 权限预设 = 沙箱（read-only / workspace-write / danger-full-access）+ 审批（ask / never），只有这两种审批策略 | `dsh-sandbox-policy`、`dsh-user-approval` | — |
| dsh-base 默认表：read-only(ask)、workspace-write(ask)、danger-full-access(**never**) | `dsh-base/cordis.patch.yml` 的 `id: permission` 行 | L3 不能用内置 danger-full-access；需要自定义 qq-full-ask |
| 预设表只能通过 profile patch 覆盖 `id: permission` 行的 config；settings 只能改 volatile 的 `defaultPreset` | `dsh-permission-presets` Config、`dsh-settings` 的 volatile 检查、`cordis-plugin-include` 的 patch 语义 | `setup-dsh.mjs` 写 profile patch |
| 单会话权限只能用 `commands/execute(agentId, "/permission <名>", [])` 设置；成功返回 `preset <名>`，无参数时返回 `current preset X` | `dsh-permission-presets` 注册的 `/permission` 命令、`dsh-commands` RPC | 桥接建会话后钉权限；每分钟用无参 `/permission` 核对 |
| **`session/prompt` 不解析斜杠命令**，文本原样进模型 | `dsh-api-session-controller` 的 prompt 实现 | 原版注释「其余 / 开头内容照常发给 DSH 的斜杠命令」在 rc.2 已不成立；QQ 文本透传**不能**改权限。v0.3.0 仍拦截特权斜杠命令（纵深防御，防未来版本行为变化） |
| `approval/request` 只带 `toolName` / `callId` / `reason`，**不带参数**；参数在之前同 `callId` 的 `tool/call` 事件里 | `dsh-user-approval` 类型、`dsh-agent-loop`（tool/call 先于审批） | 审批登记表按 callId 关联参数并展示 |
| 审批结果只有 `allowed-once` 放行（另有 rejected / cancelled / unavailable），没有「永久允许」 | `dsh-user-approval` OUTCOMES | 装复杂软件可能要批很多次 |
| **审批只在越过沙箱时触发**；`tools/pre-execute` 瀑布可以返回 `{kind:'ask'}` 主动要求审批 | `dsh-tools` 的 `prepareExecution` / `serviceAsk`、`PreToolDecision` 类型、`dsh-tool-pwsh` 的越权流程 | L2/L3 用桥接的审批闸门；不能把 `qq-full-ask` 当成「每次审批」 |
| 子代理的审批策略被固定为 never | `dsh-permission-presets` 注释、SessionEventMap | L2/L3 preset 不挂子代理/工作流；守卫与闸门都拒绝这类工具 |
| Windows 上 read-only 沙箱只限制写，且是 partial（硬链接、NUL 等缝隙），读不受限；沙箱不管网络 | `dsh-pwsh-sandbox`、`dsh-sandbox-local`、`dsh-sandbox-windows-acl` README | L1 用**工具白名单**挡写入/执行，不依赖沙箱 |
| agent preset 不能固定权限预设 | `dsh-agent-preset-registry` 定义、README | 权限只能由桥接按会话设置 |

上述行为仍需**部署后用 `npm run probe:permission` 实测确认**（脚本会逐项断言，任何一项 ❌ 都不要启用 closed-agent）。

## 4. 命令（只在 owner 私聊有效）

| 命令 | 作用 |
| --- | --- |
| `/mode` | 查看当前模式、级别、待确认申请、待审批、TOTP 状态、人物库统计 |
| `/mode reserved2` · `/mode chat` · `/mode reserved` | 切换群友模式（降级/平移，一步完成） |
| `/mode agent [L1\|L2\|L3]` | 申请切到运维 Agent（缺省级别 `admin.defaultAgentLevel`，默认 L1） |
| `/level L1\|L2\|L3\|L0` · `/permission read-only\|workspace-write\|qq-full-ask` | 调整级别；`/permission danger-full-access` 被明确拒绝 |
| `确认 <码>` / `确认 <码> <6位动态码>` | 确认申请（L3 必须附 TOTP） |
| `/cancel` | 取消全部待确认申请 |
| `/panic` 或 `紧急关闭` | 立即回到 `admin.safeMode`（默认 reserved2）/ L0 |
| `/approvals` · `通过 #n` · `拒绝 #n` | 查看 / 处理审批 |
| `/audit [条数]` | 查看审计记录并校验哈希链 |
| `/whois <QQ>` · `/people [关键词]` · `/review` | 人物档案、待审核共享与迁移 |
| `/person <QQ> name <称呼>` · `level <熟悉度>` · `avoid/ok <偏好>` · `alias <QQ>` · `forget` | 管理人物档案 |
| `/note <QQ> <内容>` · `/note-del <QQ> <编号>` · `/share approve\|reject <QQ> <编号>` | 全局记忆与共享审批 |
| `/say <群号> <内容>` | 以机器人身份在白名单群原话发言 |
| `/admin` | 命令列表 |

自然语言（确定性正则，不经过模型，`admin.naturalLanguage`）：「切换到 agent 模式」「切回群友模式」「权限提升到 L2」等
只会**登记申请或执行降级**，与对应命令完全相同。

被拦截、绝不转交 DSH 的特权斜杠命令：`/permission(s)` `/perm` `/sandbox` `/approval(s)` `/preset(s)` `/agent` `/yolo` `/mode` `/level`
`/plan` `/goal` `/model` `/export`。其它斜杠命令（例如 `/compact`）保持原版行为（作为文本交给会话）。

## 5. 确认流程

```
owner：/mode agent L2            （或自然语言；或 reserved2 下 AI 调 qq_request_mode_change 代为登记）
桥接：⚠️ 申请 #3：切换到 closed-agent，权限 L2 …  确认请回复「确认 7342」，2 分钟内有效。
owner：确认 7342                  ← 桥接拦截，不交给任何模型
桥接：✅ 申请 #3 已确认。
桥接：🔔 模式已变更：reserved2 → closed-agent / 当前权限：L2 … / 来源：QQ 管理通道（申请 + 确认码）（时间）/ 结果：成功
```

- 确认码绑定**这一个**申请（目标模式+级别），随机生成、2 分钟有效（`admin.requestTtlMs`）、只能用一次、
  每个申请最多试 3 次；并发申请各有不同的码，互不覆盖（最多 3 个待确认）。
- 申请发起后如果模式已经变了（例如期间被降级或另一个申请先确认），旧申请作废，防止「换了上下文还沿用确认」。
- 任何成功的降级/模式变化都会作废所有待确认申请。

## 6. TOTP（L3 的第二因素）

- `npm run admin:totp-setup` 在本机终端生成秘密（RFC 6238 / SHA1 / 30 秒 / 6 位），写入 `state/admin/totp.json`；
  也可以用环境变量 `QQ_BRIDGE_TOTP_SECRET` 提供（优先）。秘密不进仓库、不进提示词、不进日志。
- 重放防护：记录最后一次成功使用的时间步，同一个码（或更早的码）不能再用；允许 ±1 个时间步的时钟误差。
- 尝试次数限制：连续 5 次错误锁定 15 分钟（`admin.totpMaxFailures` / `totpLockMs`），锁定写审计。
- 控制台开启 L3 同样要求 TOTP（`POST /api/mode` 带 `totp`）。

**威胁边界（不夸大）**：TOTP 能挡住「只拿到了 owner 的 QQ 账号」的攻击者。它挡不住：同时拿到 owner 手机/验证器的攻击者；
已经能在本机执行代码或读 `state/` 的攻击者；QQ 客户端或电脑本身被控制的情况（动态码经 QQ 传输，会留在聊天记录里 ——
所以每个码只能用一次，30 秒内过期）。远程运维的更安全做法仍是 VPN + DSH Web UI / 远程桌面。

## 7. 审批增强

- 每个 DSH 审批请求进入登记表，分配**全局唯一、单调递增、跨重启不复用**的编号（`#n`），多个并发审批互不覆盖。
- 展示：工具名、理由、按 `callId` 关联到的**实际参数**（命令/路径/URL 优先显示，最多 600 字）；
  owner 私聊里只抹掉凭据赋值（`password=…`、`token: …`），群会话按原版规则整体脱敏；
  找不到参数时明确提示「无法展示具体命令——如不确定请拒绝」。
- 回复：「通过 #n」/「拒绝 #n」；只有一个挂起时也接受裸「通过」「拒绝」；多个挂起时裸回复会被要求带编号。
- 绑定：回复必须来自 ownerQQ、且在发起审批的同一会话；已决/超时/会话已重建的编号回复一律提示「不存在或已失效」。
- 超时（`questionTimeoutMs`，默认 5 分钟）自动回 DSH `rejected` 并通知；会话退役/重置时其审批全部作废（回 rejected）。
- AI 没有任何能决定审批的工具或接口；「AI 说已经批准了」没有任何效果。

## 8. 自动降权与变更通知

- 高权限（L1~L3）闲置 `admin.idleTimeoutMs`（默认 30 分钟，owner 消息与 Agent 回合结束都算活动）或满
  `admin.maxElevatedMs.<级别>`（默认 L1 4h / L2 2h / L3 1h）后自动回落到 `admin.safeMode` / L0。
- **重启不继承高权限**：桥接启动时如果上次停在 L1~L3 或发现 closed-agent，一律回落并通知。
- 回落 / `/panic` 之后，进 agent 前的聊天会话会被复用、owner 私聊带交接（见第 2 节「切换不失忆」），不会因此失忆。
  觉得回落太勤可以调大 `admin.idleTimeoutMs`（闲置）或 `admin.maxElevatedMs`（最长时长）——这是安全与方便的取舍，默认值偏保守。
- 通知内容：变更前后模式、当前权限级别、来源（QQ 命令 / 申请+确认码 / 控制台 / 自动回落 / 外部变更回退 / 启动校验 / 紧急关闭）、时间、成功或失败。
  失败时状态不变，并说明原因。

外部变更（无法事前阻止的路径 → 检测 + 告警 + 安全回退）：

| 路径 | 处理 |
| --- | --- |
| DSH 设置里直接把 `qq-mode` 改成 closed-agent | 轮询发现新值 → 默认**回退**并发 🚨 告警（`admin.externalEscalation: "alert"` 时只告警，并且**最多按 L1** 接受） |
| DSH 设置/控制台改了非提权的模式 | 接受并通知 |
| DSH 设置/控制台改了 `ownerQQ` | 审计 + 通知新旧 owner + 取消待确认申请；高权限期间立即紧急关闭 |
| 有人在 DSH Web 界面手动改了 owner 会话的权限 | 高权限期间每分钟用 `/permission` 只读查询核对，不一致、返回格式无法识别或连续 3 次查询失败 → 告警 + 紧急关闭（fail-closed） |
| 手改 `state/mode.json` | 同 DSH 设置（DSH 不可用时以本地文件为准） |
| 控制台 `/api/mode` | 走控制器（L0 时 L1/L2 直接生效、L3 要 TOTP；高权限期间与回落冷却期内拒绝提权），同样审计+通知 |

## 9. 审计日志

`state/admin/audit.jsonl`：每行一条 JSON，带 `seq`、时间、事件名、上一条的哈希与本条哈希（SHA-256 链）。
覆盖：申请创建/确认/过期/作废/拒绝、TOTP 通过/失败/锁定、模式变更成功/失败、权限预设钉住/失败/漂移、审批请求/决定/超时、
特权斜杠命令拦截、人物档案的管理操作、跨群查询、`/say`、ownerQQ 变更、桥接启动校验。
哈希链只能**发现**事后改动，不能阻止本机管理员改文件。`/audit` 与 `GET /api/admin/audit` 会校验链。

## 10. 已知限制与需要部署后验证的事项

- 第 3 节的 DSH 行为是对 rc.2 **安装包源码的静态核对**；`npm run probe:permission` 才是在目标机上的实测。
- L1 守卫与 L2/L3 闸门都依赖 Cordis 把行 `config` 作为 `apply(ctx, config)` 的第二个参数传入（Cordis 惯例）；
  若某个 DSH 版本不传：L1 守卫退回群友白名单（**更严**），闸门按 L3 处理（**更严**），不会变宽。
  闸门对 `tools/pre-execute` 的使用来自 rc.2 源码，**必须部署后实测**：L2 下让 Agent 执行 `dir`，应收到「🔐 审批 #n」。
- **L2/L3 的 Agent 运行在 owner 的本机账户下**，Windows 沙箱不限制读。审批闸门让每一条命令都经过你的眼睛，
  但一旦你批准了一条读取机密或访问本机 API 的命令，就等于交出了这些机密。已做的缓解：
  文件工具不能读 `state/`、`config.json`、`~/.dsh/.credentials.yaml`（`protected-paths.mjs`）；控制台 API 只认请求头里的令牌（`?token=` 只能打开页面）；
  高权限期间及回落后 10 分钟内控制台不能提权（`admin.consoleEscalationCooldownMs`）；DSH 设置里的外部提权会被回退；会话权限每分钟核对。
  **请不要批准你看不懂的命令**，尤其是读取 `state\`、`.dsh` 或访问 `127.0.0.1:3080/3100` 的命令。
- L3 本质上就是完全访问（只是每一步都要你批准）。不需要时不要开 L3，或设 `admin.allowL3=false`。
- 管理通道建立在 QQ 账号之上：owner 的 QQ 被盗时，攻击者可以用确认码开启 L1/L2（L3 还需要 TOTP）。
  对此的缓解是：闲置自动回落、每次变更都通知、审计、`admin.allowL3=false` 或干脆 `admin.enabled=false`。
- DSH 0.2.0-rc.2 是开发者预览，接口可能在后续版本变化；升级 DSH 前先跑 `npm run probe:permission` 与 `npm run verify:adaptation`。
