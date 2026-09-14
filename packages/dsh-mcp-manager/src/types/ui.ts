/**
 * dsh-mcp-manager — types/ui.ts：MCP 浮窗 UI 配置类型（#664 阶段 6 收敛）。
 *
 * 自 src/types.ts 拆出（ui 域）：插件自身 Config 的 `ui` 子对象（标准 cordis
 * 配置注入）留本域；跨端消费的扁平形态（GET /api/dsh-mcp/config）是 DTO，
 * 物理定义在 src/shared/dto.ts（D5），此处只按本域面转出。
 */

export type { ClientUiConfig } from "../shared/interface.ts";

/** MCP 浮窗 UI 配置（插件自身 Config 的 `ui` 子对象，标准 cordis 配置注入）。 */
export interface UiPlacementConfig {
  /** 浮窗胶囊锚点：右上 / 左上 / 右下 / 左下（默认 top-right = 历史行为）。 */
  position: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  /** 胶囊偏移：x 水平、y 垂直、blankY 空白会话垂直偏移。 */
  offset: { x: number; y: number; blankY: number };
  /** 浮窗层级基准（clamp 1–9000；胶囊与点击后弹出的主面板同取该配置值，模态管理面板独立不受影响）。 */
  zIndexBase: number;
}
