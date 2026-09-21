/**
 * dsh-mcp-manager — servers/dispatch/impl/call/index.ts：ws_mcp_call 执行器（原
 * connection/runtime/middleware.ts:583-772 的搬迁；路由/封装分支与错误文案口径不变）。
 *
 * 为什么远端分支走 ctx.tools.execute（#767 S1-4d）：换引擎后官方运行时只导出
 * `Config / apply / inject / name`，底层 client 不外露，「拿一个 client 去 callTool」这条路
 * 不再存在。转发按设计 §5.3：合成子调用 id、透传 parent、喂 `value` 给既有投影。
 *
 * 为什么全部入参显式化：原实现依赖 McpMiddleware 的 this（units / disabledTools /
 * allServers / 转发登记表），搬进新域后这些状态仍归中间层持有，只能按引用递入；本域不落第二份。
 */
import type {
  ToolDefinition,
  ToolOutputDefinition,
  ToolExecutionInput,
} from "@deepseek-ai/dsh-tools";
import type { DispatchCallInput, ToolExecutionResultLike } from "../../deps.ts";
import { redactMcpError } from "../redact/index.ts";

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
  const entry = unit.connections.get(parsed.server);
  const entryStatus = entry?.status;
  // B4 连带：六态状态机补 reconnecting 后，调用守卫须把「后台重连中」纳入未就绪
  // 范畴——否则退避窗口内会照常派发，而该代际的工具面已经不可信（官方在预算耗尽或
  // dispose 时注销工具，重连期间前缀可能已消失）。
  if (
    entry === undefined ||
    entryStatus === "failed" ||
    entryStatus === "reconnecting" ||
    entryStatus === "stopped" ||
    entryStatus === "disabled"
  ) {
    if (unit.userDisabled.has(parsed.server)) {
      throw new Error(
        `ws_mcp_call: server ${JSON.stringify(input.fullName)} 已被用户禁用；可先在 GUI「MCP」浮窗中重新连接`,
      );
    }
    if (entryStatus === "reconnecting") {
      throw new Error(
        `ws_mcp_call: server ${JSON.stringify(input.fullName)} 连接失败、正在后台重连；请稍后重试或重新连接`,
      );
    }
    throw new Error(
      `ws_mcp_call: server ${JSON.stringify(input.fullName)} 未连接或连接失败，请先 ws_mcp_search 或 ws_mcp_list 确认 server 已连接`,
    );
  }
  if (entryStatus === "connecting") {
    throw new Error(
      `ws_mcp_call: server ${JSON.stringify(input.fullName)} 连接仍在进行，请稍后重试；连接完成后再调用`,
    );
  }
  return { parsed, entry };
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
    // 封装定义契约：execute(args, exec) 的 exec 为完整 ToolRunContext，但
    // 中间层只能提供最小面（agent 透传，session cwd 解析用）——经 unknown
    // 中转（消费方封装定义只读 exec.agent）。
    const execCtx = { agent: input.agent } as unknown as Parameters<
      NonNullable<ToolDefinition["execute"]>
    >[1];
    // #413 QA P2-2：封装 execute 补超时兜底（与远端分支同预算 callBudgetMs，
    // 封装实现挂起时不无限等待）。
    const value = await pipeline.withTimeout(
      def.execute(typeof args === "object" && args !== null ? args : {}, execCtx),
      callBudgetMs + 2000,
      `ws_mcp_call: 封装调用超时（${callBudgetMs}ms），可重试；若反复超时请检查插件状态`,
      signal,
    );
    const content =
      typeof def.output?.render === "function"
        ? def.output.render(
            args,
            value as unknown as Parameters<NonNullable<ToolOutputDefinition["render"]>>[1],
          )
        : [
            {
              type: "text",
              text: typeof value === "string" ? value : JSON.stringify(value ?? {}),
            },
          ];
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
      input.execute({
        callId: subCallId(input.callId),
        ...(input.rootCallId === undefined ? {} : { rootCallId: input.rootCallId }),
        name: input.registeredNameFor(id, tool),
        arguments: typeof args === "object" && args !== null ? args : {},
        // #767 笔 1b F4 收口：远端转发**不带 agent**。带了就等于把子调用挂回该 agent 的作用域，
        // 而本包已把 mcp__* 从每个 agent 的模型视野摘掉——自家转发会被自己那条 deny 一起打死。
        // 不带 agent 走全局面（guard 靠 parent ∈ forwarding 放行）；代价是官方执行器那次图片
        // 准入退化成文本，由本包自持的 image-admission 经 finalizeContent 补回来。
        ...(input.parent === undefined ? {} : { parent: input.parent }),
        // 宿主 executor 无条件读 signal.aborted（实测 §2.9-6：给 undefined 当场 TypeError），
        // 而调用方不保证带 signal——没有就现造一个。
        signal: signal ?? new AbortController().signal,
      }),
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
    throw new Error(
      redactMcpError(
        pipeline,
        input.allServers(),
        `ws_mcp_call: 远端工具返回错误：${result.error.message}；可先用 ws_mcp_detail 核对参数 schema 后重试`,
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
    return {
      content: [hint, ...projected.content],
      ...(projected.structuredContent !== undefined
        ? { structuredContent: projected.structuredContent }
        : {}),
    };
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
