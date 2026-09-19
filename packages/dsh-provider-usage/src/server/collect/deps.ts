/**
 * dsh-provider-usage — server/collect 域依赖声明（#768 D9 注入面）。
 *
 * 本文件是纯类型面（无 import、无运行时代码）：转译后无可杀止变异体，
 * 变异面按 type-only 口径排除（见 mutation-topology.json）；
 * 窄面形状（运行时零出口 + 可装配性）由
 * test/integration/collect/composition-root.test.ts 锁定。
 *
 * 窄面 = 可测接缝三项（宿主能力，无业务实例）：
 * - warn：诊断出口（归属异常告警此出声；默认接线到层错误面，见 apply/apply.ts）；
 * - clock：可注入时钟（TTL 回收的时间源；默认 Date.now）；
 * - resolveCwd：目录归属解析（session id → cwd 原始值或 undefined；
 *   缺省不接 store，目录恒归未识别桶）。
 *
 * 命名接缝与块内联双生子：TrendCollectorOptions 的 warn/now/resolveCwd
 * 保留内联函数类型（与搬迁前逐字一致），不经 import type 引用本文件——
 * 入口 .d.ts 的声明块比较是文本级的，别名一改即漂移（export-surface-snapshot
 * 零漂移证明要求搬迁前后声明块多重集不变）。名称链接由集成测试承载
 * （test/integration/collect/composition-root.test.ts 以
 * CollectWarn/CollectClock/CollectResolveCwd 注解构造 TrendCollector，
 * tsc 编译面校验可赋值性）。
 *
 * 延期未验证（行为冻结，D9 不动；改即停上报）：
 * - resolveCwd 运行时观测后裁决（owner collect，见计划表 rev2 D9）——
 *   per-session 惰性单查缓存语义保持原状，不藉搬迁重定；
 * - 60s 惰性节流扫描与 60min 会话 TTL 算子保持原状（行为锁由
 *   test/integration/collect/composition-root.test.ts 的 D9二线路钉住）。
 *
 * 故本域不设聚合 CollectDeps：接缝随 TrendCollectorOptions 走（构造面本就是
 * 本域形状，由本域提供实现、组合根装配）——聚合体会成为
 * 无消费者的导出（最小导出纪律）。
 */

/** 采集域的诊断出口（本域只用到 warn：归属异常此出声）。 */
export type CollectWarn = (message: string) => void;

/** 采集域的可注入时钟（测试用；默认 Date.now）。 */
export type CollectClock = () => number;

/** 采集域的目录归属解析（session id → cwd 原始值或 undefined；缺省不接 store）。 */
export type CollectResolveCwd = (session: string) => string | undefined;
