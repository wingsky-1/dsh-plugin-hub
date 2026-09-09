# dsh-mcp-manager 分层架构重构方案（微服务分层设计思路）

> 依据：架构图 `docs/diagrams/mcp-manager-archify-overview.html`（7+4+1 层模型）+ 对抗性评审纪要（第八章）。
> 思路：把插件代码当作一个「单进程内的领域微服务集合」——每层是一个有**明确接口契约（上游暴露面 / 下游依赖面）**、**单向依赖**、**可独立替换与测试**的模块；物理目录按域聚合，逻辑边界 13 层，物理目录 9 个。

---

## 一、层合理性评估：现状 7+4+1 的裁定

| 层 | 裁定 | 依据 |
|----|------|------|
| ① 配置管理层 | **需拆为两域**：配置模型与校验（pure）/ 配置存储（io） | 现文件混合纯函数（normalize/import/config-schema）与 IO（store/middleware-state 落盘）；拆分后 pure 侧可无 fs 全量单测 |
| ② 连接管理层 | **必须拆为两域**：连接编排（manager 仲裁/双轨 reconcile）/ 连接执行（supervisor 单代际 + 中间层连接池） | manager.ts 单文件 134s mutation 极限（全仓第一）；B5（编排替换执行不清理）、B18（编排与执行口径分裂：重连参数/超时/closeHandler 计数）都源于「编排与执行职责混在同一层」 |
| ③ 注入 dsh 层 | **拆为两域**：模型面适配（工具注册/guard/系统提示词）/ 能力目录（L1 感知增强） | 能力目录独立子系统（last-good 磁盘缓存 + history 去重 + 注入决策），与工具注册的职责/生命周期完全不同 |
| ④ 对外集成层 | 维持 | 服务面 8 方法边界清晰 |
| ⑤ API 层 | 维持（内部可细分子模块） | routes/controllers/events/dto 已在 routes*.ts 分离，无需再拆目录 |
| ⑥ 设置页面层 | 维持 | 单一 React 组件 + POST /config |
| ⑦ 胶囊页面层 | 维持（内部按 panel/float/servers/quick-add 已分离） | — |
| ⑧ 组合根装配层 | 维持 | 装配骨架职责单一 |
| ⑨ 工具执行/投影层 | **扩展为「工具执行管道」**：前置授权裁决 → 调用 → 后置投影/截断/脱敏/超时/统计埋点 | call-result 已是两路径共用单一事实源；把策略/禁用裁决（isToolDenied/policyAllows）、redactor、withTimeout、统计埋点全部收进同一条执行管道，消除「裁决散在 guard/callTool」的现状 |
| ⑩ 共享基础设施层 | 维持（标注「跨包消费者」） | loopback/sse-hub/host-utils 等归属 other 包，本插件只消费 |
| ⑪ 统计观测层 | 维持 | 默认关闭纯观测 |

### 可新增的独立边界层（2 个，现状横切散落）
| 新增层 | 理由 | 证据 |
|--------|------|------|
| **工作空间路由层**（cwd → 归一化项目 root / scope / @root/server 全名解析） | 被 6+ 处消费（manager/setSession、middleware/resolveRoot、checkMiddlewareRoot、tool-disable 路由、catalogServersFor、catalogViewFor），且 B3（resolveRoot 漏 runtime）正是该层缺口；独立后成为「路由单一事实源」 | makeResolveRoot / findProjectRoot / normalizedProjectRoot / parseFullServerName / normalizeScope / fullServerName |
| **状态事件层**（内部状态变化 → coalesce → SSE 帧协议） | 现状 emitStatus 散在 manager/supervisor/middleware/热切换，SSE 帧构造在 routes/apply-config；B20（热切换缺 summary 帧）即无统一事件源的后果 | manager.emitStatus / sseHub.broadcast(summary|ui-config-changed) / SSE_HEARTBEAT |

### 维持合并（不建议再拆）
- 传输/协议（transport+protocol+SDK）留在「连接执行」内不独立：与 SDK 耦合强，独立价值低。
- 客户端 DOM 支撑（state/session/dom/i18n）作为「客户端支撑层」固定，不再细分。

**结论**：逻辑边界从 11 层扩为 **13 层**（拆 2、扩 1、新增 2），物理目录从平铺 29 文件聚合为 **9 个域目录**。不引入新运行时依赖、不改变导出面（index.ts 聚合 re-export 保持 smoke/契约门禁不变）。

---

## 二、目标分层模型（13 层）

```
L00 客户端支撑层    state/session/dom/i18n/constants（浏览器端底座）
L01 胶囊页面层      float/panel/servers/quick-add（用户操作面）
L02 设置页面层      settings-card（插件设置卡）
────────────────────────── HTTP/SSE 边界（loopback 围栏）──────────────────────────
L03 API/传输层      路由装配 · 控制器×9 · SSE 出口 · DTO 校验
L04 配置模型与校验  normalize · import · config-schema · user-state 解析（pure，无 IO）
L05 配置存储        store（全局/项目）· user-state 落盘 · 目录 last-good 落盘（IO）
L06 工作空间路由层  findProjectRoot · resolveRoot · parseFullServerName · normalizeScope（新）
L07 连接编排层      manager：双轨 reconcile · 生命周期仲裁 · 同名声控 · summary
L08 连接执行层      supervisor（单代际）· middleware 连接池 · transport/protocol（SDK）
L09 模型面适配层    mcp__ 注册 · ws_mcp_* 四原子 · pre-execute guard · 系统提示词
L10 能力目录层      <available_mcp_servers> · last-good 缓存 · history 去重 · 注入决策
L11 工具执行管道层  [授权裁决] → [调用] → [投影/截断/脱敏/超时/统计埋点]（扩展⑨）
L12 对外集成层      ctx.mcpManager 服务面 · runtimeRegistry（双轨）
L13 统计观测层      call-stats · 披露漏斗 · 防抖落盘
+   组合根装配层    apply 系列：读配置 → 装各层 → 生命周期/热切换/卸载收口
+   共享基础设施层  （跨包：loopback/sse-hub/host-utils/settings-namespace/placement/dsh-home）
```

---

## 三、每层职责精梳 + 上下游接口契约

> 记号：`输入 → 处理 → 输出`；「上游」= 消费本层能力的层，「下游」= 本层依赖的层。契约以 TypeScript 类型/签名表述（现状已具备，重设计仅对齐与收口）。

### L03 API/传输层
- 职责：接收浏览器 HTTP/SSE，参数/DTO 校验，调编排层动作，返回统一 JSON；SSE 状态帧出口。
- 上游：L00/L01/L02（浏览器）；下游：L06（cwd→看门）、L07（action/summary）、L04（配置读写）。
- 契约：
  - `GET /servers → { servers[], counts, middlewareMode }`（= L07.summary()）
  - `POST /servers {ServerConfigInput, scope?} → 201 {server, summary}`
  - `PATCH|DELETE /servers?name=&scope=`（= L07.update/remove）
  - `POST /session {cwd}` / `POST /resume`（= L07.setSession/resumeReconnect）
  - `POST /servers/connect|disconnect|reconnect?name=&scope=`（= L07.*）
  - `POST /import/json {json, scope?, overwrite?}`（= L04.import 模型 → L07.add/update）
  - `PATCH /tool-disable {server, tool, disabled}`（路由一致性 → L07.setToolDisabled）
  - `GET /config → ClientUiConfig & middleware`；`POST /config`（= L04 归一化 → settings）
  - `GET /events → SSE`（= 状态事件层帧协议）；`GET /health`
- 围栏契约：loopback 403 / 方法 405 / config GET 豁免。

### L04 配置模型与校验（新拆，pure）
- 职责：ServerConfig 归一化、mcpServers 导入映射、插件 Config/UI 配置 schema、user-state/disabledTools 载荷解析。
- 上游：L03/L07/L10；下游：无（不 import IO 层）。
- 契约：`normalizeServer(input) → ServerConfig | throw`；`parseClaudeJson(text) → ServerConfig[]`；`normalizeUiConfig(raw) → ClientUiConfig`；`buildConfigUiPatch`；`parseDisabledTools(raw) → DisabledToolsMap`；`normalizeScope`、`normalizeMiddlewareMode`。

### L05 配置存储（新拆，io）
- 职责：配置/用户状态/目录缓存的读改写与原子落盘；mtime 热重载检测。
- 上游：L07（编排）；下游：无业务依赖。
- 契约：`McpStore.{load, save, reloadIfChanged, changedOnDisk, find, upsert, remove}`（0600 + tmp+rename + DSH_HOME 感知）；`loadUserState/saveUserState/loadDisabledTools/saveDisabledTools`（合并式写盘）；`readCatalogServerFromDisk`。

### L06 工作空间路由层（新）
- 职责：cwd → 归一化项目 root；@root/server 全名解析/构造；scope 归一化；**含 runtimeRegistry 参与的项目/全局归属判定**（B3 修复点）。
- 上游：L03（tool-disable 一致性）、L07（setSession/connect/disconnect）、L09（resolveRoot）、L10（catalogServersFor/catalogViewFor）。
- 契约：`resolveRoot(cwd, mode, globalServers) → root|undefined`；`normalizedProjectRoot(cwd)`；`parseFullServerName(name) → {root,server}|undefined`；`fullServerName(root, server)`；`isGlobalServer(name)`（store+runtime 双源）。

### L07 连接编排层
- 职责：双轨 reconcile（store+runtime）、生命周期仲裁（start/stop/add/update/remove/connect/disconnect/reconnect）、同名声控（runtime 优先）、summary 投影、会话切换驱动。
- 上游：L03/L08/L09/L10/L12；下游：L05（存储）、L06（路由）、L08（执行）、L11（执行管道统计）。
- 契约（现状已稳定，重设计只收敛）：
  - `add/update/remove(name?, ServerConfigInput, scope) → ServerConfig`
  - `start(name, scope, directConfig?)` / `stop(name)` / `connect|disconnect|reconnect(name, scope)`
  - `registerServer(input) → {name, existing}` / `unregisterServer(name)`
  - `setSession(cwd)` / `resumeReconnect()` / `refreshFromDisk()`
  - `summary() → {servers[], counts, middlewareMode}`
  - `setToolDisabled(root, server, tool, disabled)`
- 事件：任何集合/状态变化 → `emitStatus()`（状态事件层）。

### L08 连接执行层
- 职责：单服务器代际生命周期（connect/initialize/syncTools/断开清理/有界指数退避）；中间层 per-root 连接池（in-flight 去重/force 重建/LRU 淘汰/防双进程探测）；传输/协议适配。
- 上游：L07（编排调用）、L09（工具注册回调）；下游：L04?不——执行层产物 ServerConfig/ServerStatus；SDK 内联。
- 契约：
  - `ConnectionSupervisor.{connect, disconnect, status, tools, toolDisposers, syncChain, teardownGeneration}`
  - `McpMiddleware.{projectUnitFor, ensureConnected, callTool(编解码), discover, persistCatalog, evictIfNeeded, teardownUnit}`
  - `createTransport(server) → StdioTransport|HttpTransport`（env 净化/${ENV} 展开）
  - `MCPClient.{initialize, listTools, callTool}`（SDK 薄适配）
- **职责边界硬化（评审 P1-⑥/⑨）**：退避参数/调用超时策略统一由本层解析 `server.reconnect` / `server.toolCallTimeoutMs`，编排层不再自造口径；替换/拆除代际时由本层保证 transport.close + toolDisposers 全部释放（修 B5）。

### L09 模型面适配层
- 职责：把 L08 的连接结果注册成模型可用工具（mcp__ 前缀 / ws_mcp_* 四原子）；pre-execute guard 挂载；系统提示词 section。
- 上游：L07（触发）、模型（宿主 ctx）；下游：L06（路由）、L11（执行管道裁决调用）、L13（埋点）。
- 契约：`registerMiddlewareTools(ctx, mw, resolveRoot, mode, {disabledTools, stats}) → dispose`；`buildToolDefinition`（publicToolName/truncate/schema/output 定义）；guard `ctx.on("tools/pre-execute")`。
- 边界：工具**定义**在本层，工具**执行**一律委托 L11（经 L08 的 client）。

### L10 能力目录层
- 职责：目录条目合成（用户描述>目录缓存摘要>名）、digest（只含服务器集合）、history 去重注入决策、last-good 缓存读改写、注入端视图（B 缓存 + 中间层 per-root 覆盖 + 磁盘兜底）。
- 上游：L09（宣称协议相同）；下游：L06（cwd 解析）、L05（缓存 IO）。
- 契约：`catalogServersFor(cwd)`、`catalogViewFor(cwd, servers)`、`resolveCatalogInjection(decision, messages, supervisors, maxEntries, cache, agent, mode)`、`summarizeToolDescriptions`、`digestCatalogEntries`、`composeCatalogEntries`。

### L11 工具执行管道层（扩展⑨）
- 职责：一次工具调用的完整管道：
  `authorize(禁止表+策略 rule) → route(全名+会话) → call(远端 client / 封装 execute) → project(白名单/截断/脱敏/超时/stale 提示) → 埋点(stats)`
- 上游：L09（execute 入口）、L07（setToolDisabled 写禁用表）；下游：L08（client）、L04（策略模型）、L13（埋点）。
- 契约（单一事实源，修复 B8/B9/B10/B14/B18）：
  - `isToolDenied(disabledTools, policy, serverKey, tool)` / `policyAllows` / `toolDisabledReason`
  - `projectCallToolResult(result, handlers)` / `truncateText` / `extractText`
  - `createRedactor(servers)`（执行侧错误脱敏；含 raw/decoded 双形态，修 B8）
  - `withTimeout(p, ms, msg, signal)`
  - `normalizeArguments` / `batch` 一致化
- 埋点契约：`recordCall/server/tool/durationMs/success/errorMsg`（Metadata-Only）。

### L12 对外集成层
- 职责：ctx.mcpManager 服务面（注入/控制/查询 8 方法）；runtimeRegistry 双轨归口。
- 上游：其他插件（消费方）；下游：L07、L11。
- 契约：`registerServer/unregisterServer/connect/disconnect/reconnect/getStatus/getTools/list`（类型面 shared/mcp-manager-service.d.ts）。

### L13 统计观测层
- 职责：聚合指标 + 披露漏斗 + 防抖落盘（1000ms）+ 关闭时 flush（修 B2）+ 键截断。
- 上游：L09/L11 埋点；下游：无。
- 契约：`recordCall/recordSearch/recordList/recordDetail/snapshot/flushSync/configure/dispose`。

### L00–L02 客户端
- L00 支撑：`createState/session 订阅/rebindSession/api/dom/ensure-style/i18n`。
- L01 胶囊：`float/panel/servers/quick-add`（操作统一带 cwd，修 C6/C7；checkbox 后保折叠态，修 C8）。
- L02 设置：`settings-card`（保存后清理 timer，修 C5）。
- 契约：与 L03 的 HTTP/SSE 帧协议、config 扁平形状、summary 六态计数、tool-disable 全名形态。

### 状态事件层（横切，宜并入 L07 侧或独立小模块）
- 契约：`emitStatus()` →（coalesce 同 tick）→ `sseHub.broadcast(summaryFrame | uiConfigChangedFrame)`；热切换（L07.setMiddlewareMode）必须 emit（修 B20）。

---

## 四、目标目录结构（物理 9 域）

```
packages/dsh-mcp-manager/
  src/
    index.ts                组合根 re-export（导出面不变，smoke/契约门禁零感知）
    bootstrap/              L：组合根装配
      apply.ts apply-config.ts apply-runtime.ts apply-services.ts apply-guidance.ts
    api/                    L03 API/传输
      routes.ts routes-controllers.ts routes-helpers.ts sse-exit.ts（SSE 帧协议）
    config/                 L04+L05 配置域
      model/（pure）normalize.ts import.ts config-schema.ts user-state-model.ts
      store/（io）store.ts middleware-state.ts catalog-cache-io.ts
    workspace/              L06 路由域（新）
      root-resolution.ts full-name.ts scope.ts middleware-mode.ts
    connection/             L07+L08 连接域
      orchestrator/ manager.ts
      execution/ supervisor.ts middleware.ts transport.ts protocol.ts
    inject/                 L09 模型面
      register.ts middleware-register.ts tool-definition.ts guard.ts prompt.ts
    catalog/                L10 能力目录
      entries.ts digest.ts history.ts injection.ts cache-view.ts
    execution/              L11 工具执行管道
      authorize.ts call.ts project.ts redact.ts timeout.ts args.ts
    integration/            L12 对外集成
      service.ts service-contract.ts
    stats/                  L13 统计观测
      collector.ts types.ts
    types/                  共享类型单一事实源
      server.ts status.ts ui.ts
  src/client/
    core/                   L00 支撑（state/session/dom/api/i18n/constants）
    float/                  L01 胶囊（float.ts panel.ts servers.ts quick-add.ts）
    settings/               L02 设置（settings-card.tsx）
    style.css locales.ts css.d.ts react-shim.d.ts
  共享层（跨包，非本包）：
    shared/loopback sse-hub host-utils settings-namespace dsh-home placement-math mcp-manager-service
```

迁移原则：
- `git mv` 纯搬移零行为变化；index.ts 聚合 re-export 保持导出面（smoke/service-contract 静态扫描不断）。
- 每域 `index.ts` 出口 = 该层契约面（types 精简为仅导出契约）。
- 依赖方向强制：`bootstrap → {api, config, workspace, connection, inject, catalog, execution, integration, stats}`；被依赖层之间只允许「上层依赖下层」，禁止反向（现状已有的 ManagerLite/MiddlewareHost 最小面接口保留并推广到每层）。

---

## 五、按微服务思路的分阶段重构方案（TDD 驱动）

> 每阶段：独立 worktree PR；先契约测试（层间 mock 边界）→ 红测已证实 bug → 绿修 → 门禁。阶段顺序按「风险从小到大、修复与拆分互相成就」。

### 阶段 0：契约冻结（规格层）
- 输出「层接口契约清单」（上文第三部分落成 `docs/architecture-contract.md`）；把 6.3 全部「或规格化声明」行拍板（B4/B6/B13/B14）。
- 门禁：现有 smoke/contract 全绿（零代码改动）。

### 阶段 1：配置域拆分（纯搬移 + pure 测试补全）
- `config/model` 与 `config/store` 物理分离；normalize/import/config-schema/user-state 解析补边界测试（超长 name、enabled 非布尔、Infinity timeout、URL 协议、数组参数）。
- 红测先行：B13/B14/B17 的测试先红后绿。

### 阶段 2：执行管道成形（L11）——评审 P1 核心
- 把 guard 裁决、callTool、projectCallToolResult、redactor、withTimeout、埋点收进 `execution/` 管道的多条纯函数 + 组合器；supervisor/middleware 两条调用路径改为消费同一管道。
- 红测：B8（raw/decoded 双形态 + supervisor 日志脱敏）、B9（字节口径）、B10（truncated 事实返回）、B18（口径统一：closeHandler 计数 + toolCallTimeoutMs 生效）、B14（参数形态）。
- 门禁：mutation 该域 0 新增存活。

### 阶段 3：连接域拆分（L07/L08）——评审 P1/P2 核心
- `connection/orchestrator` 与 `connection/execution` 分离；`execution` 独占代际清理（修 B5）、退避/超时口径（修 B18 另一半）、重连状态机（修 B1/B4）。
- 红测：B1（状态机断言点）、B4（reconnecting 分级）、B5（替换清理）、B18（supervisor vs 池参数同源）。
- CALL_TIMEOUT_MS 注入化（修 stryker 32s 放大）。

### 阶段 4：工作空间路由层（L06）
- 从 manager/middleware 抽出 root 解析/全名/归属；补 runtimeRegistry 参与（修 B3）。
- 红测：B3（all 模式空 cwd + 仅 runtime → @global 回落）。

### 阶段 5：能力目录层（L10）与状态事件层
- catalog 域独立（entries/digest/history/injection/cache-view）；事件源统一（热切换 emitStatus 修 B20）。
- 红测：B20（热切换发 summary 帧）；目录注入决策补 compaction/resume 用例。

### 阶段 6：客户端分层（core/float/settings）
- 支撑层独立；浮窗操作带 cwd（C6/C7）；SSE 恢复探测（C2）；设置卡 timer 清理（C5）；面板刷新与折叠态（C8/C10）；keydown 清理（C4）；超长名 CSS（C3）。
- 隔离浏览器实测（dsh-verify-isolated）：C1 编辑链路（P1）优先 + UI 回归截图归档。

### 阶段 7：质量收口
- 变异得分 ≥60（预算：优先清 416 个 NoCoverage 与 supervisor/manager/middleware 存活变异）；哑断言清零；`unit-call-stats` 接线（smoke + mutation-topology 双登记）；4 个仅 stryker 面文件纳入 smoke import；README/文档同步（B15/B16/C9 等声明项）；release-notes。

---

## 六、风险与决策点（需用户/维护者拍板）

1. **物理迁移 vs 逻辑收敛**：阶段 1/3 的纯搬移会带来大 diff（import 路径全变），stryker 配置与 smoke 断言路径需同步 —— 是否接受「先逻辑收敛（不改物理路径、只在文件内重组职责）再二期物理迁移」的两步走？
2. **L11 执行管道**的粒度：组合器（一条 `executeTool(pipe, ctx)` 管道函数）vs 保持模块级函数散调——推荐组合器（单一执行入口，便于中间件式扩展与测试）。
3. **B1/B4 重连状态口径**：补 supervisor/中间层 `reconnecting` 状态（改面较大）vs 规格化声明——推荐补状态机（六态一致）。
4. **新增层落地位置**：workspace/、execution/ 等新目录以「新文件先行 + 旧文件薄转发」渐进式（避免一次性大爆炸迁移）。
5. 本方案为**重设计蓝图**，实施仍需按仓库红线：建 issue → worktree → 方案评审 → 分阶段 PR。