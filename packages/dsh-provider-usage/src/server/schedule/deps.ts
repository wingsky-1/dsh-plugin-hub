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
 * - server/execute 的 parseReportIndexLines 经本文件 ScheduleIndexParser
 *   端口注入（C 波：store.ts 不再直引 execute 门面；纯函数实现由组合根
 *   装配期传入；#768 B1 起 execute→schedule 的 updateLastRun 值边亦清零
 *   （执行器经 DueExecutorDeps.advanceLastRun 注入能力），跨域值边归零）；
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

/**
 * 调度域 index 解析端口（C 波）：execute 域 parseReportIndexLines 的窄面
 * （纯函数，无状态无缓存；输入 index.jsonl 全文，输出推导最小记录）。
 *
 * 内联结构双生子（不 import type 引 due.ts／execute 门面，本文件保持零
 * import、转译零运行时出口）：记录形状与 due.ts LastRunRecord 同构，
 * execute 侧 ReportMeta 向上兼容（字段只多不少）；双向可赋值性由
 * test/integration/schedule/composition-root.test.ts 以 tsc 编译面锁定
 * （端口接真实现、输出喂 deriveLastRun／alignLastRun）。
 */
export type ScheduleIndexParser = (raw: string) => Array<{
  period: "daily" | "weekly" | "monthly";
  key: string;
  generatedAt: number;
  endDay: string;
  ok: boolean;
}>;

/** 调度域的诊断出口（本域只用到 warn：版本落差与调度动作此出声）。 */
export type ScheduleWarn = (message: string) => void;

/** 调度域的可注入时钟（测试用；默认 Date.now）。 */
export type ScheduleClock = () => number;
