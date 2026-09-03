/**
 * dsh-mcp-manager — 插件 Config schema 与配置归一化（纯函数，单一事实源）。
 *
 * 插件自身 Config（cordis 配置注入入口）与浮窗 UI 配置的校验/归一化/默认值；
 * 类型自 types.ts 取（防循环引用），placement-math 提供层级 clamp 与默认层级。
 */

import z from "schemastery";
import { clampZIndexBase, DEFAULT_Z_INDEX_BASE } from "./placement-math.ts";
import { DEFAULT_ANNOUNCE_CATALOG, DEFAULT_CATALOG_MAX_ENTRIES } from "./catalog.ts";
import { DEFAULT_RESULT_TRUNCATE_BYTES } from "./supervisor.ts";
import type { ClientUiConfig, UiPlacementConfig } from "./types.ts";

/** 空 description 工具的条件拼接默认开启。 */
export const DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS = true;

/** 默认浮窗 UI 配置（与升级前一致，无回归；层级基准引用 placement-math 单一事实源，
 *  DEFAULT_Z_INDEX_BASE=10 对应 CSS 默认 z-index:10）。 */
export const DEFAULT_UI_CONFIG: UiPlacementConfig = {
  position: "top-right",
  offset: { x: 8, y: 8, blankY: 40 },
  zIndexBase: DEFAULT_Z_INDEX_BASE,
};

const UI_POSITIONS: UiPlacementConfig["position"][] = ["top-right", "top-left", "bottom-right", "bottom-left"];

const UiConfigSchema = z.object({
  position: z.union([
    z.const("top-right"),
    z.const("top-left"),
    z.const("bottom-right"),
    z.const("bottom-left"),
  ]).default("top-right"),
  offset: z.object({
    x: z.number().default(8),
    y: z.number().default(8),
    blankY: z.number().default(40),
  }).default({ x: 8, y: 8, blankY: 40 }),
  zIndexBase: z.number().default(DEFAULT_UI_CONFIG.zIndexBase)
    .description("浮窗层级基准（1-9000），胶囊与点击后弹出的主面板同取该配置值"),
});

/**
 * 归一化浮窗 UI 配置（纯函数，可单测）。
 * 兼容三种形态：新 `Config.ui` 嵌套、旧隐藏命名空间的扁平 `position/offset`、
 * 客户端扁平 `position/offsetX/offsetY/blankY`。非法或缺失 → 安全回退默认，不抛。
 */
export function normalizeUiConfig(raw: unknown): ClientUiConfig {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const ui = (
    typeof src.ui === "object" && src.ui !== null ? (src.ui as Record<string, unknown>) : src
  ) as Record<string, unknown>;
  const position = UI_POSITIONS.includes(ui.position as UiPlacementConfig["position"])
    ? (ui.position as UiPlacementConfig["position"])
    : DEFAULT_UI_CONFIG.position;
  const offset = (typeof ui.offset === "object" && ui.offset !== null ? ui.offset : {}) as Record<string, unknown>;
  const clampNum = (value: unknown, dflt: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : dflt;
  const offsetX = clampNum(ui.offsetX ?? offset.x, DEFAULT_UI_CONFIG.offset.x);
  const offsetY = clampNum(ui.offsetY ?? offset.y, DEFAULT_UI_CONFIG.offset.y);
  const blankY = clampNum(ui.blankY ?? offset.blankY, DEFAULT_UI_CONFIG.offset.blankY);
  const zIndexBase = clampZIndexBase(ui.zIndexBase, DEFAULT_UI_CONFIG.zIndexBase);
  return { position, offsetX, offsetY, blankY, zIndexBase };
}

/**
 * 把客户端扁平形态（{position, offsetX, offsetY, blankY}）归一化为写入 `Config.ui`
 * 的嵌套补丁（{position, offset:{x,y,blankY}}）。走 normalizeUiConfig 的净化为唯一
 * 入口：非法值安全回退默认，负数 clamp 到 0，四舍五入。
 */
export function buildConfigUiPatch(raw: unknown): UiPlacementConfig {
  const cfg = normalizeUiConfig(raw);
  return {
    position: cfg.position,
    offset: { x: cfg.offsetX, y: cfg.offsetY, blankY: cfg.blankY },
    zIndexBase: cfg.zIndexBase,
  };
}

/** 面板垂直定位纯函数（供 smoke 断言翻转分支；clamp 到视口内，不溢出）。
 *  #378 抽取：实现上移 shared/placement-math.js，此处 re-export 保持 index.ts
 *  导出链不变（实现见 shared 模块与两包 placement-math 薄 facade）。 */
export { panelTopForAnchor } from "../../../shared/placement-math.js";

/**
 * 插件 Config schema（标准 cordis 配置注入入口；含 `ui` 子对象）。
 * 迁移后 position/offset 走插件自身 Config 而非隐藏命名空间，设置页插件卡可编辑。
 */
export const Config: z<{
  enabled: boolean;
  announceToAgent: boolean;
  storePath: string;
  announceCatalog: boolean;
  catalogMaxEntries: number;
  enhanceEmptyDescriptions: boolean;
  resultTruncateBytes: number;
  middleware: "off" | "project" | "all";
  middlewarePolicy: Record<string, unknown>;
  ui: UiPlacementConfig;
}> = z.object({
  enabled: z.boolean().default(true).description("是否启用本插件"),
  announceToAgent: z.boolean().default(true).description("是否向 Agent 宣告插件（能力清单由 <available_mcp_servers> 承担）"),
  storePath: z.string().description("全局服务器配置路径，留空用默认 <DSH_HOME>/dsh-mcp.json").disabled(true),
  announceCatalog: z.boolean().default(DEFAULT_ANNOUNCE_CATALOG).description("是否注入 MCP 能力目录（<available_mcp_servers>）"),
  catalogMaxEntries: z.number().default(DEFAULT_CATALOG_MAX_ENTRIES).description("目录注入条目上限").disabled(true),
  enhanceEmptyDescriptions: z.boolean().default(DEFAULT_ENHANCE_EMPTY_DESCRIPTIONS).description("空描述工具条件拼接自定义描述"),
  resultTruncateBytes: z.number().default(DEFAULT_RESULT_TRUNCATE_BYTES).description("工具结果截断字节数").disabled(true),
  middleware: z.union([z.const("off"), z.const("project"), z.const("all")]).default("project")
    .description("MCP 中间层模式：off=直接注册 mcp__ 工具（默认兼容）；project=项目级走 ws_mcp_search/ws_mcp_call（推荐）；all=全部走中间层"),
  middlewarePolicy: z.dict(z.any()).default({})
    .description("中间层策略：{ allowTools: {<server>: [glob]}, denyTools: {<server>: [glob]} }，server 为裸名"),
  ui: UiConfigSchema,
});