/**
 * dsh-mcp-manager — 中间层用户状态与目录缓存持久化（单一事实源）。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectUnit, DisabledToolsMap } from "./middleware-types.ts";
import { parseDisabledTools } from "./middleware-utils.ts";
import { dshHome } from "../../../shared/dsh-home.js";

/** userDisabled 持久化文件路径。 */
export function userStateFile() {
  return join(dshHome(), "dsh-mcp-user-state.json");
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
  return join(dshHome(), "dsh-mcp-catalog", `${hash}.json`);
}

/** 磁盘 last-good 目录文件中的单服务器条目（与 middleware persistCatalog
 * 落盘结构一致；读取端单一解析源）。 */
export interface PersistedCatalogServer {
  discoveredAt: number;
  tools: Array<{ name: string; description: string }>;
}

/**
 * 读取 root 的磁盘 last-good 目录缓存中**单个服务器**的工具目录。
 * 缺失 / 损坏 / 无该服务器 → undefined（容错不抛）。
 * 用途：能力目录注入端（manager.catalogViewFor）在中间层单元尚未创建时兜底
 * 读盘，避免 pre-step 触发连接副作用；与 middleware.loadCatalogCache 同源解析。
 */
export async function readCatalogServerFromDisk(file: string, serverName: string): Promise<PersistedCatalogServer | undefined> {
  try {
    if (!existsSync(file)) return undefined;
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> } | null;
    const entry = parsed && typeof parsed === "object" && parsed.entries !== null && typeof parsed.entries === "object"
      ? (parsed.entries as Record<string, unknown>)[serverName]
      : undefined;
    if (typeof entry !== "object" || entry === null) return undefined;
    const rec = entry as { discoveredAt?: unknown; tools?: unknown } | undefined;
    const tools: Array<{ name: string; description: string }> = [];
    if (rec !== undefined && Array.isArray(rec.tools)) {
      for (const tool of rec.tools) {
        const toolRec = tool as { name?: unknown; description?: unknown } | undefined;
        if (typeof toolRec !== "object" || toolRec === null || typeof toolRec.name !== "string") continue;
        tools.push({ name: toolRec.name, description: typeof toolRec.description === "string" ? toolRec.description : "" });
      }
    }
    return { discoveredAt: typeof rec?.discoveredAt === "number" ? rec.discoveredAt : 0, tools };
  } catch {
    // 损坏缓存忽略
    return undefined;
  }
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