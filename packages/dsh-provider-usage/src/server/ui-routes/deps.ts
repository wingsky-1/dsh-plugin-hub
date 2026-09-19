/**
 * dsh-provider-usage — server/ui-routes 域依赖声明（#768 D12 注入面）。
 *
 * 本文件是纯类型面（import type 零运行时）：转译后无可杀止变异体，
 * 变异面按 type-only 口径排除（routes 段 excludes 已含 server 各域 deps.ts）；
 * 窄面形状（运行时零出口 + 可装配性）由
 * test/integration/ui-routes/composition-root.test.ts 锁定。
 *
 * 窄面 = 可测接缝一项（宿主能力，无业务实例）：
 * - broadcast：ui-config 保存后的 SSE 扇出（POST /ui-config 成功后向 sseClients
 *   广播 ui-config-changed；默认接线到 apply 的 broadcastUiConfigChanged 闭包，
 *   见 apply/apply.ts）。
 *
 * 命名接缝与块内联双生子：UiRoutesContext 的 broadcastUiConfigChanged 保留内联
 * 函数类型（与搬迁前逐字一致），不经 import type 引用本文件——入口 .d.ts
 * 的声明块比较是文本级的，别名一改即漂移（export-surface-snapshot
 * 零漂移证明要求搬迁前后声明块多重集不变）。名称链接由集成测试承载
 * （test/integration/ui-routes/composition-root.test.ts 以
 * UiRoutesBroadcast 注解广播缝，tsc 编译面校验可赋值性）。
 *
 * 源码允许的纯面复用（非实例调用，不经本文件注入）：
 * - server/pipeline 的 StatsService 与 server/aggregate 的 TrendTracker 经两域
 *   interface.ts 以 type 复用（UiRoutesContext 的 statsService/trend 字段；
 *   实例只由组合根构造、经参数传递，与 D6 “业务域经门面复用读面”同形）；
 * - server/collect 的 TREND_DIR_MAX 经 server/collect/interface.ts 以值复用
 *   （目录范围口径与数据层同源；标识符常量在值层存在、类型表达不了它，
 *   故走门面复用而非注入，与 server/config|server/collect 边同形，
 *   边 server/ui-routes|server/collect，见 gate-exemptions 长期条目）；
 * - server/shared 的 LayerErrorSurface 经 server/shared/interface.ts 以 type
 *   复用（health per-layer 段数据源；实例由组合根构造、经参数传递）；
 * - shared 的 guardLoopbackMethod/readJsonBodyOutcome/writeJson 经
 *   shared/host-utils.js 直接引用，ADAPTER_CONTRACT_VERSION/normalizeUiConfig/
 *   writeUiConfig/UiPlacementConfig 经 shared/interface.ts 直接引用
 *   （共享设施不入注入面，由实现块直接引，与 refactor skill §3 同形）；
 * - root 以快照值传递（historyRoot：进程内不变，快照不会过期，与 upgrade 域的
 *   resolveRoot 能力形态不同——后者面对用户改配置后的即时解析）。
 *
 * 故本域不设聚合 UiRoutesDeps：接缝随 UiRoutesContext 走（构造面本就是
 * 本域形状，由本域提供实现、组合根装配）——聚合体会成为
 * 无消费者的导出（最小导出纪律）。
 */

/** UI 路由域的 SSE 广播出口（POST /ui-config 成功后向存活客户端扇出变更帧）。 */
export type UiRoutesBroadcast = () => void;
