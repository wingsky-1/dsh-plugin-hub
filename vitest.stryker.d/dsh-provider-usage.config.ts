// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-provider-usage 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-provider-usage/test/unit/adapters/unit-deepseek-official.test.ts',
      'packages/dsh-provider-usage/test/unit/apply/unit-apply.test.ts',
      'packages/dsh-provider-usage/test/unit/common/unit-errsurf.test.ts',
      'packages/dsh-provider-usage/test/unit/history/unit-history.test.ts',
      'packages/dsh-provider-usage/test/unit/pipeline/unit-signal-lock.test.ts',
      'packages/dsh-provider-usage/test/unit/pipeline/unit-stats-service.test.ts',
      'packages/dsh-provider-usage/test/unit/registry/unit-hotreload.test.ts',
      'packages/dsh-provider-usage/test/unit/report/unit-report-executor.test.ts',
      'packages/dsh-provider-usage/test/unit/report/unit-report.test.ts',
      'packages/dsh-provider-usage/test/unit/routes/unit-routes.test.ts',
      'packages/dsh-provider-usage/test/unit/shared/unit-config.test.ts',
      'packages/dsh-provider-usage/test/unit/shared/unit-contract.test.ts',
      'packages/dsh-provider-usage/test/unit/shared/unit-v1.test.ts',
      'packages/dsh-provider-usage/test/unit/trend/unit-trend-ledger.test.ts',
      'packages/dsh-provider-usage/test/unit/trend/unit-trend.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
