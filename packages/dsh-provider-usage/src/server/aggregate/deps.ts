/**
 * dsh-provider-usage — server/aggregate 域依赖声明（#768 D8 注入面）。
 *
 * 本文件是纯类型面（无 import、无运行时代码）：转译后无可杀止变异体，
 * 变异面按 type-only 口径排除（见 mutation-topology.json）；
 * 窄面形状（运行时零出口 + 可装配性）由
 * test/integration/aggregate/composition-root.test.ts 锁定。
 *
 * 窄面 = 可测接缝三项（宿主能力，无业务实例）：
 * - warn：诊断出口（压实失败/刷盘失败/归属异常此出声；
 *   默认接线到层错误面，见 apply/apply.ts）；
 * - clock：可注入时钟（dayKey/序列锚点的时间源；默认 Date.now）；
 * - resolveCwd：目录归属解析（session id → cwd 原始值或 undefined；
 *   缺省不接 store，目录恒归未识别桶）。
 *
 * 命名接缝与块内联双生子：TrendTrackerOptions 的 warn/now/resolveCwd/makeCollector
 * 保留内联函数类型（与搬迁前逐字一致），不经 import type 引用本文件——
 * 入口 .d.ts 的声明块比较是文本级的，别名一改即漂移（export-surface-snapshot
 * 零漂移证明要求搬迁前后声明块多重集不变）。名称链接由集成测试承载
 * （test/integration/aggregate/composition-root.test.ts 以
 * AggregateWarn/AggregateClock/AggregateResolveCwd 注解构造 TrendTracker，
 * tsc 编译面校验可赋值性）。
 *
 * 源码允许的纯面复用（非实例调用，不经本文件注入）：
 * - shared 的 dayKey/lastNDayKeys 经 shared/interface.ts 直接引用
 *   （共享设施不入注入面，由实现块直接引，与 refactor skill §3 同形）；
 * - server/collect 的 TrendCollector 有状态类经 TrendTrackerOptions.makeCollector
 *   注入（#768 B1：本域不直引 collect 门面值边，值边清零；组合根装配）；
 *   纯面（sumToken/hourOfDay/TREND_*）A 波已下沉 server/shared，本域经
 *   server/shared 门面复用；行类型与事件类型经 server/collect 门面以 type
 *   复用（值边清零）；TREND_ROW_VERSION/TREND_UNIDENTIFIED/
 *   isValidShardRow 与行类型经 server/collect/interface.ts 以 pure + type
 *   复用（零 node 依赖的纯函数与类型，与 D3 “execute 经门面复用纯面”同形；
 *   #768 D9 整域迁入（旧址在 domain2 采集目录），#768 B1 值边清零）；
 * - node:fs/promises 与 node:path 是宿主能力（分片落盘 tmp+rename 载体与
 *   路径拼接），由实现块直接持有，不经域注入面。
 *
 * 延期未验证（行为冻结，D8 不动；改即停上报）：
 * - resolveCwd 运行时观测后裁决（owner collect，见计划表 rev2 D9）——
 *   per-session 惰性单查缓存语义保持原状，不藉搬迁重定；
 * - A4(g) 量级留痕（1000 事件 / 5 session，cwd 恰 5 查）——耗时基线只注明
 *   取数时点，不跨机 ratify；
 * - store 多错语义（tmp 残留清理 allSettled + 全量 warn，主写照常推进）冻结——
 *   另立行为评审，任何改动即停上报。
 *
 * 故本域不设聚合 AggregateDeps：接缝随 TrendTrackerOptions 走（构造面本就是
 * 本域形状，由本域提供实现、组合根装配）——聚合体会成为
 * 无消费者的导出（最小导出纪律）。
 */

/** 聚合域的诊断出口（本域只用到 warn：压实/刷盘/归属异常此出声）。 */
export type AggregateWarn = (message: string) => void;

/** 聚合域的可注入时钟（测试用；默认 Date.now）。 */
export type AggregateClock = () => number;

/** 聚合域的目录归属解析（session id → cwd 原始值或 undefined；缺省不接 store）。 */
export type AggregateResolveCwd = (session: string) => string | undefined;
