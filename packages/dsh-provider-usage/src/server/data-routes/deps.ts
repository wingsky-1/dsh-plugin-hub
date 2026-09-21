/**
 * dsh-provider-usage — server/data-routes 域依赖声明（#768 D10 注入面）。
 *
 * 本文件是纯类型面（无 import、无运行时代码）：转译后无可杀止变异体，
 * 变异面按 type-only 口径排除（routes 段 excludes 已含 server 各域 deps.ts）；
 * 窄面形状（运行时零出口 + 可装配性）由
 * test/integration/data-routes/composition-root.test.ts 锁定。
 *
 * 窄面 = 可测接缝一项（宿主能力，无业务实例）：
 * - ensureHotReload：用户适配器登记后的热更新装配（POST /adapters/add 成功后
 *   对新文件起监视；默认接线到 apply 的 makeHotReloadManager，见 apply/apply.ts）。
 *
 * 命名接缝与块内联双生子：AdapterRoutesContext 的 ensureHotReload 保留内联
 * 函数类型（与搬迁前逐字一致），不经 import type 引用本文件——入口 .d.ts
 * 的声明块比较是文本级的，别名一改即漂移（export-surface-snapshot
 * 零漂移证明要求搬迁前后声明块多重集不变）。名称链接由集成测试承载
 * （test/integration/data-routes/composition-root.test.ts 以
 * DataRoutesEnsureHotReload 注解构造适配器路由，tsc 编译面校验可赋值性）。
 *
 * 源码允许的纯面复用（非实例调用，不经本文件注入）：
 * - server/pipeline 的 StatsService 经 server/pipeline/interface.ts 以 type
 *   复用（两 context 的 statsService 字段；实例只由组合根构造、经参数传递，
 *   与 D6 “业务域经门面复用读面”同形）；
 * - server/registry 的 UserAdapterRecord 类型经 server/registry/interface.ts
 *   以 type 复用；加载校验与路径准入经 AdapterRoutesContext 注入
 *   （组合根已绑定 registry 实例，#768 B2 值边清零）；
 * - shared 的 guardLoopbackMethod/readJsonBodyOutcome/writeJson 经
 *   shared/host-utils.js 直接引用，ADAPTER_CONTRACT_VERSION 经
 *   shared/interface.ts 直接引用（共享设施不入注入面，由实现块直接引，
 *   与 refactor skill §3 同形）；
 * - cordis Context（ctx.llm.listProviders 宿主模型清单）经
 *   AdapterRoutesContext.ctx 透传（组合根已注入的宿主上下文，不在域级收窄——
 *   提到域级需要引入宿主类型层循环，不值，与 execute 域块级收窄同理）。
 *
 * 故本域不设聚合 DataRoutesDeps：接缝随两 context 走（构造面本就是
 * 本域形状，由本域提供实现、组合根装配）——聚合体会成为
 * 无消费者的导出（最小导出纪律）。
 */

/** 数据路由域的热更新装配出口（POST /adapters/add 成功后对新文件起监视）。 */
export type DataRoutesEnsureHotReload = (file: string) => Promise<void>;
