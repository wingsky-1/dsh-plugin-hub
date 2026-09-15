/**
 * dsh-mcp-manager — servers/dispatch/deps.ts：ws_mcp_call 派发域的上对依赖与入参声明
 * （纯类型面，§3.1 规则 2）。
 *
 * 本域的能力面只有两条，都取「实际使用」而非「import 面」（附录 E.6 第 3 条）：
 * - pipeline 域的结果投影 / 超时兜底 / 取消息与脱敏 / 参数归一 / 策略裁决族；
 * - workspace 域的全名解析、工具名归一与全名拼装。
 *
 * 两条都是**类型边**（形状经各自 interface.ts 取），值由调用方按 `DispatchCallInput` 递进来——
 * 本片（S1-3a）是转发壳，装配表不动，故本域没有 `installXxx` 端口持有者；域间仍是零值边。
 *
 * 中间层的工作空间单元、连接条目与凭据脱敏源**不复制**进本域：`units` 按引用递入、
 * `allServers` 递取值器（脱敏只在出错路径上读服务器表），本域只读不留，避免第二个事实源。
 *
 * **只许类型依赖**：本文件出现值 import 会被 verify-dir-imports 硬判红。
 */
import type * as pipelineApi from "../../pipeline/interface.ts";
import type * as workspaceApi from "../../workspace/interface.ts";
import type { ServerConfig } from "../../config/interface.ts";
import type { MiddlewarePolicy } from "../../pipeline/interface.ts";
import type { DisabledToolsMap } from "../../store/interface.ts";
import type { ProjectUnit } from "../../connection/runtime/interface.ts";

/** pipeline 域给本域的能力面：结果投影 / 超时兜底 / 取消息与脱敏 / 参数归一 / 策略裁决。 */
export type DispatchPipelinePort = Pick<
  typeof pipelineApi,
  | "defaultCallResultFallbackText"
  | "projectCallToolResult"
  | "withTimeout"
  | "msgOf"
  | "createRedactor"
  | "normalizeArguments"
  | "policyAllows"
  | "policyDenialReason"
  | "isToolDenied"
  | "toolDisabledReason"
>;

/** workspace 域给本域的能力面：`@<root>/<server>` 全名解析、工具名归一与全名拼装。 */
export type DispatchWorkspacePort = Pick<
  typeof workspaceApi,
  "parseFullServerName" | "normalizeToolName" | "fullServerName"
>;

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
  /** 中间层工作空间单元表（按引用递入，本域不复制也不持有）。 */
  readonly units: ReadonlyMap<string, ProjectUnit>;
  /** 凭据脱敏源：全部在册服务器（出错路径才取值，与旧 `allServers()` 同惰性）。 */
  readonly allServers: () => readonly ServerConfig[];
  /** 工具级禁用映射（root → server → Set<tool>）。 */
  readonly disabledTools: DisabledToolsMap;
  /** 策略（按 @root/server 全名配置）。 */
  readonly policy: MiddlewarePolicy;
  /** 目录 TTL（ms）：判断目录提示是否过期。 */
  readonly catalogTtlMs: number;
  /** 单次调用预算缺省值（server.toolCallTimeoutMs 缺省时用它）。 */
  readonly defaultCallTimeoutMs: number;
  /** pipeline 域能力面。 */
  readonly pipeline: DispatchPipelinePort;
  /** workspace 域能力面。 */
  readonly workspace: DispatchWorkspacePort;
}
