// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-notifier:upgrade 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-notifier/test/integration/real-context-assembly.test.ts',
      'packages/dsh-notifier/test/integration/real-context-events.test.ts',
      'packages/dsh-notifier/test/integration/real-context-lifecycle.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/canonical-keys-shared-guards.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/canonical-keys-steps.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/config-shape-service.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/legacy-shape-service.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/legacy.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/quiet-windows.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/reason-shape.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/storage-layout-steps.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/version.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
