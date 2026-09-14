/**
 * dsh-mcp-manager — stats/interface.ts：统计域门面（D10，#664 阶段 6）。
 *
 * 统计域 = 调用统计收集器（collector）+ 统计/调试类型（type）。目录外模块**只能**从这里引用
 * （verify-dir-imports 静态强制）。
 *
 * 本域**不建 deps.ts**：实测运行时零对上依赖——落盘走自带 `node:fs` 原语、宿主目录经仓库共享层
 * `shared/dsh-home.js`、logger 是调用方经构造入参递入的本地结构类型。本域从不向组合根索取能力，
 * 故按「有对上依赖才建 deps.ts」的判据不建（附录 E.4；`mutation-topology.json` 的 deps.ts 排除条
 * 理由同源，其中也点明 store/stats/integration 三域不建）。
 */
export { defaultStatsPath, McpStatsCollector } from "./impl/collector.ts";
export type {
  ToolCallMetric,
  ServerStats,
  ProgressiveDisclosureStats,
  McpStatsSnapshot,
  DebugConfig,
} from "./impl/type.ts";
