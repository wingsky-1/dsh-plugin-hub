/**
 * dsh-mcp-manager — server/shared/constants.ts：跨域共享纯常量单一事实源。
 *
 * 为什么落共享层而不是留在原域：这几个默认值被 `config/model` 在**模块求值期**消费
 * （`z.object({...}).default(CONST)`，见 config/model/config-schema.ts）——端口注入要等装配
 * 完成，那时 schema 早已求值，物理上只能拿到 undefined（HB1）；而留在原域让消费方直接 import，
 * 就是 I2① 的跨域值边（config/model → catalog、config/model → connection）。唯一可行形态是
 * 「共享层单点定义 + 消费方从共享层取」。
 *
 * 为什么本文件零 import：它落在 config/model 的模块求值路径上，本文件必须是**最先可求值**的
 * 叶子——任何依赖都会把初始化顺序与值环重新引回来。
 */

/** 能力目录默认开启；为什么不启用端口：见本文件头注释。 */
export const DEFAULT_ANNOUNCE_CATALOG = true;
/** 能力目录最大条目数（防上下文膨胀）。 */
export const DEFAULT_CATALOG_MAX_ENTRIES = 6;
/** 默认单次工具调用超时（毫秒）。下探自 60s：死工具（服务器已断线但工具未注销）
 * 会让模型阻塞一整轮；15s 内快速失败并携带"服务器不可用"说明更划算。 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 15_000;
/** 工具结果渲染截断上限（字节）。extractText 现状不截断，超长 JSON 全量进上下文。 */
export const DEFAULT_RESULT_TRUNCATE_BYTES = 8192;
