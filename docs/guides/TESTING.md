# 测试说明

## 离线回归（不需要 QQ、SnowLuma、DSH 或网络）

```powershell
npm run test:audit      # 72 个脚本：原版与各版本新增的离线回归，清单见 scripts/test-audit.mjs；macOS 上 test-console-encoding 是已知失败（只适用于 Windows）
npm run test:v030       # 只跑 v0.3.0 的四个新测试
```

| 脚本 | 覆盖 |
| --- | --- |
| `scripts/test-continuity.mjs` | 同号多群识别、同名不同号不合并、改名历史、非法 QQ 号、名片清理、首次部署 listed、入群分类（陌生/熟人/回归/重复）、成员对账、持久化与重启恢复、文件损坏留证与备份恢复、版本过新拒绝、迁移步骤、真删除、私聊记忆不外流、三档共享策略、群级覆盖、recordable=false、冲突排序、注入字数上限、旧版 memberImpressions 迁移、notice 规整（ID 为 number、user_id=0 丢弃）、QQ 接口失败、退群/撤回、跨群协作授权与无内容统计 |
| `scripts/test-admin-control.mjs` | TOTP（RFC 6238 附录 B 测试向量）、窗口/重放/格式、审计哈希链与篡改发现、确认码一次性/过期/错误/次数上限、并发申请互不覆盖、降级与 /panic、L3 需要 TOTP、TOTP 锁定、闲置与最长时长回落、外部提权回退、重启不继承、老版本遗留 closed-agent、切换失败保持原状、AI 申请仍需确认、控制台 L3 要 TOTP、审批编号/裸回复歧义/旧编号/跨会话/超时、命令解析（/permission danger-full-access 拒绝、特权斜杠拦截）、权限映射 fail-closed |
| `scripts/test-integration-v030.mjs` | 在真实 `src/bridge.js`（VM 夹具 + 假 DSH + 假 OneBot）上：确认消息不进模型、DSH 设置写穿、会话钉住权限预设、L1 只读 preset、钉不上就丢弃会话、未授权 closed-agent 拒绝建会话、L3+TOTP、qq-full-ask 缺失 fail-closed、降级/panic/cancel、非 owner 与群内命令无效、提示注入无法提权、特权斜杠不透传、AI 申请工具的会话边界且不泄露确认码、控制台走控制器、外部变更回退、审批展示参数并抹凭据、闲置回落、重启不继承、多群认人与【在场人物】、熟人入群唤醒且不带别处记忆、成员对账、人物工具的 QQ 号/作用域/防投毒、跨群查询与 AI 不可达的管理接口、owner 人物命令与 /say、审计覆盖 |
| `scripts/test-agent-readonly-guard.mjs` | L1 preset 不挂执行类工具；readonly-agent 守卫只多放行只读工具；不带 profile 时与原版一致；L2/L3 审批闸门决策（L2 命令要审批、L3 除只读全部要审批、派生类拒绝、上游拒绝不放宽）；凭据路径保护；operator 守卫；L2/L3 preset 行列表 |
| `scripts/test-control-center.mjs` | v0.4.0 控制中心：SnowLuma 目录识别（版本、完整版/Lite、端口、账号）、版本比较、更新数据迁移（先备份、只搬 config/data、不碰程序文件、拒绝降级/同目录）、更新检查、子进程输出捕获/脱敏/自动重启/停止、HTTP 令牌/Host/跨站/非 JSON、未部署时不能启动桥接、固定命令集、选择目录不启动 SnowLuma、同步 homeDir、L6 合规 |
| `scripts/test-snowluma-reconnect.mjs` | v0.4.1：真实 `@snowluma/sdk` + 假 WebSocket，复现握手只报 error 时 SDK 不重连；连接看门狗恢复连接、连上即停、退避上限；正常 close 路径不变 |
| `scripts/test-agent-errors.mjs` | v0.4.1：DSH 回合错误的错误码识别与分类；日志详情抹掉凭据、令牌、本机路径；群聊只显示错误码 |
| `scripts/test-dsh-endpoint.mjs` | v0.4.1：DSH 地址自动识别（显式配置照用、桌面版优先 19387、命令行版 3080、端口探测） |
| `scripts/test-owner-relay.mjs` | v0.4.2：管理员私聊托付群会话——只有 owner 私聊能托付、目标必须是白名单群、开关默认关闭、限频、待办只看不取直到最终投递、提示词不让原样转发；端点只唤醒目标群会话、不直接发送 |
| `scripts/test-platform.mjs` | 接口平台 M1（仓库内 `interface-platform/`，缺失即失败）：平台自身单元/端到端测试（假 SnowLuma + 真实 `@snowluma/sdk` 客户端走兼容入口、发送状态 confirmed/failed/unknown 与去重、SSE 游标、多账号路由、停用桥接、断开/重连、令牌分离、Host 校验）；控制中心托管平台进程与「接入桥接」备份/还原；`viaPlatform` 时自愈不绕过平台；顶部大标签切换不发请求；控制中心只经 HTTP 管理接口与平台通信 |
| `scripts/test-napcat-manage.mjs` | NapCat 管理：系统「浏览…」窗口（macOS osascript / Windows PowerShell，参数不拼进脚本）、NapCat 版本（后端自报 / Windows 安装文件）、检查更新只读 Release 不下载、设置校验与经控制中心接口保存、页面元素 |
| `scripts/test-qq-backend-label.mjs` | 桥接日志里 QQ 后端的称呼：经接口平台写「QQ 后端（经接口平台 · NapCat 版本）」，直连 SnowLuma 仍写 SnowLuma |
| `scripts/test-mac-app.mjs` | macOS 无窗口启动 App 的脚本约定（后台启动、reopen、控制中心退出后 App 退出、不碰 SnowLuma/QQ）；macOS 上实际生成并校验签名 |
| `scripts/test-dsh-health.mjs` | DSH 探活：连续 2 次失败才判定不可用；失败原因分类（用真实的 fetch「连接被拒」「超时」错误验证）；桥接接线 |
| `scripts/test-linux-support.mjs` | Linux 支持：SnowLuma 2.x Windows / Linux 发行包识别与启动、Node 要求与平台不符时拒绝启动、按平台的更新建议、Linux「浏览…」（zenity / kdialog）、NapCat 在 Linux、systemd 用户服务；并断言 Windows / macOS 原有行为不变 |
| `scripts/test-deploy-fixes.mjs` | Windows 实机部署反馈的回归：ZIP 中文文件名 UTF-8 标志与可执行位、黑话研究日志计数、会话重置清等待租约、Linux 服务文件 POSIX 路径、禁止用 `URL.pathname` 当文件路径 |
| `scripts/test-slang-guess.mjs` | 黑话研究未确认时的 AI 推测（`lastGuess`）：字段清洗与限长、不进提示词、不进给 AI 的公开条目、确认 / 填含义后清空、控制台只在「待研究」显示并转义、「采用为含义」只填编辑框 |
| `scripts/test-dsh-model.mjs` | 控制台选择 DSH 模型：档位规范化与目录硬校验、selectModel 参数（无档位不带字段）、目录缓存、看图能力与图片降级成文字、第三方 / 价格 / off 提示；桥接接口写 config.json 并热生效、目录不可用拒绝保存、AI 令牌拒绝 |
| `scripts/test-quote-forward.mjs` | 引用合并转发：慢取缓存（并发去重、负缓存、后台完成后命中）、收消息时引用解析最多等几秒不卡住、引用里的转发 id 登记为本会话可见（跨群不登记）、消息详情对加载中的 id 明确提示、读合并转发走缓存与长超时、接口平台只给 get_msg / get_forward_msg 放宽超时、发送引用时「加载中」不算确认归属 |
| `scripts/test-mode-handover.mjs` | 切换 agent 等级不失忆：哪些会话能休眠、休眠表清洗、恢复 / 保留 / 归档判定；二代 → agent L2 → 回落的端到端（聊天会话不归档并原样复用、令牌作废、agent 会话第一条消息带私聊交接且不含群聊内容、回落时高权限会话归档、恢复后群只收到休眠提示）；过期 / 模式不同 / `/reset` / 关掉开关时归档；L1→L2 高权限会话不休眠；确认码与管理命令不进交接记录 |
| `scripts/test-scheduler.mjs` | 定时任务：按任务时区计算（含夏令时）、各种重复方式与边界日期、随机规则确定且在时间段内、不合法规则的提示；引擎的限额 / 免打扰 / 错过补发 / 满次停用 / 持久化 / 读坏不覆盖；AI 改不了开关和限制、只能发给管理员私聊；`/remind` 解析；桥接端到端（/remind 不进模型、到点发文字、AI 来说带上任务、AI 工具只在管理员私聊并另发确认、控制台接口拒绝 agent token）；控制台页面接线 |
| `scripts/test-silence-schedule.mjs` | 定时静默：时间段校验、哪些天（每天 / 工作日 / 周末 / 自选 + 跳过节假日）、跨午夜按开始那天、DeepSeek 高峰预设、临时恢复到这一段结束、持久化；桥接端到端（静默时不唤醒、消息照记、管理员私聊不受影响、定时任务跳过 / 照常执行、固定文字照发、预览标出会跳过、手动恢复正常、结束补唤醒、接口拒绝 agent token）；「只在被 @ 或私聊时唤醒」档位（没人找不唤醒、被 @ 的群放行能唤醒能发、别的群照样静默）；控制台面板 |
| `scripts/test-role-refresh.mjs` | 人格切换 / 修改后二代会话重新读卡：角色卡指纹、读卡记录按会话 + 指纹（换会话也算没读过）、持久化 0600 且不存卡片内容；下一次唤醒把新卡放最前面、投递后不再重复、引导唤醒不带；「立即」只唤醒没读到新卡的会话；`qq_get_prompt` 记为已读；`/api/role` 与 `/api/roles/update` 的生效方式、改非当前人格不唤醒 |
| `scripts/test-sticker-describe.mjs` | 一键补表情说明：挑选没有说明的表情、切批、提示词（图里文字不是指令、只输出 JSON）、解析清洗（单行、限长、编号越界 / 重复 / 缺失、偏凶 / 粗口标慎用）；端到端（控制台启动 → 专用会话看图 → 写进本地库，已有说明与官方备注不动，多批都收得到）；闸门（agent token、agent 模式、不能看图、DSH 未就绪、运行中） |
| `scripts/test-web-image.mjs` | 搜图并发送：搜索词清洗、严格安全搜索、结果页解析（去重、丢 explicit 缩略图、只认 http/https）、给 AI 的列表不含网址、候选过期与「看过」标记、每小时上限；端到端（搜图 → 没看过不能发 → 预览 → 发送图片段）；闸门（默认关、只认管理员私聊 + 二代仿真 + 有效令牌、不能看图不能预览、MCP 只在开关为 true 时注册）；网关回执超时按结果未知处理 |
| `scripts/test-agent-token-guard.mjs` | 会话令牌抄错：近似令牌只认唯一命中、提示不含正确令牌、下次唤醒提醒并在送达后清掉、连错 3 次换新且旧令牌立即失效、手动换令牌只给控制台、二代里被拦的内部输出不往群里发通知 |
| `scripts/test-prompt-blocks.mjs` | 不常变的大块只在变化时注入：第一次完整、没变一行、内容 / 会话变化与满 N 次 / M 小时 / forget 后重新完整、持久化不存内容；端到端群规则每次都在、引导唤醒总完整 |
| `scripts/test-auto-compact.mjs` | 自动压缩：配置规范化、阈值与冷却、超阈值空闲后执行 /compact 并让关键内容下次重新完整给、忙 / 未超 / 非二代 / 关闭时不压、手动接口只给控制台；控制台改压缩方式（提前压缩填几万 / 交给 DSH，校验 5～80 万、写进 config.json、马上按新阈值判断、AI 改不了） |
| `scripts/test-default-roles.mjs` | 恢复默认人格：发布包自带的原版卡合法、状态（在 / 被删 / 改过）、被删放回、改过先备份再恢复、本来就是原版不动、备份最多 10 份、不是默认人格拒绝；端到端（恢复当前人格按生效方式处理、不自动切换人格、AI 调不了） |
| `scripts/test-role-per-key.mjs` | 按会话设置人格卡：老状态文件不变、byKey 命中 / 未命中 / null 三种回落、非法 key 与别名、路径穿越拒绝、改名 / 删除跟随；各会话注入自己的卡（二代【当前角色】、一代角色提示、qq_get_prompt）；只给卡变了的会话安排读卡唤醒；控制台接口与 AI 调不了；`/role` 只改当前会话、群友发的不生效 |
| `scripts/test-backfill.mjs` | 断线补收：断档检测（含桥接重启后读回）、消息 ID 去重、命令类识别、挑选（时间窗 / 自己发的 / 收过的 / 太旧 / 上限）；端到端（补收进未读带原始时间与标记、有 @ 排唤醒、唤醒提示说明是补收的且送达后清掉、不执行补收到的命令只提醒管理员、重复补收不重复、太旧不唤醒、非二代不补）；启动后第一个事件包自动触发；拉历史失败时记下没补上的时间、重试、下次从更早的时间补 |
| `scripts/test-send-limit-console.mjs` | 发言上限：超过每分钟上限 AI 收到说明（桥接的上限，不是 QQ 的）、控制台状态里有最近 24 小时被拦次数（AI 拿不到）、控制台改上限马上生效；总览页卡片 |
| `scripts/test-agent-preset-patches.mjs` | preset 源与 bundle patch 不漂移（含新 preset） |

原版测试在本仓库里做过的调整（都是让测试不依赖开发机环境，没有放宽断言）：
- `test-preset-prompt.mjs`：行尾测试改为显式构造 CRLF 样本，不再依赖检出时的行尾；
- `test-preset-local-tools.mjs`：找不到 DSH 安装时跳过工具名对账（原来是抛错）；
  只存在于可选第三方 bundle 的三个工具名（`dsh_snapshot` 等）不算「假名」；
- `test-audit-bridge.mjs`：closed-agent 用例先设置级别 L2（v0.3.0 起未授权的 closed-agent 拒绝建会话）；
- `start.bat` / `restart.bat` 恢复 CRLF 并加 `.gitattributes` 固定；补了公开版 `docs/guides/VOICE.md`。

用真实 DSH 安装包做工具名对账（可选，仍然离线）：

```powershell
$env:DSH_INSTALL_MODULES = "<装了 @deepseek-ai/dsh（0.2.0-rc.2 或 0.2.1）的目录>\node_modules"
node scripts/test-preset-local-tools.mjs
```

## 需要部署后集成验证的部分

| 项 | 怎么验证 |
| --- | --- |
| DSH 权限预设目录含 qq-full-ask、`commands/execute "/permission …"` 生效、prompt 不执行斜杠命令、qq-agent-readonly 已加载 | `npm run probe:permission`（需 DSH 运行） |
| L1 守卫确实收到 `profile: readonly-agent` 配置 | L1 下让 Agent 尝试写一个文件，应被「不在 L1 只读 Agent 白名单内」拒绝 |
| SnowLuma 实际推送的成员通知字段 | `npm run probe:member-events -- 300`（只读、默认打码） |
| 入群唤醒、熟人认出、审批消息里的参数展示、TOTP 端到端、自动回落 | 见 [../DSH_DEPLOYMENT.md](../DSH_DEPLOYMENT.md) 第 12 节 |
| **L2/L3 审批闸门在真实 DSH 上是否弹审批** | L2 下让 Agent 执行 `dir`，必须先收到「🔐 审批 #n」 |
| 控制台新增的级别选择 / 紧急关闭按钮 | 浏览器手测（Playwright 回归 `npm run test:console-ui` 的基线未重录，见已知问题） |
