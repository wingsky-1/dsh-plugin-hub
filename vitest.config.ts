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
          // 默认 5s 会误杀「实现预算本身就是 30s」的用例（超时兜底、挂起型子进程重连），
          // 故统一放宽；个别更长的用例仍可在文件内显式标注。
          // hookTimeout 必须同步放宽：beforeAll 里的建 fixture / 起服务 / 迁移准备
          // 常超过 vitest 默认的 10s，会以 hook 失败的形式假红。
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['packages/*/test/e2e/**/*.test.ts'],
          environment: 'node',
          // e2e 走真实端口、文件系统与子进程，单文件最坏数百秒（mcp-manager smoke 实测 328s）
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
      {
        test: {
          name: 'contract',
          // test/client/** 的现有形态是「读 lib 产物字符串 + vm 执行」，属产物契约断言，
          // 不需要 DOM 环境；未来直连 src/client/** 的 DOM 单测另立 happy-dom project。
          include: ['packages/*/test/client/**/*.test.ts'],
          environment: 'node',
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
