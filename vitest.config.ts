import { defineConfig } from "vitest/config";
import coverage from "./scripts/data/coverage.config.json" with { type: "json" };
import mutationTopology from "./scripts/data/mutation-topology.json" with { type: "json" };

/**
 * 仓库级测试与覆盖率配置。
 *
 * **本文件不承载事实**（#733 计划项 3.4）：覆盖率面（include / exclude / thresholds）的唯一事实源
 * 是 `scripts/data/coverage.config.json`；测试分层 glob 的唯一事实源是
 * `scripts/data/mutation-topology.json` 的 `$testLayers.layers`。这里只做两件事——把数据翻译成
 * vitest 的配置形态，以及声明各层的**运行环境**（environment / timeout，属配置决策不是事实）。
 * `scripts/gate/verify-coverage-scope.mjs` 会判红本文件里再出现 thresholds / include / exclude
 * 字面量：同一事实两处声明，就一定会有一处先腐烂。
 *
 * 分层即目录：test/unit、test/integration、test/e2e 直连 src 源码；test/client 是「读 lib 产物 +
 * vm 执行」的客户端契约测试。产物契约测试（读 lib/）不属于覆盖率口径。
 */

/** 各测试层的运行环境与超时（配置决策；层清单来自 mutation-topology 的 $testLayers）。 */
const LAYER_RUNTIME = {
  unit: {
    environment: "node",
    // 默认 5s 会误杀「实现预算本身就是 30s」的用例（超时兜底、挂起型子进程重连），
    // 故统一放宽；个别更长的用例仍可在文件内显式标注。
    // hookTimeout 必须同步放宽：beforeAll 里的建 fixture / 起服务 / 迁移准备
    // 常超过 vitest 默认的 10s，会以 hook 失败的形式假红。
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  integration: { environment: "node", testTimeout: 60_000, hookTimeout: 60_000 },
  // e2e 走真实端口、文件系统与子进程，单文件最坏数百秒（mcp-manager smoke 实测 328s）
  e2e: { environment: "node", testTimeout: 600_000, hookTimeout: 600_000 },
  // test/client/** 的现有形态是「读 lib 产物字符串 + vm 执行」，属产物契约断言，
  // 不需要 DOM 环境；未来直连 src/client/** 的 DOM 单测另立 happy-dom project。
  client: { environment: "node" },
};

/** 层名 → project 名：`--project contract` 是既有 CLI 契约（release.yml / package.json 在用），保留别名。 */
const PROJECT_NAME = { client: "contract" };

export default defineConfig({
  test: {
    // 显式钉住逐文件隔离。这**不是**复述默认值：本仓测试面依赖它——多个测试文件在模块作用域设
    // `DSH_HOME`（被测单例在模块加载期就把落盘路径定死），一旦为提速改成 false，同一 worker 内的
    // 单例会共享第一次求值时的 home：轻则写进已删除的临时目录（红得莫名其妙），重则写进真实
    // `~/.dsh`（#218 污染红线）。vitest 大版本换过隔离实现，故把这条不变量写成可审查的事实。
    isolate: true,
    projects: Object.entries(mutationTopology.$testLayers.layers).map(([layer, glob]) => ({
      test: {
        name: PROJECT_NAME[layer] ?? layer,
        include: [`packages/*/${glob}`],
        ...LAYER_RUNTIME[layer],
      },
    })),
    coverage: {
      provider: "istanbul",
      include: coverage.include,
      exclude: coverage.exclude.map((entry) => entry.pattern),
      reporter: ["text", "json-summary", "json", "lcov"],
      reportsDirectory: "coverage",
      // 阈值只许升不许降：scripts/gate/threshold-monotonic.mjs 对比基准判分；基线与各排除项的
      // 理由（含 `**/client/**` 的解除条件）见 scripts/data/coverage.config.json 的 note。
      thresholds: coverage.thresholds,
    },
  },
});
