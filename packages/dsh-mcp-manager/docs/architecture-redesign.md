# dsh-mcp-manager 分层架构重构方案（v2，吸收对抗性评审修正）

> v1（253 行）经微服务专家对抗性评审 62/100「需重大修正」；本版为修正稿。
> 评审全文见 `docs/architecture-redesign-review.md`。
> 修正主线：13 层→**7 逻辑层 + 9 物理目录**；分布式物理迁移→**单一集中式纯搬移 PR**；
> 「导出面保住静态契约」承诺修正为**静态面清单化同步**；拆分归属/B 系列映射补齐。

---

## 一、分层裁定（7 逻辑层 + 组合根 + 共享）

> 「层」= 有独立生命周期/可独立替换的边界；子目录归属不升格为层（避免文档主义）。

| 逻辑层 | 包含（物理目录） | 裁定依据 |
|--------|-----------------|---------|
| ① 客户端层 | `src/client/{core, float, settings}`（L00–L02） | 浏览器端底座+UI，独立生命周期；**保留 src/client/index.ts 入口**（build-client 契约锚点），style.css 引用路径随之确定 |
| ② API 层 | `src/api/`（L03） | routes/controllers/sse-exit/health；错误契约（HTTP body 与日志双轨脱敏）入契约 |
| ③ 配置域 | `src/config/{model, store}`（L04+L05） | normalize/import/config-schema 与 store/user-state/目录缓存已文件分离（#592 已做），**不升双逻辑层**；normalizeScope 移归 ⑤ 路由域 |
| ④ 连接域 | `src/connection/{orchestrator, execution}`（L07+L08） | **唯一真实拆分收益**：manager.ts 1184 行 + 双常量证明路由域名需收敛；orchestrator=仲裁/双轨/生命周期，execution=supervisor 代际/中间层池/transport/protocol；**状态事件层并入本域**（两帧触发源契约先定） |
| ⑤ 模型面+目录域 | `src/inject/` + `src/catalog/`（L09+L10） | 工具注册/guard/提示词 与 能力目录/检索分目录；**目录检索函数族**（searchCatalogMulti/listCatalog/findToolDetail/boundCatalogTools/scoreTool/isCatalogFresh）落位 `catalog/search.ts`；normalizeScope/MIDDLEWARE_GLOBAL_ROOT 收敛于 ⑥ |
| ⑥ 执行管道域 | `src/execution/`（L11） | 纯函数族 + 薄适配（**不建 executeTool 大组合器**）；授权裁决/调用/投影/截断/脱敏/超时/埋点；两路径同构由**契约测试**强制 |
| ⑦ 服务/统计域 | `src/integration/` + `src/stats/`（L12+L13） | ctx.mcpManager 8 方法 + call-stats；B6/B2 契约入 |
| 组合根 | `src/bootstrap/` | apply 系列（装配/热切换/卸载）；**apply-services.ts 落位与 service-contract 静态扫描路径同步**（P0） |
| 共享 | `shared/`（跨包，消费者） | loopback/sse-hub/host-utils/settings-namespace/dsh-home/placement |

**拆得不够的点（评审指出，纳入本版）**：`middleware.ts` 的 `callTool()`（L491–614）是「池方法 + 管道」混层最典型样本——路由/unit 查找留 ④，裁决/禁用/stale/withTimeout/redact/project/封装直呼归 ⑥。

---

## 二、目标目录结构（9 域 + 客户端 3 子目录）

```
src/
  index.ts                 组合根 re-export（唯一汇聚转发点；middleware.ts 停止 re-export）
  bootstrap/               apply.ts apply-config.ts apply-runtime.ts apply-services.ts apply-guidance.ts
  api/                     routes.ts routes-controllers.ts routes-helpers.ts sse-exit.ts health.ts
  config/
    model/                 normalize.ts import.ts config-schema.ts user-state-model.ts
    store/                 store.ts middleware-state.ts catalog-cache-io.ts
  workspace/               root-resolution.ts full-name.ts scope.ts middleware-mode.ts（含 MIDDLEWARE_GLOBAL_ROOT 单源）
  connection/
    orchestrator/          manager.ts（L07：仲裁/双轨/summary/事件出口）
    execution/             supervisor.ts middleware.ts transport.ts protocol.ts（L08 + callTool 管道段切割）
  inject/                  register.ts middleware-register.ts tool-definition.ts guard.ts prompt.ts
  catalog/                 entries.ts digest.ts history.ts injection.ts cache-view.ts search.ts（检索函数族）
  execution/               authorize.ts call.ts project.ts redact.ts timeout.ts args.ts stats-hook.ts
  integration/             service.ts
  stats/                   collector.ts types.ts
  types/                   server.ts status.ts ui.ts host-faces.ts（ManagerLite/RoutesManager/MiddlewareHost/SupervisorLite 收敛）
src/client/
  index.ts                 （入口不动，仅 re-export + apply/inject 契约）
  core/                    state.ts session.ts dom.ts api.ts i18n.ts constants.ts
  float/                   float.ts panel.ts servers.ts quick-add.ts
  settings/                settings-card.tsx
  style.css locales.ts css.d.ts react-shim.d.ts
```

破环与收敛清单（评审 3.x）：
- middleware.ts 的六段 re-export 块整体删除，汇聚只留 `src/index.ts`；
- `routes.ts:21` 的 `import type { ClientUiConfig } from "./index.ts"` 改从 `types/ui.ts` 取（消组合根类型环）；
- `MIDDLEWARE_GLOBAL_ROOT` 收敛为 `workspace/` 单源；`normalizeScope` 归 workspace；
- 四个最小面接口（ManagerLite/RoutesManager/MiddlewareHost/SupervisorLite）并入 `types/host-faces.ts`。

---

## 三、每层职责与接口契约（7 逻辑层）

> 契约口径：**成功签名 + 错误契约 + 事件契约**；只列「新增/缺口」项，现状稳定面引用代码。

### ① 客户端层
- 职责：L00 core（state/session/dom/api/i18n）；L01 float（胶囊/面板/列表/表单）；L02 settings（设置卡）。
- 契约补齐：SSE 帧集合显式清单（summary/ui-config-changed/ping + 60s watchdog）；未知状态策略（C13：统一丢卡 or 塞 stopped，二选一）；204 备忘（C14）；tool-disable 全名形态与 projectRoot 缺失防御（C6/C7）。
- 落位：`src/client/index.ts` 保留（build-client 入口）；style.css 引用改「子目录 → 根」。

### ② API 层
- 职责：9+ 控制器、loopback 围栏、SSE/health 出口、DTO 校验。
- 契约补齐：**错误契约**——HTTP 400 body 写入前必须经脱敏（与日志同口径，B8 P0-②），声明「无业务错误码，文案即契约」；`GET /servers` 零副作用语义显式化；makeEventsRoute/makeHealthRoute 落位 sse-exit.ts/health.ts。

### ③ 配置域
- model：`normalizeServer → ServerConfig | throw`；`parseClaudeJson`；`normalizeUiConfig`（三形态兼容=读取兼容不迁移写回）；Config schema 默认（middleware: project）vs 运行时默认（off）的演进规则显式化；B15 描述修正。
- store：`McpStore.{load,save,reloadIfChanged,find,upsert,remove}`（0600 + tmp+rename + DSH_HOME）；`projectStores` 缓存语义（缓存命中仍 reloadIfChanged）；user-state/disabledTools 合并式写盘 + IO 损坏容错契约（现状吞错，写明）；目录 last-good「摘要实质变化才写盘」；B17（唯一 tmp 名 + 失败清理）。
- 存储 IO 错误处理契约：损坏文件不抛、基线推进（现状语义固化）。

### ④ 连接域
- orchestrator（L07）：双轨 reconcile、生命周期仲裁（add/update/remove/connect/disconnect/reconnect/registerServer/unregisterServer）、summary 投影、会话切换、resumeReconnect（目标集=配置全集，#412 语义）、setToolDisabled（B19 口径统一：supervisor 分支与中间层分支同一查询函数）。
- execution（L08）：supervisor 单代际（connect/initialize/syncTools/退避/清理）、中间层池（in-flight/force/LRU/防双进程）、transport/protocol。
- **契约关键面**：
  - 状态事件契约：emitStatus 无参 + listeners Set + coalesce（同 tick 合并）；**两帧触发源**——summary 帧来自 emitStatus；ui-config-changed 帧来自 settings onChange（现状不经 emitStatus 不 coalesce，保持两链，写清各自语义）；B20 修复=热切换补 emitStatus。
  - **B5 契约**：L08 提供 teardown 接口，**L07 有显式调用义务**（替换/remove/update/unregister 必须调用）；start() 同步→异步决策（P0 拍板，波及 routes×9+apply+测试）。
  - AbortSignal 面：`callTool(tool, args, {signal, timeoutMs})` 选项面；withTimeout 兜底裕量（30s+2s）语义显式化。
  - 退避/超时口径：先收敛为 L08 单一解析函数（消费 `server.reconnect`/`server.toolCallTimeoutMs`）再供 supervisor/池两实例（B18）。
  - `middleware.callTool` 管道段切割线：路由/unit 查找留本层；裁决/禁用/stale/withTimeout/redact/project/封装直呼归 ⑥。

### ⑤ 模型面+目录域
- inject（L09）：mcp__ 注册、ws_mcp_* 四原子、pre-execute guard、系统提示词；**guard 覆盖语义**：现状仅 mode≠off 挂载（apply.ts:139）→「工具级禁用三入口」off 模式实际一入口，显式化或补挂载（规格决策）；B11 反解（双下划线）决策入规格表。
- catalog（L10）：entries/digest（只含 name 稳定性契约）/history 去重/injection 决策/`catalogViewFor`（宿主面设计：从 manager.ts:443 迁出需最小面 host）/`catalog/search.ts` 检索函数族（B10 修复落点）。
- 接线契约：`registerCatalogInjection`（apply-runtime.ts:74）挂载在 bootstrap、决策在 catalog——写清跨域接线与数据源组装接口。

### ⑥ 执行管道域
- 职责：一次工具调用的完整管道（纯函数族 + 薄适配，不建大组合器）：授权裁决（isToolDenied/policyAllows/glob）→ 调用（远端 client / 封装 execute）→ 投影/截断/脱敏/超时/stale 提示 → 统计埋点。
- 契约：
  - 两路径（supervisor 直呼 / ws_mcp_call）差异面签名：handlers（CallResultTextHandlers）、timeout 来源（toolCallTimeoutMs vs CALL_TIMEOUT+2s）、redact（有/无）、stale 提示（有/无）；
  - **两路径同构由契约测试强制**（同一输入分别喂两路径断言输出一致）；
  - 日志脱敏覆盖点清单（supervisor.ts:362、manager 各处 logger.warn——B8 P0-②）；
  - supervisor 路径新增 stats 埋点 = **行为扩展声明**（非纯重构）；
  - redactor 支持 raw/decoded 双形态（percent-encoding 防绕过）。

### ⑦ 服务/统计域
- integration（L12）：8 方法；registerServer 串行队列语义；B6（getTools 查询面）决策入规格表。
- stats（L13）：isEnabled/loadExisting（重启恢复）；B2 修复语义（configure 关闭先刷 or flushSync 不以 enabled 短路）；**前置：unit-call-stats.test.ts 双登记接线**（现状三处均不执行）。

---

## 四、迁移策略（逻辑收敛 → 单一集中式纯搬移 PR）

1. **先逻辑收敛**（阶段 1–5）：文件内重组职责（类/函数归位、新目录建新文件、旧文件薄转发保名），**不做 git mv**；行为修复与逻辑收敛分 commit。
2. **集中式纯搬移 PR**（阶段 6）：一次 git mv 到位 + 全静态面同步 + 全量门禁 + 迁移专用验证（迁移 PR 不夹带任何 bug 修复/行为变更，回归可归因）。
3. **静态面清单**（该 PR 必须同步，否则必红）：
   - `test/service-contract.test.ts:145` 扫描路径（`src/apply-services.ts` → 新位置）；
   - `stryker.conf.d/dsh-mcp-manager-{manager,entry,supervisor,middleware,routes,runtime}.json` 六段 mutate 清单 + `scripts/data/mutation-topology.json` + workflow-assert（三方一致）+ mutate-scope-guard；
   - observe 夜间基线（src 口径四班次重建）策略与 incremental 缓存作废处理；
   - `bundle-host.ts` client 入口发现（src/client/index.ts 保留即无感）；
   - smoke/unit 全部只 import `../lib/index.js`（✓ 不受迁移影响）。
4. **门禁策略决策**（进 issue 方案，维护者批准）：迁移 PR 的变异门禁 =「先提分过线再迁移」or「迁移 PR 走 observe 夜间重建豁免」——取决于 §六 门禁判分口径澄清。

---

## 五、分阶段 TDD 计划（阶段 0–7，含 B 系列全量落位）

| 阶段 | 内容 | Bug 落位 |
|------|------|---------|
| 0 规格决策表 | 拍板 §六 全部决策项 + 契约缺口清单 + 迁移门禁策略三件文档 | B4/B6/B11/B13/B14/B18 超时口径/B8 双形态/门禁判分 |
| 1 测试基建 + 配置域 | fakeTransport/fakeMCPClient 桩进 helpers.ts；**unit-call-stats 双登记接线**；createRedactor 基线测试（现状零测试）；B7 直测；配置 model/store 逻辑归位 | **B2**、B7、B13、B14、B17 |
| 2 执行管道成形 | 纯函数族 + 薄适配；两路径契约测试；supervisor 埋点（行为扩展声明）；execution/ 文件挂 stryker 段 | B8、B9、B10（检索面同步改）、B18、B14 |
| 3 连接域逻辑收敛 | orchestrator/execution 文件内重组；状态事件契约先定；B5 契约决策先行；六态一致单 PR（B1+B4+C13） | B1、B4、B5、B18、B19、B20 |
| 4 工作空间路由层 | workspace/ 新文件 + 旧函数薄转发 + 调用点全切；双常量收敛 | **B3（提前）**、B11 规格落地 |
| 5 目录域 | catalog/search.ts 检索族落位；catalogViewFor 宿主面；registerCatalogInjection 接线显式化 | B10（若阶段 2 未完成）、B12 |
| 6 集中式纯搬移 PR | git mv + 静态面全同步 + 门禁兜底（见 §四） | 无行为变更 |
| 7 客户端分层 + 收口 | core/float/settings；C1（P1 编辑链路优先）+C2/C3/C4/C5/C6/C7/C8/C10 隔离浏览器实测；哑断言清理；文档同步 | C1–C15、B15、B16、B12、B19 |
| 8 质量收口 | 变异得分（判分口径澄清后校准）；4 个仅 stryker 面文件按断言价值选择性纳入 smoke | — |

红测前置条件表（评审 5 表格）：
- B8：createRedactor 基线测试先行（现状零测试）；
- B5：fakeTransport 桩 + start 同步→异步契约先决（弱断言先行：替换后旧实例 disposed + 新代际建立）；
- B2：接线先行（三处登记）；
- B11：规格决策先行（映射表 or 规格化不可逆名）；
- B1：改状态机断言点（`failedAttempts>0` 分支断言），勿整窗口轮询；`_idleTimeout` 私有字段改 resolveReconnect 纯函数断言。

---

## 六、规格决策表（阶段 0 拍板）

| # | 决策项 | 选项 | 推荐 |
|---|--------|------|------|
| D1 | B1/B4 重连状态 | 补 `reconnecting` 状态机（supervisor+池+summarize+counts+客户端 C13 同步）vs 文档化回避 | 补状态机（六态一致，单 PR） |
| D2 | B5 start() 契约 | 同步 fire-and-forget + syncChain 收口 vs 变 async（涟漪 routes×9+apply+测试） | 若涟漪可控选 async；否则 fire-and-forget + 显式 teardown 义务（P0 评估） |
| D3 | B6 getTools 查询面 | 与 summary 同源（中间层也返回）vs 文档声明仅 supervisor 路径 | 与 summary 同源（查询面一致） |
| D4 | B8 脱敏口径 | 整 URL（现状安全激进）vs 仅用户信息（raw/decoded 双形态，诊断性好） | 仅用户信息 + 双形态 + 日志脱敏全覆盖（走安全语义红线流程） |
| D5 | B11 双下划线反解 | publicToolName 加分隔符转义（映射表）vs 规格化「含 `__` 名不可逆不禁用」 | 规格化不可逆（改动面小）；映射表列入后续增强 |
| D6 | B18 超时口径 | toolCallTimeoutMs 生效 + 保留 CALL_TIMEOUT+2s 兜底 vs 照 supervisor 抄（无兜底） | 保留兜底（防半开双保险） |
| D7 | 门禁判分口径 | covered（74.66% 已过 60）vs 总得分（58.74% 未过） | **先澄清 mutation-gate.mjs 判分输入**再定「先提分后迁移」or「迁移走夜间重建豁免」 |
| D8 | off 模式 guard | 补挂载（off 模式 mcp__ 直呼也拦截）vs 文档化「off 仅一入口」 | 补挂载（工具级禁用语义完整） |

---

## 七、风险清单（按阶段，评审 10 表格收敛）

- 阶段 1：纯搬移收益近零但门禁成本全量 → 本阶段不做 git mv，修复与迁移分 commit。
- 阶段 3：门禁重灾区（manager/middleware 迁移 → 六段清单≥3 段失效）→ 逻辑收敛先行，物理迁移延后集中 PR；B5 契约决策先行。
- 阶段 4：双份实现窗口（新文件+旧函数残留）→ 薄转发 + 调用点全切后再删旧。
- 阶段 5：catalogViewFor 宿主面设计成本未披露 → 先薄桥接留在 manager 或造最小面 host。
- 阶段 6（客户端）：index.ts 缺失会构建/契约双崩 → 入口保留、CSS 引用路径先行验证。
- 阶段 8：smoke import 拓展膨胀测试时长 → 按断言价值裁剪，stryker 侧耗时预算。