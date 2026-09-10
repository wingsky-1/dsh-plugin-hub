/**
 * dsh-mcp-manager — types/ui.ts：MCP 浮窗 UI 配置类型（#664 阶段 6 收敛）。
 *
 * 自 src/types.ts 拆出（ui 域）：插件自身 Config 的 `ui` 子对象（标准 cordis
 * 配置注入）与客户端消费的扁平形态（GET /api/dsh-mcp/config）。
 */

/** MCP 浮窗 UI 配置（插件自身 Config 的 `ui` 子对象，标准 cordis 配置注入）。 */
export interface UiPlacementConfig {
  /** 浮窗胶囊锚点：右上 / 左上 / 右下 / 左下（默认 top-right = 历史行为）。 */
  position: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  /** 胶囊偏移：x 水平、y 垂直、blankY 空白会话垂直偏移。 */
  offset: { x: number; y: number; blankY: number };
  /** 浮窗层级基准（clamp 1–9000；胶囊与点击后弹出的主面板同取该配置值，模态管理面板独立不受影响）。 */
  zIndexBase: number;
}

/** 客户端消费的浮窗 UI 配置（GET /api/dsh-mcp/config 的扁平形状）。 */
export interface ClientUiConfig {
  position: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  offsetX: number;
  offsetY: number;
  blankY: number;
  zIndexBase: number;
}