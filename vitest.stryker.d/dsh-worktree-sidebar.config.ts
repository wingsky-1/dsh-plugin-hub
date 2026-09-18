// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-worktree-sidebar 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-worktree-sidebar/test/client-dom/inject-visibility.test.ts',
      'packages/dsh-worktree-sidebar/test/integration/apply-lifecycle.test.ts',
      'packages/dsh-worktree-sidebar/test/integration/binding-store.test.ts',
      'packages/dsh-worktree-sidebar/test/integration/git-real.test.ts',
      'packages/dsh-worktree-sidebar/test/integration/tools-real.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/api-routes.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/binding-model.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/client-bindings.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/client-index.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/client-source.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/client-takeover.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/git-inspect.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/git-service.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/host-agents.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/host-sessions.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/host-typert.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/inject-attach.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/scope.test.ts',
      'packages/dsh-worktree-sidebar/test/unit/tools.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
