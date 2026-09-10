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
- `domain2/schedule/config.ts` → `domain2/collect/interface.ts`（TREND_DIR_MAX）
- `domain2/execute/runner.ts` → `domain2/aggregate/interface.ts`（metricValue/TrendTracker）+ `domain2/collect/interface.ts`（sumToken/TrendCell）
- `domain2/routes/ui.ts` → `domain1/pipeline/interface.ts`（StatsService，type-only + cacheSize() 方法调用）
- 域1/域2/装配 → 共享底座一律经各目录 `interface.ts` 面具消费 `shared/interface.ts` 转发符号

### 域1 · 适配器取数与胶囊展示框架
| 层 | 职责 | 文件(行数) | 备注 |
|---|---|---|---|
| C1 契约/工具散层 | v2 契约校验/esc/图表工具/配置归一化/净化 | shared/contracts.ts(425)+charts.ts(369)+config.ts(101)+sanitize.ts(319)+ui-config.ts(87)+client-logic.ts(68)+placement-math.ts(39) | **共享底座**（R6 裁定维持散层）：契约/图表/配置/净化/双端共享，不拆子目录；interface.ts 为 C1 门面 |
| C2 注册/加载层 | 注册表+持久化+热更新+密钥链+路径 | domain1/registry/{registry(308),user-adapters(388),user-adapter-loader(36),hotreload(141),path-resolve(79),provider-config(198)} | 四职责经 stats-service 与路由双收口（C6 直连） |
| C3 执行管道层 | 取数编排+管道+安全执行 | domain1/pipeline/{stats-service(256),v2(236),guards(132)} | 编排/管道/守卫分文件，内聚成立 |
| C4 历史存储层 | 按天 JSONL/v3 迁移/清理 | domain1/history/history.ts(420) | 纯存储 |
| C5 适配器实现层 | 三内置适配器 | domain1/adapters/{deepseek-official(777),opencode-go(518),zai-coding-cn(461)}(.mjs) | 自包含零 import；retention 死字段已删除 |
| C6 路由层（宿主） | /stats /history /adapters* | domain1/routes/{stats(123),adapters(213)} | **仅宿主**；客户端单列跨进程 UI 层 |

### 域2 · 事件监听·趋势·报告框架
| 层 | 职责 | 文件(行数) | 备注 |
|---|---|---|---|
| E1 事件采集层 | session/event 折叠状态机 | domain2/collect/{collector(445),types(346)} | 纯逻辑，now/emit 注入 |
| E2 聚合/压实/存储层 | 双面记账+压实+分片+自愈 | domain2/aggregate/{aggregator(701),aggregate-query(628),aggregate-rows(193),store(259),index(356)} | D2 后主类保留状态容器与方法，压实转换/查询投影为纯函数模块（不接触 this） |
| E3 报告调度层 | 配置归一化+窗口+lastRun+队列 | domain2/schedule/{config(538),schedule(243),scheduler(93),tasks(164)} | E3⇄E4 经域2公共层解耦（D8）；tasks 持注入 executor |
| E4 报告执行/产出层 | 执行接线+LLM 生成+渲染+落盘 | domain2/execute/{runner(284),generate(507),format(63),executor(49),list-dirs(16)} | executor 独立工厂（含错误脱敏契约）；list-dirs 独立文件（闭包收敛） |
| E5 路由层（宿主） | /trend /report-* /health | domain2/routes/{ui(246),reports(313)} | **仅宿主** |

### 客户端（跨进程 UI 层）
- 浏览器进程：`src/client/*`（4239 行）——胶囊/面板/设置页五 tab/趋势/报告 UI
- **经 HTTP 消费宿主**（C6/E5 路由），**不 import 宿主运行时**
- 与宿主共享源码契约：contracts/charts/placement-math 等**构建期双端共用同一份源码**（client/core.ts、trend-math.ts、index.tsx），非运行时依赖
- 宿主 inject（src/apply/apply.ts）`["webServer","llm","sessions"]` vs 客户端 inject（client/index.tsx）`["locale","sessions","remote","remote.session","slots"]` —— **两码事，勿混**

### 装配层与共享底座
| 组件 | 职责 | 文件 |
|---|---|---|
| 装配层 | 组合两域/16 路由注册/定时器/生命周期 | apply/apply.ts(457)+apply/index.ts(188)+apply/report-config-service.ts(43) |
| 共享底座 | charts/config/sanitize/contracts 类型 + placement-math + shared/* | shared/interface.ts 门面 + charts.ts/config.ts/sanitize.ts/ui-config.ts/client-logic.ts/placement-math.ts/contracts.ts |

---

## 2. 层间上下游接口契约

### 2.1 域1 契约
| 层 | 上游→ | 对外主契约 | ←下游 | 穿透说明 |
|---|---|---|---|---|
| C1 | 全部层+客户端 | isUsageStatsAdapter(contracts)/esc(contracts)/ADAPTER_UTILS(charts)/normalizeConfig(config)/FetchContext·CapsuleInput·PanelInput | 零内部依赖（charts 不 import contracts 防环；contracts type-only charts 为弱依赖） | — |
| C2 | C3/装配/**C6 路由** | registry.register/select/getEntry/replaceByFile/snapshot；resolveProviderConfig；HotReloadableAdapter；resolveAddAdapterFile(user-adapters)；readAdapterStateResult/writeAdapterState | C1 | **C6 直读 registry**（domain1/routes/{adapters,stats}、domain2/routes/ui.ts）——注册表非仅 stats-service 收口；registry 为公开管理对象，判断面不收口 |
| C3 | C6/装配 | StatsService.getStats/cacheFresh/purge/warmup/scheduleWriteAdapterState；runV2Pipeline(pipeline/v2)；safeFetchData(guards，5s 固定)；V2PipelineResult | C2/C4/C5 | **D7 已落地**：面板缓存四段语义整体下沉为 `StatsService.getPanelResult`（key 归一 → stale 判定 → miss 删除 → 管道 → 失败不写）+ purgeAllCaches（generation 失效 + per-key 单飞）；路由不再直读写 panelCache |
| C4 | C3/C6 | HistoryStore.append/query/last/pruneAll/migrateLegacyV3 | 无 | — |
| C5 | C3 | 三 UsageStatsAdapter 实例（version/name/label/providers/fetchData/formatCapsule/formatPanel） | 无 | — |
| C6 | 浏览器 | 6 路由 loopback；响应形状见现状图/契约表 | C3/C2/C4 | D7 后仅 registry/history 直读保留 |

### 2.2 域2 契约
| 层 | 上游→ | 对外主契约 | ←下游 | 备注 |
|---|---|---|---|---|
| E1 | 装配(session/event 订阅) | TrendCollector.handleEvent/handleDisposed；emit(call/correct/counter)；sanitizeDirName(types)；TREND_UNIDENTIFIED(types) | E2 | 事件流形状/TTL/done 上限为关键不变量 |
| E2 | E1/装配 | TrendTracker.buckets/dirRows/seriesStacked/dirStacked/windowSummary/dirTotals/stats；TrendStore | E4/**E5 路由直连** | 四不变量：身份快照/防双计/聚合权威/残差归未识别；**台账守恒（Σ事件 == buckets == agg == dirRows + unidentified）为真缺口断言**，由 unit-trend-ledger 事件回放式端到端对账固化（D2 拆分前置安全网） |
| E3 | 装配/E5 | normalizeReportConfig(config)/candidateWindow(schedule)/pendingReports/presetLastRun；ReportScheduler(scheduler)/ReportTaskQueue(tasks)/updateLastRun | 域2公共层（last-run/report-index） | E3⇄E4 共同依赖域2公共层（common/last-run.ts、common/report-index.ts，无状态无缓存防 indexCache 双份）；executor 独立工厂属 E4 |
| E4 | E3 任务/装配 executor | runDueReport(runner)/generateReport(generate)/buildStatsSnapshot/reportBodyToHtml(format)/persistReport/readReportIndex | E2（buckets/dirRows）+ 域2公共层 | LLM 失败不推进 lastRun；注入面=聚合数值+basename；executor 工厂（execute/executor.ts）含错误脱敏契约 |
| E5 | 浏览器 | 10 路由（/trend /health /ui-config /events /report-*6） | E2/E3/E4 | **E5 直连 E2/E3/E4**（routes/ui 直调 trend 查询面；reports 经 ReportConfigService（apply/report-config-service.ts）收口 reportCfg） |

### 2.3 隐藏共享
| 共享 | 位置 | 说明 |
|---|---|---|
| reportCfg 双源 | apply/apply.ts `let reportCfg` + get/set | 内存态+磁盘 config.json 双源（#629 只保 lastRun 串行化）——**已由 ReportConfigService（apply/report-config-service.ts）收口**：内存权威 + per-root 串行写链，并发 update 不交错 |
| lastRunChainByRoot | domain2/common/last-run.ts | per-root 临界区链（D8 归位，无状态无缓存） |
| indexCache | domain2/execute/runner.ts | 读侧投影 stat 记忆化 + `__ForTests` 钩子——**留在 E4 读侧**，common/report-index 不携带缓存（防双份） |
| sseClients / EVENTS_URL | apply/apply.ts + client/core.ts | SSE 死面（客户端零消费，D4 文档化保留） |
| watchedFiles | apply/apply.ts 闭包 | 热更去重 |

---

## 3. 当前目录结构

两级「先域再层」目录化已完成（D9）：`shared/` 为共享底座；域1 与域2 各含
registry/pipeline/history/adapters/routes 与 collect/aggregate/common/schedule/execute/routes；
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