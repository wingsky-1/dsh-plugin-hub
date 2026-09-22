// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-mcp-manager:manager 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-mcp-manager/test/unit/ports/orchestrator-ports.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-apply.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-call-stats.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-config-env-policy.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-hotspot.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-init-failure.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-manager.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-manager2.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-redaction-a1.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-redaction.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-routes-a2.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-routes-sse.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-summary-a3.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-workspace.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
