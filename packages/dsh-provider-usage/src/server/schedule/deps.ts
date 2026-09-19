/**
 * dsh-provider-usage — server/schedule 域依赖声明（#768 D2 注入面）。
 *
 * 本文件是纯类型面（无 import、无运行时代码）：转译后无可杀止变异体，
 * 变异面按 type-only 口径排除（见 mutation-topology.json）；
 * 窄面形状（运行时零出口 + 可装配性）由
 * test/integration/schedule/composition-root.test.ts 锁定。
 *
 * 窄面 = 可测接缝两项（宿主能力，无业务实例）：
 * - warn：诊断出口（scheduler tick 异常/提交失败、队列任务失败、
 *   store 校准落差此出声；默认接线到层错误面）；
 * - now：可注入时钟（tick/去重修剪的时间源；默认 Date.now）。
 *
 * 命名接缝与块内联双生子：三块的 Options 保留内联函数类型（与搬迁前逐字一致），
 * 不经 import type 引用本文件——入口 .d.ts 的声明块比较是文本级的，别名一改即
 * 漂移（export-surface-snapshot 零漂移证明要求搬迁前后声明块多重集不变）。
 * 名称链接由集成测试承载（test/integration/schedule/composition-root.test.ts 以
 * ScheduleWarn/ScheduleClock 注解构造调度器与队列，tsc 编译面校验可赋值性）。
 *
 * 源码允许的纯面复用（非实例调用，不经本文件注入）：
 * - server/config 的 ReportConfig 类型 + parseHHMM 经
 *   server/config/interface.ts 以 type + pure 复用（零 node 依赖的纯函数，
 *   与 D1 “业务域经门面复用纯面”同形）；
 * - domain2/common 的 parseReportIndexLines 经 domain2/common/interface.ts
 *   以纯解析复用（无状态无缓存；store.ts 唯一跨域值导入）；
 * - shared 的 dayKey 经 shared/interface.ts 直揕引用（共享设施不入
 *   注入面，由实现块直接引，与 refactor skill §3 同形）。
 *
 * 执行器注入保留在块级（ReportTaskQueueOptions.executor，
 * 类型定义在 tasks.ts：输入/结果形状本就是本域形状，
 * 由 execute 域的 makeDueReportExecutor 提供实现、组合根装配）——
 * 提到域级需要引入与 tasks 形状的类型层循环，不值。
 * root 以快照值传递（scheduler/store/executor 的 root 参数：
 * historyRoot 在进程内不变，快照不会过期，与 upgrade 域的
 * resolveRoot 能力形态不同——后者面对用户改配置后的即时解析）。
 * 故本域不设聚合 ScheduleDeps：接缝随块级 Options 走，聚合体会成为
 * 无消费者的导出（最小导出纪律）。
 */

/** 调度域的诊断出口（本域只用到 warn：版本落差与调度动作此出声）。 */
export type ScheduleWarn = (message: string) => void;

/** 调度域的可注入时钟（测试用；默认 Date.now）。 */
export type ScheduleClock = () => number;
