// @ts-nocheck
/**
 * dsh-idle-archive — 单元测试共享辅助（#83 剩余缺口：结构化单测）。
 *
 * - assert：断言统一出口（对齐 web-file-preview 样板）；
 * - withTempHome(fn)：DSH_HOME 隔离辅助——凡触及 readState/writeState/stateFile
 *   的用例必须走隔离临时路径（防 flake 纪律，见 docs/DEVELOPMENT.md §5）：
 *   临时目录 + 环境变量注入，finally 中清理目录并还原环境，全程无网络、无固定 sleep。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export { assert };

/**
 * 在隔离临时 DSH_HOME 下执行异步用例。
 * @param fn - 用例体（DSH_HOME 已指向新临时目录）。
 * @returns - fn 的返回值（透传）。
 */
export async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "dia-unit-"));
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn();
  } finally {
    process.env.DSH_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
}
