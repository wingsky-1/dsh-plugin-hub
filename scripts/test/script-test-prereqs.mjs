#!/usr/bin/env node
/**
 * scripts/test/script-test-prereqs.mjs — `test:scripts` 里依赖**编译产物**的用例前置包清单
 * （#722 门禁分层）。
 *
 * 为什么单列：PR 侧改为按改动切片构建后，repo-gate 不再保证全仓 lib 产物齐备；而
 * `service-contract-wiring.test.ts` 用仓库 tsc 真实编译契约测试文件，需要这些包的
 * **声明产物**（`lib/index.d.ts` 等）。CI（repo-gate 构建步骤）与本地门禁
 * （`scripts/gate/local-gate.mjs`）都从本清单读取，避免「少建一个包 → 门禁假红」这类
 * 只能靠人记住的耦合。
 *
 * 不变式：`service-contract-wiring.test.ts` 的 SUITES（#845 起 = 磁盘上有
 * test/tsconfig.json 的包）必须被本清单覆盖——该用例自带断言，新增编译面套件却忘记
 * 登记时会在 test:scripts 内判红（fail-closed）。
 *
 * 成员由「是否被某个 SUITES 接线」决定，不由「是否真的读 lib 产物」决定：
 * dsh-lan-proxy / dsh-provider-usage 的 test/tsconfig.json 只引 src、不需要产物，
 * dsh-worktree-sidebar 同理，三者都必须登记——断言上看不出这个差异，漏登就是红。
 * 多建几个包是这里刻意接受的成本。
 */
export const PREREQ_PACKAGES = [
  "dsh-decision-gateway",
  "dsh-lan-proxy",
  "dsh-mcp-manager",
  "dsh-notifier",
  "dsh-provider-usage",
  "dsh-worktree-sidebar",
];
