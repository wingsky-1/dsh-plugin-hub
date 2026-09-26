// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-decision-gateway:client 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-decision-gateway/test/client-dom/custom-presets-ui.test.ts',
      'packages/dsh-decision-gateway/test/client-dom/fold-hidden.test.ts',
      'packages/dsh-decision-gateway/test/client-dom/locale-host.test.ts',
      'packages/dsh-decision-gateway/test/client-dom/pane-helpers.test.ts',
      'packages/dsh-decision-gateway/test/client-dom/panes-probability.test.ts',
      'packages/dsh-decision-gateway/test/client-dom/tabs-mask-history.test.ts',
      'packages/dsh-decision-gateway/test/client-unit/contract-parsers.test.ts',
      'packages/dsh-decision-gateway/test/client-unit/format.test.ts',
      'packages/dsh-decision-gateway/test/client-unit/history-entry.test.ts',
      'packages/dsh-decision-gateway/test/client-unit/locale-i18n.test.ts',
      'packages/dsh-decision-gateway/test/client-unit/routes-consistency.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
