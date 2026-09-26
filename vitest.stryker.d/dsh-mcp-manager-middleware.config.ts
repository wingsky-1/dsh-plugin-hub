// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-mcp-manager:middleware 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-mcp-manager/test/unit/ports/inject-ports.test.ts',
      'packages/dsh-mcp-manager/test/unit/ports/runtime-ports.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-apply.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-call-timeout.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-erasure.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-hotspot.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-image-admission.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-init-failure.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-manager.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-manager2.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-middleware.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-redaction.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-routes-sse.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-runtime-pure.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-stats-a4.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-visibility.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
