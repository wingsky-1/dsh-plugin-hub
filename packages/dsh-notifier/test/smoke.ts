// @ts-nocheck
/**
 * dsh-notifier — 宿主端冒烟测试入口（fake ctx，无网络）。
 *
 * 测试按功能域拆分（#18 方案C），本文件只做顺序聚合——ESM 按声明序
 * 求值，各用例文件的顶层断言依序执行；单文件职责见各文件头注释：
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
import "./unit-config.test.ts";
import "./unit-text.test.ts";
import "./unit-sanitize.test.ts";

// e2e：fake ctx + apply
import "./e2e-approval.test.ts";
import "./e2e-done.test.ts";
import "./e2e-interrupt.test.ts";
import "./e2e-question-turn.test.ts";

// e2e：边缘路径与生命周期清理（#82 批次 4 热点补强）
import "./e2e-edge.test.ts";

// e2e：HTTP 路由 + 两端契约
import "./routes.test.ts";
import "./client-contract.test.ts";

console.log("dsh-notifier smoke: OK");
