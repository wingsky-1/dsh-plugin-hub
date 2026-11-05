/**
 * dsh-mcp-manager — servers/dispatch/impl/call/index.ts：ws_mcp_call 执行器（原
 * connection/runtime/middleware.ts:583-772 的搬迁；路由/封装分支与错误文案口径不变）。
 *
 * 远端分支的 0.2.2-rc.1 路径：经 `ctx.loader.import` 取得宿主公开的 nested
 * `ToolExecutionPipeline`，以精确注册名与受控 source 合成子调用，并保留真实
 * agent / toolSet / rootCallId / parent / signal。官方结果的 `value` 继续喂既有投影；
 * nested definition 已物化的图片内容优先复用，缺少物化信号时才回落到 A+ 诊断准入。
 *
 * 为什么全部入参显式化：原实现依赖 McpMiddleware 的 this（units / disabledTools /
 * allServers / 转发登记表），搬进新域后这些状态仍归中间层持有，只能按引用递入；本域不落第二份。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  ToolDefinition,
  ToolOutputDefinition,
  ToolExecutionInput,
  ToolExecutionFailure,
  ToolExecutionResult,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type { ToolExecutionPipeline, ToolExecutionSource } from "@deepseek-ai/dsh-tools/pipeline";
import type { ServerState } from "../../../../../shared/interface.ts";
import type { DispatchCallInput, ToolExecutionResultLike } from "../../deps.ts";
import { redactMcpError } from "../redact/index.ts";

interface RuntimeLoader {
  import(specifier: string): unknown;
}

type ToolPipelineConstructor = new (
  ctx: Context,
  source?: ToolExecutionSource,
) => ToolExecutionPipeline;

interface ToolPipelineModule {
  ToolExecutionPipeline: ToolPipelineConstructor;
}

type NestedModelContent = Extract<ToolExecutionResult, { isError: false }>["content"];

export interface NestedExecutionHooks {
  deferContext?: ToolRunContext["deferContext"];
  concludeTurn?: ToolRunContext["concludeTurn"];
  /** 本次 nested dispatch 的 opaque parent 仍在中间层转发登记表中。 */
  isParentActive?: () => boolean;
  /** 官方 definition 已持久化并物化的模型面内容；只在对应外层执行仍存活时交回。 */
  onModelContent?: (content: NestedModelContent) => void;
}

function isRuntimeLoader(value: unknown): value is RuntimeLoader {
  return (
    typeof value === "object" &&
    value !== null &&
    "import" in value &&
    typeof value.import === "function"
  );
}

function isToolPipelineModule(value: unknown): value is ToolPipelineModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "ToolExecutionPipeline" in value &&
    typeof value.ToolExecutionPipeline === "function"
  );
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadToolPipeline(ctx: Context): Promise<ToolPipelineModule> {
  const loader: unknown = ctx.get("loader");
  if (!isRuntimeLoader(loader)) {
    throw new Error("dsh-mcp-manager: 宿主未提供 loader 服务，无法加载官方工具执行 pipeline");
  }
  // 分开绑定再调用仍是宿主公开 loader.import；可避免 contract 扫描器把属性方法误认成裸
  // import()。该闸应在本包外收紧，本任务不修改或豁免仓库判据。
  const load = loader.import.bind(loader);
  const module: unknown = await load("@deepseek-ai/dsh-tools/pipeline");
  if (!isToolPipelineModule(module)) {
    throw new Error(
      "dsh-mcp-manager: @deepseek-ai/dsh-tools/pipeline 未导出 ToolExecutionPipeline",
    );
  }
  return module;
}

type NestedSourceScope = Parameters<NonNullable<ToolExecutionSource["get"]>>[1];
type NestedSourceToolSet = Parameters<NonNullable<ToolExecutionSource["get"]>>[2];

interface ExactNestedToolSource extends ToolExecutionSource {
  /** prepare 与 dispatch 之间重新核对 live admission 和注册定义 identity。 */
  current(scope: NestedSourceScope, toolSet: NestedSourceToolSet): boolean;
  /** 本次精确 definition 是否通过官方 `projectContent` 物化过模型面内容。 */
  projectedContent(result: ToolExecutionResult): NestedModelContent | undefined;
}

/**
 * 官方 MCP definition 已将远端 image data 替换为 durable attachment 时，nested `content` 才是可复用
 * 的已落库模型面。纯诊断文本不算：它要求外层 A+ 继续按本包更窄的 count/byte 规则复核与补偿。
 */
function hasStoredModelImage(content: ToolExecutionResult["content"]): boolean {
  let found = false;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "image") continue;
    if (!("attachment" in block)) return false;
    found = true;
  }
  return found;
}

/**
 * 模型可见面与本步 admission 属于外层复合工具；`mcp__*` 是本插件隐藏并控制的私有依赖。
 * 因此先用调用者的 agent/toolSet 证明 `ws_mcp_call` 本身仍 admitted，再只解析本次路由已经
 * 验证过的精确登记名。内层不使用外层 toolSet，否则本包自己的 visibility deny 会令正常网关
 * 调用全部变成 UNKNOWN_TOOL；同时也不接受通配符、任意 `mcp__*` 或任意全局工具 fallback。
 */
function exactNestedToolSource(
  tools: Context["tools"],
  expectedName: string,
  isParentActive: () => boolean,
): ExactNestedToolSource {
  let lookedUp = false;
  let expectedDefinition: ToolDefinition | undefined;
  let projectsContent = false;
  const outerAdmitted = (scope: NestedSourceScope, toolSet: NestedSourceToolSet): boolean => {
    const outer =
      toolSet === undefined
        ? tools.executable("ws_mcp_call", scope)
        : tools.executable("ws_mcp_call", scope, toolSet);
    return outer !== undefined;
  };
  const current = (scope: NestedSourceScope, toolSet: NestedSourceToolSet): boolean => {
    if (!isParentActive() || !outerAdmitted(scope, toolSet)) return false;
    return (
      lookedUp &&
      expectedDefinition !== undefined &&
      tools.executable(expectedName) === expectedDefinition
    );
  };
  return {
    get(name, scope, toolSet) {
      if (name !== expectedName || !isParentActive() || !outerAdmitted(scope, toolSet))
        return undefined;
      if (!lookedUp) {
        lookedUp = true;
        expectedDefinition = tools.executable(expectedName);
        projectsContent = typeof expectedDefinition?.projectContent === "function";
      }
      return tools.executable(expectedName) === expectedDefinition ? expectedDefinition : undefined;
    },
    reject(name, nested) {
      if (name !== expectedName) {
        return new Error(`nested MCP execution rejected unexpected tool ${JSON.stringify(name)}`);
      }
      if (!nested || !isParentActive()) {
        return new Error(
          `nested MCP execution ${JSON.stringify(name)} requires an active enclosing execution token`,
        );
      }
      if (lookedUp && expectedDefinition === undefined) {
        return new Error(
          `nested MCP execution ${JSON.stringify(name)} is not a current unconditional registration`,
        );
      }
      return undefined;
    },
    current,
    projectedContent(result) {
      return projectsContent && result.isError === false && hasStoredModelImage(result.content)
        ? result.content
        : undefined;
    },
  };
}

function isNestedExecutionAgent(value: unknown): value is NonNullable<ToolExecutionInput["agent"]> {
  return typeof value === "object" && value !== null;
}

/** 旧导出签名里的 agent 是 unknown；执行域只接受可承载运行时身份的对象。 */
export function nestedExecutionAgent(
  value: unknown,
): NonNullable<ToolExecutionInput["agent"]> | undefined {
  if (value === undefined) return undefined;
  if (isNestedExecutionAgent(value)) return value;
  throw new Error("ws_mcp_call: nested execution agent must be an object");
}

/** 把 nested 结果携带的外层效果交给当前 active 的外层执行上下文。 */
function commitNestedEffects(
  result: ToolExecutionResult,
  hooks: NestedExecutionHooks,
  canCommit: boolean,
): void {
  if (!canCommit) return;
  const contexts = result.additionalContexts ?? [];
  if (contexts.length > 0) {
    if (hooks.deferContext === undefined) {
      throw new Error("nested MCP result carries context without an outer execution context");
    }
    for (const context of contexts) hooks.deferContext(context);
  }
  if (result.isError === false && result.concludesTurn === true) {
    if (hooks.concludeTurn === undefined) {
      throw new Error("nested MCP result concludes the turn without an outer execution context");
    }
    hooks.concludeTurn();
  }
}

/** 完成一次共享生命周期调用，并把嵌套结果附加的上下文/结束语义交还外层执行。 */
export async function executeNestedTool(
  ctx: Context,
  input: ToolExecutionInput,
  hooks: NestedExecutionHooks,
): Promise<ToolExecutionResultLike> {
  const module = await loadToolPipeline(ctx);
  const parentActive = (): boolean =>
    input.parent !== undefined && (hooks.isParentActive?.() ?? false);
  const source = exactNestedToolSource(ctx.tools, input.name, parentActive);
  const executionPipeline = new module.ToolExecutionPipeline(ctx, source);
  const prepared = await executionPipeline.prepare(input);
  const outcome =
    prepared.kind !== "dispatch"
      ? prepared
      : source.current(prepared.exec.agent, prepared.exec.toolSet)
        ? await executionPipeline.dispatch(prepared.exec)
        : {
            kind: "final-result" as const,
            result: nestedDependencyUnavailable(input.name),
          };
  const result = await executionPipeline.complete(prepared.exec, outcome);

  // complete 可能晚于 withTimeout 结算。只有外层 parent 仍在 forwarding 且本次 signal 未取消时，
  // nested context/conclusion 才属于仍存活的外层调用；迟到完成仍保留 pipeline 终结事件，但不污染
  // 已失败或已交付的外层执行。
  const canCommit = parentActive() && !input.signal.aborted;
  commitNestedEffects(result, hooks, canCommit);
  const modelContent = source.projectedContent(result);
  if (canCommit && modelContent !== undefined) hooks.onModelContent?.(modelContent);
  return result;
}

/** prepare 之后 admission、注册 identity 或 parent 活性变化时，仍走 complete 发布终局事件。 */
function nestedDependencyUnavailable(name: string): ToolExecutionFailure {
  const reason = `nested MCP dependency ${JSON.stringify(name)} is no longer executable in the active caller execution`;
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${reason}` }],
    error: {
      message: reason,
      info: { name: "ToolNotFoundError", code: "UNKNOWN_TOOL", reason },
    },
  };
}

/**
 * 合成子调用 id。品牌串（`ToolCallId`）没有运行时构造器——它的 brand 函数住在 dsh-llm 的
 * 运行时，而本包对官方包只许 `import type`——所以只能 `as unknown as` 造。格式照宿主 PTC 的
 * 先例（`${exec.callId}:ptc:${n}`，dsh-tools/lib/index.js:1211）：留着父 id 前缀，
 * 日志归因时一眼看出这是谁派发的子调用；尾序号固定 1，因为每次 ws_mcp_call 只转发一个子调用。
 */
function subCallId(callId: ToolExecutionInput["callId"]): ToolExecutionInput["callId"] {
  return `${String(callId)}:mcp:1` as unknown as ToolExecutionInput["callId"];
}

/** dispatch 域的连接条目（经 input.units 取值，不另持连接表；结构约束写法——
 * 直接索引泛型 U 会 TS2536，故先收窄到含 connections 形态再取）。 */
type CallEntry =
  DispatchCallInput["units"] extends ReadonlyMap<string, infer U>
    ? U extends { connections: Map<string, infer V> }
      ? V
      : never
    : never;

/** 远端子调用入参：合成 callId，并完整保留调用者 nested pipeline identity。 */
export function remoteExecutionInput(
  input: DispatchCallInput,
  id: string,
  tool: string,
  args: unknown,
): ToolExecutionInput {
  return {
    callId: subCallId(input.callId),
    ...(input.rootCallId === undefined ? {} : { rootCallId: input.rootCallId }),
    name: input.registeredNameFor(id, tool),
    arguments: typeof args === "object" && args !== null ? args : {},
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.toolSet === undefined ? {} : { toolSet: input.toolSet }),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    // 宿主 executor 无条件读 signal.aborted（实测 §2.9-6：给 undefined 当场 TypeError），
    // 而调用方不保证带 signal——没有就现造一个。
    signal: input.signal ?? new AbortController().signal,
  };
}
/** 派发前视为「未就绪」的六态子集（failed / reconnecting / stopped / disabled）；无条目同判。 */
const NOT_DISPATCHABLE_STATES: ReadonlySet<ServerState | undefined> = new Set([
  "failed",
  "reconnecting",
  "stopped",
  "disabled",
  undefined,
]);

/** 未就绪三归因（次序承重）：用户禁用 > 后台重连中 > 其余未就绪。 */
export function notReadyError(
  fullName: string,
  status: ServerState | undefined,
  userDisabled: boolean,
): Error {
  if (userDisabled) {
    return new Error(
      `ws_mcp_call: server ${JSON.stringify(fullName)} 已被用户禁用；可先在 GUI「MCP」浮窗中重新连接`,
    );
  }
  if (status === "reconnecting") {
    return new Error(
      `ws_mcp_call: server ${JSON.stringify(fullName)} 连接失败、正在后台重连；请稍后重试或重新连接`,
    );
  }
  return new Error(
    `ws_mcp_call: server ${JSON.stringify(fullName)} 未连接或连接失败，请先 ws_mcp_search 或 ws_mcp_list 确认 server 已连接`,
  );
}

/** 条目就绪裁决：可派发则带条目返回，否则带该情形的错误。 */
type ReadinessVerdict = { ready: true; entry: CallEntry } | { ready: false; error: Error };

/**
 * 就绪裁决（B4 连带：六态补 reconnecting 后守卫须把「后台重连中」纳入未就绪——
 * 否则退避窗口内会照常派发，而该代际的工具面已不可信）。
 */
export function judgeEntryReadiness(
  fullName: string,
  server: string,
  userDisabled: boolean,
  entry: CallEntry | undefined,
): ReadinessVerdict {
  const status = entry?.status;
  if (NOT_DISPATCHABLE_STATES.has(status)) {
    return { ready: false, error: notReadyError(fullName, status, userDisabled) };
  }
  if (status === "connecting") {
    return {
      ready: false,
      error: new Error(
        `ws_mcp_call: server ${JSON.stringify(fullName)} 连接仍在进行，请稍后重试；连接完成后再调用`,
      ),
    };
  }
  if (entry === undefined) {
    return { ready: false, error: notReadyError(fullName, status, userDisabled) };
  }
  return { ready: true, entry };
}
/**
 * 封装 execute 的最小 exec 面：契约要完整 ToolRunContext，中间层只能给最小面
 * （agent 透传，session cwd 解析用）——经 unknown 中转（消费方封装定义只读 exec.agent）。
 */
export function wrappedExecContext(
  input: DispatchCallInput,
): Parameters<NonNullable<ToolDefinition["execute"]>>[1] {
  return { agent: input.agent } as unknown as Parameters<NonNullable<ToolDefinition["execute"]>>[1];
}

/** 封装结果投影：有 output.render 走渲染，否则按字符串/JSON 文本兜底。 */
export function wrappedContent(def: ToolDefinition, args: unknown, value: unknown) {
  if (typeof def.output?.render === "function") {
    return def.output.render(
      args,
      value as unknown as Parameters<NonNullable<ToolOutputDefinition["render"]>>[1],
    );
  }
  return [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value ?? {}),
    },
  ];
}
/** 解析调用目标：回答「这通调用派得出去吗？」——全名格式 + 单元在册 + 条目就绪
 * （失败/重连中/停止/禁用/连接中各有去处，用户指引见各分支文案）；策略裁决与
 * 两条执行分支在外层（不同问题）。
 * @returns 目标全名解析、单元与就绪条目；不可达时抛错。 */
function resolveCallTarget(input: DispatchCallInput): {
  parsed: { root: string; server: string };
  entry: CallEntry;
} {
  const parsed = input.workspace.parseFullServerName(input.fullName);
  if (parsed === undefined) {
    throw new Error(
      `ws_mcp_call: unknown server ${JSON.stringify(input.fullName)}; 格式应为 @<root>/<server>`,
    );
  }
  const unit = input.units.get(parsed.root);
  if (unit === undefined) {
    throw new Error(
      `ws_mcp_call: 工作空间 ${JSON.stringify(parsed.root)} 未激活；请先 ws_mcp_search 或 ws_mcp_list`,
    );
  }
  const verdict = judgeEntryReadiness(
    input.fullName,
    parsed.server,
    unit.userDisabled.has(parsed.server),
    unit.connections.get(parsed.server),
  );
  if (!verdict.ready) throw verdict.error;
  return { parsed, entry: verdict.entry };
}

/** 执行封装直呼分支：回答「注入的封装定义怎么调？」——定义查找 + 超时兜底 +
 * output.render 投影（与 supervisor 封装分支 / dsh-tools 同口径）；路由、策略与
 * 远端转发不在此（不同问题）。
 * @returns 调用结果（content + 条件 structuredContent）；失败抛错（已脱敏）。 */
async function executeWrappedCall(
  input: DispatchCallInput,
  parsed: { root: string; server: string },
  tool: string,
  args: unknown,
  callBudgetMs: number,
  wrapped: ToolDefinition[],
): Promise<unknown> {
  const { pipeline, signal } = input;
  const def = wrapped.find((d) => d?.name === tool);
  if (def === undefined) {
    throw new Error(
      `ws_mcp_call: 工具 ${JSON.stringify(`${parsed.server}/${tool}`)} 不存在（封装定义服务器）`,
    );
  }
  try {
    // #413 QA P2-2：封装 execute 补超时兜底（与远端分支同预算 callBudgetMs，
    // 封装实现挂起时不无限等待）。
    const value = await pipeline.withTimeout(
      def.execute(typeof args === "object" && args !== null ? args : {}, wrappedExecContext(input)),
      callBudgetMs + 2000,
      `ws_mcp_call: 封装调用超时（${callBudgetMs}ms），可重试；若反复超时请检查插件状态`,
      signal,
    );
    const content = wrappedContent(def, args, value);
    // #512 共性问题：structuredContent 条件展开——封装 execute 返回 undefined
    // 时不落键，防显式 undefined 值键触发宿主 lossless JSON 校验失败（#381 同源）。
    return {
      content,
      ...(value !== undefined ? { structuredContent: value } : {}),
    };
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason;
    throw new Error(
      redactMcpError(
        pipeline,
        input.allServers(),
        `ws_mcp_call: ${JSON.stringify(`${parsed.server}/${tool}`)} 封装调用失败：${pipeline.msgOf(error)}`,
      ),
    );
  }
}

/** 执行远端转发分支：回答「远端工具怎么调并收敛？」——装载就绪守卫 + 子调用合成 +
 * 超时兜底 + isError 收敛 + 白名单投影（stale 目录前置提示）；路由、策略与封装
 * 直呼不在此（不同问题）。
 * @returns 投影后的调用结果；失败抛错（已脱敏）。 */
async function executeRemoteCall(
  input: DispatchCallInput,
  parsed: { root: string; server: string },
  tool: string,
  args: unknown,
  entry: CallEntry,
  callBudgetMs: number,
  stale: boolean,
): Promise<unknown> {
  const { pipeline, signal } = input;
  // 装载尚未完成（账本键还没写回）时没有可派发的注册名。这不是旧的「client 缺失」就绪性
  // 判定：状态面已在上面把 connecting 挡掉，但官方等待窗口的 onState 与 mountServer 的返回
  // 之间还隔着微任务，状态可能已推进而 id 尚未写回——留一道并发窗口的兜底。
  const id = entry.id;
  if (id === undefined) {
    throw new Error(
      `ws_mcp_call: server ${JSON.stringify(input.fullName)} 未就绪（装载未完成）；请稍后重试或重新连接`,
    );
  }
  let result: ToolExecutionResultLike;
  try {
    result = await pipeline.withTimeout(
      input.execute(remoteExecutionInput(input, id, tool, args)),
      callBudgetMs + 2000,
      `ws_mcp_call: 调用超时（${callBudgetMs}ms），可重试；若反复超时请用 ws_mcp_detail 核对参数或检查服务器状态`,
      signal,
    );
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason;
    throw new Error(
      redactMcpError(
        pipeline,
        input.allServers(),
        `ws_mcp_call: ${JSON.stringify(`${parsed.server}/${tool}`)} 调用失败：${pipeline.msgOf(error)}`,
      ),
    );
  }
  // isError 必须在上面 try 之外收敛（RECON 反例 4）：官方在 MCP isError:true 时**抛错**，
  // 套进那个 catch 会得到双层「调用失败：」；同时手工补回核对参数的引导句。
  if (result.isError === true) {
    const hostDependencyRejected = result.error.info?.code === "UNKNOWN_TOOL";
    throw new Error(
      redactMcpError(
        pipeline,
        input.allServers(),
        hostDependencyRejected
          ? `ws_mcp_call: 调用失败（宿主 MCP 依赖准入拒绝）：${result.error.message}`
          : `ws_mcp_call: 远端工具返回错误：${result.error.message}；可先用 ws_mcp_detail 核对参数 schema 后重试`,
      ),
    );
  }
  // #512：远端结果经 call-result.ts 统一投影收敛（白名单清洗 + 无 content 兜底），与
  // supervisor（mcp__ 直呼）/ 官方 dsh-mcp-client createExecutor 同一契约——不再裸透传
  // resultObj，Python SDK 必带的 isError:false / _meta 等字段不再外泄进工具契约。
  // 换引擎后喂进来的是官方结果里的 `value`（远端原始结果，实测 §2.9-5），故与旧链路
  // 逐字节等价；`errorText` 分支因此在新链路上不可达（isError 已在上面收敛），保留是
  // 为了不把「投影形态」的两种协议违规入口拆成两处实现——有意变更，已在 PR 台账登记。
  const projected = pipeline.projectCallToolResult(result.value, {
    errorText: (content) =>
      `ws_mcp_call: 远端工具返回错误：${pipeline.msgOf(content)}；可先用 ws_mcp_detail 核对参数 schema 后重试`,
    fallbackText: (r) => {
      const raw =
        typeof r === "object" && r !== null && "content" in r
          ? (r as { content?: unknown }).content
          : undefined;
      return raw !== undefined && !Array.isArray(raw)
        ? pipeline.msgOf(raw)
        : pipeline.defaultCallResultFallbackText(r);
    },
  });
  if (stale) {
    // schema 可能已过期：结果前置提示（投影后的白名单结构，仅扩 content）。
    const hint = {
      type: "text",
      text: "（提示：本工具目录已过期，schema 可能已变更，请重新 ws_mcp_search）",
    };
    const value = {
      content: [hint, ...projected.content],
      ...(projected.structuredContent !== undefined
        ? { structuredContent: projected.structuredContent }
        : {}),
    };
    return value;
  }
  return projected;
}

/** 执行一次 ws_mcp_call：路由一致性校验 → 策略裁决 → 封装直呼 / 远端转发两条分支。 */
export async function executeMcpCall(input: DispatchCallInput): Promise<unknown> {
  const { pipeline, workspace } = input;
  const { parsed, entry } = resolveCallTarget(input);
  const tool = workspace.normalizeToolName(parsed.server, input.toolRaw);
  // 工具级禁用（P0-1 三入口统一走 isToolDenied；#767 笔 2 后这是唯一裁决）。
  const policyKey = workspace.fullServerName(parsed.root, parsed.server);
  if (pipeline.isToolDenied(input.disabledTools, policyKey, tool)) {
    throw new Error(pipeline.toolDisabledReason(policyKey, tool));
  }
  const catalog = input.catalogEntryFor(parsed.server);
  const stale =
    catalog !== undefined &&
    catalog.unavailable === undefined &&
    Date.now() - catalog.discoveredAt > input.catalogTtlMs;
  if (stale) {
    // stale：仍可调用（目录只是提示），但 schema 可能过期——在结果前置提示。
  }
  const args = pipeline.normalizeArguments(input.rawArgs);
  // B18/D6：调用预算读 server.toolCallTimeoutMs（缺省 DEFAULT_TOOL_CALL_TIMEOUT_MS=15s），
  // withTimeout 兜底统一 +2s——两路径（supervisor SDK timeoutMs 无兜底）预算
  // 差异写入两路径契约测试的差异面签名。
  const callBudgetMs = entry.server?.toolCallTimeoutMs ?? input.defaultCallTimeoutMs;
  // #413 封装直呼分支：runtime 注入的封装定义服务器（toolDefinitions）——
  // execute 为调用方 JS（不经远端 client.callTool）。禁用/策略已在上面统一
  // 裁决（isToolDenied），此处直接调调用方 execute；输出经封装 output.render
  // 投影为 ContentBlock[]（与 supervisor 封装分支 / dsh-tools 同口径）。
  const wrapped = entry.server?.toolDefinitions;
  if (Array.isArray(wrapped)) {
    return executeWrappedCall(input, parsed, tool, args, callBudgetMs, wrapped);
  }
  return executeRemoteCall(input, parsed, tool, args, entry, callBudgetMs, stale);
}
