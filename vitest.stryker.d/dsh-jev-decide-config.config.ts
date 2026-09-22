// 生成物，勿手改：由 scripts/gate/gen-stryker-conf.mjs 从 mutation-topology.json 派生
// （dsh-jev-decide:config 的变异面测试清单）。改动请改拓扑后跑 pnpm stryker:gen。
//
// 为什么存在：Stryker 的 testFiles 会触发上游 #6144（static mutant 被当作 runtime
// 激活 → 模块级变异体全部漏判），故测试面限定改由本文件的 include 承载。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-jev-decide/test/integration/api.test.ts',
      'packages/dsh-jev-decide/test/integration/routes-fence.test.ts',
      'packages/dsh-jev-decide/test/unit/baseurl-guard.test.ts',
      'packages/dsh-jev-decide/test/unit/config.test.ts',
      'packages/dsh-jev-decide/test/unit/custom-presets.test.ts',
      'packages/dsh-jev-decide/test/unit/keys-hardening.test.ts',
      'packages/dsh-jev-decide/test/unit/put-envelope.test.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
