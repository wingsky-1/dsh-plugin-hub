/**
 * dsh-provider-usage — server/pipeline 域依赖声明（#768 D6 注入面）。
 *
 * 本文件是纯类型面（无 import、无运行时代码）：转译后无可杀止变异体，
 * 变异面按 type-only 口径排除（见 mutation-topology.json）；
 * 窄面形状（运行时零出口 + 可装配性）由
 * test/integration/pipeline/composition-root.test.ts 锁定。
 *
 * 窄面 = 可测接缝两项（宿主能力，无业务实例）：
 * - sanitize：诊断出口的净化函数（scheduleWriteAdapterState 落盘前的诊断脱敏与
 *   错误落差的净化出口；默认接线到 shared 净化面）；
 * - diagnose：适配器状态诊断记录出口（读旧状态失败与写合并的诊断记录；
 *   默认接线到层错误面）。
 *
 * 命名接缝与块内联双生子：StatsServiceOptions 的 sanitizeDiagnostic /
 * recordAdapterStateDiagnostic 保留内联函数类型（与搬迁前逐字一致），
 * 不经 import type 引用本文件——入口 .d.ts 的声明块比较是文本级的，别名一改即
 * 漂移（export-surface-snapshot 零漂移证明要求搬迁前后声明块多重集不变）。
 * 名称链接由集成测试承载（test/integration/pipeline/composition-root.test.ts 以
 * PipelineSanitize/PipelineDiagnose 注解构造 StatsService，tsc 编译面校验可赋值性）。
 *
 * 源码允许的纯面复用（非实例调用，不经本文件注入）：
 * - shared 的 sanitizeHtml/esc/ADAPTER_UTILS 经 shared/interface.ts
 *   直接引用（先转义后清洗双层：format 入参带 esc 转义、输出必经
 *   sanitizeHtml 净化；清洗失败即 fail-closed 由 sanitize.ts 自证，
 *   本域只保证「不缺席」——缺席必须红，见 D6二）；
 * - server/history 的 HistoryStore 经 server/history/interface.ts 以 type
 *   复用（v2.ts 的 Pick<HistoryStore, "last"> 与统计服务的 HistoryStore
 *   整体类型；实例只由组合根构造、经 StatsServiceOptions 传入）；
 * - server/registry 的 AdapterRegistry 类型经 server/registry/interface.ts
 *   以 type 复用；模型配置与适配器状态读写经实例方法调用（同域收口后
 *   #768 B2 值边清零，实例只由组合根构造、经 StatsServiceOptions 传入）；
 * - node:fs/promises 与 async-mutex 是宿主能力（原子写 tmp+rename 载体与
 *   per-provider 互斥），由实现块直接持有，不经域注入面。
 *
 * 故本域不设聚合 PipelineDeps：接缝随 StatsServiceOptions 走（构造面本就是
 * 本域形状，由本域 StatsService 提供实现、组合根装配）——聚合体会成为
 * 无消费者的导出（最小导出纪律）。
 */

/** 管线域的诊断净化出口（落盘前脱敏与错误落差的净化函数）。 */
export type PipelineSanitize = (s: string) => string;

/** 管线域的诊断记录出口（适配器状态读写的诊断记录）。 */
export type PipelineDiagnose = (message: string) => void;
