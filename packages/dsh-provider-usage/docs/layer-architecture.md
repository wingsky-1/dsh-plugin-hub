# dsh-provider-usage 分层职责与上下游接口契约（两大功能域 · 双专家评审合并版）

> 状态：**契约基线 v4 已定稿**（G2 + 对抗评审 62 分 → 修订 v2 → 双专家评审合并 → 决策表 D1-D16 全部拍板）。
> 用途：分层模型与契约基线；**重构实施方案唯一事实源见 `docs/refactor-implementation-plan.md`**（阶段零→收尾、目录树、文件映射表）。
> 配套图：`docs/diagrams/usage-current-architecture.html`（现状分层）、`docs/diagrams/usage-target-architecture.html`（目标含外部边界），JSON 快照与 visual-check 截图同目录。
> 证据（D14 符号锚约定）：契约引用一律以「文件 · 符号」为准；行号仅为本基线快照 `e64f859` 的证据注释，重构后必然漂移、不再具约束力。

---

## 1. 两大功能域划分

**域边界实证**：域1 业务面（registry/pipeline/adapters/history/stats-service）与域2 业务面（trend/report）之间**零直接 import**（grep 双向零命中）。两域仅经装配层 apply.ts 组合。

> ⚠️ 修订（评审 R1）：**不能声明「两域零依赖」**。真实跨域依赖存在于共享底座与路由层：
> - report/config.ts:17 → trend/types.ts（TREND_DIR_MAX）
> - report/{schedule,runner,generate,format}.ts → charts.ts / trend/aggregator / trend/types
> - routes/ui.ts:9 → stats-service.ts
> 准确表述：**两域业务面零直接依赖**；共享底座（charts/config/contracts 类型）与路由层跨域依赖如实标注。

### 域1 · 适配器取数与胶囊展示框架
| 层 | 职责 | 文件(行数) | 备注 |
|---|---|---|---|
| C1 契约/工具散层 | v2 契约校验/esc/图表工具/配置归一化 | contracts.ts(427)+charts.ts(369)+config.ts(101) | **散层非单层**（R6）：契约/图表/配置三类纯函数；placement-math(39) 是 shared 的包级 re-export 归共享底座 |
| C2 注册/加载层 | 注册表+持久化+热更新+密钥链+路径 | registry(308)+user-adapters(388)+loader(36)+hotreload(141)+path-resolve(79)+provider-config(198) | 四职责经 stats-service 与路由双收口（R2 补 C6 直连） |
| C3 执行管道层 | 取数编排+管道+安全执行 | stats-service(196)+pipeline/v2(252)+guards(132) | 编排/管道/守卫已分文件，内聚成立 |
| C4 历史存储层 | 按天 JSONL/v3 迁移/清理 | core/history(420) | 纯存储 |
| C5 适配器实现层 | 三内置适配器 | adapters/*.mjs(1756) | 自包含零 import；**retention 死字段**（D15） |
| C6 路由层（宿主） | /stats /history /adapters* | routes/stats+adapters(363) | **仅宿主**；客户端单列跨进程 UI 层（R2） |

### 域2 · 事件监听·趋势·报告框架
| 层 | 职责 | 文件(行数) | 备注 |
|---|---|---|---|
| E1 事件采集层 | session/event 折叠状态机 | trend/collector(445)+types(284) | 纯逻辑，now/emit 注入 |
| E2 聚合/压实/存储层 | 双面记账+压实+分片+自愈 | trend/aggregator(1177)+store(254)+index(341) | aggregator 四职责（记账/压实/查询/残差），维持+观测 |
| E3 报告调度层 | 配置归一化+窗口+lastRun+队列 | report/config(456)+schedule(243)+scheduler(222)+tasks(164) | **静态依赖 E4**（scheduler→runner 解析，R3） |
| E4 报告执行/产出层 | 执行接线+LLM 生成+渲染+落盘 | report/runner(305)+generate(420)+format(63) | runner=执行接线器；executor 属装配层闭包非 E4（R3） |
| E5 路由层（宿主） | /trend /report-* /health | routes/ui+reports(515) | **仅宿主** |

### 客户端（跨进程 UI 层，R2 单列）
- 浏览器进程：`src/client/*`（5061 行）——胶囊/面板/设置页五 tab/趋势/报告 UI
- **经 HTTP 消费宿主**（C6/E5 路由），**不 import 宿主运行时**
- 与宿主共享源码契约：contracts/charts/placement-math 等**构建期双端共用同一份源码**（client/core.ts:7、trend-math.ts:9、index.tsx:45），非运行时依赖
- 宿主 inject（index.ts:110）`["webServer","llm","sessions"]` vs 客户端 inject（index.tsx:735）`["locale","sessions","remote","remote.session","slots"]` —— **两码事，勿混**

### 装配层与共享底座
| 组件 | 职责 | 文件 |
|---|---|---|
| 装配层 | 组合两域/16 路由注册/定时器/生命周期 | apply.ts(447)+index.ts(141) |
| 共享底座 | charts/config/sanitize/contracts 类型 + placement-math + shared/* | charts.ts/sanitize.ts/config.ts/placement-math.ts |

---

## 2. 层间上下游接口契约（修订 v2）

### 2.1 域1 契约
| 层 | 上游→ | 对外主契约 | ←下游 | 穿透说明 |
|---|---|---|---|---|
| C1 | 全部层+客户端 | isUsageStatsAdapter(contracts)/esc(contracts)/ADAPTER_UTILS(charts)/normalizeConfig(config)/FetchContext·CapsuleInput·PanelInput | 零内部依赖（charts 不 import contracts 防环；contracts type-only charts 为弱依赖） | — |
| C2 | C3/装配/**C6 路由** | registry.register/select/getEntry/replaceByFile/snapshot；resolveProviderConfig；HotReloadableAdapter；resolveAddAdapterFile(user-adapters)；readAdapterStateResult/writeAdapterState | C1 | **C6 直读 registry**（routes/adapters、stats、ui）——注册表非仅 stats-service 收口（R4）；registry 为公开管理对象，判断面不收口（基线裁定） |
| C3 | C6/装配 | StatsService.getStats/cacheFresh/purge/warmup/scheduleWriteAdapterState；runV2Pipeline(pipeline/v2)；safeFetchData(core/guards，5s 固定)；V2PipelineResult | C2/C4/C5 | **C6 直读写 panelCache**（routes/stats）+ cache.clear（routes/adapters）——D7 裁定：整体下沉为 StatsService.getPanelResult（含 generation 失效与 per-key 单飞）+ purgeAllCaches |
| C4 | C3/C6 | HistoryStore.append/query/last/pruneAll/migrateLegacyV3 | 无 | — |
| C5 | C3 | 三 UsageStatsAdapter 实例（version/name/label/providers/fetchData/formatCapsule/formatPanel；**retention 死字段待删**，收尾阶段） | 无 | — |
| C6 | 浏览器 | 6 路由 loopback；响应形状见现状图/契约表 | C3/C2/C4 | 见上 R4（D7 后仅 registry/history 直读保留） |

### 2.2 域2 契约
| 层 | 上游→ | 对外主契约 | ←下游 | 备注 |
|---|---|---|---|---|
| E1 | 装配(session/event 订阅) | TrendCollector.handleEvent/handleDisposed；emit(call/correct/counter)；sanitizeDirName(types)；TREND_UNIDENTIFIED(types) | E2 | 事件流形状/TTL/done 上限为关键不变量 |
| E2 | E1/装配 | TrendTracker.buckets/dirRows/seriesStacked/dirStacked/windowSummary/dirTotals/stats；TrendStore | E4/**E5 路由直连** | 四不变量：身份快照/防双计/聚合权威/残差归未识别（R8：台账守恒为真缺口断言，阶段三固化） |
| E3 | 装配/E5 | normalizeReportConfig(config)/candidateWindow(schedule)/pendingReports/presetLastRun；ReportScheduler(scheduler)/ReportTaskQueue(tasks)/updateLastRun(scheduler) | 域2公共层（last-run/report-index，D8 归位） | E3⇄E4 共同依赖域2公共层（D8 后）；executor 独立工厂属 E4 |
| E4 | E3 任务/装配 executor | runDueReport(runner)/generateReport(generate)/buildStatsSnapshot/reportBodyToHtml(format)/persistReport/readReportIndex | E2（buckets/dirRows）+ 域2公共层 | LLM 失败不推进 lastRun；注入面=聚合数值+basename；executor 工厂（execute/executor）含错误脱敏契约 |
| E5 | 浏览器 | 10 路由（/trend /health /ui-config /events /report-*6） | E2/E3/E4 | **E5 直连 E2/E3/E4**（routes/ui 直调 trend 查询面；reports 直读写 reportCfg 经闭包——ReportConfigService 收敛，阶段二） |

### 2.3 隐藏共享（R5 补齐）
| 共享 | 位置 | 说明 |
|---|---|---|
| reportCfg 闭包双源 | apply.ts `let reportCfg` + get/set | 内存态+磁盘 config.json 双源，无双写串行化（#629 只保 lastRun）——**ReportConfigService 收敛（阶段二，<50 行复用 per-root 串行链）** |
| lastRunChainByRoot | scheduler.ts 模块级 Map | per-root 临界区链——**D8 移入 domain2/common/last-run.ts（无状态无缓存）** |
| indexCache | runner.ts 模块级 | 读侧投影 stat 记忆化 + `__ForTests` 钩子——**留在 E4 读侧，common/report-index 不携带缓存（防双份）** |
| sseClients / EVENTS_URL | apply.ts + core.ts | SSE 死面（客户端零消费，D4 文档化保留） |
| watchedFiles | apply.ts 闭包 | 热更去重——**目录化时收敛为 apply/hotreload-manager 模块** |

---

## 3. 层职责评审结论（对抗评审 62 分 → 修订项）

### 必须修正（已落地 + 实施裁定）
- **R1** 两域依赖表述精化（业务面零依赖 + 跨域共享如实标注）——已落地
- **R2** C6/E5 只建模宿主路由；客户端单列跨进程 UI 层；宿主/客户端 inject 分列——已落地
- **R3** E3⇄E4 同域双向静态依赖；executor 属装配层闭包——**D8 裁定**：executor 独立工厂归 E4，E3⇄E4 改共同依赖域2公共层
- **R4** 路由直连服务对象内部（panelCache/registry/config/historyRoot）——**D7 裁定**：面板缓存整体下沉（getPanelResult/purgeAllCaches + generation 失效 + per-key 单飞）；registry 判断面不收口（合法下游）
- **R5** 隐藏共享（reportCfg 双源/模块级缓存/SSE 死面）补入模型——已落地 + 阶段二收敛 reportCfg 双源

### 可选修正（讨论项，已裁定）
- **R6** C1 拆「纯工具散层」——**裁定维持散层**：三文件并入 shared/ 目录（C1=共享底座），interface.ts 收口，不拆子目录
- **R7** 单列「宿主↔客户端共享源码契约」——**裁定**：编译期类型对齐断言 + 单一事实源 shape 类型（/events 排除，进 typecheck）
- **R8** aggregator 四不变量固化——**裁定进阶段三**：真缺口仅台账守恒（其余三不变量已被 unit-trend 覆盖），事件回放式端到端断言
- **R9** 装配层 executor 收敛 E4——**裁定做**：独立工厂文件 + 脱敏入契约（D8）

### 评审认可（保留）
C2-C5/E1-E2 层定义准确、C3 三层并一与 E1 纯状态机判断成立、SSE/retention 死面识别正确、行号零编造。

---

## 4. 决策表（D1-D16 最终裁定 · 详见 refactor-implementation-plan.md §3）
| # | 决策项 | 最终裁定 |
|---|---|---|
| D-1 | C2 六文件拆分 | 维持（并入 registry/ 目录） |
| D-2 | aggregator 1177 行拆分 | **拆**（R8 守恒断言 + 阶段零变异网双重前置） |
| D-3 | C3 编排/管道/守卫 | 维持 |
| D-4 | SSE /events 死面 | 文档化保留（backlog） |
| D-5 | contracts/charts 共享 | 物理化 = shared/（C1 底座目录） |
| D-6 | 客户端分层 | 分域保留；客户端拆分本轮不做（D15） |
| D-7 | StatsService 缓存收口 | **做**：整体下沉 + generation 失效 + per-key 单飞 |
| D-8 | executor 收敛 E4 | **做**：独立工厂 + common 归位 + 报告面组合收敛 |
| D-9 | 目录化 + interface.ts | **做**：两级域→层 + 最小面导出；门禁降级 verify-docs 软/硬组合 |
| D-10 | 文件瘦身 | **做**（~400 观察/>600 必裁定；客户端除外） |
| D-11 | 注释清理 | **做**（触碰面同步） |
| D-12 | 变异网阶段零前置 | **做**（安全网先于重构） |
| D-13 | 死面清理独立收尾 PR | **做**（deprecated shim 一版） |
| D-14 | 契约表符号锚 | **做**（行号降为基线证据注释） |
| D-15 | 客户端拆分范围 | 本轮不做（backlog） |
| D-16 | 对外估算 | 8-12 天，内部 1.5-2× |

---

## 5. 现状 vs 目标（图索引）
- 现状分层：`docs/diagrams/usage-current-architecture.html`（域1 七层 + 域2 六层 + 装配）
- 目标（含外部边界）：`docs/diagrams/usage-target-architecture.html`（+ 浏览器客户端/用户自定义适配器/远端 API/dsh 宿主运行时 四外部角色）
- 两图均 validate 9/9、deliver 冻结、visual-check 四视口无溢出（基线 e64f859 快照）
- **重构实施方案**：`docs/refactor-implementation-plan.md`（阶段零→收尾、目录树、文件映射表、跟踪 issue）
