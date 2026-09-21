/**
 * dsh-jev-decide — components 域门面（域内跨文件唯一入口；本文件只转出、不放实现）。
 *
 * DOM 原子（atoms.ts）+ 概率条小组件（probability.ts）经此门面被 panes / index 消费；
 * 禁止绕过门面直引域内实现；禁止跨 pane 深路径直引（公共一律走本门面或 api/ 门面）。
 */
export {
  actionButton,
  badge,
  clear,
  el,
  errorLine,
  fmtTime,
  fold,
  noteLine,
  numberInput,
  okLine,
  shortId,
  textInput,
} from "./atoms.ts";
export type { Attrs } from "./atoms.ts";
export { HIGH_LINE, probRow, tierBadge } from "./probability.ts";
