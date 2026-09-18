/**
 * dsh-mcp-manager — shared/constants.ts：跨端契约常量单一事实源（D5，#767 B2a-wire W3b）。
 *
 * 为什么这三条落跨端层而不是留在宿主内部：客户端已经把它们**以字面量重复实现**——
 * src/client/core/api.ts 用 server.scope === "global" 比较、并拼接 @@global/<name>，
 * 即 SCOPE_GLOBAL 与 "@" + MIDDLEWARE_GLOBAL_ROOT + "/" 各写了一份且无判据（同族于
 * 附录 G·G14 的跨包字面量重复）。它们是两端契约，不是宿主内部常量：留宿主内部等于承认
 * 第二份物理定义合法。客户端改引本文件属 #769（N1 本轮不重构客户端），本轮只把物理定义
 * 收到这里——此后它是唯一落点，客户端将来改引零成本。
 *
 * 为什么本文件零 import：它落在 workspace 域与各消费方的模块求值路径上，必须是最先可求值的
 * 叶子；任何依赖都会把初始化顺序与值环重新引回来。
 */

/** 全局作用域（配置里的 scope 取值；客户端浮窗比较同一字面量）。 */
export const SCOPE_GLOBAL = "global";

/** 项目级作用域。 */
export const SCOPE_PROJECT = "project";

/** 全局虚拟 root（全局服务器经中间层访问时的路由 key）。 */
export const MIDDLEWARE_GLOBAL_ROOT = "@global";
