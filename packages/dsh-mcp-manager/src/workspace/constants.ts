/**
 * dsh-mcp-manager — workspace/constants.ts：工作空间路由域常量（单一事实源）。
 *
 * MIDDLEWARE_GLOBAL_ROOT 此前在 manager.ts 与 middleware-utils.ts 双份定义
 * （同值 "@global"，漂移风险 + 反解归一化两处维护）；阶段 4 收敛为单源，
 * 全部引用经 workspace/interface.ts 取。阶段 6 集中搬移后根目录无残留。
 */

/** 中间层 all 模式的全局虚拟 root（全局服务器经中间层访问时的路由 key）。 */
export const MIDDLEWARE_GLOBAL_ROOT = "@global";