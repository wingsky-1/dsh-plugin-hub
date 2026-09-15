/**
 * dsh-mcp-manager — server/shared/constants.ts：跨域共享纯常量单一事实源。
 *
 * 为什么落共享层而不是留在原域：这几个默认值被 config 域在**模块求值期**消费
 * （`z.object({...}).default(CONST)`，见 server/config/config-schema.ts）——端口注入要等装配
 * 完成，那时 schema 早已求值，物理上只能拿到 undefined（HB1）；而留在原域让消费方直接 import，
 * 就是 I2① 的跨域值边（config → catalog、config → connection）。唯一可行形态是
 * 「共享层单点定义 + 消费方从共享层取」。
 *
 * LIST_DEFAULT_TOOLS_PER_SERVER 的落点依据是同一条值面门槛（I5：被 ≥2 域消费的值常量归共享层）：
 * catalog（检索装箱）与 inject（ws_mcp_list 工具定义）两域消费它，留在 connection/runtime 就是两条
 * 跨域值边。它不是模块求值期常量，落这里只为消除两条边并把定义收成一处。
 *
 * 为什么本文件零 import：它落在 config 域的模块求值路径上，本文件必须是**最先可求值**的
 * 叶子——任何依赖都会把初始化顺序与值环重新引回来。
 */

/** 能力目录默认开启；为什么不启用端口：见本文件头注释。 */
export const DEFAULT_ANNOUNCE_CATALOG = true;
/** 能力目录最大条目数（防上下文膨胀）。 */
export const DEFAULT_CATALOG_MAX_ENTRIES = 6;
/** 默认单次工具调用超时（毫秒）。下探自 60s：死工具（服务器已断线但工具未注销）
 * 会让模型阻塞一整轮；15s 内快速失败并携带"服务器不可用"说明更划算。 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 15_000;
/**
 * 连接等待超时（毫秒）。从 connection/runtime/limits.ts 上移（#767 S1-2b）：换引擎后连接不再由
 * 我方协议栈持有，这个预算只能包在官方句柄的 ready 上，消费方变成 servers/lifecycle 与仍在的
 * runtime 子层——两处消费按 I5 归共享层，物理定义因此只剩这一份。
 */
export const CONNECT_TIMEOUT_MS = 10_000;
/**
 * 工具发现超时（毫秒）。同上上移（#767 S1-2b）；换引擎后这个预算由官方插件在 ready 内结算，
 * 本包保留常量出口供 runtime 子层与 inject 消费，新的等待窗口不再拿它轮询（理由见
 * servers/lifecycle/impl/timeout）。
 */
export const DISCOVERY_TIMEOUT_MS = 10_000;
/** 工具结果渲染截断上限（字节）。extractText 现状不截断，超长 JSON 全量进上下文。 */
export const DEFAULT_RESULT_TRUNCATE_BYTES = 8192;
/** ws_mcp_list 每服务器工具条数默认上限（catalog 与 inject 两域消费，见本文件头注释）。 */
export const LIST_DEFAULT_TOOLS_PER_SERVER = 50;
