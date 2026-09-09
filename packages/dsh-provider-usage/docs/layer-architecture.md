# dsh-provider-usage 分层职责与上下游接口契约（两大功能域 · 对抗评审修订版）

> 状态：分层建模 + 契约梳理（G2 通过 + 对抗评审 62 分 → 修订 v2）。**尚未进入实施**。
> 用途：作为「重构为目标架构」讨论的基线文档（下会话以此为输入）。
> 配套图：`docs/diagrams/usage-current-architecture.html`（现状分层）、`docs/diagrams/usage-target-architecture.html`（目标含外部边界），JSON 快照与 visual-check 截图同目录。
> 证据：全部接口签名带 文件:行号，经代码核对 + 独立子代理对抗评审交叉验证；评审 5 项核心指控全部复核属实。

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
| C1 | 全部层+客户端 | isUsageStatsAdapter(contracts:134)/esc(:120)/ADAPTER_UTILS(charts:356)/normalizeConfig(config:77)/FetchContext·CapsuleInput·PanelInput | 零内部依赖（charts 不 import contracts 防环；contracts:12 type-only charts 为弱依赖） | — |
| C2 | C3/装配/**C6 路由** | registry.register(:104)/select(:160)/getEntry(:140)/replaceByFile(:256)/snapshot(:187)；resolveProviderConfig(:97)；HotReloadableAdapter；resolveAddAdapterFile(user-adapters:362)；readAdapterStateResult/writeAdapterState(:224/:322) | C1 | **C6 直读 registry**（routes/adapters:27/84、stats:69、ui:39）——注册表非仅 stats-service 收口（R4） |
| C3 | C6/装配 | StatsService.getStats(:139)/cacheFresh(:65)/purge/warmup/scheduleWriteAdapterState；runV2Pipeline(v2:65)；safeFetchData(guards:24 5s 固定)；V2PipelineResult | C2/C4/C5 | **C6 直读写 panelCache**（routes/stats:93/107/117）+ cache.clear（routes/adapters:87/177）——StatsService 缺全清/面板读写公开方法，接口不完整诱发（R4 结构债 P2） |
| C4 | C3/C6 | append(:54)/query(:81)/last(:106)/pruneAll(:189)/migrateLegacyV3(:353) | 无 | — |
| C5 | C3 | 三 UsageStatsAdapter 实例（version/name/label/providers/fetchData/formatCapsule/formatPanel；**无 retention**） | 无 | — |
| C6 | 浏览器 | 6 路由 loopback；响应形状见现状图/契约表 | C3/C2/C4 | 见上 R4 |

### 2.2 域2 契约
| 层 | 上游→ | 对外主契约 | ←下游 | 备注 |
|---|---|---|---|---|
| E1 | 装配(session/event 订阅) | TrendCollector.handleEvent(:227)/handleDisposed(:263)；emit(call/correct/counter)；sanitizeDirName(types:71)；TREND_UNIDENTIFIED(:31) | E2 | 事件流形状/TTL/done 上限为关键不变量 |
| E2 | E1/装配 | TrendTracker.buckets(:274)/dirRows(:282)/seriesStacked(:313)/dirStacked(:287)/windowSummary(:327)/dirTotals(:308)/stats(:338)；TrendStore | E4/**E5 路由直连** | 四不变量：身份快照/防双计/聚合权威/残差归未识别（R8 建议固化断言） |
| E3 | 装配/E5 | normalizeReportConfig(config:382)/candidateWindow(schedule:76)/pendingReports(:202)/presetLastRun(:228)；ReportScheduler(scheduler:180)/ReportTaskQueue(tasks:91)/updateLastRun(scheduler:82) | E4（静态依赖 runner 解析，scheduler:14） | E3⇄E4 同域双向静态依赖（R3）；executor 是 apply.ts:316-335 闭包 |
| E4 | E3 任务/装配 executor | runDueReport(runner:165)/generateReport(generate:213)/buildStatsSnapshot(:276)/reportBodyToHtml(format:32)/persistReport(:147)/readReportIndex(:272) | E2（buckets/dirRows） | LLM 失败不推进 lastRun；注入面=聚合数值+basename |
| E5 | 浏览器 | 10 路由（/trend /health /ui-config /events /report-*6） | E2/E3/E4 | **E5 直连 E2/E3/E4**（routes/ui:104-111 直调 trend 查询面；reports 直读写 reportCfg 经闭包） |

### 2.3 隐藏共享（R5 补齐）
| 共享 | 位置 | 说明 |
|---|---|---|
| reportCfg 闭包双源 | apply.ts:310 `let reportCfg` + :397-398 get/set | 内存态+磁盘 config.json 双源，无双写串行化（#629 只保 lastRun） |
| lastRunChainByRoot | scheduler.ts:80 模块级 Map | per-root 临界区链 |
| indexCache | runner.ts:36 模块级 | 读侧投影 stat 记忆化 + `__ForTests` 钩子 |
| sseClients / EVENTS_URL | apply.ts:362 + core.ts:26 | SSE 死面（客户端零消费） |
| watchedFiles | apply.ts:102 闭包 | 热更去重 |

---

## 3. 层职责评审结论（对抗评审 62 分 → 修订项）

### 必须修正（已在本文档落地）
- **R1** 两域依赖表述精化（业务面零依赖 + 跨域共享如实标注）
- **R2** C6/E5 只建模宿主路由；客户端单列跨进程 UI 层；宿主/客户端 inject 分列
- **R3** E3⇄E4 同域双向静态依赖；executor 属装配层闭包
- **R4** 路由直连服务对象内部（panelCache/registry/config/historyRoot）如实标注为结构债——根因 StatsService 缺面板缓存 get/set/全清方法
- **R5** 隐藏共享（reportCfg 双源/模块级缓存/SSE 死面）补入模型

### 可选修正（讨论项，未落地）
- R6 C1 拆「纯工具散层」或按依赖分组（本文档已按散层描述，文件未动）
- R7 单列「宿主↔客户端共享源码契约」（已在 §1 客户端节简述）
- R8 aggregator 四不变量固化为文档化断言（进 TDD 阶段）
- R9 装配层 executor 收敛 E4 观察项（apply 只留 queue.submit）

### 评审认可（保留）
C2-C5/E1-E2 层定义准确、C3 三层并一与 E1 纯状态机判断成立、SSE/retention 死面识别正确、行号零编造。

---

## 4. 决策表（供下会话重构讨论拍板）
| # | 决策项 | 候选 | 推荐 | 依据 |
|---|---|---|---|---|
| D-1 | C2 六文件拆分 | 维持 | 依赖单向后收口，拆增装配面 |
| D-2 | aggregator 1177 行拆分 | 维持+观测 | 强内聚；拆须先固化四不变量 |
| D-3 | C3 编排/管道/守卫 | 维持 | 已分文件职责互补 |
| D-4 | SSE /events 死面 | 移除或文档化 | 客户端零消费，声明错位 |
| D-5 | contracts/charts 共享 | 维持包内 | 纯契约零副作用 |
| D-6 | C6/C7 客户端分层 | 分域保留 | 与宿主层对应 |
| D-7 | StatsService 缓存方法补齐 | **重构候选** | R4 根因：接口不完整诱发路由穿透 |
| D-8 | executor 收敛 E4 | 观察项 | R9，防装配层上帝化 |

---

## 5. 现状 vs 目标（图索引）
- 现状分层：`docs/diagrams/usage-current-architecture.html`（域1 七层 + 域2 六层 + 装配）
- 目标（含外部边界）：`docs/diagrams/usage-target-architecture.html`（+ 浏览器客户端/用户自定义适配器/远端 API/dsh 宿主运行时 四外部角色）
- 两图均 validate 9/9、deliver 冻结、visual-check 四视口无溢出
