/**
 * dsh-mcp-manager — 插件 Config schema 与配置归一化（纯函数，单一事实源）。
 *
 * 插件自身 Config（cordis 配置注入入口）与浮窗 UI 配置的校验/归一化/默认值；
 * 类型自 types.ts 取（防循环引用），placement-math 提供层级 clamp 与默认层级。
 */

import z from "schemastery";
import { clampZIndexBase, DEFAULT_Z_INDEX_BASE } from "../../shared/interface.ts";
// 三个默认值在**模块求值期**被下面的 z.object().default() 消费——端口注入要等装配完成，
// 那时 schema 早已求值，只能取共享层的单一物理定义（I2①：不再产生 config/model → catalog /
// connection 的值边）。
import { DEFAULT_ANNOUNCE_CATALOG, DEFAULT_CATALOG_MAX_ENTRIES } from "../shared/interface.ts";
import type { ClientUiConfig } from "../../shared/interface.ts";
import type { UiPlacementConfig } from "./impl/ui/type.ts";

/** 默认浮窗 UI 配置（与升级前一致，无回归；层级基准引用 placement-math 单一事实源，
 *  DEFAULT_Z_INDEX_BASE=10 对应 CSS 默认 z-index:10）。 */
export const DEFAULT_UI_CONFIG: UiPlacementConfig = {
  position: "top-right",
  offset: { x: 8, y: 8, blankY: 40 },
  zIndexBase: DEFAULT_Z_INDEX_BASE,
};

const DebugConfigSchema = z
  .object({
    callStats: z
      .boolean()
      .default(false)
      .description("是否开启 MCP 工具调用统计调试与落盘（默认关闭，仅可通过配置文件开启）"),
    statsFile: z
      .string()
      .default("")
      .description("统计落盘路径，留空使用默认 <DSH_HOME>/@wingsky-1/dsh-mcp-manager/stats.json"),
  })
  .default({ callStats: false, statsFile: "" });

// 集合内容与下方 UiConfigSchema 的 z.union 逐项对应：加锚点时两处同改（归一化白名单与 schema 校验同源）。
const UI_POSITIONS: ReadonlySet<string> = new Set([
  "top-right",
  "top-left",
  "bottom-right",
  "bottom-left",
]);

// 官方 ConfigForm 以 meta.volatile 识别稳定可编辑子树；extra 写入同一 metadata，
// 同时保持本包对外 callable schema 的平面输入/输出类型。
const UiConfigSchema = z
  .object({
    position: z
      .union([
        z.const("top-right"),
        z.const("top-left"),
        z.const("bottom-right"),
        z.const("bottom-left"),
      ])
      .default("top-right"),
    offset: z
      .object({
        x: z.number().default(8),
        y: z.number().default(8),
        blankY: z.number().default(40),
      })
      .default({ x: 8, y: 8, blankY: 40 }),
    zIndexBase: z
      .number()
      .default(DEFAULT_UI_CONFIG.zIndexBase)
      .description("浮窗层级基准（1-9000），胶囊与点击后弹出的主面板同取该配置值"),
  })
  .extra("volatile", true);

/** 配置袋收窄：非空对象才是可按键读取的形态，其余（null / 标量 / undefined）一律视作空袋。 */
function isConfigBag(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** position 是否落在受支持锚点上；白名单外（含缺省）一律回落默认，不抛。 */
function isUiPosition(value: unknown): value is UiPlacementConfig["position"] {
  return typeof value === "string" && UI_POSITIONS.has(value);
}

/** 实际承载 UI 值的配置袋：优先嵌套 ui（新 Config 形态），否则顶层（旧隐藏命名空间 / 客户端扁平形态）。 */
function uiValueBag(raw: unknown): Record<string, unknown> {
  if (!isConfigBag(raw)) return {};
  return isConfigBag(raw.ui) ? raw.ui : raw;
}

/** 数值净化：非有限数（含非数字）回落默认，其余 clamp 到非负并四舍五入。 */
function clampNum(value: unknown, dflt: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : dflt;
}

/**
 * 归一化浮窗 UI 配置（纯函数，可单测）。
 * 兼容三种形态：新 `Config.ui` 嵌套、旧隐藏命名空间的扁平 `position/offset`、
 * 客户端扁平 `position/offsetX/offsetY/blankY`。非法或缺失 → 安全回退默认，不抛。
 */
export function normalizeUiConfig(raw: unknown): ClientUiConfig {
  const ui = uiValueBag(raw);
  const position = isUiPosition(ui.position) ? ui.position : DEFAULT_UI_CONFIG.position;
  const offset = isConfigBag(ui.offset) ? ui.offset : {};
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
 *  实现自持于包内 src/shared/placement-math.ts（shared-leaf 叶子约束），此处
 *  re-export 保持 index.ts 导出链不变。 */
export { panelTopForAnchor } from "../../shared/interface.ts";

/**
 * 插件 Config schema（标准 cordis 配置注入入口；含 `ui` 子对象）。
 * 官方 ConfigForm 只开放 ui child；根级运行时字段全部 disabled。
 */
export const Config: z<{
  enabled: boolean;
  announceToAgent: boolean;
  storePath: string;
  announceCatalog: boolean;
  catalogMaxEntries: number;
  debug: {
    callStats: boolean;
    statsFile: string;
  };
  ui: UiPlacementConfig;
}> = z.object({
  enabled: z.boolean().default(true).description("是否启用本插件").disabled(true),
  announceToAgent: z
    .boolean()
    .default(true)
    .description("是否向 Agent 宣告插件（能力清单由 <available_mcp_servers> 承担）")
    .disabled(true),
  storePath: z
    .string()
    .description("全局服务器配置路径，留空用默认 <DSH_HOME>/@wingsky-1/dsh-mcp-manager/mcp.json")
    .disabled(true),
  announceCatalog: z
    .boolean()
    .default(DEFAULT_ANNOUNCE_CATALOG)
    .description("是否注入 MCP 能力目录（<available_mcp_servers>）")
    .disabled(true),
  catalogMaxEntries: z
    .number()
    .default(DEFAULT_CATALOG_MAX_ENTRIES)
    .description("目录注入条目上限")
    .disabled(true),
  debug: DebugConfigSchema.disabled(true),
  ui: UiConfigSchema,
});

/** schema 的输入面（Config(...) 的入参类型）：空输入即「全部取默认值」。 */
type ConfigInput = Parameters<typeof Config>[0];

/**
 * 默认配置（键集 = schema 中带 .default() 的字段）。从 schema 归一化**空输入**派生，
 * 不手写第二份默认值——默认值只写在上面的 .default(...) 里，改一处即改两处。
 * storePath 无默认值，故键集比 schema 字段数少 1（config-matrix 门禁的 N1/N2 锁这条不变式）。
 */
export const DEFAULT_CONFIG = Config({} as ConfigInput);

/**
 * 归一化：把外部输入按 schema 校验并补默认值。
 * 与 normalizeUiConfig 分工不同：后者只处理 ui 子面（设置页提交的局部 patch），
 * 本函数给出一份**完整**配置。
 */
export function normalizeConfig(input: unknown) {
  return Config(input as ConfigInput | undefined);
}

/** 只接受布尔值的**顶层**配置键（客户端 UI 按它渲染开关）；嵌套的 debug.callStats 不是顶层键。 */
export const BOOLEAN_KEYS: readonly string[] = ["enabled", "announceToAgent", "announceCatalog"];

/**
 * 非负整数键及其上界：本包**没有产品上界**——catalogMaxEntries 只被要求是正整数，
 * 上界是机器/内存极限而非产品约束，编一个上界等于造假事实。空对象是显式声明而不是遗漏。
 */
export const COUNT_LIMITS: Record<string, number> = {};
