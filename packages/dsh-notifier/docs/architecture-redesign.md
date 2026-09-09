# dsh-notifier 架构重构方案（v2，结构定稿）

> 依据：规格章（F 编号 + 规则矩阵）+ 目标架构图（docs/diagrams/current-architecture.{html,json}）+ 分层对抗评审（前序会话）+ **结构对抗性评审（双视角独立子代理：微服务专家 c4be9ca2 / 资深架构师 221c05b0，主会话逐项交叉验证全部成立）+ 人在环拍板（G2/G3）**。
> 定调：**整体重构为目标架构，不拘泥于当前实现现状**（用户 G2 拍板）；结构方向「需修改后定稿」，M1-M12 修正项已全部采纳（见 §7）。

## 1. 目标分层（终稿）

```
                ┌─ SDK 契约层（registerKind/confirmKind/listKinds/registerChannel/send · 插件 ABI）
外部插件 ──────►│   注册驱动：运行时裁决确认 + UI 列表（不扩展配置合法范围）
                └── registerChannel = 配置层注册面（只增配置、非功能特性；保留寄存器，不接线投递）
前端 ──────────► API 层（REST/SSE · loopback 围栏）──► 配置域经 ConfigPort 读取
后端主链（事件驱动）：
  ① 事件监听层（宿主事件订阅/详情提取/事件源状态机：错误合并·聚合）
     ↓ 事件+详情（已聚合 + 详情字段预脱敏）
  ② 路由与裁决层（kind 确认态/免打扰[纯函数]/kindRoutes/stale/severity —— current() 单刻快照）
     ↓ 判定结果
  （内容脱敏：渲染完成后、任何落史/投递前统一处理 · 开关 sanitizeContent 控制）
     ↓ 已脱敏文本
  ③ 投递编排层（fail-soft 逐频道 + 码点截断 + 受理/终态解耦 + 框架层重试/并发门）
     ↓            ↘
  ④ 渠道适配层          归档存储（history/status 两 store → store 接口 → 本地文件）
  browser(SSE)/system/bark/webhook → OS 原生/远程推送
```

## 2. 目标目录结构（v2 定稿：35 个宿主 TS，含 9 个 interface.ts）

```
src/
  index.ts                 # 装配层（唯一允许 import 全部域 interface.ts）+ 包导出面（re-export 段分节注释）
  service.d.ts             # cordis 声明合并：只 re-export sdk/interface.ts 的类型
  config/                  # 配置域（契约 + 桥两段）
    interface.ts           # NotifyConfig/ChannelConfig/SoundSetting… + ConfigPort（含 confirmKind + 降级语义）
                           # + normalize/validate/sanitize/redact/unmask + createSettingsBridge/installNotifierSettings/
                           #   migrateLegacyConfig/SETTINGS_NS/路径函数 re-export
    config.ts              # 类型 + 默认值 + CONFIG_KEYS/ASSEMBLY 锁（零 node 依赖）
    normalize.ts           # normalizeConfig + 频道/kindRoutes/allowKinds/声音归一化（零 node 依赖）
    validators.ts          # SETTING_VALIDATORS/HINTS + 各 is* 严格校验（零 node 依赖）
    redact.ts              # redactConfigView / unmaskChannels / SECRET_MASK / CHANNEL_SECRET_FIELDS
    paths.ts               # DSH_HOME + configFile/historyFile/statusFile/toastScriptPath（node 依赖面）
    quiet-hours.ts         # 零依赖纯函数（parseHHMM/isInQuietHours/QUIET_ALLOW_KINDS）
    settings.ts            # 官方 settings 接线（薄包装，forward shared/settings-namespace）
    settings-bridge.ts     # 镜像/CAS/迁移桥（ConfigPort 实现）
    migrate.ts             # 存量迁移
  text/                    # 跨层文本域（文案/脱敏/命令构造，纯函数）
    interface.ts           # NOTIFY_KINDS/NotifyDetail/formatDuration/prettyToolName/KIND_SEVERITY/sanitizeErrorText/
                           #   sanitizeNoticeContent/SystemTone/buildSoundCommand/buildSystemCommand/toneFileCandidates/音色映射
    message.ts             # 文案单表 + 格式化 + 工具名美化（KIND_SEVERITY 随 NOTIFY_KINDS 同域）
    sanitize.ts            # SANITIZE_RULES（why 注释整体保留）+ sanitizeErrorText + sanitizeNoticeContent（单实现双导出）
    system-commands.ts     # 音色平台映射 + 命令构造
  channels/                # 渠道适配域（内置 + 配置驱动 + 装配）
    interface.ts           # createBarkChannel/createBarkGate/createWebhookChannel/createBrowserChannel/createSystemChannel/
                           #   createOutboundChannelResolver + 各渠道常量（含 renderWebhookBody/priorityFor）
    bark.ts                # 出站：单次投递 + retryable 错误标记（4xx 不可重试；网络/5xx 可重试）；重试/门在框架层
    webhook.ts             # 出站：单次投递（失败不重试，retry 缺省 = 关）；凭据 scrub 出口
    browser.ts             # 内置 browser 频道（createBrowserChannel({sse})，包 SseHub type）
    system.ts              # 内置 system 频道（createSystemChannel({system})，包 SystemNotifier type）
    outbound.ts            # 统一装配：enabled 过滤 + 实例化（不再按 type 特判 gate）
  server/                  # API 层（路由 + SSE 枢纽 + 系统通知）
    interface.ts           # SseHub/SystemNotifier/RouteDeps(=ConfigPort+注入面)/PatchResult/ROUTES
                           # + createSseHub/createSystemNotifier/applyConfigPatch/buildRoutes re-export
    routes.ts              # ROUTES + RouteDeps + applyConfigPatch + buildRoutes（纯组装）
    sse-bus.ts             # SseHub 业务包装（seq + 滚动缓冲，委托 shared/sse-hub.js）
    system-notifier.ts     # 系统通知（探测/节流/runCommand/deliverOnce/自播判定）
  pipeline/                # 推送管线域（裁决 + 投递编排）
    interface.ts           # AdjudicatedNotice/AdjudicateResult/ResolvedTarget/SuppressReason/DispatchSpec/
                           #   RetryableError 协议 + createAdjudicator/createDeliverer + AdjudicateDeps/DeliverDeps
    adjudicate.ts          # 裁决：current() 单刻快照；enabled→确认→免打扰→路由→stale→severity（isKindConfirmed 经 deps 注入）
    deliver.ts             # 投递编排：截断/重试门/fail-soft/终态上报/落史（全部经 deps；门表 = 实例闭包按 channelId 键控）
  sdk/                     # SDK 契约域（对外 ABI + 服务实现）
    interface.ts           # NotifyRequest/NotifyResult/KindRegistration/NotifyChannel/ChannelCapabilities/
                           #   NotifierService/NotifierServiceInternal/NotifySentEvent/NotifierServiceDeps/
                           #   NotifySeverity/BUILTIN_CHANNELS + createNotifierService/getNotifierService
    service.ts             # createNotifierService 实现：注册表 + send/sendKind 编排（渲染→裁决→脱敏→投递/落史）
  events/                  # 事件监听域
    interface.ts           # EventHandlers/EventHandlersDeps/DoneBatcher + createEventHandlers/createDoneBatcher
                           #   + sessionTitleOf/lastTurnEndOf/isSubagentOf/SubagentOwnership re-export
    event-handlers.ts      # 审批/提问/完成状态机/错误合并/turn-end/askRemind 定时器
    aggregate.ts           # 完成风暴聚合（DoneBatcher）
    agent-session.ts       # 会话读取/子代理判定（事件层专属纯函数）
  stores/                  # 归档存储域
    interface.ts           # HistoryStore/HistoryEntry/HISTORY_LIMIT/StatusStore/ChannelStatusEntry
                           # + createHistoryStore/createStatusStore
    history.ts             # jsonl（写队列/原子写/按天清理）
    status.ts              # json（debounce/原子写/64 条上限）
```

规模说明：目标 35 个宿主 TS 文件（含 9 个 interface.ts）+ toast.ps1；对 4.3k 行单进程 cordis 插件属「值得但偏重」区间——门面纪律须配脚本门禁随 PR 落地（见 §10）防腐化。

## 3. interface.ts 门面纪律

1. **目录唯一出口**：域外代码（其他目录 / index.ts / service.d.ts）一律 `import "<域>/interface.ts"`；域内实现文件互引不受限。src 内禁止跨目录 import interface.ts 以外的文件（shared/ 仓库共享层与官方类型层为全局例外）。
2. **内容 = 类型 + 公开入口 re-export**：本域独有、需面外的类型在 interface.ts 定义；公开工厂/常量 `export { createXxx } from "./impl.ts"` 收口；私有实现细节不导出。
3. **类型原创规则（P2-11）**：非本域原创的类型一律 `import type` 自依赖域再 re-export，禁止把类型定义下沉到 impl 造成消费者被迫 import impl。
4. **域内防表观环（P2-3）**：域内实现文件**不得** import 本域 interface.ts 的**值**（interface re-export impl 与 impl import interface 值会成 impl→interface→impl 表观环）；确需 interface.ts 内类型时用 `import type`（编译期擦除）。
5. **跨域类型依赖显式化**：interface.ts 顶部 `import type "../<域>/interface.ts"`——依赖图 = interface 级依赖图（type/值双构，见 §4）。
6. **运行时跨域一律经 deps 注入**：域 A 需要域 B 能力时在 A 的 interface.ts 声明注入面（如 `AdjudicateDeps.isKindConfirmed`），由 index.ts 组装，避免运行时耦合与循环。
7. **注入回调签名一律结构化字面量**（P1-9）：禁止跨域 import 对端域类型（含 import type）——server 不 import sdk 的前提（sendTest/listKinds 等保持内联签名）。

## 4. 域依赖图（v2，type/值双构；M3 修正后）

```
text ────type──→ config                       # SoundId/SoundSetting
server ──type+值→ config                       # sanitize/validate/redact/unmask + ConfigPort(type)
server ────type─→ stores                       # HistoryStore
server ──type+值→ text                         # buildSystemCommand/buildSoundCommand（SystemNotifier 用）
channels ──type─→ sdk                          # NotifyChannel/NotifySeverity
channels ─type+值→ config                       # SECRET_MASK / isWebhookHeaderName / ChannelConfig
channels ──type+值→ text                        # sanitizeErrorText（scrub）
channels ──type─→ server                        # SseHub / SystemNotifier（内置频道）
pipeline ──type─→ sdk                           # ResolvedTarget.channel: NotifyChannel（仅 type）
pipeline ─type+值→ config                       # isInQuietHours（运行时纯函数）+ NotifyConfig(type)
pipeline ──type─→ text                          # NOTIFY_KINDS 相关类型
sdk ────type+值→ pipeline                       # createAdjudicator/createDeliverer + 结果类型
sdk ────type+值→ text                           # NOTIFY_KINDS / sanitizeNoticeContent（编排调用）
sdk ────type─→ config                           # NotifyConfig（deps 面）
events ──type─→ config                          # NotifyConfig
events ──type+值→ text                          # sanitizeErrorText / sessionTitleOf / lastTurnEndOf / isSubagentOf
events ──type─→ stores                          # HistoryEntry（EventHandlersDeps.appendHistory）
index ──→ 全部 interface                        # 装配 + re-export
```

无环要点（M1/M3）：
- **pipeline 对 sdk 仅 type**（isKindConfirmed 经 AdjudicateDeps 注入；KIND_SEVERITY 移 text/ 消除 severity 运行时环）；
- **sdk 无 channels 边**（NotifyChannel 定义在 sdk/interface 自身；内置频道经 index.ts 注入 sdk/deliver）；
- **events 落史经注入回调**（EventHandlersDeps.appendHistory，类型 import type HistoryEntry from stores/interface；merged 落史属事件源级轨道）。

## 5. 关键类型契约

```ts
// pipeline/interface.ts
interface ResolvedTarget {
  id: string;
  channel: NotifyChannel;                       // import type sdk/interface
  dispatch?: BrowserDispatchSpec | SystemDispatchSpec;  // 内置频道播放决议（裁决时随 current() 快照解析）
}
interface BrowserDispatchSpec { pop: boolean; sound: { mode: "silent" | "system" | "selfplay"; tone?: SoundId } }
interface SystemDispatchSpec { pop: boolean; sound: SoundSetting }
interface AdjudicatedNotice {
  kind: string; title: string; body: string;    // body 已脱敏（统一时点之后）
  severity?: NotifySeverity; ts: number;        // ts = 裁决时刻
  targets: ResolvedTarget[]; stale: string[];   // stale = kindRoutes 指向已删频道（记 skipped）
}
type SuppressReason = "disabled" | "kind-pending" | "quiet";   // 仅裁决层三值；merged 属事件源级轨道（不并入）
type AdjudicateResult =
  | { decision: "suppressed"; reason: SuppressReason; kind: string; title: string; body: string; ts: number }  // 已脱敏文本
  | { decision: "deliver"; notice: AdjudicatedNotice };

// config/interface.ts —— ConfigPort（配置域对 API/判定层的正式接口，settings-bridge 实现）
interface ConfigPort {
  resolve(): NotifyConfig;                      // getCurrent 别名
  readUser(): { user: Record<string, unknown>; revision?: number };  // 降级：未 attach → {user:{}, revision:undefined}
  writable(): boolean;                          // 降级：未 attach → false
  update(patch: object, expectedRevision?: number): Promise<void>;    // SETTINGS_CONFLICT / SETTINGS_UNAVAILABLE
  confirmKind(kind: string, confirmed: boolean): Promise<void>;       // CAS 重试 ≤2（原 confirmKindToConfig）
}
// server/interface.ts —— RouteDeps = ConfigPort + 注入面（已移除 setConfirm）
interface RouteDeps extends ConfigPort {
  logger: { warn: (m: string) => void; info: (m: string) => void };
  sse: SseHub; system: SystemNotifier; history: HistoryStore;
  sendTest(channelId?: string): Array<{ channelId: string; status: string; error?: string }>;  // 结构化字面量
  statusReader(): Promise<Record<string, unknown>>;
  listKinds(): Array<{ id: string; label: string; confirmed: boolean }>;                       // 结构化字面量
}

// sdk/interface.ts —— ChannelCapabilities 扩展（v2）
interface ChannelCapabilities {
  titleMaxLen: number;                          // 码点数；0 = 不支持独立标题
  maxBodyLen: number;
  mergeTitleIntoBody?: boolean;                 // 取代 titleMaxLen<=0 隐式「并入正文」语义（修 service.ts:73 vs :282）
  retry?: { maxRetries: number; backoffMs?: number };   // 缺省 = 不重试（webhook 零重试锁定）
  maxInflight?: number;                         // 缺省 = 无门
}
// pipeline/interface.ts —— retryable 错误协议（共享）
interface RetryableError extends Error { retryable?: boolean }  // channel 按协议标注：4xx=false、网络/5xx=true
```

渠道可靠性契约（M4/架构师 P1-5）：
- **门表生命周期** = createDeliverer 实例闭包、按 channelId（`type:id`）键控、跨配置变更延续（对等现 outbound.ts:13-22 + channel-bark.ts:40-48）；
- **maxInflight 超限 = 排队**（无上限队列，对等现 channel-bark.ts:127-139）；
- **退避 = 线性 1s/2s**（backoffMs 为基数，对等现 channel-bark.ts:120）；
- **超时归属 channel 侧**（BARK_TIMEOUT_MS=10s、webhook timeoutSec 1-60 不动）；
- 行为对等清单逐点对照规则矩阵 B-G/C-G（4xx 不重试、webhook 不重试、并发 ≤2 排队、跨配置延续）。

## 6. 脱敏模块（v2 修正口径）

- **位置**：`text/sanitize.ts`（文件头显式声明安全模块定位；SANITIZE_RULES 有序表 why 注释【message.ts:164-175 原文：DSN 先于 JWT、邮箱殿后带双否定断言、已证伪不收录清单】整体保留）。
- **接口**：`sanitizeErrorText(text, maxLen?)`（通用原语，出口 scrub 用）+ `sanitizeNoticeContent(notice: {title, body}, enabled: boolean)`（统一入口）——**单实现双导出**（sanitizeNoticeContent 内部复用 sanitizeErrorText，测试锁同样本输出一致）。
- **时点（Q1 拍板）**：**渲染完成后、任何落史/投递之前**统一处理一次——覆盖①裁决 suppressed 落史（kind-pending/quiet）、②事件层 merged 落史、③投递三路径；AdjudicateResult 与 AdjudicatedNotice 均携带已脱敏文本。
- **开关（Q5 相关）**：`sanitizeContent: boolean` 默认 true；进 NotifyConfig + DEFAULT_CONFIG + SETTING_VALIDATORS/HINTS（config 域 validators.ts）新键；**UI 开关首版不做**（只留契约键，手改/API 可用）。`sanitizeContent=false` = 通知与历史均明文，写入 README「安全模型」（P2-2）。
- **出口脱敏固定各出口**：bark/webhook 凭据 scrub（channel 内）、server 错误固定文案、redactConfigView 配置视图——不并入统一入口。
- 与 L4 口径：sanitizeContent 是插件自有键，与 SDK 注册无关（不扩展 allowKinds 合法范围）。

## 7. 结构评审修正记录（M1-M12，全部采纳）

| # | 修正项 | 来源 | 处理 |
|---|---|---|---|
| M1 | severity 归属环 | 微服务 P0-1 | KIND_SEVERITY 移 text/（pipeline→text 已有边）；「pipeline 不依赖 sdk」= 仅运行时 |
| M2 | 脱敏时点（suppressed 落史缺口） | 微服务 P1-1 | 渲染后、任何落史/投递前统一处理（§6；Q1） |
| M3 | 依赖图补边/改标注 | 微服务 P1-2/P1-3 + 架构师 P1-1 | type/值双构重画（§4）；events→stores(type)；merged 不并入 SuppressReason |
| M4 | 重试/门上移语义 | 微服务 P1-5 + 架构师 P1-5 | 渠道可靠性契约（§5） |
| M5 | ConfigPort 补 confirmKind | 微服务 P1-6 | §5 ConfigPort；RouteDeps 移除 setConfirm |
| M6 | 导出面核对机制 | 微服务 P1-7 + 架构师 P1-4 | tsc --declaration 快照 diff 随 PR1 落地（§10） |
| M7 | config.ts 再拆 | 微服务 P1-8 + 架构师 P1-2 | config/ 五文件（config/normalize/validators/redact/paths），≤400 行自洽（Q3） |
| M8 | 内置频道注入面 | 微服务 P1-4 + 架构师 P2-8 | createBrowserChannel({sse}) / createSystemChannel({system}) |
| M9 | RouteDeps 回调解耦纪律 | 微服务 P1-9 | §3-7 结构化字面量纪律 |
| M10 | DispatchSpec + 快照变更登记 | 架构师 P1-6 | §5 spec 字段；「裁决时快照播放决议」行为变更登记（→ requirements §6.2） |
| M11 | 规模计数修正 | 架构师 P1-2 | 35 TS 文件（含 9 interface.ts） |
| M12 | 无环声明可验证化 | 架构师 P1-1 + 微服务 P2-5 | §4 图 + 「域内 impl→interface 仅 import type」纪律（§3-4） |

P2 采纳项（不阻塞定稿，随 PR 消化）：sanitize 单实现双导出 + 一致性测试；sanitizeContent=false 明文语义入 README；sdk→channels(type) 虚边删除；单刻快照/播放决议行为变更补 TDD 用例；stryker mutate 路径随搬家更新 + message 拆三文件后段边界重定；SANITIZE_RULES why 注释保留；service.d.ts 两处 import("./service.ts") 改指 sdk/interface.ts；ConfigPort 降级语义 JSDoc；index.ts 装配段与 re-export 段分节注释（shared 4 个 re-export 保留）；消费方类型编译用例（现状类型面零编译校验）。

## 8. 决策表（D 扩展）

- D1-D9：前序会话方向性确认（引用 HANDOFF-NEXT.md / TARGET-LAYERS-DRAFT.md），本版落为 §1/§5 终稿。
- **D10（Q1）**：脱敏时点 = 渲染后、任何落史/投递前统一处理；开关 sanitizeContent 默认 true。
- **D11（Q2 用户裁定）**：**registerChannel 是配置层的事情，只增加配置、不增加功能特性**——保留寄存器（SDK 面），投递集合不消费注册表；信道注册的启用模型归 v-next（L8 项以此裁定闭环）。
- **D12（Q3）**：config/ 再拆五文件，≤400 行纪律无豁免（声明型文件同拆，不含 fudge）。
- **D13（Q4）**：门禁随重构 PR 落地（PR1 导出面快照 diff + interface import 检查脚本），不采用「先文档后脚本」。
- **D14（Q5）**：text/ 命名维持；sanitize.ts 文件头声明安全定位。
- **D15（Q6）**：disabled（enabled=false）**不落史**保持现状（service.ts:396-397 语义不变）；「suppressed 统一落史」仅覆盖 kind-pending/quiet。

## 9. 注释与文件规模纪律

- 注释只保留 why（动机/约束/陷阱/权衡，AGENTS.md 规则 7）；清理 what/how 复述、过期/失真注释、无信息占位注释；设计决策进文档/Suggested Commit Message。
- 已知失真注释清单（随 PR3 修）：service.ts:73 vs :282（titleMaxLen<=0 语义）；service.ts:12-13 vs bark 内部重试（「框架统一重试」）；service.ts:44「调用方负责脱敏」→ 改「中心兜底：sanitizeContent 开关」。
- 单文件 ≤400 行；超限必须拆（同目录互引不受门面限制）；声明型文件（校验器/规则表）同样拆文件，不豁免。

## 10. 迁移策略（三 PR，含门禁）

- **PR1 机械搬家 + interface.ts 落地 + stryker 路径更新**（零行为变更）：16 平铺 → 目录树；各域 interface.ts 二合一；**导出面快照**（重构前 tsc --declaration 基线 diff 重构后导出符号集合，含 shared 4 个 re-export）；stryker/mutation-topology dsh-notifier 段 mutate 路径全部更新（message 拆三文件后段边界重定，新增文件是否入变异面决策）；全门禁（build/test/contract/pack:check/typecheck）。
- **PR2 行为重构**（逐步对齐规则矩阵，每步可测）：adjudicate/deliver 拆分 + current() 单刻快照 + 播放决议快照化；重试/并发门上移框架（bark/webhook 行为对等清单）；脱敏统一时点 + sanitizeContent 开关；ConfigPort/RouteDeps 契约落地；行为变更登记用例（requirements §6.2）。
- **PR3 注释清理 + 门禁 lint 落地**：§9 注释清单；interface import 检查 + 环路检测脚本；消费方类型编译用例。
- 隔离纪律：全部在 worktree 进行；浏览器实测走 dsh-verify-isolated。

## 11. 关联文档

- 规格与 TDD 计划：docs/requirements-and-tdd-plan.md（缺陷/行为变更/迁移登记见 §6）
- 目标架构图：docs/diagrams/current-architecture.{html,json}（层口径 v1；v2 目录结构以本文档为准）
- 交接存档：docs/HANDOFF-NEXT.md（本版定稿后由会话产出更新）