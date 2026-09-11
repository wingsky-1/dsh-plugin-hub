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
          name: 'host',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'packages/*/test/client/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'client',
          include: ['packages/*/test/client/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
        },
      },
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
