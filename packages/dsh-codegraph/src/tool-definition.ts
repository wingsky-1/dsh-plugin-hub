/**
 * codegraph 封装工具定义（8 个：codegraph_explore + impact/node/callers/callees/
 * search/files/status）——独立纯函数，便于测试与复用。
 *
 * 定位（issue #363 补充 3 架构收敛）：dsh-codegraph **不再自注册任何裸名工具**，
 * 本文件产出的是「封装定义」——execute 先 `codegraph sync <path>`（TTL 30s
 * 缓存）再内部转发底层真实 codegraph CLI（guardedCodegraph 管线），底层实现
 * 完全内部化，模型只见封装工具。定义经 mcp-manager 的
 * `registerServer.toolDefinitions` 通道注册（#362 补充 4），本插件不直接
 * `ctx.tools.register`。
 *
 * 契约要点（#356 回归）：
 * - 参数 schema 字段名必须是 `parameters`（@deepseek-ai/dsh-llm 的 ToolSchema
 *   契约），**不是** MCP 风格的 `inputSchema`——字段名错误会导致 dsh-tools
 *   投影时 `snapshotJsonValue(undefined)` 抛
 *   "tool \"<name>\" parameters must be lossless JSON before schema projection"；
 * - output 必含 schema + render（ToolOutputDefinition 契约），execute 返回
 *   canonical JSON 值，render 投影为模型可读的 ContentBlock[]；
 * - 参数 schema 与 CLI 1.6.0 实测对齐（#363：impact/callers/callees 无 file、
 *   node 无 line、files 用 filter 而非 path、search 映射 query 子命令、
 *   status 用位置参数 path 而非 --path）。
 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { findAmbiguousCandidates, guardedCodegraph, runCodegraph } from "./guard.ts";

/** 统一的 output 契约（canonical 值 { text }，render 投影为 ContentBlock[]）。 */
const TEXT_OUTPUT: ToolDefinition["output"] = {
  schema: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
    additionalProperties: false,
  },
  render(_args: unknown, value?: unknown) {
    const text = value && typeof value === "object" && "text" in value
      ? String((value as { text?: unknown }).text ?? "")
      : "";
    return [{ type: "text", text }];
  },
};

/** 公共样板文案单一事实源（防描述漂移；#414）：各工具参数/描述统一引用，
 * 不再手抄。projectPath 语义：显式传入优先，缺省补全为当前会话 worktree。 */
const SHARED = {
  projectPath: "Target worktree path (defaults to current session worktree)",
};

/** 从 execute 上下文取会话 cwd（缺省 undefined）。 */
function sessionCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | undefined {
  return exec?.agent?.session?.header?.cwd;
}

/** 构建 codegraph_explore 封装定义（纯函数，无副作用）。
 * 兼容旧名 buildGuardToolDefinition（#329/#356 公共导出面）。 */
export function buildExploreToolDefinition(): ToolDefinition {
  return {
    name: "codegraph_explore",
    description:
      "Explore code architecture and symbol definitions with call paths. Returns matching symbol source and usage context. " +
      "ALWAYS prioritize this over plain grep or direct file reading for structural code navigation. " +
      "Auto-syncs worktree index; projectPath defaults to current session worktree. " +
      "NOT for literal text search (use grep) or call hierarchy (use callers/callees).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Code question or symbol name (e.g. 'how is X called')" },
        projectPath: { type: "string", description: SHARED.projectPath },
      },
      required: ["query"],
    },
    output: TEXT_OUTPUT,
    // 只读查询，可与其他工具调用并行（不修改共享状态）。
    isConcurrencySafe: () => true,
    // canonical 值：{ text }；guardedCodegraph 返回纯文本（含拒绝引导），不抛错。
    execute: async (
      args: { query: string; projectPath?: string },
      exec: { agent?: { session?: { header?: { cwd?: string } } } },
    ) => {
      const cwd = sessionCwd(exec);
      const text = await guardedCodegraph(args, cwd, async (projectPath) => {
        return runCodegraph(["explore", args.query, "--path", projectPath]);
      }, "codegraph_explore");
      return { text };
    },
  };
}

/**
 * codegraph_status：查看索引状态与统计（同步检查当前 worktree 索引）。
 * CLI: codegraph status [path]（1.6.0 实测 path 是**位置参数**，非 --path；
 * -j/--json 输出 JSON）。任何查询前可先确认索引状态。
 */

/**
 * 通用构建器：一个裸名封装工具（映射某个 codegraph CLI 子命令）。
 * @param name 工具名（裸名，如 codegraph_impact）
 * @param description 工具描述（含「何时用此工具 / 何时用另一工具」互引，#363 验收 11）
 * @param params 参数 schema（与 CLI 实测对齐）
 * @param required 必填参数名
 * @param buildArgs 由工具参数构建 CLI 子命令参数；projectPath 由 execute 追加——
 *   flag 模式追加 `--path <p>`，positional 模式（status）追加位置参数 `<p>`
 * @param opts.toolLabel 提示语中的工具显示名（默认取 name）
 * @param opts.symbolParam 需要同名软消歧的符号参数名（#363）：execute 内先
 *   `codegraph query <symbol>` 列候选，跨文件同名 ≥2 → 返回「传完整限定名」提示
 *   （CLI 对同名符号合并输出不报错，不消歧模型会拿到无提示的混合结果）
 * @param opts.pathStyle projectPath 追加形态：`"flag"`（默认）追加 `--path <p>`；
 *   `"positional"` 追加位置参数 `<p>`（供 `codegraph status`——CLI 1.6.0 实测
 *   status 只接受位置参数 [path]，传 `--path` 报 unknown option #465）。positional
 *   模式下 projectPath 从 `args.path` 读取（显式传入即目标路径，否则缺省补全），
 *   且 buildArgs 不得自行追加位置参数（避免双位置参数 → too many arguments）
 */
function buildCliTool(
  name: string,
  description: string,
  params: ToolDefinition["parameters"],
  required: string[],
  buildArgs: (args: Record<string, unknown>) => string[],
  opts: { toolLabel?: string; symbolParam?: string; pathStyle?: "flag" | "positional" } = {},
): ToolDefinition {
  const label = opts.toolLabel ?? name;
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: params,
      required,
    },
    output: TEXT_OUTPUT,
    // 只读查询，可与其他工具调用并行（不修改共享状态）。
    isConcurrencySafe: () => true,
    execute: async (
      args: Record<string, unknown>,
      exec: { agent?: { session?: { header?: { cwd?: string } } } },
    ) => {
      const cwd = sessionCwd(exec);
      // positional 模式（status）：projectPath 语义由 `path` 参数承担（CLI 位置
      // 参数）；其余工具沿用 `projectPath` 参数。
      const projectPathKey = opts.pathStyle === "positional" ? "path" : "projectPath";
      const projectPath = typeof args[projectPathKey] === "string" ? args[projectPathKey] : undefined;
      // 同名歧义软消歧（#363）：符号参数有值 → 先 query 列候选。
      if (opts.symbolParam !== undefined) {
        const symbol = args[opts.symbolParam];
        if (typeof symbol === "string" && symbol !== "") {
          const candidates = await guardedCodegraph(
            { projectPath },
            cwd,
            async (p) => runCodegraph(["query", symbol, "--limit", "50", "--path", p]),
            label,
          );
          // 空结果（guardedCodegraph 已转中文提示）→ 无候选，不消歧。
          if (!candidates.includes("查询无结果") && !candidates.includes("执行失败")) {
            const files = findAmbiguousCandidates(candidates, symbol);
            if (files.length >= 2) {
              return {
                text: `${label}：符号 ${symbol} 在多个文件存在（候选：${files.join("、")}）。请传完整限定名消歧，或用 codegraph_search 确认归属。`,
              };
            }
          }
        }
      }
      const text = await guardedCodegraph(
        { projectPath },
        cwd,
        async (p) => {
          const cmd = buildArgs(args);
          // #465：status 只接受位置参数 [path]；其余子命令用 --path。
          if (opts.pathStyle === "positional") cmd.push(p);
          else cmd.push("--path", p);
          return runCodegraph(cmd);
        },
        label,
      );
      return { text };
    },
  };
}

/**
 * codegraph_impact：修改/删除某符号的影响面（调用方及其下游）。
 * CLI: codegraph impact <symbol> [-d depth] [-p path]（1.6.0 实测无 --file）。
 */
export function buildImpactToolDefinition(): ToolDefinition {
  return buildCliTool(
    "codegraph_impact",
    "Analyze downstream blast radius before modifying or deleting a symbol. Returns affected callers and dependents. " +
      "MANDATORY before modifying, refactoring, or deleting any shared code symbol. " +
      "symbol is required (use fully-qualified name if ambiguous); depth defaults to 2 (1-5). " +
      "NOT for literal text search (use grep) or inspect single symbol source (use codegraph_node).",
    {
      symbol: { type: "string", description: "Target symbol name (use fully-qualified name if ambiguous)" },
      depth: { type: "number", description: "Traversal depth (default 2, range 1-5; higher means more comprehensive but slower)", minimum: 1, maximum: 5 },
      projectPath: { type: "string", description: SHARED.projectPath },
    },
    ["symbol"],
    (args) => {
      const cmd = ["impact", String(args.symbol)];
      if (typeof args.depth === "number") cmd.push("--depth", String(args.depth));
      return cmd;
    },
    { symbolParam: "symbol" },
  );
}

/**
 * codegraph_node：单符号源码 + 调用/被调 trail（符号模式），或按文件读源码 +
 * 符号表与依赖方（文件模式）。CLI: codegraph node [symbol] [-f file] [--offset] [--limit]
 * [--symbols-only]（1.6.0 实测无 --line）。symbol 与 file 二选一（都传 → symbol 优先；
 * 都不传 → 报错给用法）。
 */
export function buildNodeToolDefinition(): ToolDefinition {
  return buildCliTool(
    "codegraph_node",
    "Inspect exact source and call trails for a specific symbol, or view a file's symbol table and dependencies. " +
      "Provide either symbol or file. Efficient alternative to reading entire large files into context. " +
      "NOT for literal text search (use grep) or impact analysis (use codegraph_impact).",
    {
      symbol: { type: "string", description: "Symbol name (symbol mode; mutually exclusive with file, symbol takes precedence). Required: provide either 'symbol' or 'file'" },
      file: { type: "string", description: "File path (file mode; mutually exclusive with symbol, e.g. 'src/auth.ts'). Required: provide either 'symbol' or 'file'" },
      offset: { type: "number", description: "File mode: 1-based start line (pagination)", minimum: 1 },
      limit: { type: "number", description: "File mode: max line count (pagination)", minimum: 1 },
      symbolsOnly: { type: "boolean", description: "File mode: return symbol table and dependencies only, omit raw source" },
      projectPath: { type: "string", description: SHARED.projectPath },
    },
    [],
    (args) => {
      const cmd = ["node"];
      if (typeof args.symbol === "string" && args.symbol !== "") {
        cmd.push(String(args.symbol));
      } else if (typeof args.file === "string" && args.file !== "") {
        cmd.push("--file", String(args.file));
        if (typeof args.offset === "number") cmd.push("--offset", String(args.offset));
        if (typeof args.limit === "number") cmd.push("--limit", String(args.limit));
        if (args.symbolsOnly === true) cmd.push("--symbols-only");
      }
      return cmd;
    },
    { symbolParam: "symbol" },
  );
}

/** 构建 callers/callees 通用注册（CLI: codegraph callers|callees <symbol> [-l limit]）。 */
function buildCallersCalleesTool(name: "codegraph_callers" | "codegraph_callees"): ToolDefinition {
  const sub = name === "codegraph_callers" ? "callers" : "callees";
  const description = name === "codegraph_callers"
    ? "List all incoming callers of a symbol ('who calls X'). Use this to understand how a function, class, or method is consumed across the codebase. " +
      "NOT for literal text search (use grep) or outgoing dependencies (use codegraph_callees)."
    : "List all outgoing dependencies and function calls made by a symbol ('what does X call'). Use this to inspect internal implementation dependencies. " +
      "NOT for literal text search (use grep) or incoming callers (use codegraph_callers).";
  return buildCliTool(
    name,
    description,
    {
      symbol: { type: "string", description: "Target symbol name (use fully-qualified name if ambiguous)" },
      limit: { type: "number", description: "Max results to return (default 20, range 1-100)", minimum: 1, maximum: 100 },
      projectPath: { type: "string", description: SHARED.projectPath },
    },
    ["symbol"],
    (args) => {
      const cmd = [sub, String(args.symbol)];
      if (typeof args.limit === "number") cmd.push("--limit", String(args.limit));
      return cmd;
    },
    { symbolParam: "symbol" },
  );
}

/** codegraph_callers：谁调用了某符号（CLI 1.6.0 实测无 --file）。 */
export function buildCallersToolDefinition(): ToolDefinition {
  return buildCallersCalleesTool("codegraph_callers");
}

/** codegraph_callees：某符号调用了谁（CLI 1.6.0 实测无 --file）。 */
export function buildCalleesToolDefinition(): ToolDefinition {
  return buildCallersCalleesTool("codegraph_callees");
}

/**
 * codegraph_search：按关键词搜索符号（映射 CLI query 子命令——CLI 1.6.0 无 search
 * 子命令，`codegraph search` 会回到顶层帮助；query 即「搜索符号」）。
 * kind 为过滤枚举（function/method/class/interface/type/variable/route/component），
 * 非法 kind 等价不过滤（CLI 实测 -k bogus → No results found）。
 */
export function buildSearchToolDefinition(): ToolDefinition {
  return buildCliTool(
    "codegraph_search",
    "Search codebase symbols and definitions by keyword or query text. " +
      "PRIMARY entry point for discovering symbols, functions, classes, and types across the codebase. " +
      "ALWAYS prioritize this over grep for locating code symbols. NOT for call hierarchy (use callers/callees) or raw strings (use grep).",
    {
      query: { type: "string", description: "Search query or keyword (symbol name or snippet)" },
      kind: {
        type: "string",
        description: "Filter by symbol kind: function/method/class/interface/type/variable/route/component",
        enum: ["function", "method", "class", "interface", "type", "variable", "route", "component"],
      },
      limit: { type: "number", description: "Max results to return (default 10)", minimum: 1 },
      projectPath: { type: "string", description: SHARED.projectPath },
    },
    ["query"],
    (args) => {
      const cmd = ["query", String(args.query)];
      if (typeof args.kind === "string") cmd.push("--kind", args.kind);
      if (typeof args.limit === "number") cmd.push("--limit", String(args.limit));
      return cmd;
    },
  );
}

/**
 * codegraph_files：从索引列出项目文件结构（tree/flat/grouped）。CLI: codegraph files
 * [-p path] [--filter dir] [--pattern glob] [--format tree|flat|grouped] [--max-depth n]
 * （1.6.0 实测参数名：filter 而非 path）。只覆盖已索引文件。
 */
export function buildFilesToolDefinition(): ToolDefinition {
  return buildCliTool(
    "codegraph_files",
    "List indexed project file structure (tree, flat, or grouped) with optional glob or path filtering. " +
      "Use for exploring directory layout. Note: only covers indexed files.",
    {
      filter: { type: "string", description: "Directory prefix filter (e.g. 'src')" },
      pattern: { type: "string", description: "Glob pattern filter (e.g. '*.ts')" },
      format: {
        type: "string",
        description: "Output format: tree (default) / flat / grouped",
        enum: ["tree", "flat", "grouped"],
      },
      maxDepth: { type: "number", description: "Max directory depth for tree format", minimum: 1 },
      projectPath: { type: "string", description: SHARED.projectPath },
    },
    [],
    (args) => {
      const cmd = ["files"];
      if (typeof args.filter === "string") cmd.push("--filter", args.filter);
      if (typeof args.pattern === "string") cmd.push("--pattern", args.pattern);
      if (typeof args.format === "string") cmd.push("--format", args.format);
      if (typeof args.maxDepth === "number") cmd.push("--max-depth", String(args.maxDepth));
      return cmd;
    },
  );
}

/**
 * codegraph_status：查看索引状态与统计（当前 worktree 的索引健康度、文件/符号数、
 * 待同步变更数）。CLI: `codegraph status [path]`（1.6.0 实测 path 是**位置参数**，
 * 非 --path；`-j/--json` 输出 JSON，查询前可先确认索引状态）。
 * 参数对齐 CLI 实测：无 file/line。
 */
export function buildStatusToolDefinition(): ToolDefinition {
  return buildCliTool(
    "codegraph_status",
    "Inspect local codegraph index health, symbol/file counts, and pending sync status for the current worktree.",
    {
      path: { type: "string", description: "Target worktree path (defaults to current session worktree; positional argument)" },
    },
    [],
    // 位置参数由 execute 按 pathStyle: "positional" 统一追加（#465：buildArgs 不再
    // 自行 push path，避免与追加的 projectPath 构成双位置参数 → too many arguments）。
    () => ["status"],
    { pathStyle: "positional" },
  );
}
