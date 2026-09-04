// @ts-nocheck
/**
 * dsh-notifier — 宿主端冒烟测试入口（fake ctx，无网络）。
 *
 * 测试按功能域拆分（#18 方案C），本文件只做顺序聚合——用 await import()
 * 逐个串行求值，单文件职责见各文件头注释：
 *
 * 【为何不能静态 import（#508 回归教训）】静态 import 的「按声明序求值」只保证
 * 求值*启动*顺序：各用例文件大量使用顶层 await（TLA），ESM 规范下无依赖的
 * 兄弟模块在 TLA 挂起时会并发交错求值。两个文件（unit-webhook §④ 与
 * service-contract §⑥）各自替换 globalThis.fetch + finally 恢复，窗口一旦
 * 重叠，先完成者的 finally 会用它捕获的 origFetch 覆盖后装者的 mock——§⑥
 * 的请求遂直打本机真实 bark-server。await import() 强制前一文件完整跑完
 * （含 finally）才轮到下一个，mock 生命周期互不重叠。
 *
 * - unit-config.test.ts     配置归一化 / 免打扰判定（parseHHMM、isInQuietHours）
 * - unit-text.test.ts       文案格式化 / 工具名美化 / 系统命令构造 / loopback 判定
 * - unit-sanitize.test.ts   错误文本脱敏（含性能护栏与 FP 证伪回归）
 * - e2e-approval.test.ts    审批请求通知（waterfall 不短路 / allowKinds 例外）
 * - e2e-done.test.ts        完成状态机 / 错误合并 / 子代理分流 / 风暴聚合
 * - e2e-interrupt.test.ts   中断抑制 S1/S2 与完成判定白名单
 * - e2e-question-turn.test.ts 提问通知（userQuestions 包装）与轮结束通知
 * - routes.test.ts          HTTP 路由（config/events/health/test/history 全套）
 * - client-contract.test.ts 客户端契约与两端路由一致性
 */

// unit：纯函数域
await import("./unit-config.test.ts");
await import("./unit-text.test.ts");
await import("./unit-sanitize.test.ts");
// #515：共享 SSE 枢纽（shared/sse-hub.js 主动回收：stalled/maxAge/上限/观测）
await import("./unit-sse-hub.test.ts");
// #508 M2：webhook 频道（渲染/注入防护/认证头/掩码泛化/配置契约）
await import("./unit-webhook.test.ts");

// e2e：fake ctx + apply
await import("./e2e-approval.test.ts");
await import("./e2e-done.test.ts");
await import("./e2e-interrupt.test.ts");
await import("./e2e-question-turn.test.ts");

// e2e：边缘路径与生命周期清理（#82 批次 4 热点补强）
await import("./e2e-edge.test.ts");

// e2e：真实 cordis Context 形态（#290 C/D/E：未注入访问/事件可达契约/静态契约）
await import("./real-context.test.ts");

// e2e：HTTP 路由 + 两端契约
await import("./routes.test.ts");
await import("./migration.test.ts");
await import("./client-contract.test.ts");
await import("./client-style.test.ts");

// M1：通知中心 service 契约（severity 映射 / send 受理 / 动态 kind 待确认 / 防冒认 / fail-soft）
await import("./service-contract.test.ts");

console.log("dsh-notifier smoke: OK");
