/**
 * dsh-mcp-manager — catalog/impl/directory/index.ts：工具目录内存态 + 投影 + last-good（#767 S1-3b）。
 *
 * 本块原先长在 connection/runtime/middleware.ts 的 McpMiddleware 上，与连接池共用一份实例状态；
 * 搬进来的理由（767-v6-STAGED-PLAN §2.6 裁定 A）：per-root 工具目录是「采集」的产物，采集与落盘
 * 分居两域会造出两个事实源。搬完后连接层只剩调用点，目录的写与读都经本块的实例。
 *
 * **宿主能力走入参契约而不是端口**（同 `CatalogViewHost` 的口径）：注册面视图、落盘路径与告警
 * 出口都由连接层在调用点构造递入——它们是连接的宿主面事实（`host.ctx.tools.schemas()` /
 * `host.catalogCachePath(root)` / `host.logger.warn`），本域只按值使用，不持有、不推导。
 *
 * 状态收进类实例字段而不是模块级 let：`gate:module-state` 明禁模块级可变状态（I9）。形态照
 * `catalog/impl/service` 的 CatalogPorts。
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CatalogServer, CatalogTool } from "../entries/type.ts";
import { catalogPorts } from "../service/index.ts";
import { fileMode, readJsonFile, writeFileAtomic } from "../../../shared/interface.ts";

/** 注册面视图：宿主 `ctx.tools.schemas()` 的返回形状（每次投影现取）。 */
export type SchemaView = ReadonlyArray<{
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
}>;

/** 投影入参：id 前缀（`mcp__<id>__`）源自连接层的账本键，其余为本域要用的宿主面事实。 */
export interface RegisteredProjectionInput {
  root: string;
  serverName: string;
  id: string;
  /** 注册面视图（连接层现取宿主注册表）。 */
  schemas: SchemaView;
  /**
   * 落盘路径：连接层用 `host.catalogCachePath(root)` 算，本域不推路径。接 thunk 是为了
   * 保住「路径求值失败 = 投影失败（unavailable 降级）」这条既有语义——调用点把求值推后
   * 到这里，求值抛错才落在本层的 catch 内（先求值再传参会让异常逃出降级面）。
   */
  cachePath: () => string;
  /** 凭据脱敏：本域不持服务器表，故这一层由调用方（连接层）闭包给出。 */
  redact: (error: unknown) => string;
  /** runtime 注入条目（内存态）不落盘（#413）：判定同样归调用方。 */
  isRuntimeServer: (name: string) => boolean;
  /** 告警出口（连接层转 host.logger.warn）。 */
  warn: (message: string) => void;
}

/**
 * 目录 last-good 写盘（H2 等价接入，#767 S2-C 筆3）：登记路径（`catalog/<hash>.json`）
 * 经 file-io `writeFileAtomic`（mode 取登记表 + 同路径写串行 + 失败清理临时名）；
 * 未登记路径（单测 tmp 覆盖 `cachePath`）回落硬化直写（随机后缀 + 失败清理）——
 * `writeFileAtomic` 对未登记路径抛 I6，直接调等于把回落写盘变成 warn（store.save 的 S2-B 同式）。
 * 序列化形状由调用方给整串（`{ version: 1, root, entries }` + 2 空格）逐字节不变：序列化收敛不是本笔的事。
 *
 * 模块函数而非类成员/导出：调用点同文件，导出会进导出面快照（零 diff 要求）。 */
async function writeDirectoryCacheFile(file: string, data: string): Promise<void> {
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
  // R1/R2 同式硬化：回落临时名加随机后缀 + 失败清理（与 file-io `writeOnce` 同式）；
  // mode 沿既有回落形状（无 mode），只补唯一性与清理，不改写盘语义。
  const dir = dirname(file);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, "utf8");
    await rename(tmp, file);
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/**
 * 每 root 的工具目录内存态 + last-good 磁盘读写 + 注册面投影。
 *
 * 「root 在册」由独立的 root 集合承载：只有 root 在册、且某服务器在册时读口才作答。这条区分
 * 是必须的——「单元根本没有该 root」与「root 在册但没有该服务器」在消费点走的是不同分支
 * （detail 报未发现，而 search/list 只是没有命中）。
 */
class CatalogDirectory {
  /** root →（裸 server 名 → 目录条目）。 */
  private readonly byRoot = new Map<string, Map<string, CatalogServer>>();
  /** 在册 root 集合：与 byRoot 同步维护，承载「单元存在但目录为空」这一可区分状态。 */
  private readonly roots = new Set<string>();

  /** 读口：root 的整份目录；root 不在册 → undefined。域外只读，故给 ReadonlyMap。 */
  serversFor(root: string): ReadonlyMap<string, CatalogServer> | undefined {
    return this.byRoot.get(root);
  }

  /** 读口：单服务器条目；root 或服务器不在册 → undefined。 */
  entryFor(root: string, serverName: string): CatalogServer | undefined {
    return this.byRoot.get(root)?.get(serverName);
  }

  /** 读口：root 在册的服务器裸名表（A1 归因文案用）。 */
  serverNamesFor(root: string): readonly string[] {
    const servers = this.byRoot.get(root);
    return servers === undefined ? [] : [...servers.keys()];
  }

  /**
   * 读口：该 id 前缀下是否已有注册工具——「已连上」的唯一正向证据（官方零状态 API）。
   * 注册面视图按入参现给，本域不自己去取宿主注册表。
   */
  hasRegisteredTools(schemas: SchemaView, id: string): boolean {
    const prefix = `mcp__${id}__`;
    return schemas.some(
      (schema) => typeof schema?.name === "string" && schema.name.startsWith(prefix),
    );
  }

  /**
   * 装载 root 的 last-good 目录缓存（缺失/损坏 → 空）。
   *
   * root 已在册即短路：单元创建是唯一载入点，重复读盘会拿磁盘那份**盖掉**内存里更新的投影
   * （落盘是异步 fire-and-forget，内存态才是权威）。
   */
  async ensureRootLoaded(root: string, cachePath: string): Promise<void> {
    // 已在册即短路（含**先投影后建单元**的顺序：投影会就地建表，此时不再读盘覆盖）。
    if (this.byRoot.has(root)) return;
    const servers = new Map<string, CatalogServer>();
    this.byRoot.set(root, servers);
    this.roots.add(root);
    try {
      // H2 等价接入（#767 S2-C 筆3）：容错读经 file-io `readJsonFile`（缺失/不可读/
      // 是目录/坏 JSON 一律回落 null，与既有 existsSync+readFile+parse 的「缺失/损坏 → 空」同族）；
      // 形状校验与条目清洗逐条不变。
      const parsed = await readJsonFile<{ entries?: Record<string, unknown> } | null>(cachePath);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.entries === "object" &&
        parsed.entries !== null
      ) {
        for (const [serverName, entry] of Object.entries(parsed.entries)) {
          const rec = entry as { discoveredAt?: unknown; tools?: unknown } | undefined;
          if (typeof rec !== "object" || rec === null) continue;
          servers.set(serverName, {
            discoveredAt: typeof rec.discoveredAt === "number" ? rec.discoveredAt : 0,
            tools: parsePersistedTools(rec.tools),
          });
        }
      }
    } catch {
      // 损坏缓存忽略
    }
  }

  /** 注销 root 的内存目录（拆毁单元时调用）；root 从未在册则无动作。 */
  dropRoot(root: string): void {
    this.byRoot.delete(root);
    this.roots.delete(root);
  }

  /**
   * 注销单个服务器的内存目录条目（remove/update 配置变更后调用；#392 遗留①）。
   * @returns 是否真的删掉了条目——调用方据此决定要不要广播状态（与 `Map.delete` 同口径）。
   */
  dropServer(root: string, serverName: string): boolean {
    return this.byRoot.get(root)?.delete(serverName) ?? false;
  }

  /** 条目不可用（发现或落盘失败）：置空并带脱敏后的原因（unavailable 段）。 */
  markUnavailable(root: string, serverName: string, reason: string): void {
    // 只翻转已有条目：不存在的服务器不因「标记不可用」而在册（那是另一条语义）。
    const servers = this.byRoot.get(root);
    if (servers === undefined || !servers.has(serverName)) return;
    servers.set(serverName, {
      discoveredAt: 0,
      tools: new Map(),
      unavailable: reason,
    });
  }

  /**
   * 注册面 → per-root 目录的投影（裁定 W + 裁定 K）。
   *
   * 官方注册名是 `mcp__<id>__<tool>`，去掉前缀即裸名；description 与 parameters 都在注册面
   * 视图里，不需要第二份工具清单。fresh 短路：TTL 内不重投影（discover 惰性语义），且短路发生
   * 在任何落盘动作之前。落盘失败（含路径求值失败）由本层 catch 收口成 unavailable 降级。
   */
  async projectRegisteredTools(input: RegisteredProjectionInput): Promise<void> {
    const servers = this.byRoot.get(input.root);
    if (servers === undefined) return;
    if (isCatalogFresh(servers.get(input.serverName))) return; // fresh
    const prefix = `mcp__${input.id}__`;
    try {
      const tools: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }> = [];
      for (const schema of input.schemas) {
        const name = schema?.name;
        if (typeof name !== "string" || !name.startsWith(prefix)) continue;
        tools.push({
          name: name.slice(prefix.length),
          description: typeof schema.description === "string" ? schema.description : "",
          inputSchema: (schema.parameters ?? {}) as Record<string, unknown>,
        });
      }
      servers.set(input.serverName, {
        discoveredAt: Date.now(),
        tools: boundCatalogTools(tools),
      });
      // 落盘失败由外层 catch 收口报错；不 await 会让失败变成未处理拒绝而不是日志
      await this.persistRoot(input.root, {
        cachePath: input.cachePath,
        isRuntimeServer: input.isRuntimeServer,
        warn: input.warn,
      });
    } catch (error) {
      this.markUnavailable(input.root, input.serverName, input.redact(error));
    }
  }

  /**
   * #413：从封装定义（toolDefinitions）投影目录，替代远端 discover。
   * 封装 execute 为调用方 JS 直呼（不经远端 MCP），目录数据源即调用方定义：
   * name/description 直取；dsh-tools 的 parameters（ToolSchema）即 JSON Schema
   * 形态，直接作 CatalogTool.inputSchema（与 supervisor 封装分支同口径）。
   */
  projectWrappedTools(input: {
    root: string;
    serverName: string;
    definitions: readonly unknown[];
  }): void {
    // root 未在册时就地建表：虚拟单元的投影是**纯内存写**，不依赖读盘完成（顺带避免
    // 「先写投影、后建单元」这一顺序下静默丢写）。
    let servers = this.byRoot.get(input.root);
    if (servers === undefined) {
      servers = new Map<string, CatalogServer>();
      this.byRoot.set(input.root, servers);
      this.roots.add(input.root);
    }
    servers.set(input.serverName, {
      discoveredAt: Date.now(),
      tools: wrappedToolsOf(input.definitions),
    });
  }

  /**
   * 目录 last-good 持久化（空采集不写盘；public 供测试与外部触发）。
   *
   * 路径求值由**调用方**给（连接层用 host.catalogCachePath(root) 算），写盘失败只 warn；
   * 路径求值失败按设计逃出本层、由投影的 catch 收口成 unavailable 降级。
   */
  async persistRoot(
    root: string,
    opts: {
      cachePath: () => string;
      isRuntimeServer: (name: string) => boolean;
      warn: (message: string) => void;
    },
  ): Promise<void> {
    const servers = this.byRoot.get(root);
    if (servers === undefined) return;
    let anyTools = false;
    const payload: Record<string, unknown> = {};
    for (const [serverName, entry] of servers) {
      // #413：runtime 注入条目（内存态，不落盘）目录只驻内存——防卸载/重启后
      // 幽灵条目被 ensureRootLoaded 载回（与 removeRootEntry 清理同类问题）。
      if (opts.isRuntimeServer(serverName)) continue;
      if (entry.tools.size === 0) continue;
      anyTools = true;
      payload[serverName] = {
        discoveredAt: entry.discoveredAt,
        tools: [...entry.tools.entries()].map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    }
    if (!anyTools) return;
    // 求值在 try 之外：路径求值失败是要被投影 catch 收口成 unavailable 的运行时错误。
    const cachePath = opts.cachePath();
    try {
      // H2 等价接入（#767 S2-C 筆3）：求值后 try 内写段经 `writeDirectoryCacheFile`
      // （登记路径走 `writeFileAtomic`，未登记回落硬化直写）；runtime 过滤/空采集早返/求值位置均不动。
      await writeDirectoryCacheFile(
        cachePath,
        JSON.stringify({ version: 1, root, entries: payload }, null, 2),
      );
    } catch (error) {
      opts.warn(`dsh-mcp-manager: catalog cache write failed: ${msgOf(error)}`);
    }
  }

  /**
   * 从磁盘 last-good 目录缓存中清除单服务器条目（remove/update 后调用；#392 遗留①）。
   * persistRoot 是全量覆盖且空采集不写盘——remove 后该 root 目录可能已空，若不显式
   * 清盘，磁盘缓存仍残留已删服务器条目，插件重启/@global 单元重建时 ensureRootLoaded
   * 把幽灵条目载回（ws_mcp_list 再次列出）。这里读现有缓存、删条目、写回；条目删空则
   * 删除缓存文件。内存目录由调用方（dropMiddlewareConnection）先行删除。
   */
  async removeRootEntry(
    root: string,
    serverName: string,
    opts: { cachePath: string; warn: (message: string) => void },
  ): Promise<void> {
    try {
      if (!existsSync(opts.cachePath)) return;
      const raw = await readFile(opts.cachePath, "utf8");
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        root?: unknown;
        entries?: Record<string, unknown>;
      } | null;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        typeof parsed.entries !== "object" ||
        parsed.entries === null
      )
        return;
      if (!(serverName in parsed.entries)) return;
      delete parsed.entries[serverName];
      if (Object.keys(parsed.entries).length === 0) {
        await rm(opts.cachePath, { force: true }).catch(() => {});
        return;
      }
      // #903 crash 残留 tmp：失败分支 rm 清理 + 随机后缀（与 file-io 同式）。
      const tmp = `${opts.cachePath}.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(
          tmp,
          JSON.stringify({ version: 1, root, entries: parsed.entries }, null, 2),
          "utf8",
        );
        await rename(tmp, opts.cachePath);
      } catch (writeError) {
        await rm(tmp, { force: true }).catch(() => {});
        throw writeError;
      }
    } catch (error) {
      opts.warn(`dsh-mcp-manager: catalog cache remove failed: ${msgOf(error)}`);
    }
  }
}

/** 目录域唯一的内存目录实例：类不外放，外部 new 不出第二份目录。 */
export const catalogDirectory = new CatalogDirectory();

/** 目录新鲜判定：有条目、无 unavailable 段、且发现时间在 TTL 内
 *  （投影惰性重做专用；纯时间比较，无副作用）。 */
export function isCatalogFresh(catalog: CatalogServer | undefined): boolean {
  const {
    connection: { CATALOG_TTL_MS },
  } = catalogPorts.get();
  return (
    catalog !== undefined &&
    catalog.unavailable === undefined &&
    Date.now() - catalog.discoveredAt <= CATALOG_TTL_MS
  );
}

/** 单服务器目录装箱（投影专用纯函数）：按限额收敛工具清单——
 *  工具数上限 MAX_TOOLS_PER_SERVER、单描述字节上限 MAX_BYTES_PER_TOOL（超限
 *  截断）、累计字节上限 MAX_TOTAL_CATALOG_BYTES（超限即停）。行为与原
 *  discover 内联循环逐位一致（含 totalBytes 对截断后条目的计算口径）。 */
export function boundCatalogTools(
  tools: Iterable<{ name?: unknown; description?: unknown; inputSchema?: unknown }>,
): Map<string, CatalogTool> {
  const {
    connection: { MAX_TOOLS_PER_SERVER, MAX_BYTES_PER_TOOL, MAX_TOTAL_CATALOG_BYTES },
  } = catalogPorts.get();
  const bounded = new Map<string, CatalogTool>();
  let totalBytes = 0;
  for (const tool of tools) {
    if (bounded.size >= MAX_TOOLS_PER_SERVER) break;
    const name = String(tool.name ?? "");
    if (name === "") continue;
    const description = typeof tool.description === "string" ? tool.description : "";
    // B9：描述按 UTF-8 字节截断（slice 按字符会让中文等多字节场景超上限）；
    // 逐字符累加字节，保证截断点落在字符边界（不产生替换符）。
    let desc = description;
    if (Buffer.byteLength(desc, "utf8") > MAX_BYTES_PER_TOOL) {
      let bytes = 0;
      let cut = 0;
      while (
        cut < desc.length &&
        bytes + Buffer.byteLength(desc[cut], "utf8") <= MAX_BYTES_PER_TOOL
      ) {
        bytes += Buffer.byteLength(desc[cut], "utf8");
        cut += 1;
      }
      desc = desc.slice(0, cut);
    }
    bounded.set(name, {
      description: desc,
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
    });
    // B9：totalBytes 全字节口径（JSON.stringify().length 按码元计，低估字节数）
    totalBytes +=
      Buffer.byteLength(desc, "utf8") +
      Buffer.byteLength(JSON.stringify(bounded.get(name)?.inputSchema ?? {}), "utf8");
    if (totalBytes > MAX_TOTAL_CATALOG_BYTES) break;
  }
  return bounded;
}

/** 磁盘条目里的工具数组 → 内存工具表（非字符串名跳过；描述与 schema 缺省补空）。 */
function parsePersistedTools(raw: unknown): Map<string, CatalogTool> {
  const tools = new Map<string, CatalogTool>();
  if (!Array.isArray(raw)) return tools;
  for (const tool of raw) {
    const rec = tool as
      { name?: unknown; description?: unknown; inputSchema?: unknown } | undefined;
    if (typeof rec !== "object" || rec === null || typeof rec.name !== "string") continue;
    tools.set(rec.name, {
      description: typeof rec.description === "string" ? rec.description : "",
      inputSchema: (rec.inputSchema ?? {}) as Record<string, unknown>,
    });
  }
  return tools;
}

/** 封装定义 → 工具表（空名跳过；description 非字符串归空）。 */
function wrappedToolsOf(definitions: readonly unknown[]): Map<string, CatalogTool> {
  const tools = new Map<string, CatalogTool>();
  for (const definition of definitions) {
    const def = definition as { name?: unknown; description?: unknown; parameters?: unknown };
    if (typeof def?.name !== "string" || def.name === "") continue;
    tools.set(def.name, {
      description: typeof def.description === "string" ? def.description : "",
      inputSchema: (def.parameters ?? {}) as Record<string, unknown>,
    });
  }
  return tools;
}

/** 错误取消息：本域不 import pipeline 门面（会多一条跨域类型边），故只取 message 字段。 */
function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
