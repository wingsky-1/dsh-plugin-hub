import { defineConfig } from 'vitest/config'

/**
 * 仓库级测试与覆盖率配置（单一事实源）。
 *
 * 分层即目录：test/unit、test/integration、test/e2e 直连 src 源码；
 * test/client 需要 DOM 环境；产物契约测试（读 lib/）不属于覆盖率口径。
 * 覆盖率只对源码计算，范围与阈值都在此文件，不另设脚本。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/integration/**/*.test.ts'],
          environment: 'node',
        },
      },
      // e2e / contract / client 三个 project 在后续阶段接入：
      // e2e 需真实 IO 环境、contract 测 lib 产物、client 需 happy-dom（当前形态是 vm 读产物字符串）。
    ],
    coverage: {
      provider: 'istanbul',
      include: ['packages/*/src/**/*.{ts,tsx}', 'shared/**/*.js'],
      exclude: ['**/*.d.ts'],
      reporter: ['text', 'json-summary', 'json', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
})
