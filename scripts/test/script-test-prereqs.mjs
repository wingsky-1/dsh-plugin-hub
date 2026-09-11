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
 * 不变式：`service-contract-wiring.test.ts` 的 SUITES 必须被本清单覆盖——该用例自带
 * 断言，新增编译面套件却忘记登记时会在 test:scripts 内判红（fail-closed）。
 */
export const PREREQ_PACKAGES = ['dsh-notifier', 'dsh-mcp-manager']
