/**
 * dsh-mcp-manager — 中间层用户状态与目录缓存持久化（单一事实源）。
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectUnit } from "../../connection/interface.ts";
import {
  catalogFile,
  fileMode,
  readJsonFile,
  userStatePath,
  writeFileAtomic,
} from "../../shared/interface.ts";

/** 用户已禁用的工具集合（root → server → tool 列表）。root 为 @global 时跨工作空间共享。 */
export type DisabledToolsMap = Map<string, Map<string, Set<string>>>;

/**
 * 状态写盘（H2 等价接入，#767 S2-C）：登记路径经 file-io `writeFileAtomic`
 * （mode 取登记表 + 同路径写串行 + 失败清理临时名并上抛原错误）；未登记路径
 * （单测 tmp / 调用方自定义）回落既有直写形状——`writeFileAtomic` 对未登记路径
 * 抛 I6，直接调等于把「回落写盘」变成「写失败」（store.save 的 S2-B 同式）。
 * 旧路径字面量只许出现在 paths：本文件只认 `userStatePath`/`catalogFile` 单点。
 *
 * 模块函数而非类成员/导出：调用点同文件，导出会进导出面快照（零 diff 要求）。
 */
async function writeStateFile(file: string, data: string): Promise<void> {
  let registered = true;
  try {
    fileMode(file);
  } catch {
    registered = false;
  }
  if (registered) {
    await writeFileAtomic(file, data);
    return;
  }
  const dir = dirname(file);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  // R1 硬化（#767 S2-C 筆3）：回落临时名加随机后缀 + 失败清理（与 file-io `writeOnce` 同式）；
  // mode 沿既有回落形状（无 mode），只补唯一性与清理，不改写盘语义。
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, "utf8");
    await rename(tmp, file);
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/** userDisabled 持久化文件路径（名字与权限的物理定义在 server/shared/paths.ts，I7 单源）。 */
export function userStateFile() {
  return userStatePath();
}

/** 加载 userDisabled（损坏/缺失 → 空）。 */
export async function loadUserState(file: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  try {
    const parsed = await readJsonFile<{ disabled?: Record<string, string[]> } | null>(file);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.disabled === "object" &&
      parsed.disabled !== null
    ) {
      for (const [root, names] of Object.entries(parsed.disabled)) {
        if (Array.isArray(names))
          out.set(root, new Set(names.filter((name) => typeof name === "string")));
      }
    }
  } catch {
    // 损坏忽略
  }
  return out;
}

/** 同文件另一键的原样保留（read-modify-write）：user-state.json 同时承载
 * `disabled`（服务器级）与 `disabledTools`（工具级）两键，两次写必须互不抹掉
 * 对方（#903 S1：PATCH /tool-disable 后任意 connect 即复活）。跨键保留取文件
 * 原值、不做归一化——本函数只拥有本键的写语义（损坏/缺失的对方键由对方读端
 * 容错，不在此静默改写）。 */
async function otherKeyOf(file: string, key: "disabled" | "disabledTools"): Promise<unknown> {
  try {
    const parsed = await readJsonFile<Record<string, unknown> | null>(file);
    if (parsed && typeof parsed === "object") return (parsed as Record<string, unknown>)[key];
  } catch {
    // 损坏/缺失 → 无对方键可保留
  }
  return undefined;
}

/** 持久化 userDisabled（合并式：先读现有文件，内存 units 覆盖，保留已淘汰
 * root 的记录——防 LRU 淘汰/卸载后禁用记录被静默抹掉，P1 修复）。
 * 同文件 `disabledTools` 键原样保留（#903 S1 双键互抹修复）。 */
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
  const kept = await otherKeyOf(file, "disabledTools");
  try {
    await writeStateFile(
      file,
      JSON.stringify(
        { version: 1, disabled, ...(kept !== undefined ? { disabledTools: kept } : {}) },
        null,
        2,
      ),
    );
  } catch {
    // 落盘失败不阻塞主流程
  }
}

/** 目录缓存文件路径（每工作空间一份；root 哈希防路径注入；落点单源在 server/shared/paths.ts）。 */
export function catalogCacheFileFor(root: string) {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return catalogFile(hash);
}

/** 磁盘 last-good 目录文件中的单服务器条目（与 middleware persistCatalog
 * 落盘结构一致；读取端单一解析源）。 */
export interface PersistedCatalogServer {
  discoveredAt: number;
  tools: Array<{ name: string; description: string }>;
}

/** 清洗磁盘条目中的工具清单：回答「哪些工具条目可用？」——逐条校验 name 为字符串、
 * description 缺失置空串；非数组输入视为空清单。文件可读性与服务器定位在
 * readCatalogServerFromDisk 内（不同问题）。 */
function cleanPersistedTools(tools: unknown): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = [];
  if (!Array.isArray(tools)) return out;
  for (const tool of tools) {
    const toolRec = tool as { name?: unknown; description?: unknown } | undefined;
    if (typeof toolRec !== "object" || toolRec === null || typeof toolRec.name !== "string")
      continue;
    out.push({
      name: toolRec.name,
      description: typeof toolRec.description === "string" ? toolRec.description : "",
    });
  }
  return out;
}

/**
 * 读取 root 的磁盘 last-good 目录缓存中**单个服务器**的工具目录。
 * 缺失 / 损坏 / 无该服务器 → undefined（容错不抛）。
 * 用途：能力目录注入端（manager.catalogViewFor）在中间层单元尚未创建时兜底
 * 读盘，避免 pre-step 触发连接副作用；与 middleware.loadCatalogCache 同源解析。
 */
export async function readCatalogServerFromDisk(
  file: string,
  serverName: string,
): Promise<PersistedCatalogServer | undefined> {
  try {
    const parsed = await readJsonFile<{ entries?: Record<string, unknown> } | null>(file);
    const entry =
      parsed &&
      typeof parsed === "object" &&
      parsed.entries !== null &&
      typeof parsed.entries === "object"
        ? (parsed.entries as Record<string, unknown>)[serverName]
        : undefined;
    if (typeof entry !== "object" || entry === null) return undefined;
    const rec = entry as { discoveredAt?: unknown; tools?: unknown } | undefined;
    const tools = cleanPersistedTools(rec?.tools);
    return { discoveredAt: typeof rec?.discoveredAt === "number" ? rec.discoveredAt : 0, tools };
  } catch {
    // 损坏缓存忽略
    return undefined;
  }
}

/** 从持久化载荷解析 disabledTools 三层结构（损坏/缺失 → 空；容错不抛）。
 *  阶段 6 自 middleware-utils.ts 并入（状态域归属；loadDisabledTools 同文件引用）。 */
export function parseDisabledTools(raw: unknown): DisabledToolsMap {
  const out: DisabledToolsMap = new Map();
  if (typeof raw !== "object" || raw === null) return out;
  for (const [root, servers] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof servers !== "object" || servers === null) continue;
    const serverMap = new Map<string, Set<string>>();
    for (const [server, tools] of Object.entries(servers as Record<string, unknown>)) {
      if (!Array.isArray(tools)) continue;
      const set = new Set<string>(
        tools.filter((tool): tool is string => typeof tool === "string" && tool !== ""),
      );
      if (set.size > 0) serverMap.set(server, set);
    }
    if (serverMap.size > 0) out.set(root, serverMap);
  }
  return out;
}

/** 加载工具级禁用（disabledTools 三段：root → server → tool[]；损坏/缺失 → 空）。 */
export async function loadDisabledTools(file: string): Promise<DisabledToolsMap> {
  try {
    const parsed = await readJsonFile<{ disabledTools?: unknown } | null>(file);
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
 * 同文件 `disabled` 键原样保留（#903 S1 双键互抹修复，对称侧）。
 */
export async function saveDisabledTools(
  file: string,
  disabledTools: DisabledToolsMap,
): Promise<void> {
  const payload: Record<string, Record<string, string[]>> = {};
  for (const [root, servers] of disabledTools) {
    const serverRec: Record<string, string[]> = {};
    for (const [server, tools] of servers) {
      if (tools.size > 0) serverRec[server] = [...tools].sort();
    }
    if (Object.keys(serverRec).length > 0) payload[root] = serverRec;
  }
  const kept = await otherKeyOf(file, "disabled");
  try {
    await writeStateFile(
      file,
      JSON.stringify(
        { version: 1, disabledTools: payload, ...(kept !== undefined ? { disabled: kept } : {}) },
        null,
        2,
      ),
    );
  } catch {
    // 落盘失败不阻塞主流程
  }
}
