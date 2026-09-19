/**
 * dsh-mcp-manager — catalog/impl/cache-view/index.ts：注入端目录缓存视图（#664 阶段 5）。
 *
 * 自 src/manager.ts 迁出（catalog 域）：合成注入端目录缓存视图——以 B
 * （supervisor 摘要缓存）为基底，逐服务器按「scope + 模式」用中间层目录摘要
 * 覆盖（#569 修复核心）。diskCatalogSummaryCache（mtime 缓存）随迁，以工厂
 * 闭包持有（防多实例共享串状态）；宿主最小面 CatalogViewHost 解耦 manager
 * 细节（C-DIR：catalogViewFor 私有缓存随迁，薄桥接）。
 */

import { existsSync, statSync } from "node:fs";
import { catalogSummaryFile } from "../../../shared/interface.ts";
import type { McpMiddleware } from "../../../connection/runtime/interface.ts";
import type { ServerConfig } from "../../../config/interface.ts";
import { MIDDLEWARE_GLOBAL_ROOT, SCOPE_PROJECT } from "../../../../shared/interface.ts";
import { catalogDirectory } from "../directory/index.ts";
import { catalogPorts } from "../service/index.ts";
import { summarizeToolDescriptions } from "../entries/index.ts";
import type { CatalogCache } from "../entries/index.ts";

/**
 * 目录摘要缓存文件（连接成功时把工具描述摘要持久化于此；目录 digest 的稳定数据源）。
 * 名字与权限的物理定义在 server/shared/paths.ts（I7 单源）。
 */
export function catalogCacheFile() {
  return catalogSummaryFile();
}

/** catalogViewFor 的宿主最小面（manager 提供；实例经读取器取——apply 完成后恒在，pre-step 窗口未装配时返回 undefined 走 B 兜底）。 */
export interface CatalogViewHost {
  getCatalogCache(): CatalogCache;
  getMiddleware(): McpMiddleware | undefined;
  catalogCachePathFor(root: string): string;
}

/** 注入端目录缓存视图解析器（makeCatalogViewFor 产物）。 */
export type CatalogViewResolver = (
  cwd: string | undefined,
  servers: Map<string, { server: ServerConfig; scope: string }>,
) => Promise<CatalogCache>;

/**
 * 合成注入端目录缓存视图（#569 修复核心）：以 B（supervisor 摘要缓存）为基底，
 * 逐服务器按「scope + 模式」用中间层目录摘要覆盖——修复「middleware 采集的
 * 工具摘要注入端读不到」：
 * - 用户手写 server.description 由 composeCatalogEntries 处理（优先级最高），
 *   不在此视图内；
 * - 本视图只负责注入端的 ②（中间层目录摘要）与 ③（B 缓存摘要）两级回退；
 * - **判 middleware 实例**（apply 完成后恒在；实例缺失＝pre-step 窗口尚未装配 → 全部走 B）。
 *
 * root 映射（单池后与单元表同口径）：
 * - scope=project → 该 cwd 归一化项目 root 的单元 → 无则磁盘 last-good；
 * - scope=global → @global 单元/磁盘 → 仍无则保留 B。
 * 严格按 scope 解析、不跨 scope 混配同名服务器（防不同配置被错配）。
 * 单元不存在时读磁盘 last-good（带 mtime 缓存），**不主动 projectUnitFor**
 * ——pre-step 无连接副作用。
 *
 * diskCatalogSummaryCache（root → server → { mtimeMs, summary }）在闭包内
 * 持有：防 pre-step 每轮重复读盘解析（目录文件最大 ~256KB，JSON parse 有成本）。
 */
export function makeCatalogViewFor(host: CatalogViewHost): CatalogViewResolver {
  const diskCatalogSummaryCache = new Map<
    string,
    Map<string, { mtimeMs: number; summary: string | undefined }>
  >();

  /** 查中间层单服务器目录摘要：内存单元优先，单元缺失/无该服务器 → 磁盘
   * last-good 兜底（带 mtime 缓存，防 pre-step 每轮读盘）。返回 undefined
   * 表示中间层无此服务器数据（调用方保留 B 兜底）。 */
  async function middlewareCatalogSummary(
    mw: McpMiddleware,
    root: string,
    name: string,
  ): Promise<string | undefined> {
    const {
      store: { readCatalogServerFromDisk },
    } = catalogPorts.get();
    const catalog = catalogDirectory.entryFor(root, name);
    const tools = catalog?.tools;
    if (tools !== undefined && tools.size > 0 && catalog?.unavailable === undefined) {
      // 内存目录（已含磁盘 last-good：单元创建时 ensureRootLoaded 载入）→ 直接聚合。
      return summarizeToolDescriptions(tools as Map<string, { description?: unknown }>);
    }
    // 内存无该服务器数据（单元未建 / 条目缺失 / 发现失败）→ 磁盘 last-good 兜底。
    const file = host.catalogCachePathFor(root);
    const cachedRoot = diskCatalogSummaryCache.get(root);
    const cached = cachedRoot?.get(name);
    let mtimeMs = 0;
    try {
      if (!existsSync(file)) return undefined;
      const stat = statSync(file);
      mtimeMs = stat.mtimeMs;
    } catch {
      return undefined; // 文件消失/不可读 → 无磁盘兜底
    }
    if (cached?.mtimeMs === mtimeMs) return cached.summary;
    const persisted = await readCatalogServerFromDisk(file, name);
    if (persisted === undefined) return undefined;
    const summary = summarizeToolDescriptions(
      new Map(persisted.tools.map((tool) => [tool.name, { description: tool.description }])),
    );
    let rootCache = diskCatalogSummaryCache.get(root);
    if (rootCache === undefined) {
      rootCache = new Map();
      diskCatalogSummaryCache.set(root, rootCache);
    }
    rootCache.set(name, { mtimeMs, summary });
    return summary;
  }

  return async (cwd, servers): Promise<CatalogCache> => {
    const {
      workspace: { normalizedProjectRoot },
    } = catalogPorts.get();
    const catalogCache = host.getCatalogCache();
    const view: CatalogCache = new Map();
    for (const [name, entry] of catalogCache) view.set(name, { summary: entry.summary });
    const mw = host.getMiddleware();
    if (mw === undefined) return view;
    // 项目 root 只解析一次（所有 project scope 服务器共用；空 cwd → 无项目单元）。
    const cwdRoot =
      cwd === undefined || cwd === null || cwd === ""
        ? undefined
        : await normalizedProjectRoot(cwd);
    for (const [name, { scope }] of servers) {
      if (name === "") continue;
      // root 解析：project scope → 项目 root；global scope → @global。
      // 跨 scope 不混配（同名项目级/全局是两份配置）。
      const root = scope === SCOPE_PROJECT ? cwdRoot : MIDDLEWARE_GLOBAL_ROOT;
      if (root === undefined) continue;
      const summary = await middlewareCatalogSummary(mw, root, name);
      if (summary !== undefined) view.set(name, { summary });
    }
    return view;
  };
}
