/**
 * dsh-mcp-manager — servers/dispatch/impl/call/index.ts：ws_mcp_call 执行器（原
 * connection/runtime/middleware.ts:583-772 的搬迁，语义逐字不变）。
 *
 * 为什么本片仍走旧客户端调用面：换引擎后官方不暴露底层 client，ws_mcp_call 只能经
 * ctx.tools.execute（透传 parent）转发（设计 §5.3）——那是 S1-4 的改道；本片只搬结构，
 * 远端分支仍是 entry.client.callTool，故行为零变化。
 *
 * 为什么全部入参显式化：原实现依赖 McpMiddleware 的 this（units / policy / disabledTools /
 * allServers），搬进新域后这些状态仍归中间层持有，只能按引用递入；本域不落第二份。
 */
import type { ToolDefinition, ToolOutputDefinition } from "@deepseek-ai/dsh-tools";
import type { DispatchCallInput } from "../../deps.ts";
import { redactMcpError } from "../redact/index.ts";

/** 执行一次 ws_mcp_call：路由一致性校验 → 策略裁决 → 封装直呼 / 远端 client 两条分支。 */
export async function executeMcpCall(input: DispatchCallInput): Promise<unknown> {
  const { pipeline, workspace, signal } = input;
  const parsed = workspace.parseFullServerName(input.fullName);
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
  // 范畴——否则退避窗口内会落到下方 entry.client.callTool（client 未 initialize）。
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
  const tool = workspace.normalizeToolName(parsed.server, input.toolRaw);
  // 工具级禁用（先查禁用表再查策略；P0-1 三入口统一走 isToolDenied）。
  const policyKey = workspace.fullServerName(parsed.root, parsed.server);
  if (pipeline.isToolDenied(input.disabledTools, input.policy, policyKey, tool)) {
    // 策略拒绝与禁用拒绝文案区分（策略拒绝附「调整 middlewarePolicy 配置」下一步）。
    if (!pipeline.policyAllows(input.policy, policyKey, tool)) {
      const reason = pipeline.policyDenialReason(input.policy, policyKey, tool);
      throw new Error(
        `${reason ?? `ws_mcp_call: 工具 ${JSON.stringify(`${policyKey}/${tool}`)} 被策略拒绝`}；如需放行请调整 middlewarePolicy 配置`,
      );
    }
    throw new Error(pipeline.toolDisabledReason(policyKey, tool));
  }
  const catalog = unit.catalog.get(parsed.server);
  const stale =
    catalog !== undefined &&
    catalog.unavailable === undefined &&
    Date.now() - catalog.discoveredAt > input.catalogTtlMs;
  if (stale) {
    // stale：仍可调用（目录只是提示），但 schema 可能过期——在结果前置提示。
  }
  const args = pipeline.normalizeArguments(input.rawArgs);
  // B18/D6：调用预算读 server.toolCallTimeoutMs（缺省 CALL_TIMEOUT_MS），
  // withTimeout 兜底统一 +2s——两路径（supervisor SDK timeoutMs 无兜底）预算
  // 差异写入两路径契约测试的差异面签名。
  const callBudgetMs = entry.server?.toolCallTimeoutMs ?? input.defaultCallTimeoutMs;
  // #413 封装直呼分支：runtime 注入的封装定义服务器（toolDefinitions）——
  // execute 为调用方 JS（不经远端 client.callTool）。禁用/策略已在上面统一
  // 裁决（isToolDenied），此处直接调调用方 execute；输出经封装 output.render
  // 投影为 ContentBlock[]（与 supervisor 封装分支 / dsh-tools 同口径）。
  const wrapped = entry.server?.toolDefinitions;
  if (Array.isArray(wrapped)) {
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
  if (entry.client === undefined) {
    throw new Error(
      `ws_mcp_call: server ${JSON.stringify(input.fullName)} 未就绪（client 缺失）；请稍后重试或重新连接`,
    );
  }
  try {
    const result = await pipeline.withTimeout(
      entry.client.callTool(tool, typeof args === "object" && args !== null ? args : {}, {
        signal,
        timeoutMs: callBudgetMs,
      }),
      callBudgetMs + 2000,
      `ws_mcp_call: 调用超时（${callBudgetMs}ms），可重试；若反复超时请用 ws_mcp_detail 核对参数或检查服务器状态`,
      signal,
    );
    // #512：远端结果经 call-result.ts 统一投影收敛（isError 判定 + 白名单
    // 清洗 + 无 content 兜底），与 supervisor（mcp__ 直呼）/ 官方
    // dsh-mcp-client createExecutor 同一契约——不再裸透传 resultObj，
    // Python SDK 必带的 isError:false / _meta 等字段不再外泄进工具契约。
    // fallbackText（复核闸 F1）：content 键存在但非数组（协议违规形态）时
    // 保留远端原文（msgOf，与旧文案行为等价）；content 缺省走默认兜底。
    const projected = pipeline.projectCallToolResult(result, {
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
}
