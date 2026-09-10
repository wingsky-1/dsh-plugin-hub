# dsh-mcp-manager 分层架构重构方案（v3，经两轮对抗性评审）

> v1（62/100）→ v2（78/100）→ v3（本版，吸收二轮修正，目标 ≥90 后进 issue 方案评审）。
> 评审全文：`docs/architecture-redesign-review.md`（一轮 62/100 + 二轮 78/100）。
> v3 修正主线：D2 撤销 async 选项（B5 最小修复=补调 disconnect，syncChain FIFO 保证）；D7 闭环（covered
> 口径已达标，改机制决策）；阶段 2 stryker 矛盾拍死（阶段 2 就地挂段）；三条阶段不变式；
> 迁移专用验证三件套；目录命名歧义消除；B12/B19 提前；C 复核撤回过时事实（mutate-scope-guard）。

---

## 一、分层裁定（7 逻辑层 + 组合根 + 共享）

| 逻辑层 | 包含（物理目录） | 裁定依据 |
|--------|-----------------|---------|
| ① 客户端层 | `src/client/{core, float, settings}` | 浏览器端底座+UI；保留 `src/client/index.ts`（build-client 契约锚点），style.css 引用路径随之确定 |
| ② API 层 | `src/api/` | routes/controllers/sse-exit/health；错误契约（HTTP body 经 redactor 注入面）入契约 |
| ③ 配置域 | `src/config/{model, store}` | normalize/import/config-schema 与 store/user-state/目录缓存已文件分离，不升双逻辑层；normalizeScope 归 ⑥ |
| ④ 连接域 | `src/connection/{orchestrator, runtime}` | **唯一真实拆分收益**（manager 1184 行 + 双常量）；orchestrator=仲裁/双轨/生命周期/事件出口，runtime=supervisor 代际/中间层池/transport/protocol/limits；**状态事件层并入本域** |
| ⑤ 模型面+目录域 | `src/inject/` + `src/catalog/` | 工具注册/guard/提示词 与 能力目录/检索分目录；目录检索函数族落位 `catalog/search.ts` |
| ⑥ 工作空间路由域 | `src/workspace/` | root 解析/全名/scope/MIDDLEWARE_GLOBAL_ROOT 单源/normalizeMiddlewareMode 收敛（含 middleware-const 常量归位） |
| ⑦ 执行管道域 | `src/pipeline/` | 纯函数族 + 薄适配（不建 executeTool 大组合器）；授权/调用/投影/截断/脱敏/超时/埋点；两路径同构由契约测试强制 |
| ⑧ 服务/统计域 | `src/integration/` + `src/stats/` | ctx.mcpManager 8 方法 + call-stats |
| 组合根 | `src/bootstrap/` | apply 系列（装配/热切换/卸载） |
| 共享 | `shared/`（跨包消费者） | loopback/sse-hub/host-utils/settings-namespace/dsh-home/placement |

**命名修正（二轮 B）**：连接域执行子目录 `runtime/`（非 execution/），执行管道域 `pipeline/`（非 execution/）——消除双 execution 目录歧义。

---

## 二、目标目录结构（10 域 + 客户端 3 子目录）

```
src/
  index.ts                 组合根 re-export（唯一汇聚转发点；middleware.ts 停止 re-export）
  bootstrap/               apply.ts apply-config.ts apply-runtime.ts apply-services.ts apply-guidance.ts
  api/                     routes.ts routes-controllers.ts routes-helpers.ts sse-exit.ts health.ts redactor-factory.ts
  config/
    model/                 normalize.ts import.ts config-schema.ts user-state-model.ts
    store/                 store.ts middleware-state.ts catalog-cache-io.ts
  workspace/               root-resolution.ts full-name.ts scope.ts middleware-mode.ts constants.ts（含 MIDDLEWARE_GLOBAL_ROOT 单源）
  connection/
    orchestrator/          manager.ts（L07：仲裁/双轨/summary/事件出口）
    runtime/               supervisor.ts middleware.ts transport.ts protocol.ts limits.ts（原 middleware-const 常量）
  inject/                  register.ts middleware-register.ts tool-definition.ts guard.ts prompt.ts
  catalog/                 entries.ts digest.ts history.ts injection.ts cache-view.ts search.ts（检索函数族）
  pipeline/                authorize.ts call.ts project.ts redact.ts timeout.ts args.ts msg.ts stats-hook.ts
  integration/             service.ts
  stats/                   collector.ts types.ts
  types/                   server.ts status.ts ui.ts host-faces.ts middleware-types.ts（ProjectUnit/ConnectionEntry/CatalogTool 等收敛）
src/client/
  index.ts                 （入口不动，仅 re-export + apply/inject 契约）
  core/                    state.ts session.ts dom.ts api.ts i18n.ts constants.ts
  float/                   float.ts panel.ts servers.ts quick-add.ts
  settings/                settings-card.tsx
  style.css locales.ts css.d.ts react-shim.d.ts
```

破环与收敛清单：
- middleware.ts 的六段 re-export 块整体删除，汇聚只留 `src/index.ts`；`middleware-types.ts` 收进 `types/`；
- `routes.ts:21` 的 `import type { ClientUiConfig } from "./index.ts"` 改从 `types/ui.ts` 取（消组合根类型环）；
- `MIDDLEWARE_GLOBAL_ROOT`、`normalizeMiddlewareMode`、`normalizeScope` 收敛于 `workspace/`；
- `middleware-const.ts` 常量归 `connection/runtime/limits.ts`（执行域语义常量）；`msgOf` 归 `pipeline/msg.ts`；
- 四个最小面接口（ManagerLite/RoutesManager/MiddlewareHost/SupervisorLite）并入 `types/host-faces.ts`；
- stryker exclude 同步补 `!src/types/**`（host-faces/middleware-types 不收变异）；
- `config-schema.ts` 跨域常量（DEFAULT_ANNOUNCE_CATALOG/DEFAULT_RESULT_TRUNCATE_BYTES）改为从 catalog/
  supervisor 域类型化 import（保持单向 config→下游），机制写入契约。
- **每目录 `interface.ts` 门面（D10）**：每个物理目录提供 `interface.ts`，re-export 目录对外
  「类型 + 函数」作为该目录唯一对外引用面；跨目录引用只能 import 对方目录的 `interface.ts`，
  禁直引目录内实现文件（同目录内自由引用）；跨目录共享 DTO 仍集中 `types/`；检查由
  `scripts/gate/verify-dir-imports.mjs` 静态强制（已接入 `pnpm contract` 门禁）。阶段 2 起新建
  目录即带 interface.ts，存量文件阶段 6 集中搬移时统一补齐。

### 阶段 7 客户端分层落地映射表（旧文件 → 新文件）

> 客户端目录不受 D10 门面约束（`src/client/` 从 verify-dir-imports from 侧整体豁免，
> index.ts 为 build-client 契约锚点，见 scripts/gate/verify-dir-imports.mjs #670 裁决）；
> 分层为纯搬移 + 拆分，零行为变更，C 类修复另行 commit。

| 旧（src/client/） | 新 | 说明 |
|---|---|---|
| index.ts | index.ts（不变） | 入口不动，仅 re-export + apply/inject 契约；import 路径随分层同步 |
| constants.ts | core/constants.ts | 纯移动 |
| dom.ts | core/dom.ts + core/api.ts | 拆出：dom.ts 保留 `el`（DOM 元素创建）；api.ts 收 `api()`（HTTP 请求，**拆出自 dom.ts**），C14 204 备忘注释随迁 |
| locales.ts | locales.ts（根保留）+ core/i18n.ts | 字典数据与 `McpLocaleKey` 类型留根（LocaleNamespaceMap 声明合并锚点）；i18n.ts 收渲染期文案求值辅助 `tStatus`（**拆出自 locales.ts**） |
| state.ts | core/state.ts | 纯移动 |
| session.ts | core/session.ts | 纯移动 |
| float.ts | float/float.ts | 纯移动 |
| panel.ts | float/panel.ts | 纯移动 |
| servers.ts | float/servers.ts | 纯移动 |
| quick-add.ts | float/quick-add.ts | 纯移动 |
| settings-card.tsx | settings/settings-card.tsx | 纯移动 |
| style.css / css.d.ts / react-shim.d.ts | 根保留 | 构建契约锚点文件不动 |
| shared/client/* 相对路径 | 一级文件 4 层 `../../../../shared/...`；二级文件（core/float/settings）5 层 `../../../../../shared/...` | 加深一级计入工作量；packages/ 下 bundle-host X1 的包内 shared/ 产物会掩盖深度错误（本地验证前先 `rm -rf packages/<pkg>/shared`） |

### 客户端目录不变式（阶段 7 后生效）

- `src/client/index.ts` 是 build-client 契约锚点与唯一汇聚入口，位置永不移动；
- 客户端内部按 core（支撑）/ float（胶囊与面板）/ settings（设置卡）分层，feature 模块
  间不互相 import，跨模块动作经 index.ts 装配的 UiActions 回调注入；
- 跨包共享一律走 `shared/client/*`（i18n/ensure-style），相对路径深度按文件层级数。 

---

## 三、每层职责与接口契约（7 逻辑层 + 组合根）

> 契约口径：成功签名 + 错误契约 + 事件契约；只列「新增/缺口」项，现状稳定面引用代码。
> **目录门面规则（D10）**：下述各域（物理目录）均以 `interface.ts` 为唯一对外引用面；
> 跨域依赖的契约落在 interface.ts 上，实现文件不对外承诺任何引用面。

### ① 客户端层
- 契约补齐：SSE 帧集合显式清单（summary/ui-config-changed/ping + 60s watchdog）；未知状态策略（C13 与 B1/B4 六态单 PR 同改）；204 备忘（C14）；tool-disable 全名形态与 projectRoot 缺失防御（C6/C7）；`src/client/index.ts` 保留 + style.css 相对引用路径。

### ② API 层
- **错误契约机制（二轮 P0-② 补机制）**：`makeRoutes` 构造时注入 redactor 实例（`api/redactor-factory.ts` 从 manager 服务器配置构建）；`handleError` 写 400 body 前先 redact——HTTP body 与日志同口径脱敏；声明「无业务错误码，文案即契约」。
- `GET /servers` 零副作用语义显式化；sse-exit/health 落位。

### ③ 配置域
- model：normalizeServer/parseClaudeJson/normalizeUiConfig（三形态=读取兼容不迁移写回）；Config schema 默认（middleware: project）vs 运行时（off）演进规则显式化；B15 描述修正；跨域常量单向 import。
- store：McpStore 全契约（0600+tmp+rename+DSH_HOME）；projectStores 缓存语义；user-state/disabledTools 合并式写盘；IO 损坏容错契约；目录 last-good「摘要实质变化才写盘」；B17（唯一 tmp 名+失败清理）。
- **阶段不变式**：`apply-services.ts` 在阶段 1–5 **禁止薄转发/移动**（service-contract.test.ts:145 硬编码 `src/apply-services.ts` + L150 marker 扫描），直到集中式迁移 PR 一次性移动并同步扫描路径（二轮 P0-① 补死）。

### ④ 连接域
- orchestrator：双轨 reconcile、生命周期仲裁、summary、会话切换、resumeReconnect（目标集=配置全集）、setToolDisabled（B19 口径统一）。
- runtime：supervisor 单代际、中间层池、transport/protocol、limits 常量。
- **契约关键面**：
  - 状态事件契约：emitStatus 无参 + listeners Set + coalesce；两帧触发源（summary 帧经 emitStatus；ui-config-changed 帧经 settings onChange 直接广播，保持两链并写清）；B20=热切换补 emitStatus。
  - **B5 契约（二轮修正）**：L08/runtime 提供 teardown；L07 有显式调用义务。**start() 保持同步**——替换分支补调 `void existing.disconnect()`，旧实例 disconnect await syncChain、新代际 syncTools 排同一 syncChain，FIFO 保证旧清理先于新注册；`manager.connect` L1011-1017 同修。真涟漪面 = manager 内部 5 处 + apply.ts L148/L150（非 routes×9）。
  - AbortSignal 面：`callTool(tool, args, {signal, timeoutMs})` 选项面；withTimeout 兜底裕量（30s+2s）显式化。
  - 退避/超时口径：收敛为 runtime 单一解析函数（消费 server.reconnect/toolCallTimeoutMs）再供两实例（B18）；CALL_TIMEOUT+2s 兜底保留（防半开双保险，D6）。
  - `middleware.callTool` 管道段切割线：路由/unit 查找留 runtime；裁决/禁用/stale/withTimeout/redact/project/封装直呼归 ⑦ pipeline。

### ⑤ 模型面+目录域
- inject：mcp__ 注册、ws_mcp_* 四原子、pre-execute guard、提示词。**guard 覆盖语义（二轮 D8 修正）**：off 模式现状无 guard（manager.middleware===undefined）——目标：guard 挂载与中间层实例解耦，数据源直接用 manager.disabledTools（独立注册路径），实现「工具级禁用三入口」三模式一致；B11 反解决策见 D5。
- catalog：entries/digest（只含 name）/history/injection 决策/catalogViewFor（迁出含私有 diskCatalogSummaryCache mtime 缓存，宿主最小面）/search.ts 检索族（B10 落点）。
- 接线契约：registerCatalogInjection 挂载在 bootstrap、决策在 catalog，写清跨域接线。

### ⑥ 工作空间路由域
- root-resolution/full-name/scope/middleware-mode/constants 单源；isGlobalServer 双源（store+runtime）；B3 修复态（makeResolveRoot 查 projectServersFor("@global")）。

### ⑦ 执行管道域（pipeline/）
- 纯函数族 + 薄适配：authorize → call → project/truncate/redact/timeout/stale → 埋点；msg/redact/timeout 归属本域。
- 契约：两路径差异面签名（handlers/timeout 来源/redact/stale）；**两路径同构由契约测试强制——同构断言范围显式排除 timeout/redact/stale 三项差异面**（其余环节输入同、输出同）；日志脱敏覆盖点清单（supervisor.ts:362 及 manager 十余处 logger.warn，实施时列全量行号）；supervisor 路径新增 stats 埋点=行为扩展声明；redactor raw/decoded 双形态。
- **stryker 归属（二轮关键 3 拍死，取方案 b）**：阶段 1–5 新建文件（pipeline/*、catalog/search.ts、workspace/* 等）**一律不纳入既有六段 mutate 清单**（防空段断言只查正向条目、不查 src 全覆盖 → 该阶段属**明示接受的变异盲区**，门禁以 covered 不回落为守）；阶段 6 集中迁移时一次性重画六段清单 + topology 三方一致。方案 a（逐阶段挂段）违背「静态面集中到迁移 PR」，弃。

### ⑧ 服务/统计域
- integration：8 方法；registerServer 串行队列；**B6 修复落位（二轮 A 补）**：getTools 与 summary 同源（中间层接管的服务器也返回工具），键形态决策见 D9。
- stats：isEnabled/loadExisting；B2 修复语义；前置=unit-call-stats 双登记接线。

### 组合根
- apply 系列装配/热切换/卸载；apply-services.ts 位置受 service-contract 静态扫描约束（阶段不变式）。

---

## 四、迁移策略（逻辑收敛 → 单一集中式纯搬移 PR）

### 三条阶段不变式（二轮 P0 补，阶段 1–5 全程生效）
1. `apply-services.ts` 禁止移动/薄转发（service-contract 静态扫描路径）；
2. **每阶段末全绿门禁**：`pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck` + service-contract 双层锁 + 关键 smoke 断言清单；
3. **commit 切分**：逻辑收敛与行为修复分 commit（每 commit 可独立验证）。

### 集中式纯搬移 PR（阶段 6）
- 前置：B 系列行为修复**全部完成**（B12/B19 已提前，见阶段表），迁移 PR 零行为变更；
- 静态面清单（必须同步，否则必红）：service-contract.test.ts:145 扫描路径；stryker 六段 mutate 清单 + mutation-topology.json + workflow-assert；observe 基线（src 口径四班次重建）策略；incremental 缓存作废处理；bundle-host client 入口（src/client/index.ts 保留即无感）。
- **迁移专用验证三件套（二轮 B 补机制）**：① 迁移前基线快照（全绿门禁 + smoke 断言清单逐条记录）；② 迁移 PR 的 `git diff --stat` 校验（只含 rename/移动，无内容变更）；③ 迁移后全绿 + observe 基线重建触发。
- 门禁策略（D7 闭环后）：covered 口径已达标（74.66≥60），迁移 PR 不卡总得分；incremental 缓存作废后走 observe 夜间重建豁免或手动重建基线。

---

## 五、分阶段 TDD 计划（阶段 0–8，B/C 全量落位）

| 阶段 | 内容 | Bug 落位 |
|------|------|---------|
| 0 规格决策表 | 拍板 §六 全部决策 + 契约缺口清单 + 迁移门禁策略三件文档 | B4/B6/B11/B13/B14/B18/B8/D9 |
| 1 测试基建 + 配置域 | fakeTransport/fakeMCPClient 桩进 helpers.ts；unit-call-stats 双登记；createRedactor 基线测试；B7 直测；config model/store 逻辑归位（不动文件） | B2、B7、B13、B14、B17 |
| 2 执行管道成形 | pipeline/ 纯函数族+薄适配（**就地挂 middleware 段**）；两路径契约测试；supervisor 埋点声明 | B8、B9、B10（catalog/search 同步改）、B18、B14 |
| 3 连接域逻辑收敛 | orchestrator/runtime 文件内重组；事件契约先定；B5 补调 disconnect（start 保持同步）；六态单 PR（B1+B4 宿主端 + **C13 仅拍板客户端未知状态策略，实现留阶段 7**） | B1、B4、B5、B18、B19、B20 |
| 4 工作空间路由域 | workspace/ 新文件+薄转发+调用点全切；双常量收敛 | B3（提前）、B11 规格落地 |
| 5 目录域 | catalog/search.ts 检索族落位；catalogViewFor（含 diskCatalogSummaryCache）迁出；B12 修复 | B10（若未完成）、B12 |
| 6 集中式纯搬移 PR | git mv + 静态面全同步 + 迁移验证三件套（零行为变更） | — |
| 7 客户端分层 + 收口 | core/float/settings（**附旧文件→新文件映射表**，core/api.ts、core/i18n.ts 标注「拆出自 dom.ts/locales.ts」；shared/client/* 相对路径加深一级计入工作量）；C1（P1 优先）+C2/C3/C4/C5/C6/C7/C8/C10+C13 实现，隔离浏览器实测；哑断言清理；文档同步（C11 依赖 C1 修复后 PATCH 分支可达，时序标注） | C1–C15、B15、B16、B19 |
| 8 质量收口 | 变异得分（covered 口径已达标，守 observe 回落判据）；4 个仅 stryker 面文件按断言价值选择性纳入 smoke | — |

**顺序显式化**：B12/B19 行为修复在阶段 3/5 完成（先于阶段 6 迁移），迁移 PR 零行为变更成立。

---

## 六、规格决策表（阶段 0 拍板，v3 修订）

| # | 决策项 | 选项 | 推荐（v3） |
|---|--------|------|-----------|
| D1 | B1/B4 重连状态 | 补 reconnecting 状态机 vs 文档化回避 | 补状态机（六态一致，B1+B4+C13 单 PR） |
| D2 | B5 start() 契约 | ~~变 async~~（涟漪失实，撤回）vs **保持同步 + 替换分支补调 void existing.disconnect()** | **保持同步**：syncChain FIFO 保证旧清理先于新注册；涟漪面=manager 内部 5 处+apply 2 处 |
| D3 | B6 getTools 查询面 | 与 summary 同源 vs 文档声明仅 supervisor | 与 summary 同源（修复落位阶段 3） |
| D4 | B8 脱敏口径 | 整 URL vs 仅用户信息（raw/decoded 双形态） | 仅用户信息 + 双形态 + 日志脱敏全覆盖 + API redactor 注入面（走安全红线） |
| D5 | B11 双下划线反解 | publicToolName 加分隔符转义（映射表）vs 规格化不可逆 | **规格化不可逆 + 不改 publicToolName**（防冲击官方 mcp__ 同名契约）；映射表列入增强 |
| D6 | B18 超时口径 | toolCallTimeoutMs 生效+保留 CALL_TIMEOUT+2s 兜底 vs 无兜底 | 保留兜底（防半开双保险） |
| D7 | 门禁判分 | ~~先澄清判分输入~~（已闭环：covered 74.66≥60 达标）vs **observe 回落判据（covered<baseline-1pp）+ incremental 重建豁免** | **机制决策**：迁移 PR 走 observe 夜间重建豁免；日常守 covered≥baseline-1pp |
| D8 | off 模式 guard | 补挂载（数据源 manager.disabledTools，独立注册路径）vs 文档化一入口 | **补挂载**（guard 与中间层实例解耦，三模式一致） |
| D9 | getTools 键形态 | 注册名（mcp__ 前缀，与 ctx.tools 一致）vs 裸名（与 summary().tools 一致） | **注册名**（保持与现状 getTools 一致，文档化两套键口径） |
| D10 | 目录解耦形态（维护者追加） | 每目录 interface.ts 门面 vs 维持类型集中 | **严格门面**：每物理目录一个 interface.ts（对外类型+函数唯一面）；跨目录引用只能走 interface.ts，禁直引实现文件；DTO 仍集中 types/；verify-dir-imports.mjs 静态强制接入 contract；阶段 2 起生效、阶段 6 存量补齐 |

---

## 七、风险清单（按阶段）

- 阶段 1：纯搬移收益近零但门禁成本全量 → 本阶段不做 git mv；apply-services 不变式首日生效。
- 阶段 2：新文件变异盲区 → 就地挂 middleware 段（拍死）。
- 阶段 3：六态跨端（宿主+客户端）单 PR 回归面 → 隔离浏览器实测配合；B5 同步契约先定。
- 阶段 4：双份实现窗口 → 薄转发+调用点全切后再删旧。
- 阶段 5：catalogViewFor 宿主面（含私有 mtime 缓存）→ 薄桥接或最小面 host。
- 阶段 6：集中迁移门禁面 → 迁移验证三件套 + 静态面清单全同步；mutate-scope-guard 已退役（#276），不再列入。
- 阶段 8：smoke import 拓展膨胀时长 → 按断言价值裁剪 + stryker 耗时预算。