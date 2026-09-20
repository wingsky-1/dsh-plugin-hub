/**
 * lint 收缩棘轮（#764 A5）synthetic 探针固件：刻意保留 2 处未使用变量。
 *
 * 只为 scripts/test/lint-toolchain.test.ts 的三档断言提供稳定、可数的 error
 * 发现数；不被 pnpm lint 默认面覆盖（仓根零散文件不在 lint 入口 glob 内），
 * 不参与任何构建与测试面。计数变更须同步改测试内三档期望；禁止把计数重新
 * 绑定到业务文件的存量数（v1 退役 #932 裁决）。
 */
const probeUnusedAlpha = 1;
const probeUnusedBeta = 2;
export {};
