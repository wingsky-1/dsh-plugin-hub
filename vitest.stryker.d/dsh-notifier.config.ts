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
      'packages/dsh-notifier/test/integration/real-context.test.ts',
      'packages/dsh-notifier/test/integration/service-contract.test.ts',
      'packages/dsh-notifier/test/unit/api/journal.test.ts',
      'packages/dsh-notifier/test/unit/api/kinds.test.ts',
      'packages/dsh-notifier/test/unit/api/probe.test.ts',
      'packages/dsh-notifier/test/unit/api/route.test.ts',
      'packages/dsh-notifier/test/unit/api/service.test.ts',
      'packages/dsh-notifier/test/unit/api/settings.test.ts',
      'packages/dsh-notifier/test/unit/api/stream.test.ts',
      'packages/dsh-notifier/test/unit/channels/bark.test.ts',
      'packages/dsh-notifier/test/unit/channels/browser.test.ts',
      'packages/dsh-notifier/test/unit/channels/capabilities.test.ts',
      'packages/dsh-notifier/test/unit/channels/deliver.test.ts',
      'packages/dsh-notifier/test/unit/channels/system.test.ts',
      'packages/dsh-notifier/test/unit/channels/webhook.test.ts',
      'packages/dsh-notifier/test/unit/config/input.test.ts',
      'packages/dsh-notifier/test/unit/config/model.test.ts',
      'packages/dsh-notifier/test/unit/config/redact.test.ts',
      'packages/dsh-notifier/test/unit/config/service.test.ts',
      'packages/dsh-notifier/test/unit/events/listen.test.ts',
      'packages/dsh-notifier/test/unit/events/session.test.ts',
      'packages/dsh-notifier/test/unit/events/translate.test.ts',
      'packages/dsh-notifier/test/unit/pipeline/dispatch.test.ts',
      'packages/dsh-notifier/test/unit/pipeline/finalize.test.ts',
      'packages/dsh-notifier/test/unit/pipeline/judge.test.ts',
      'packages/dsh-notifier/test/unit/pipeline/route.test.ts',
      'packages/dsh-notifier/test/unit/pipeline/service.test.ts',
      'packages/dsh-notifier/test/unit/shared/paths.test.ts',
      'packages/dsh-notifier/test/unit/shared/reason.test.ts',
      'packages/dsh-notifier/test/unit/stores/history.test.ts',
      'packages/dsh-notifier/test/unit/stores/status.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/legacy.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/reason-shape.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/service.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/steps.test.ts',
      'packages/dsh-notifier/test/unit/upgrade/version.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
