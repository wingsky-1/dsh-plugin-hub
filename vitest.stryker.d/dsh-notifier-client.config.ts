// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-notifier:client 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-notifier/test/client-dom/apply-lifecycle.test.ts',
      'packages/dsh-notifier/test/client-dom/controls.test.ts',
      'packages/dsh-notifier/test/client-dom/diagnostics.test.ts',
      'packages/dsh-notifier/test/client-dom/display.test.ts',
      'packages/dsh-notifier/test/client-dom/status.test.ts',
      'packages/dsh-notifier/test/client-dom/title.test.ts',
      'packages/dsh-notifier/test/client-unit/api-error.test.ts',
      'packages/dsh-notifier/test/client-unit/banner.test.ts',
      'packages/dsh-notifier/test/client-unit/capabilities.test.ts',
      'packages/dsh-notifier/test/client-unit/locale-fallback.test.ts',
      'packages/dsh-notifier/test/client-unit/locale.test.ts',
      'packages/dsh-notifier/test/client-unit/mask.test.ts',
      'packages/dsh-notifier/test/client-unit/notify-audio.test.ts',
      'packages/dsh-notifier/test/client-unit/notify-lease.test.ts',
      'packages/dsh-notifier/test/client-unit/notify-policy.test.ts',
      'packages/dsh-notifier/test/client-unit/notify-registry.test.ts',
      'packages/dsh-notifier/test/client-unit/notify-session.test.ts',
      'packages/dsh-notifier/test/client-unit/notify-title.test.ts',
      'packages/dsh-notifier/test/client-unit/reason-text.test.ts',
      'packages/dsh-notifier/test/client-unit/save-guard.test.ts',
      'packages/dsh-notifier/test/client-unit/settings-compare-912.test.ts',
      'packages/dsh-notifier/test/client-unit/settings-diff.test.ts',
      'packages/dsh-notifier/test/client-unit/settings-ui-v3.test.ts',
      'packages/dsh-notifier/test/client-unit/status-poll.test.ts',
      'packages/dsh-notifier/test/client-unit/status-text.test.ts',
      'packages/dsh-notifier/test/integration/status-roundtrip.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
