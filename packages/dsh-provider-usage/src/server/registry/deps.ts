/**
 * dsh-provider-usage — server/registry 域依赖声明（#768 D7 注入面）。
 *
 * 本文件是纯类型面（无 import、无运行时代码）：转译后无可杀止变异体，
 * 变异面按 type-only 口径排除（见 mutation-topology.json）；
 * 窄面形状（运行时零出口 + 可装配性）由
 * test/integration/registry/composition-root.test.ts 锁定。
 *
 * 窄面 = 可测接缝两项（宿主能力，无业务实例）：
 * - diag：诊断出口（register 契约拒收与 recordError 登记此出声；
 *   默认接线到 console.warn 前缀通道）；
 * - sanitize：错误登记的路径脱敏出口（recordError 落盘前的绝对路径归约；
 *   默认恒等函数，信息面最小披露由调用方供给）。
 *
 * 命名接缝与块内联双生子：makeAdapterRegistry 的 Options 保留内联函数类型
 * （与搬迁前逐字一致），不经 import type 引用本文件——入口 .d.ts 的声明块比较是
 * 文本级的，别名一改即漂移（export-surface-snapshot 零漂移证明要求搬迁前后声明块
 * 多重集不变）。名称链接由集成测试承载
 * （test/integration/registry/composition-root.test.ts 以
 * RegistryDiag/RegistrySanitize 注解构造注册表，tsc 编译面校验可赋值性）。
 *
 * 源码允许的纯面复用（非实例调用，不经本文件注入）：
 * - shared 的 isUsageStatsAdapter/describeUsageStatsAdapterShape 等契约类型与纯函数经
 *   shared/interface.ts 以 type + pure 复用（零 node 依赖的纯判定，与 D1
 *   “业务域经门面复用纯面”同形）；
 * - shared/dsh-home.js 的 dshHome/userHome 经相对路径直接引用
 *   （path-resolve/provider-config/user-adapters 的家目录接缝，单一事实源承载
 *   DSH_HOME 与用户 home 语义，不经域注入面）；
 * - node:fs/promises 与 node:fs/node:path/node:crypto 是宿主能力
 *   （原子写 tmp+rename 载体、路径解析与取证备份轮转），由实现块直接持有，
 *   不经域注入面；
 * - server/adapters 的 BuiltinRegistryPort 经 server/adapters/deps.ts 以
 *   Pick<AdapterRegistry, "register"> 收窄消费本域注册窄面（反向由消费侧声明，
 *   本域不声明对 adapters 的依赖——依赖方向 registry ← adapters）。
 *
 * 故本域不设聚合 RegistryDeps：接缝随 makeAdapterRegistry Options 走（构造面本就是
 * 本域形状，由本域提供实现、组合根装配）——聚合体会成为
 * 无消费者的导出（最小导出纪律）。
 */

/** 注册表域的诊断出口（本域只用到 warn：契约拒收与错误登记此出声）。 */
export type RegistryDiag = (message: string) => void;

/** 注册表域的路径脱敏出口（错误登记落盘前的绝对路径归约）。 */
export type RegistrySanitize = (s: string) => string;
