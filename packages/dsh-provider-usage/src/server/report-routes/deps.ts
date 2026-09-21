/**
 * dsh-provider-usage — server/report-routes 域依赖声明（#768 D11 注入面）。
 *
 * 本文件是纯类型面（import type 零运行时）：转译后无可杀止变异体，
 * 变异面按 type-only 口径排除（routes 段 excludes 已含 server 各域 deps.ts）；
 * 窄面形状（运行时零出口 + 可装配性）由
 * test/integration/report-routes/composition-root.test.ts 锁定。
 *
 * 窄面 = 本域真正消费的两个能力（宿主装配递实例，域内只见窄口）：
 * - reportCfg：配置服务的读 + 写（GET 读内存权威/磁盘兜底，
 *   POST 归一化后串行写盘 + 内存 + scheduler 热更；默认接线到组合根构造的
 *   ReportConfigService，见 apply/apply.ts）；
 * - reportQueue：任务队列的提交 + 查询（POST /generate 入队去重，
 *   GET /status 轮询；默认接线到组合根构造的 ReportTaskQueue）。
 *
 * 命名接缝直引（非双生子）：context 字段经 import type 引用本面端口——
 * ReportRoutesContext 不进包导出面（handleReportStatus 已退役入口转发，白盒直连域门面），
 * 端口别名不触及 export-surface-snapshot 的逐入口过滤比对（该门禁只比
 * 各入口导出符号名的声明块多重集），故单一定義无漂移；名称链接由集成测试承载
 * （test/integration/report-routes/composition-root.test.ts 以
 * ReportRoutesConfigPort/ReportRoutesQueuePort 注解构造路由 context，
 * tsc 编译面校验可赋值性 + 窄面桩跑全 handler 证明只触窄口）。
 *
 * 源码允许的纯面复用（非实例调用，不经本文件注入）：
 * - server/config 的 ReportPeriod/ReportPrompts/ReportConfig 类型经
 *   server/config/interface.ts 以 type 复用；归一化/磁盘读/默认表经
 *   ReportRoutesContext 注入（组合根供给，#768 B2 值边清零）；
 * - server/schedule 的窗口/幂等纯函数（presetLastRunForNewlyEnabled/
 *   previousClosedWindow）+ lastRun 读写（readLastRun/updateLastRun）经
 *   ReportRoutesContext 注入（#768 B1：本域不直引 schedule 门面值边，值边
 *   清零；纯函数不下沉 shared，DueReport 语义留调度域；per-root 临界区链归属
 *   调度域，路由 preset 与执行器推进共走同一条链，本域不自建第二条链）；
 * - server/execute 的读面（readReportIndex/reportHtmlFile/reportMetaFile）经
 *   ReportRoutesContext 只读查询闭包注入（幂等短路与详情落盘读，#768 B2 值边清零；
 *   类型经 server/execute/interface.ts 以 type 复用，实例不直引）；
 * - shared 的 guardLoopbackMethod/readJsonBodyOutcome/writeJson 经
 *   shared/host-utils.js 直接引用，sanitizeHtml 经 shared/interface.ts 直接
 *   引用（共享设施不入注入面，由实现块直接引，与 refactor skill §3 同形）；
 * - cordis Context（ctx.llm.listProviders/listModels 宿主模型清单与发现）
 *   经 ReportRoutesContext.ctx 透传（组合根已注入的宿主上下文，不在域级收窄——
 *   提到域级需要引入宿主类型层循环，不值，与 execute 域块级收窄同理）。
 *
 * 执行器不进本域注入面：队列的 executor（幂等下沉/生成/lastRun 推进/脱敏）
 * 由 server/execute 的 makeDueReportExecutor 提供实现、经
 * ReportTaskQueueOptions.executor 在块级注入、组合根装配——本域只经队列的
 * submit/get 消费执行（提到域级需要引入与 tasks 形状的类型层循环，不值，
 * 与 execute 域 DueExecutorDeps 留块级同理）。
 * root 以快照值传递（historyRoot：进程内不变，快照不会过期，与 upgrade 域的
 * resolveRoot 能力形态不同——后者面对用户改配置后的即时解析）。
 * 故本域不设聚合 ReportRoutesDeps：接缝随 context 两窄口走（构造面本就是
 * 本域形状，由本域提供实现、组合根装配）——聚合体会成为
 * 无消费者的导出（最小导出纪律）。
 */
import type { ReportConfigService } from "../config/interface.ts";
import type { ReportTaskQueue } from "../schedule/interface.ts";

/** 报告路由域的配置服务窄口（读内存权威 + 串行写盘 + 热更回调 + 默认模板表）。 */
export type ReportRoutesConfigPort = Pick<ReportConfigService, "get" | "update" | "promptDefaults">;

/** 报告路由域的任务队列窄口（提交去重 + 状态查询）。 */
export type ReportRoutesQueuePort = Pick<ReportTaskQueue, "submit" | "get">;
