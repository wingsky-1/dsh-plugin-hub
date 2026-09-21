/**
 * dsh-jev-decide — panes 域门面（一 tab 一文件，各只管自己的渲染 + 事件）。
 *
 * index.ts 薄装配经此门面挂载三 tab；pane 间禁止深路径直引。
 */
export { renderConnectionPane } from "./connection.ts";
export type { ConnectionHost } from "./connection.ts";
export { renderPresetsPane } from "./presets.ts";
export type { PresetsHost } from "./presets.ts";
export { renderHistoryPane } from "./history.ts";
export type { HistoryHost } from "./history.ts";
