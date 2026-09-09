/**
 * dsh-mcp-manager — catalog/cache-view.ts：注入端目录缓存视图（#664 阶段 5）。
 *
 * 自 src/manager.ts 迁出（catalog 域）：合成注入端目录缓存视图——以 B
 * （supervisor 摘要缓存）为基底，逐服务器按「scope + 模式」用中间层目录摘要
 * 覆盖（#569 修复核心）。diskCatalogSummaryCache（mtime 缓存）随迁，以工厂
 * 闭包持有（防多实例共享串状态）；宿主最小面 CatalogViewHost 解耦 manager
 * 细节（C-DIR：catalogViewFor 私有缓存随迁，薄桥接）。
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { dshHome } from "../../../../shared/dsh-home.js";
import type { McpMiddleware } from "../middleware.ts";
import type { ServerConfig } from "../types/interface.ts";
import { readCatalogServerFromDisk } from "../config/store/interface.ts";
import { normalizedProjectRoot, SCOPE_PROJECT, MIDDLEWARE_GLOBAL_ROOT } from "../workspace/interface.ts";
import { summarizeToolDescriptions } from "./entries.ts";
import type { CatalogCache } from "./entries.ts";

/** 目录缓存文件（连接成功时把工具描述摘要持久化于此；目录 digest 的稳定数据源）。 */
export function catalogCacheFile() {
  return join(dshHome(), "dsh-mcp-catalog.json");
}

/** catalogViewFor 的宿主最小面（manager 提供；中间层/模式可能热切换，用读取器）。 */
export interface CatalogViewHost {
  getCatalogCache(): CatalogCache;
  getMiddleware(): McpMiddleware | undefined;
  getMiddlewareMode(): string;
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
 * - **判 middlewareMode 而非 middleware 实例**（评审修正①）：热切换 off 后
 *   middleware 实例与 units 残留（apply.setMiddlewareMode 只卸载 ws_mcp_* 工具），
 *   判实例会错误读中间层目录。
 *
 * root 映射（与 middlewareTakes 同口径 + 热切换残留兜底，评审修正②③）：
 * - mode=off → 全部走 B（无中间层目录语义）；
 * - scope=project → 该 cwd 归一化项目 root 的单元 → 无则磁盘 last-good；
 * - scope=global → @global 单元/磁盘（all 模式权威；project 模式热切换残留/
 *   上次 all 会话的 last-good 兜底）→ 仍无则保留 B。
 * 严格按 scope 解析、不跨 scope 混配同名服务器（防不同配置被错配）。
 * 单元不存在时读磁盘 last-good（带 mtime 缓存），**不主动 projectUnitFor**
 * ——pre-step 无连接副作用。
 *
 * diskCatalogSummaryCache（root → server → { mtimeMs, summary }）在闭包内
 * 持有：防 pre-step 每轮重复读盘解析（目录文件最大 ~256KB，JSON parse 有成本）。
 */
export function makeCatalogViewFor(host: CatalogViewHost): CatalogViewResolver {
  const diskCatalogSummaryCache = new Map<string, Map<string, { mtimeMs: number; summary: string | undefined }>>();

  /** 查中间层单服务器目录摘要：内存单元优先，单元缺失/无该服务器 → 磁盘
   * last-good 兜底（带 mtime 缓存，防 pre-step 每轮读盘）。返回 undefined
   * 表示中间层无此服务器数据（调用方保留 B 兜底）。 */
  const middlewareCatalogSummary = async (mw: McpMiddleware, root: string, name: string): Promise<string | undefined> => {
    const unit = mw.units.get(root);
    const catalog = unit?.catalog.get(name);
    const tools = catalog?.tools;
    if (tools !== undefined && tools.size > 0 && catalog?.unavailable === undefined) {
      // 内存单元（已含磁盘 last-good：单元创建时 loadCatalogCache 载入）→ 直接聚合。
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
  };

  return async (cwd, servers): Promise<CatalogCache> => {
    const catalogCache = host.getCatalogCache();
    const view: CatalogCache = new Map();
    for (const [name, entry] of catalogCache) view.set(name, { summary: entry.summary });
    const mw = host.getMiddleware();
    if (mw === undefined || host.getMiddlewareMode() === "off") return view;
    // 项目 root 只解析一次（所有 project scope 服务器共用；空 cwd → 无项目单元）。
    const cwdRoot = cwd === undefined || cwd === null || cwd === "" ? undefined : await normalizedProjectRoot(cwd);
    for (const [name, { scope }] of servers) {
      if (name === "") continue;
      // root 解析：project scope → 项目 root；global scope → @global（all 权威，
      // project 模式残留兜底）。跨 scope 不混配（同名项目级/全局是两份配置）。
      const root = scope === SCOPE_PROJECT ? cwdRoot : MIDDLEWARE_GLOBAL_ROOT;
      if (root === undefined) continue;
      const summary = await middlewareCatalogSummary(mw, root, name);
      if (summary !== undefined) view.set(name, { summary });
    }
    return view;
  };
}