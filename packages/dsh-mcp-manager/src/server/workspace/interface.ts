/**
 * dsh-mcp-manager — workspace/interface.ts：工作空间路由域唯一对外引用面（D10，#664 阶段 4）。
 *
 * 工作空间路由域 = 项目根发现/归一化（root-resolution 块）+ server 全名与工具名
 * 解析（full-name 块）+ scope 常量（scope 块）
 * + (scope, name)→注册名 id 的内存表（server-id 块，见 server/shared/constants.ts 的
 * SERVER_NAME_PATTERN）+ 全局虚拟 root 单源（shared/constants.ts，被前两个块消费）。
 * 目录外模块**只能**从这里引用（verify-dir-imports 静态强制）。
 *
 * 为什么不建 deps.ts：静态 import 面零对上依赖（无 ctx/Context、无宿主能力、无他域值引），
 * 运行时**欠**的那条对上依赖（makeResolveRoot 经入参对象取 resolveProjectRoot / projectServersFor
 * 两个成员，附录 E.3；决策⑥以运行时能力消费为准）仍走「调用方现传参」，没有需要端口持有者
 * 中转的状态；server-id 块的 idFactory 同理是**工厂入参**（每次装配现给），不是域级端口——
 * 现在建 deps.ts 只会得到没有消费方的 I2③ 死声明。等 makeResolveRoot 那笔真正需要
 * install(deps) 时再同笔落地。
 */
export {
  findProjectRoot,
  normalizedProjectRoot,
  makeResolveRoot,
} from "./impl/root-resolution/index.ts";
export {
  fullServerName,
  parseFullServerName,
  bareServerName,
  normalizeToolName,
} from "./impl/full-name/index.ts";
export { SCOPE_GLOBAL, SCOPE_PROJECT, normalizeScope } from "./impl/scope/index.ts";
export { MIDDLEWARE_GLOBAL_ROOT } from "../../shared/interface.ts";
export { makeServerIdTable } from "./impl/server-id/index.ts";
export type {
  ServerIdFactory,
  ServerIdTable,
  ServerIdTableOptions,
} from "./impl/server-id/index.ts";
