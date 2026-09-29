// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-provider-usage 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-provider-usage/test/client-dom/report-section.test.ts',
      'packages/dsh-provider-usage/test/client-dom/trend-section.test.ts',
      'packages/dsh-provider-usage/test/integration/adapters/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/aggregate/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/collect/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/config/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/data-routes/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/execute/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/history/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/pipeline/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/registry/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/report-routes/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/schedule/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/ui-routes/composition-root.test.ts',
      'packages/dsh-provider-usage/test/integration/upgrade/upgrade-chain.test.ts',
      'packages/dsh-provider-usage/test/unit/adapters/adapters-pure.test.ts',
      'packages/dsh-provider-usage/test/unit/adapters/deepseek-official.test.ts',
      'packages/dsh-provider-usage/test/unit/apply/apply.test.ts',
      'packages/dsh-provider-usage/test/unit/common/errsurf.test.ts',
      'packages/dsh-provider-usage/test/unit/history/history.test.ts',
      'packages/dsh-provider-usage/test/unit/pipeline/signal-lock.test.ts',
      'packages/dsh-provider-usage/test/unit/pipeline/stats-service.test.ts',
      'packages/dsh-provider-usage/test/unit/registry/hotreload.test.ts',
      'packages/dsh-provider-usage/test/unit/registry/registry-pure.test.ts',
      'packages/dsh-provider-usage/test/unit/report/report-b2-3.test.ts',
      'packages/dsh-provider-usage/test/unit/report/report-executor.test.ts',
      'packages/dsh-provider-usage/test/unit/report/report.test.ts',
      'packages/dsh-provider-usage/test/unit/routes/refactor-pure.test.ts',
      'packages/dsh-provider-usage/test/unit/routes/routes.test.ts',
      'packages/dsh-provider-usage/test/unit/schedule/schedule-pure.test.ts',
      'packages/dsh-provider-usage/test/unit/server-shared/s2-contracts.test.ts',
      'packages/dsh-provider-usage/test/unit/shared/chart.test.ts',
      'packages/dsh-provider-usage/test/unit/shared/config.test.ts',
      'packages/dsh-provider-usage/test/unit/shared/contract.test.ts',
      'packages/dsh-provider-usage/test/unit/trend/trend-ledger.test.ts',
      'packages/dsh-provider-usage/test/unit/trend/trend-sanitize-dir.test.ts',
      'packages/dsh-provider-usage/test/unit/trend/trend-shard-row.test.ts',
      'packages/dsh-provider-usage/test/unit/trend/trend.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
