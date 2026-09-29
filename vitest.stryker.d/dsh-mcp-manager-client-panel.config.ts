// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-mcp-manager:client-panel 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-mcp-manager/test/client-dom/core-dom.test.ts',
      'packages/dsh-mcp-manager/test/client-dom/float-panel-mount.test.ts',
      'packages/dsh-mcp-manager/test/client-dom/float-pill-render.test.ts',
      'packages/dsh-mcp-manager/test/client-dom/float-quick-add-form.test.ts',
      'packages/dsh-mcp-manager/test/client-dom/float-servers-render.test.ts',
      'packages/dsh-mcp-manager/test/client-dom/panel-aria-modal.test.ts',
      'packages/dsh-mcp-manager/test/client-dom/settings-card.test.ts',
      'packages/dsh-mcp-manager/test/client-unit/context-s2.test.ts',
      'packages/dsh-mcp-manager/test/client-unit/core-api.test.ts',
      'packages/dsh-mcp-manager/test/client-unit/core-constants.test.ts',
      'packages/dsh-mcp-manager/test/client-unit/core-i18n.test.ts',
      'packages/dsh-mcp-manager/test/client-unit/float-pure.test.ts',
      'packages/dsh-mcp-manager/test/client-unit/locales.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
