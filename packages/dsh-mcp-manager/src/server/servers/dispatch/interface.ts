/**
 * dsh-mcp-manager — servers/dispatch/interface.ts：ws_mcp_call 派发域唯一对外引用面（D10）。
 *
 * 本域承诺：模型面 ws_mcp_call 的执行路径——路由与就绪校验、策略裁决、参数归一、两条执行
 * 分支（封装直呼 / 远端 client）与结果投影、调用错误文案的凭据脱敏。目录外模块**只能**从
 * 这里引用（verify-dir-imports 静态强制）；域内实现不被域外直引。
 *
 * 远端分支走宿主 `ctx.tools.execute`（#767 S1-4d，设计 §5.3）：合成子调用 id、透传 parent、
 * 用官方结果的 `value` 喂既有投影；虚拟单元（toolDefinitions）分支不改道。执行器不持有状态——
 * 工作空间单元、连接条目、凭据脱敏源、注册名派生与转发登记表全部经显式入参
 * `DispatchCallInput` 递入，中间层仍是这些状态唯一的事实源。
 *
 * 本域**没有** `installDispatch` 端口持有者：上游 pipeline / workspace 由调用方按
 * `DispatchCallInput` 递值，装配表（src/index.ts 的 installXxx 序列）本片不动；转发壳从
 * connection/runtime 自己的端口表取本域执行器（见 runtime/deps.ts 的 DispatchPort）。
 */
export { executeMcpCall } from "./impl/call/index.ts";
export type {
  CatalogEntryLite,
  DispatchCallInput,
  DispatchPipelinePort,
  DispatchWorkspacePort,
} from "./deps.ts";
