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
/**
 * MCP 服务器注册名（官方 dsh-mcp-client 的 serverName）命名空间约束，与官方逐字同源。
 * 从 config/normalize.ts 上移（#767 S1-4a）：workspace 域的 id 生成器要用**同一份**判定，
 * 留在 config 域就会多出一条 workspace → config 的跨域值边（I2① 判红），而重抄一份正则等于
 * 两个物理定义、会静默漂移。config 域门面照旧转出同名符号，既有调用点不变。
 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/**
 * 官方 dsh-mcp-client 的包名（交给 loader 按名解析的**说明符**，不是 import 语句）。
 *
 * 落共享层是因为消费方在 servers/lifecycle：官方包不在 catalog、仓库内不可解析，只能经
 * loader 的 baseUrl 按名解析（设计 §1.1），而这条说明符必须与其他配置面口径同源——散在
 * 消费方里就会随重构复制出第二份，改包名时只改一处才谈得上一致性。测试同样经共享层门面取，
 * 不重抄字面量。
 */
export const OFFICIAL_MCP_CLIENT_SPECIFIER = "@deepseek-ai/dsh-mcp-client";
/**
 * 官方 dsh-mcp-client 在宿主日志面上的记录名（cordis 日志记录的 `name` 字段）。
 *
 * 换引擎后本插件拿不到官方的状态 API 与错误对象，官方「说了什么」只剩日志这一条通道；而
 * 每条官方日志都带 `mcp-client(<serverName>)` 前缀。落共享层是为了让归属判定与「交给官方的
 * serverName 就是我方 id」这条事实同源——散在消费方里就会随重构复制出第二份。
 */
export const OFFICIAL_MCP_CLIENT_LOG_NAME = "mcp-client";
