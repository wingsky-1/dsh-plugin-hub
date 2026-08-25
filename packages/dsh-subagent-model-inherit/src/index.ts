/**
 * dsh-subagent-model-inherit — 子 Agent 自动继承父会话当前模型与思考等级（宿主端）。
 *
 * 解决的两个官方断裂点（dsh 0.1.1-rc.2，issue #153）：
 * 1. `reasoningEffort` 不在 `AgentOptions`（仅 provider/model/maxTokens）——
 *    子 Agent 创建时无法携带父的思考等级；
 * 2. 父 Agent 的动态模型选择（GUI 切换走 installModelSelection waterfall，
 *    不写回 options）不传递给子 Agent——子只继承 `resolveChildAgentOptions`
 *    合并出的静态基值。
 *
 * 机制（对齐官方基建模式，零 DSH 源码修改）：
 * - 监听根上下文 `agent/created`（emit 事件，payload.agent 为新发布 Agent）；
 * - 三道门判定（见 resolveInheritedSelection）：origin/父存活/显式覆盖；
 * - 快照源与官方 dsh-host-apiproxy selectionFor 的 current getter 回退链同构：
 *   父日志最近 request/header config → ctx.agentDefaultModel.currentSelection()；
 * - 在子 Agent 自己的 scope 安装 `agent/request` waterfall（首次注入后跳过——
 *   首请求落日志后 loop 以 logged header 延续注入值），仅覆盖
 *   provider/model/reasoningEffort 三字段，其余采样字段原样保留；
 *   快照无 effort 时剥离子的继承 effort（对齐 installModelSelection 语义）。
 *
 * 时序保证：官方 createAgent 序列为 setup → publish → agent/created →
 * agent/session-start → loop start；本插件在 agent/created 监听器内同步完成
 * waterfall 安装（无 await），必然赶在子首个请求之前。
 *
 * 已知限制（等值判据的盲区，接受现状并在此声明）：
 * - 「未指定」与「显式指定了恰好等于父基值的 provider/model」不可区分
 *   （requested 原始值不过事件面）；前者注入正确，后者会被注入父快照——
 *   当父 GUI 切换过模型时该注入违背「显式指定优先」，触发条件苛刻、影响限于
 *   首请求路由。根治需上游在 durable header 记录 requested overrides 标志。
 * - 冷恢复子（父已销毁/进程重启）跳过注入：沿用其日志中已落盘的 header，
 *   而非回到部署缺省。
 */
import type { Context } from "@deepseek-ai/cordis";
// 类型面引入：dsh-agent 提供 Events 声明合并（agent/created、agent/request、
// ctx.agents）与 Agent/ModelSelection 类型；dsh-agent-default-model 提供
// ctx.agentDefaultModel 声明合并。均为编译期擦除的类型导入。
import type {} from "@deepseek-ai/dsh-agent";
import type { Agent, ModelSelection } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type { LlmCallConfig } from "@deepseek-ai/dsh-llm";

/** Stable cordis plugin name. */
export const name = "subagent-model-inherit";

/** Core services required before the inheritance listener can register. */
export const inject = ["agents"];

/**
 * 三道门判定 + 继承快照解析（纯函数，便于单测钉死边界）。
 *
 * @param child 新发布的子 Agent（agent/created payload.agent）
 * @param parent 按 header.parentSession 查到的活父 Agent；查不到传 undefined
 * @param fallback 父无历史请求时的回退快照（ctx.agentDefaultModel?.currentSelection()）；
 *   由调用方容错解析，本函数不触碰 ctx
 * @returns 应注入的选择；任一道门不过或无可用快照返回 undefined
 */
export function resolveInheritedSelection(
  child: Agent,
  parent: Agent | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  // 门 1：durable origin 血缘（childSessionMeta 写入，fork 型会话不带此标记）。
  const header = child.session.header;
  if (header.origin !== "subagent" || header.parentSession === undefined) {
    return undefined;
  }
  // 门 2：父存活（冷恢复/父已销毁 → 跳过，沿用子日志既有 header）。
  if (parent === undefined) {
    return undefined;
  }
  // 门 3：显式覆盖跳过——resolveChildAgentOptions 以 requested 后展开合并，
  // requested 未指定 provider/model 时子 options 与父相等；不等即视为已指定。
  // 已知盲区见文件头注释。
  if (
    child.options.provider !== parent.options.provider ||
    child.options.model !== parent.options.model
  ) {
    return undefined;
  }
  // 快照：优先父日志最近 header config（与 apiproxy selectionFor 回退链第二级
  // 同构）；缺失时用部署默认选择回退。detached 拷贝，避免共享父的可变引用。
  const logged = parent.session.requestHeader()?.config;
  if (logged !== undefined) {
    return {
      provider: logged.provider,
      model: logged.model,
      ...(logged.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: logged.reasoningEffort }),
    };
  }
  return fallback;
}

/**
 * 注入一次 LlmCallConfig（纯函数）。仅覆盖 provider/model/reasoningEffort
 * 三字段；temperature/maxTokens/stop 等采样字段原样保留。快照无 effort 时剥离
 * resolved 中继承来的 effort——对齐官方 installModelSelection 的
 * "absent effort clears inherited effort" 语义。
 */
export function injectSelection(
  resolved: LlmCallConfig,
  selection: ModelSelection,
): LlmCallConfig {
  const { reasoningEffort: _inheritedEffort, ...rest } = resolved;
  return {
    ...rest,
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
  };
}

/** apply 配置（当前无配置键，保留扩展位）。 */
export interface SubagentModelInheritConfig {
  [key: string]: unknown;
}

/**
 * 挂载入口：注册根上下文 agent/created 监听器。
 *
 * 监听器内全程同步（无 await）：官方 createAgent 在 publish（含 agent/created
 * 分发）之后才 start loop，同步安装的 waterfall 必然赶在子首请求之前；一旦
 * await 后再安装就会漏掉首请求并在日志里留下基模型 header 快照噪音。
 * waterfall 装在 child.ctx（Agent scope）上，子销毁随 scope 自动清理。
 */
export function apply(ctx: Context, _config: SubagentModelInheritConfig = {}): void {
  // 防御：inject 未按预期生效的组合（如裸 cordis 测试环境）静默跳过。
  if (ctx.get("agents") === undefined) return;

  ctx.on("agent/created", ({ agent }) => {
    const parentSessionId = agent.session.header.parentSession;
    const parent =
      parentSessionId === undefined ? undefined : ctx.agents.get(parentSessionId);
    const defaultModel = ctx.get("agentDefaultModel");
    const selection = resolveInheritedSelection(
      agent,
      parent,
      defaultModel?.currentSelection(),
    );
    if (selection === undefined) return;

    let injected = false;
    agent.ctx.on("agent/request", async (_payload, next) => {
      const resolved = await next();
      // 仅首请求注入：loop 之后以已落盘的 logged header 构建请求，注入值
      // 自行延续；重复注入只会制造 header 变更快照噪音。
      if (injected) return resolved;
      injected = true;
      return injectSelection(resolved, selection);
    });
  });
}
