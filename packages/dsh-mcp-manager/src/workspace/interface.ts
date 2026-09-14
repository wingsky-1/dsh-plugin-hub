/**
 * dsh-mcp-manager — workspace/interface.ts：工作空间路由域唯一对外引用面（D10，#664 阶段 4）。
 *
 * 工作空间路由域 = 项目根发现/归一化（root-resolution 块）+ server 全名与工具名
 * 解析（full-name 块）+ scope 常量（scope 块）+ 中间层模式归一化（mode 块）
 * + 全局虚拟 root 单源（shared/constants.ts，被前两个块消费）。目录外模块**只能**从这里引用
 * （verify-dir-imports 静态强制）。
 *
 * 本刀是就地重构，**不建 deps.ts**：静态 import 面零对上依赖（无 ctx/Context、无宿主能力、
 * 无他域值引），但运行时**欠**一条对上依赖——makeResolveRoot 经入参对象取 middlewareMode /
 * projectServersFor 两个成员（附录 E.3；决策⑥以运行时能力消费为准）。该端口与本域改成
 * install(deps) 的那一笔同笔落地：现在新建文件会改 scannedSrcFiles/allSrcTsFiles/crossModuleRefs
 * 三个计数、破坏零位移验收，且没有消费方时会成为 I2③ 的死声明。
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
export { normalizeMiddlewareMode } from "./impl/mode/index.ts";
export { MIDDLEWARE_GLOBAL_ROOT } from "../shared/interface.ts";
