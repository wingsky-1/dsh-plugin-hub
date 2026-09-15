/**
 * dsh-mcp-manager — servers/dispatch/interface.ts：ws_mcp_call 派发域唯一对外引用面（D10）。
 *
 * 本域承诺：模型面 ws_mcp_call 的执行路径——路由与就绪校验、策略裁决、参数归一、两条执行
 * 分支（封装直呼 / 远端 client）与结果投影、调用错误文案的凭据脱敏。目录外模块**只能**从
 * 这里引用（verify-dir-imports 静态强制）；域内实现不被域外直引。
 *
 * 本片（S1-3a）是**结构搬迁**，语义零变化：远端分支仍走旧 `entry.client.callTool`
 * （改道 `ctx.tools.execute` + 透传 parent 是 S1-4，设计 §5.3）。执行器不持有状态——工作空间
 * 单元、连接条目、凭据脱敏源与两条上游能力全部经显式入参 `DispatchCallInput` 递入，中间层
 * 仍是这些状态唯一的事实源。
 *
 * 本域**没有** `installDispatch` 端口持有者：上游 pipeline / workspace 由调用方按
 * `DispatchCallInput` 递值，装配表（src/index.ts 的 installXxx 序列）本片不动；转发壳从
 * connection/runtime 自己的端口表取本域执行器（见 runtime/deps.ts 的 DispatchPort）。
 */
export { executeMcpCall } from "./impl/call/index.ts";
export type { DispatchCallInput, DispatchPipelinePort, DispatchWorkspacePort } from "./deps.ts";
