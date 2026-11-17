/**
 * dsh-mcp-manager — visibility/interface.ts：模型可见面域门面（#767 笔 1b 交付物 A）。
 *
 * 本域只做一件事：把本包经官方引擎注册的 `mcp__*` 工具从**每一个 agent 的模型视野**里摘掉，
 * 并在注册面变化时重同步。为什么是隐藏而不是注销：`ctx.tools` 没有 `unregister(name)`，注册方
 * （官方 dsh-mcp-client）拿走的 disposer 不交给本包——宿主留给外界的唯一手段是 `restrict`
 * （按作用域生效的模型可见面掩码）。
 *
 * 目录外（组合根）只能从本文件引用本域符号（verify-dir-imports 静态强制）。本域**没有**
 * `deps.ts`、也没有端口持有者：它的全部输入都是组合根按**调用实参**递进来的（与
 * `servers/dispatch` 的 `executeMcpCall(input)` 同一形态）——域间值边因此为零。
 */
import type { AgentFace, LoggerPort } from "../shared/interface.ts";

/**
 * 事件面（组合根从 `faces.events` 递进来）。成员**全可选**：监听面缺失（假 ctx、宿主未合并
 * `dsh-agent` 的事件面）时本域降级成 no-op 并 `logger.warn` 一次，不抛——与
 * `registerMiddlewareTools` 对 `typeof ctx.on !== "function"` 同口径。
 */
export interface VisibilityEventsPort {
  /** 新 agent 完成装配 → 给它本人上限制。 */
  readonly onAgentCreated?: (handler: (agent: AgentFace) => void) => () => void;
  /** agent 离开注册表 → dispose 它那条限制并清记忆。载荷只有 id（宿主事件面如此）。 */
  readonly onAgentDisposed?: (handler: (agent: { id: string }) => void) => () => void;
  /** 注册面/限制面变化（无载荷）→ 全量 reconcile。 */
  readonly onToolsChange?: (handler: () => void) => () => void;
  /** 当前全部活 agent（装载时全量 reconcile）；服务缺席给空表。 */
  readonly liveAgents?: () => readonly AgentFace[];
}

/**
 * `startAgentVisibility` 的全部实参。
 *
 * `isOwnedServerId` 是**活**判定（`McpMiddleware.ownsServerId`），不是快照：restriction 会校验
 * 目标的 `restrictableNames`，名字不在活注册面里当场抛，故名单每次都要从活注册面现算。
 * 本域只隐藏本插件 own 集合里的 `mcp__<id>__`；官方/兄弟插件直接装载的 `mcp__<serverName>__`
 * 不归本包管，必须保持模型可见（共存边界）。
 */
export interface StartAgentVisibilityArgs {
  readonly events: VisibilityEventsPort;
  /** 注册名中段是否属于本插件装载的官方实例；官方 mcp__ 名恒为 false。 */
  readonly isOwnedServerId: (id: string) => boolean;
  /** 活注册面上的全部注册名（组合根现读 `faces.tools.schemas()`，本域不缓存）。 */
  readonly registeredNames: () => readonly string[];
  readonly logger: LoggerPort;
}

export { startAgentVisibility } from "./impl/mask/index.ts";
