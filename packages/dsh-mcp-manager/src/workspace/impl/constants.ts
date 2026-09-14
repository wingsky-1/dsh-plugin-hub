/**
 * dsh-mcp-manager — workspace/impl/constants.ts：工作空间路由域常量（单一事实源）。
 *
 * MIDDLEWARE_GLOBAL_ROOT 此前在 manager.ts 与 middleware-utils.ts 双份定义
 * （同值 "@global"，漂移风险 + 反解归一化两处维护）；阶段 4 收敛为单源，
 * 全部引用经 workspace/interface.ts 取。
 *
 * 落 `impl/` 根而不进块：本值被 full-name 与 root-resolution 两个块消费（§3.1 规则 1 的
 * 「跨块值文件」），成块目录只放单一职责的实现。
 */

/** 中间层 all 模式的全局虚拟 root（全局服务器经中间层访问时的路由 key）。 */
export const MIDDLEWARE_GLOBAL_ROOT = "@global";
