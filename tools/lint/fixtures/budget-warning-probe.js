/**
 * 预算警告探针（#764 A2）：非忽略文件的结构性 warning 来源。
 *
 * 行内把 no-var 降为 warn（其余规则不动），单文件恰好 0 error + 1 warning，用于实跑
 * lint.mjs 的 problems>budget 分支（--max-warnings=0 即超预算 exit 1 且报超出预算）。
 * 不被 pnpm lint 默认面覆盖（tools/lint/fixtures 不在入口 glob 内），不参与构建与测试面。
 * 计数变更须同步改 lint-toolchain.test.ts 的预算断言；禁止绑定业务文件存量数。
 */
/* eslint no-var: warn */
var budgetWarningProbe = 1;
export { budgetWarningProbe };
