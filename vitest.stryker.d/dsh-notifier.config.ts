// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-notifier 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-notifier/test/integration/consumer-types.test.ts',
      'packages/dsh-notifier/test/integration/e2e-approval.test.ts',
      'packages/dsh-notifier/test/integration/e2e-done-commit.test.ts',
      'packages/dsh-notifier/test/integration/e2e-done-evidence.test.ts',
      'packages/dsh-notifier/test/integration/e2e-done-status.test.ts',
      'packages/dsh-notifier/test/integration/e2e-done-subagent.test.ts',
      'packages/dsh-notifier/test/integration/e2e-edge.test.ts',
      'packages/dsh-notifier/test/integration/e2e-interrupt.test.ts',
      'packages/dsh-notifier/test/integration/e2e-outbound.test.ts',
      'packages/dsh-notifier/test/integration/e2e-question-turn.test.ts',
      'packages/dsh-notifier/test/integration/migration.test.ts',
      'packages/dsh-notifier/test/integration/routes-config-secrets.test.ts',
      'packages/dsh-notifier/test/integration/routes-config.test.ts',
      'packages/dsh-notifier/test/integration/routes-events.test.ts',
      'packages/dsh-notifier/test/integration/routes-guards.test.ts',
      'packages/dsh-notifier/test/integration/routes-history.test.ts',
      'packages/dsh-notifier/test/integration/routes-kinds.test.ts',
      'packages/dsh-notifier/test/integration/service-contract.test.ts',
      'packages/dsh-notifier/test/unit/unit-aggregate.test.ts',
      'packages/dsh-notifier/test/unit/unit-config-port.test.ts',
      'packages/dsh-notifier/test/unit/unit-config.test.ts',
      'packages/dsh-notifier/test/unit/unit-event-handlers.test.ts',
      'packages/dsh-notifier/test/unit/unit-pipeline-contract.test.ts',
      'packages/dsh-notifier/test/unit/unit-pipeline-orchestrate.test.ts',
      'packages/dsh-notifier/test/unit/unit-sanitize.test.ts',
      'packages/dsh-notifier/test/unit/unit-server-sse-bus.test.ts',
      'packages/dsh-notifier/test/unit/unit-settings-bridge.test.ts',
      'packages/dsh-notifier/test/unit/unit-sse-hub.test.ts',
      'packages/dsh-notifier/test/unit/unit-stores.test.ts',
      'packages/dsh-notifier/test/unit/unit-system-notifier.test.ts',
      'packages/dsh-notifier/test/unit/unit-text.test.ts',
      'packages/dsh-notifier/test/unit/unit-webhook.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
