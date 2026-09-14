/**
 * WS 压缩协商策略的形状与默认值。
 *
 * 与 defaults.ts 同因：它既是配置 schema 的默认值来源，也是 createLanProxy 的
 * wsDeflatePolicy 参数默认值——没有单一归属，留在引擎域会让配置域值引引擎实现。
 */

/** WS 压缩协商策略：浏览器段开关 + UA 拒绝片段。 */
export interface DeflatePolicy {
  /** 浏览器段是否允许协商 permessage-deflate（false = 全局关闭压缩）。 */
  browser?: boolean;
  /** UA 字符串包含任一片段 → 该端强制不协商压缩。 */
  uaDeny?: readonly string[];
}

/** 默认 WS 压缩策略（单一事实源）：浏览器段可协商，但 iOS 三件套强制不协商。 */
export const DEFAULT_DEFLATE_POLICY: Readonly<DeflatePolicy> = Object.freeze({
  browser: true,
  uaDeny: Object.freeze(["iPhone", "iPad", "iPod"]),
});
