// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-lan-proxy:client 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-lan-proxy/test/client-dom/settings-card.test.ts',
      'packages/dsh-lan-proxy/test/client-unit/ca-status.test.ts',
      'packages/dsh-lan-proxy/test/client-unit/host-trust-alert.test.ts',
      'packages/dsh-lan-proxy/test/client-unit/host-trust-status.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
