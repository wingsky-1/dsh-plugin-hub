// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-mcp-manager:supervisor 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-mcp-manager/test/integration/apply-lifecycle.test.ts',
      'packages/dsh-mcp-manager/test/unit/call-stats.test.ts',
      'packages/dsh-mcp-manager/test/unit/config-env-policy.test.ts',
      'packages/dsh-mcp-manager/test/unit/hotspot.test.ts',
      'packages/dsh-mcp-manager/test/unit/init-failure.test.ts',
      'packages/dsh-mcp-manager/test/unit/manager.test.ts',
      'packages/dsh-mcp-manager/test/unit/manager2.test.ts',
      'packages/dsh-mcp-manager/test/unit/middleware.test.ts',
      'packages/dsh-mcp-manager/test/unit/redaction-a1.test.ts',
      'packages/dsh-mcp-manager/test/unit/redaction.test.ts',
      'packages/dsh-mcp-manager/test/unit/routes-a2.test.ts',
      'packages/dsh-mcp-manager/test/unit/routes-sse.test.ts',
      'packages/dsh-mcp-manager/test/unit/stats-a4.test.ts',
      'packages/dsh-mcp-manager/test/unit/store.test.ts',
      'packages/dsh-mcp-manager/test/unit/summary-a3.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
