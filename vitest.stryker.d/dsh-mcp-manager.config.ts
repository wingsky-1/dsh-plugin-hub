// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-mcp-manager 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-mcp-manager/test/client-unit/unit-summary-a3-guard.test.ts',
      'packages/dsh-mcp-manager/test/integration/real-context.test.ts',
      'packages/dsh-mcp-manager/test/unit/ports/api-ports.test.ts',
      'packages/dsh-mcp-manager/test/unit/ports/catalog-ports.test.ts',
      'packages/dsh-mcp-manager/test/unit/ports/inject-ports.test.ts',
      'packages/dsh-mcp-manager/test/unit/ports/lifecycle-ports.test.ts',
      'packages/dsh-mcp-manager/test/unit/ports/orchestrator-ports.test.ts',
      'packages/dsh-mcp-manager/test/unit/ports/pipeline-ports.test.ts',
      'packages/dsh-mcp-manager/test/unit/ports/runtime-ports.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-apply.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-call-stats.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-call-timeout.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-catalog.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-config-env-policy.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-config-env.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-dispatch.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-erasure.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-file-io-queue.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-file-io.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-hotspot.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-image-admission.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-init-failure.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-lifecycle-logs.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-lifecycle-mount.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-lifecycle.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-manager.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-manager2.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-middleware.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-official-package-face.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-pipeline.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-redaction-a1.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-redaction.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-routes-a2.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-routes-sse.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-stats-a4.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-store.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-summary-a3.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-visibility.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-workspace-id.test.ts',
      'packages/dsh-mcp-manager/test/unit/unit-workspace.test.ts',
      'packages/dsh-mcp-manager/test/unit/upgrade/service.test.ts',
      'packages/dsh-mcp-manager/test/unit/upgrade/storage-layout.test.ts',
      'packages/dsh-mcp-manager/test/unit/upgrade/version.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
