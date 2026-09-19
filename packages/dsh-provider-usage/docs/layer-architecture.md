# dsh-provider-usage 分层职责与上下游接口契约（两大功能域）

> 状态：**当前架构的契约基线 v4**（分层重构已完成，#670；决策表 D1-D17 见 §4 与
> `docs/refactor-implementation-plan.md` §3）。
> 用途：分层模型与契约基线；架构现状与决策记录见 `docs/refactor-implementation-plan.md`
> （当前目录树、文件布局映射、测试分层）。
> 配套图：`docs/diagrams/usage-current-architecture.html`（现状分层；图内容为重构前
> src 布局的快照，含目录化前的路径（如 src/report/config.ts），**契约以符号锚为准**）。
> 符号锚约定（D14）：契约引用一律以「文件 · 符号」为准，不引用行号。

---

## 1. 两大功能域划分

**域边界实证**：域1 业务面（registry/pipeline/history/adapters/stats-service）与域2 业务面
（collect/aggregate/schedule/execute）之间**零直接 import**（grep 双向零命中）。
两域仅经装配层 `apply/apply.ts` 组合。

准确表述：**两域业务面零直接依赖**；共享底座与路由层的跨域依赖如实标注：
- `server/config/normalize.ts` → `server/collect/interface.ts`（TREND_DIR_MAX；#768 D1 前在 `domain2/schedule/config.ts`，D9 随域改址）
- `server/execute/runner.ts` → `server/aggregate/interface.ts`（metricValue/TrendTracker，#768 D3 前在 `domain2/execute/runner.ts`，D8 随域改址）+ `server/collect/interface.ts`（sumToken/TrendCell，D9 随域改址）
- `server/ui-routes/context.ts` → `server/pipeline/interface.ts`（StatsService，type-only + cacheSize() 方法调用，#768 D6 随域改址，D12 前在 `domain2/routes/ui.ts`）
- `server/ui-routes/trend.ts` → `server/collect/interface.ts`（TREND_DIR_MAX；D12 前在 `domain2/routes/ui.ts`，D9 随域改址）
- 域1/域2/装配 → 共享底座一律经各目录 `interface.ts` 面具消费 `shared/interface.ts` 转发符号

### 域1 · 适配器取数与胶囊展示框架
| 层 | 职责 | 文件(行数) | 备注 |
|---|---|---|---|
| C1 契约/工具散层 | v2 契约校验/esc/图表工具/配置归一化/净化 | shared/contracts.ts(425)+charts.ts(369)+config.ts(101)+sanitize.ts(319)+ui-config.ts(87)+client-logic.ts(68)+placement-math.ts(39) | **共享底座**（R6 裁定维持散层）：契约/图表/配置/净化/双端共享，不拆子目录；interface.ts 为 C1 门面 |
| C2 注册/加载层 | 注册表+持久化+热更新+密钥链+路径 | server/registry/{interface.ts 门面 + deps.ts 注入面 + registry/user-adapters/user-adapter-loader/hotreload/path-resolve/provider-config}（#768 D7 由 domain1/registry 整域迁入，候选+唯一启用+错误登记，双启用判据锁定） | 四职责经 stats-service 与路由双收口（C6 直连） |
| C3 执行管道层 | 取数编排+管道+安全执行 | server/pipeline/{interface.ts 门面 + deps.ts 注入面 + stats-service/v2/guards}（#768 D6 由 domain1/pipeline 整域迁入，取数渲染管道：入参组装→safe 执行→净化→归一化，净化缺席判据锁定） | 编排/管道/守卫分文件，内聚成立 |
| C4 历史存储层 | 按天 JSONL/v3 迁移/清理 | server/history/history.ts（#768 D5 由 domain1/history 整域迁入，interface 门面 + 并发语义确定化，pipeline 经门面 type-only 消费） | 纯存储 |
| C5 适配器实现层 | 三内置适配器 | server/adapters/{deepseek-official(777),opencode-go(518),zai-coding-cn(461)}(.mjs) + interface.ts 门面 + deps.ts 注入面 + register.ts 内置装配 fail-fast（#768 D4 由 domain1/adapters 整域迁入，.mjs 零改动） | 自包含零 import；retention 死字段已删除 |
| C6 路由层（宿主） | /stats /history /adapters* | server/data-routes/{interface.ts 门面 + deps.ts 注入面 + stats/adapters}（#768 D10 由 domain1/routes 改名迁入，零行为变更，403 先于 405 围栏判据锁定） | **仅宿主**；客户端单列跨进程 UI 层 |

### 域2 · 事件监听·趋势·报告框架
| 层 | 职责 | 文件(行数) | 备注 |
|---|---|---|---|
| E1 事件采集层 | session/event 折叠状态机 | server/collect/{interface.ts 门面 + deps.ts 注入面 + collector/types}（#768 D9 由 domain2/collect 整域迁入，零行为变更，resolveCwd 延期未验证） | 纯逻辑，now/emit 注入 |
| E2 聚合/压实/存储层 | 双面记账+压实+分片+自愈 | server/aggregate/{interface.ts 门面 + deps.ts 注入面 + aggregator/aggregate-rows/aggregate-query/store/index}（#768 D8 由 domain2/aggregate 整域迁入，derive/align 聚合查询纯面 + 随行修正与冻结，A4(f) 判据锁定） | D2 后主类保留状态容器与方法，压实转换/查询投影为纯函数模块（不接触 this） |
| E3 报告调度层 | 窗口/幂等+队列+lastRun（配置面 D1 起归 server/config） | server/schedule/{due,scheduler,tasks,store}（#768 D2 由 domain2/schedule+common/last-run 整域迁入，叶环归零） | 与 E4 经本域门面解耦（executor 持注入，推进走同一 per-root 链）；tasks 持注入 executor |
| E4 报告执行/产出层 | 执行接线+LLM 生成+渲染+落盘 | server/execute/{report-index,runner,generate,format,executor,list-dirs}（#768 D3 由 domain2 整域迁入，零行为变更） | executor 独立工厂（含错误脱敏契约）；list-dirs 独立文件（闭包收敛）；parse+记忆化单源 |
| E5 路由层（宿主） | /trend /report-* /health | domain2/routes/{interface.ts 空锚点，D13 删} + server/ui-routes/{interface.ts 门面 + deps.ts 注入面 + context/health/trend/ui-config/events}（#768 D12 由 domain2/routes 迁入，一域四块不升域，零行为变更，健康读 errsurf 与 SSE 非可靠判据锁定）+ server/report-routes/{interface.ts 门面 + deps.ts 注入面 + reports}（#768 D11 由 domain2/routes 迁入，interface 门面 + deps 注入面 + 配置窄口消费，零行为变更，释放顺序锁定） | **仅宿主** |

### 客户端（跨进程 UI 层）
- 浏览器进程：`src/client/*`（4239 行）——胶囊/面板/设置页五 tab/趋势/报告 UI
- **经 HTTP 消费宿主**（C6/E5 路由），**不 import 宿主运行时**
- 与宿主共享源码契约：contracts/charts/placement-math 等**构建期双端共用同一份源码**（client/core.ts、trend-math.ts、index.tsx），非运行时依赖
- 宿主 inject（src/apply/apply.ts）`["webServer","llm","sessions"]` vs 客户端 inject（client/index.tsx）`["locale","sessions","remote","remote.session","slots"]` —— **两码事，勿混**

### 装配层与共享底座
| 组件 | 职责 | 文件 |
|---|---|---|
| 装配层 | 组合两域/16 路由注册/定时器/生命周期 | apply/apply.ts+apply/index.ts（报告配置服务已归 server/config/service.ts，#768 D1） |
| 共享底座 | charts/config/sanitize/contracts 类型 + placement-math + shared/* | shared/interface.ts 门面 + charts.ts/config.ts/sanitize.ts/ui-config.ts/client-logic.ts/placement-math.ts/contracts.ts |

---

## 2. 层间上下游接口契约

### 2.1 域1 契约
| 层 | 上游→ | 对外主契约 | ←下游 | 穿透说明 |
|---|---|---|---|---|
| C1 | 全部层+客户端 | isUsageStatsAdapter(contracts)/esc(contracts)/ADAPTER_UTILS(charts)/normalizeConfig(config)/FetchContext·CapsuleInput·PanelInput | 零内部依赖（charts 不 import contracts 防环；contracts type-only charts 为弱依赖） | — |
| C2 | C3/装配/**C6 路由** | registry.register/select/getEntry/replaceByFile/snapshot；resolveProviderConfig；HotReloadableAdapter；resolveAddAdapterFile(user-adapters)；readAdapterStateResult/writeAdapterState | C1 | **C6 直读 registry**（server/data-routes/{adapters,stats}、server/ui-routes/health.ts）——注册表非仅 stats-service 收口；registry 为公开管理对象，判断面不收口 |
| C3 | C6/装配 | StatsService.getStats/cacheFresh/purge/warmup/scheduleWriteAdapterState；runV2Pipeline(pipeline/v2)；safeFetchData(guards，5s 固定)；V2PipelineResult | C2/C4/C5 | **D7 已落地**：面板缓存四段语义整体下沉为 `StatsService.getPanelResult`（key 归一 → stale 判定 → miss 删除 → 管道 → 失败不写）+ purgeAllCaches（generation 失效 + per-key 单飞）；路由不再直读写 panelCache |
| C4 | C3/C6 | HistoryStore.append/query/last/pruneAll/migrateLegacyV3 | 无 | — |
| C5 | C3 | 三 UsageStatsAdapter 实例（version/name/label/providers/fetchData/formatCapsule/formatPanel） | 无 | — |
| C6 | 浏览器 | 6 路由 loopback；响应形状见现状图/契约表 | C3/C2/C4 | D7 后仅 registry/history 直读保留 |

### 2.2 域2 契约
| 层 | 上游→ | 对外主契约 | ←下游 | 备注 |
|---|---|---|---|---|
| E1 | 装配(session/event 订阅) | TrendCollector.handleEvent/handleDisposed；emit(call/correct/counter)；sanitizeDirName(types)；TREND_UNIDENTIFIED(types) | E2 | 事件流形状/TTL/done 上限为关键不变量 |
| E2 | E1/装配 | TrendTracker.buckets/dirRows/seriesStacked/dirStacked/windowSummary/dirTotals/stats；TrendStore | E4/**E5 路由直连** | 四不变量：身份快照/防双计/聚合权威/残差归未识别；**台账守恒（Σ事件 == buckets == agg == dirRows + unidentified）为真缺口断言**，由 unit-trend-ledger 事件回放式端到端对账固化（D2 拆分前置安全网） |
| E3 | 装配/E5 | candidateWindow/pendingReports/presetLastRun（due）；ReportScheduler/ReportTaskQueue；read/updateLastRun（store） | server/schedule 门面（归一化经 server/config 门面；index 解析经 server/execute 门面纯面，#768 D3 前在 common） | E3⇄E4 经 server/schedule 门面解耦（#768 D2；executor 独立工厂属 E4，推进走同一 per-root 链；读侧记忆化在 server/execute/runner，防双份缓存） |
| E4 | E3 任务/装配 executor | runDueReport(runner)/generateReport(generate)/buildStatsSnapshot/reportBodyToHtml(format)/persistReport/readReportIndex/parseReportIndexLines | E2（buckets/dirRows，经 domain2 门面纯面复用）+ server/config/schedule 双门面 | LLM 失败不推进 lastRun；注入面=聚合数值+basename；executor 工厂（server/execute/executor.ts，#768 D3 前在 domain2/execute）含错误脱敏契约 |
| E5 | 浏览器 | 10 路由（/trend /health /ui-config /events /report-*6） | E2/E3/E4 | **E5 直连 E2/E3/E4**（server/ui-routes/trend 直调 trend 查询面，#768 D12 前在 domain2/routes/ui.ts；report-routes 经 deps.ts 窄口（ReportRoutesConfigPort/ReportRoutesQueuePort）收口 reportCfg 与任务队列，#768 D11 前在 domain2/routes 且经 apply 装配面取服务类型；执行器由队列内嵌，组合根装配） |

### 2.3 隐藏共享
| 共享 | 位置 | 说明 |
|---|---|---|
| reportCfg 双源 | apply/apply.ts `let reportCfg` + get/set | 内存态+磁盘 config.json 双源（#629 只保 lastRun 串行化）——**已由 ReportConfigService（server/config/service.ts，#768 D1 前在 apply/report-config-service.ts）收口**：内存权威 + per-root 串行写链，并发 update 不交错 |
| lastRunChainByRoot | server/schedule/store.ts | per-root 临界区链（D8 归位无状态无缓存；#768 D2 起归属调度域，叶环归零） |
| indexCache | server/execute/runner.ts（#768 D3 前在 domain2/execute/runner.ts） | 读侧投影 stat 记忆化 + `__ForTests` 钩子——**留在 E4 读侧**，server/execute/report-index 不携带缓存（防双份） |
| sseClients / EVENTS_URL | apply/apply.ts + client/core.ts | SSE 死面（客户端零消费，D4 文档化保留） |
| watchedFiles | apply/apply.ts 闭包 | 热更去重 |

---

## 3. 当前目录结构

两级「先域再层」目录化已完成（D9）：`shared/` 为共享底座；域1 与域2 各含
registry/pipeline/history/routes 与 collect/aggregate/common/routes（schedule 已整域迁 server/schedule，#768 D2；execute 已整域迁 server/execute，#768 D3；adapters 已整域迁 server/adapters，#768 D4）；server/ 下设 config/shared/upgrade/schedule/execute/adapters 六域；
`apply/` 为装配层组合根。每目录 `interface.ts` 为唯一对外引用面（最小面具名导出，禁整文件
re-export；跨目录直引由 `scripts/gate/verify-dir-imports.mjs` 软报告，interface.ts 符号存在性
硬校验）。完整目录树与文件映射见 `docs/refactor-implementation-plan.md §4/§5`。

---

## 4. 决策表（D1-D17 已拍板决策记录 · 详见 refactor-implementation-plan.md §3）

| # | 决策项 | 最终裁定 |
|---|---|---|
| D-1 | C2 六文件拆分 | 维持（并入 registry/ 目录） |
| D-2 | aggregator 拆分 | **已拆**：纯函数模块 aggregate-rows/aggregate-query（R8 台账守恒断言前置） |
| D-3 | C3 编排/管道/守卫 | 维持 |
| D-4 | SSE /events 死面 | 文档化保留（backlog） |
| D-5 | contracts/charts 共享 | 物理化 = shared/（C1 底座目录） |
| D-6 | 客户端分层 | 分域保留；客户端拆分本轮不做（D15） |
| D-7 | StatsService 缓存收口 | **已实施**：getPanelResult 整体下沉 + generation 失效 + per-key 单飞 |
| D-8 | executor 收敛 E4 | **已实施**：独立工厂 + common 归位 + 报告面组合收敛 |
| D-9 | 目录化 + interface.ts | **已实施**：两级域→层 + 最小面具名导出；门禁 = verify-dir-imports 软/硬组合 |
| D-10 | 文件瘦身 | **已实施**（客户端除外） |
| D-11 | 注释清理 | **已实施**（删废话/过时/重复，保留 why 与 issue 关联） |
| D-12 | 变异网前置 | **已实施**：变异分层网先行建立，observe 夜间硬校验生效 |
| D-13 | 死面清理独立收尾 PR | **已完成**：capsuleHtmlFromHistory / AdapterConfig.retention 已清理（#680） |
| D-14 | 契约表符号锚 | **已实施**：契约引用一律「文件 · 符号」，不引用行号 |
| D-15 | 客户端拆分范围 | 本轮不做（backlog） |
| D-16 | 对外估算 | 8-12 天，内部 1.5-2×（实施历时符合） |
| D-17 | **测试分层** | **已实施**：L1 层内单元 + L2 interface 契约 + L3 user-case 集成（UC1-UC6）+ L4 变异按层分段（threshold 60） |

---

## 5. 配套图

- **现状分层**：`docs/diagrams/usage-current-architecture.html`（域1 七层 + 域2 六层 + 装配；
  visual-check 已通过）。图内容为重构前 src 布局的快照（含目录化前路径），契约以符号锚为准。
- 目标态图（`usage-target-architecture.html`）对应重构前的「目标」设计稿，目录化后布局以
  §3 目录结构与 §4/§5 之文件映射为准。