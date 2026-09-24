// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-decision-gateway:tools 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-decision-gateway/test/integration/api.test.ts',
      'packages/dsh-decision-gateway/test/integration/routes-fence.test.ts',
      'packages/dsh-decision-gateway/test/unit/baseurl-guard.test.ts',
      'packages/dsh-decision-gateway/test/unit/decide-contract.test.ts',
      'packages/dsh-decision-gateway/test/unit/precheck-noegress.test.ts',
      'packages/dsh-decision-gateway/test/unit/signal-cancel.test.ts',
      'packages/dsh-decision-gateway/test/unit/tool-description.test.ts',
      'packages/dsh-decision-gateway/test/unit/tools.test.ts',
      'packages/dsh-decision-gateway/test/unit/verdict-tiers.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
