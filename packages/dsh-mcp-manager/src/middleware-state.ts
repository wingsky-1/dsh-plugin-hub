/**
 * dsh-mcp-manager — 中间层用户状态与目录缓存持久化（单一事实源）。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ProjectUnit } from "./middleware-types.ts";

/** userDisabled 持久化文件路径。 */
export function userStateFile() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-mcp-user-state.json");
}

/** 加载 userDisabled（损坏/缺失 → 空）。 */
export async function loadUserState(file: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  try {
    if (!existsSync(file)) return out;
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { disabled?: Record<string, string[]> } | null;
    if (parsed && typeof parsed === "object" && typeof parsed.disabled === "object" && parsed.disabled !== null) {
      for (const [root, names] of Object.entries(parsed.disabled)) {
        if (Array.isArray(names)) out.set(root, new Set(names.filter((name) => typeof name === "string")));
      }
    }
  } catch {
    // 损坏忽略
  }
  return out;
}

/** 持久化 userDisabled（合并式：先读现有文件，内存 units 覆盖，保留已淘汰
 * root 的记录——防 LRU 淘汰/卸载后禁用记录被静默抹掉，P1 修复）。 */
export async function saveUserState(file: string, units: Map<string, ProjectUnit>): Promise<void> {
  const merged = await loadUserState(file);
  for (const [root, unit] of units) {
    if (unit.userDisabled.size > 0) merged.set(root, new Set(unit.userDisabled));
    else merged.delete(root);
  }
  const disabled: Record<string, string[]> = {};
  for (const [root, names] of merged) {
    if (names.size > 0) disabled[root] = [...names].sort();
  }
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, disabled }, null, 2), "utf8");
    await rename(tmp, file);
  } catch {
    // 落盘失败不阻塞主流程
  }
}

/** 目录缓存文件路径（每工作空间一份；root 哈希防路径注入）。 */
export function catalogCacheFileFor(root: string) {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-mcp-catalog", `${hash}.json`);
}