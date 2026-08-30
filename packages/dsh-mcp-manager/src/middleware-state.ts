/**
 * dsh-mcp-manager — 中间层用户状态与目录缓存持久化（单一事实源）。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ProjectUnit, DisabledToolsMap } from "./middleware-types.ts";
import { parseDisabledTools } from "./middleware-utils.ts";

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

/** 加载工具级禁用（disabledTools 三段：root → server → tool[]；损坏/缺失 → 空）。 */
export async function loadDisabledTools(file: string): Promise<DisabledToolsMap> {
  try {
    if (!existsSync(file)) return new Map();
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { disabledTools?: unknown } | null;
    return parseDisabledTools(parsed?.disabledTools);
  } catch {
    // 损坏忽略
    return new Map();
  }
}

/**
 * 持久化工具级禁用。内存映射是进程内完整视图（启动时 loadDisabledTools 全量
 * 加载 + setToolDisabled 增量变更），直接整图写盘即满足「多工作空间互不抹掉」
 * （同一进程内所有空间共用同一映射）；跨进程并发写属读-改-写竞态，与
 * 服务器级 userDisabled（saveUserState）现状一致。
 */
export async function saveDisabledTools(file: string, disabledTools: DisabledToolsMap): Promise<void> {
  const payload: Record<string, Record<string, string[]>> = {};
  for (const [root, servers] of disabledTools) {
    const serverRec: Record<string, string[]> = {};
    for (const [server, tools] of servers) {
      if (tools.size > 0) serverRec[server] = [...tools].sort();
    }
    if (Object.keys(serverRec).length > 0) payload[root] = serverRec;
  }
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, disabledTools: payload }, null, 2), "utf8");
    await rename(tmp, file);
  } catch {
    // 落盘失败不阻塞主流程
  }
}