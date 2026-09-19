/**
 * dsh-mcp-manager — servers/dispatch/deps.ts：ws_mcp_call 派发域的上对依赖与入参声明
 * （纯类型面，§3.1 规则 2）。
 *
 * 本域的能力面只有两条，都取「实际使用」而非「import 面」（附录 E.6 第 3 条）：
 * - pipeline 域的结果投影 / 超时兜底 / 取消息与脱敏 / 参数归一 / 策略裁决族；
 * - workspace 域的全名解析、工具名归一与全名拼装。
 *
 * 两条都是**类型边**（形状经各自 interface.ts 取），值由调用方按 `DispatchCallInput` 递进来——
 * 本片（S1-3a）起是转发壳，装配表不动，故本域没有 `installXxx` 端口持有者；域间仍是零值边。
 * 换引擎后（S1-4d）远端分支改道宿主的 `ctx.tools.execute`：执行能力、注册名派生与转发登记表
 * 也一并按引用递入，本域仍不持任何状态。
 *
 * 中间层的工作空间单元、连接条目与凭据脱敏源**不复制**进本域：`units` 按引用递入、
 * `allServers` 递取值器（脱敏只在出错路径上读服务器表），本域只读不留，避免第二个事实源。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。
 */
import type {
  ToolExecutionInput,
  ToolExecutionResult,
  ToolExecutionToken,
} from "@deepseek-ai/dsh-tools";
import type * as pipelineApi from "../../pipeline/interface.ts";
import type * as workspaceApi from "../../workspace/interface.ts";
import type { ServerConfig } from "../../config/interface.ts";
import type { DisabledToolsMap } from "../../store/interface.ts";
import type { ProjectUnit } from "../../connection/runtime/interface.ts";

/** pipeline 域给本域的能力面：结果投影 / 超时兜底 / 取消息与脱敏 / 参数归一 / 禁用裁决。 */
export type DispatchPipelinePort = Pick<
  typeof pipelineApi,
  | "defaultCallResultFallbackText"
  | "projectCallToolResult"
  | "withTimeout"
  | "msgOf"
  | "createRedactor"
  | "normalizeArguments"
  | "isToolDenied"
  | "toolDisabledReason"
>;

/** workspace 域给本域的能力面：`@<root>/<server>` 全名解析、工具名归一与全名拼装。 */
export type DispatchWorkspacePort = Pick<
  typeof workspaceApi,
  "parseFullServerName" | "normalizeToolName" | "fullServerName"
>;

/**
 * 目录条目在本域的**窄结构类型**（#767 S1-3b）：只要「发现时刻 + 可选不可用原因」这两样。
 *
 * 为什么不 import catalog 的 `CatalogServer`：那会给本域到 catalog 域加一条跨模块类型边，
 * 而本域只读这两个字段；窄形状在这里写一次，由调用方（连接层）按引用递值。
 */
export interface CatalogEntryLite {
  readonly discoveredAt: number;
  readonly unavailable?: string;
}

/** 宿主工具执行入参（子调用身份 + 参数 + 真 signal）。别名的意义是形状只在这里写一次。 */
export type ToolExecutionInputLike = ToolExecutionInput;

/** 宿主工具执行结果（判别的成功 / 失败联合；isError 只能从判别式走）。 */
export type ToolExecutionResultLike = ToolExecutionResult;

/**
 * 一次 ws_mcp_call 执行所需的全部外部输入。
 *
 * 为什么全是显式入参而不是构造器状态：本域是执行器（无 `this`），中间层的单元表仍归
 * connection/runtime 持有——状态只有一个事实源，本域只读经引用递进来的那一份。
 *
 * 两个超时/新鲜度常量按值递入（而不是本域直引 connection/runtime/limits.ts）：直引会让本域
 * 到旧子层产生一条跨域值边（I2①），而它们的物理定义在 S1-5 前仍属 runtime 子层。
 */
export interface DispatchCallInput {
  /** 路由全名 `@<root>/<server>`（原样进错误文案）。 */
  readonly fullName: string;
  /** 模型给的裸工具名（经 workspace 归一后再用）。 */
  readonly toolRaw: string;
  /** 原始入参（经 pipeline.normalizeArguments 归一）。 */
  readonly rawArgs: unknown;
  /** 调用方取消信号（透传给两分支与超时兜底）。 */
  readonly signal: AbortSignal | undefined;
  /** 调用方会话 agent（封装直呼分支透传，供 session cwd 解析）。 */
  readonly agent: unknown;
  /** 本次外层调用的 id：合成子调用 id 的父前缀（`<parent>:mcp:1`，先例见 dsh-tools 的 PTC）。 */
  readonly callId: ToolExecutionInput["callId"];
  /** 根调用 id：有就透传——宿主按 `rootCallId ?? callId` 回填，不带会把子调用误标成新根。 */
  readonly rootCallId?: ToolExecutionInput["rootCallId"];
  /**
   * 外层调用的 token，作为子调用的 `parent` 透传：PTC 模式下不带 parent 的原生名直呼会被
   * 判 UNKNOWN_TOOL；同一 token 也是 guard 识别「这次调用出自我方转发」的凭据（裁定 R/Z）。
   */
  readonly parent?: ToolExecutionToken;
  /** 中间层工作空间单元表（按引用递入，本域不复制也不持有）。 */
  readonly units: ReadonlyMap<string, ProjectUnit>;
  /**
   * 目录条目读口：本域只拿来判「目录是否过期」（schema 提示用），故递的是按 server 名取值器
   * 而不是整份目录——本域不持目录，也不引 catalog 域门面（免多一条跨模块边）。
   */
  readonly catalogEntryFor: (serverName: string) => CatalogEntryLite | undefined;
  /** 凭据脱敏源（#770-8）：脱敏全集快照（全局 store + 全部 projectStores 缓存 +
   * runtimeRegistry，含 disabled/unconnected），调用方须递宿主 redactionServers 快照
   *（中间层转供的同一秘密源，与 manager.redactError/middleware.redact 同源）。
   * 出错路径才取值（与旧 `allServers()` 同惰性），本域只读不留，避免第二个事实源。 */
  readonly allServers: () => readonly ServerConfig[];
  /** 工具级禁用映射（root → server → Set<tool>）。 */
  readonly disabledTools: DisabledToolsMap;
  /** 目录 TTL（ms）：判断目录提示是否过期。 */
  readonly catalogTtlMs: number;
  /** 单次调用预算缺省值（server.toolCallTimeoutMs 缺省时用它）。 */
  readonly defaultCallTimeoutMs: number;
  /** 注册名派生（唯一派生点是中间层的 publicToolName；本域不得自己拼 `mcp__<id>__<tool>`）。 */
  readonly registeredNameFor: (id: string, tool: string) => string;
  /** 宿主工具执行面（本域只转发；结果用 `value` 喂投影，与旧链路逐字节等价）。 */
  readonly execute: (input: ToolExecutionInputLike) => Promise<ToolExecutionResultLike>;
  /** 在飞的转发登记表（按引用递入）：派发前后登记 / 注销 `parent`，guard 据此放行。 */
  readonly forwarding: Set<ToolExecutionToken>;
  /** pipeline 域能力面。 */
  readonly pipeline: DispatchPipelinePort;
  /** workspace 域能力面。 */
  readonly workspace: DispatchWorkspacePort;
}
