/**
 * dsh-provider-usage — server/execute 域依赖声明（#768 D3 注入面）。
 *
 * 本文件是纯类型面（无 import、无运行时代码）：转译后无可杀止变异体，
 * 变异面按 type-only 口径排除（见 mutation-topology.json）；
 * 窄面形状（运行时零出口 + 可装配性）由
 * test/integration/execute/composition-root.test.ts 锁定。
 *
 * 窄面 = 可测接缝两项（宿主能力，无业务实例）：
 * - warn：诊断出口（persist 落盘失败、notify 推送失败此出声；
 *   默认接线到层错误面）；
 * - now：可注入时钟（generatedAt/durationMs 的时间源；默认 Date.now）。
 *
 * 命名接缝与块内联双生子：各块的 Options 保留内联函数类型（与搬迁前逐字一致），
 * 不经 import type 引用本文件——入口 .d.ts 的声明块比较是文本级的，别名一改即
 * 漂移（export-surface-snapshot 零漂移证明要求搬迁前后声明块多重集不变）。
 * 名称链接由集成测试承载（test/integration/execute/composition-root.test.ts 以
 * ExecuteWarn/ExecuteClock 注解构造执行器与调度器，tsc 编译面校验可赋值性）。
 *
 * 源码允许的纯面复用（非实例调用，不经本文件注入）：
 * - server/config 的 ReportConfig 类型 + promptFor 经
 *   server/config/interface.ts 以 type + pure 复用（零 node 依赖的纯函数，
 *   与 D1 “业务域经门面复用纯面”同形）；
 * - server/schedule 的任务类型（ReportTaskInput/ReportTaskResult）经
 *   server/schedule/interface.ts 以 type 复用；per-root 临界区链
 *   （updateLastRun）经同一门面以值复用——链归属调度域（METHOD §3 Q1
 *   有主即止），执行器的推进与路由 preset 共走同一条链，本域不自建第二条链；
 * - server/aggregate 的 metricValue/TrendTracker 与 domain2/collect 的
 *   sumToken/TrendCell/TREND_UNIDENTIFIED/sanitizeDirName 经各自
 *   interface.ts 以 pure + type 复用（零 node 依赖的纯函数与类型，
 *   与 D2 “store 经 common 门面复用纯解析”同形）；
 * - shared 的 dayKey/escHtml 经 shared/interface.ts 直接引用（共享设施不入
 *   注入面，由实现块直接引，与 refactor skill §3 同形）。
 *
 * 能力注入保留在块级（DueExecutorDeps：trend/getReportCfg/historyRoot/
 * sanitizeDiagnostic，类型定义在 executor.ts；GenerateReportOptions.llm：
 * ReportLlmService 窄面，类型定义在 generate.ts）——提到域级需要引入与
 * 各块形状的类型层循环，不值。
 * root 以快照值传递（executor/runner 的 historyRoot 参数：进程内不变，
 * 快照不会过期，与 upgrade 域的 resolveRoot 能力形态不同——后者面对用户改
 * 配置后的即时解析）。
 * ctx.llm 在块级收窄为 ReportLlmService（generate.ts 最小结构面），执行器
 * 不透传完整宿主上下文给生成块。
 * 故本域不设聚合 ExecuteDeps：接缝随块级 Options 走，聚合体会成为
 * 无消费者的导出（最小导出纪律）。
 */

/** 执行域的诊断出口（本域只用到 warn：落盘与推送落差此出声）。 */
export type ExecuteWarn = (message: string) => void;

/** 执行域的可注入时钟（测试用；默认 Date.now）。 */
export type ExecuteClock = () => number;
