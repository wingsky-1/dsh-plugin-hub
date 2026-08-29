/**
 * dsh-provider-usage — 胶囊位置 UI 配置（纯函数 + 持久化文件读写）。
 *
 * #276 方案 A 阶段 3 拆分：自 index.ts 抽离，导出面由 index.ts 转发 re-export
 * 保持不变（外部消费者仍从 lib/index.js 导入）。
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_Z_INDEX_BASE, clampZIndexBase } from "./placement-math.ts";

/** 胶囊/面板位置配置（设置页「胶囊位置」区维护，持久化到 historyRoot/ui.json）。 */
export interface UiPlacementConfig {
  /** 胶囊锚点：右上/左上/右下/左下（默认 top-right = 历史行为）。 */
  placement: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  /** 胶囊水平偏移 px（对 left 或 right 生效）。 */
  offsetX: number;
  /** 胶囊垂直偏移 px（对 top 或 bottom 生效）。 */
  offsetY: number;
  /** 面板相对胶囊下缘的垂直间距 px。 */
  panelOffsetY: number;
  /** 层级基准（clamp 1–9000；胶囊与点击后弹出的主面板 computed z-index 均取该配置值，#128 重开）。 */
  zIndexBase: number;
}

/** 默认胶囊/面板位置：右上角、右侧对齐（offsetX=0 贴容器右缘）；offsetY=48 让
 *  胶囊默认位于 dsh-mcp-manager 浮窗（默认 top-right、offsetY=8、高约 26px）下方，
 *  保证两胶囊默认互不重叠（issue #116，去避让后以固定默认值错开；跨包避让契约，
 *  不可回退——见两包 README 与 docs/DEVELOPMENT.md「浮窗移动端适配约定」）。 */
export const DEFAULT_UI_CONFIG: UiPlacementConfig = {
  placement: "top-right",
  offsetX: 0,
  offsetY: 48,
  panelOffsetY: 10,
  zIndexBase: DEFAULT_Z_INDEX_BASE,
};

const UI_PLACEMENTS: UiPlacementConfig["placement"][] = ["top-right", "top-left", "bottom-right", "bottom-left"];

/** 校验并归一化客户端提交的 UI 配置（非法值回退默认；offset 限制 0–2000）。 */
export function normalizeUiConfig(raw: unknown): UiPlacementConfig {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const placement = UI_PLACEMENTS.includes(src.placement as UiPlacementConfig["placement"])
    ? (src.placement as UiPlacementConfig["placement"])
    : DEFAULT_UI_CONFIG.placement;
  const clamp = (v: unknown, dflt: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : Number(v);
    return Number.isFinite(n) ? Math.min(2000, Math.max(0, Math.round(n))) : dflt;
  };
  return {
    placement,
    offsetX: clamp(src.offsetX, DEFAULT_UI_CONFIG.offsetX),
    offsetY: clamp(src.offsetY, DEFAULT_UI_CONFIG.offsetY),
    panelOffsetY: clamp(src.panelOffsetY, DEFAULT_UI_CONFIG.panelOffsetY),
    // #128：层级基准 clamp 到 [1,9000]，非法回退默认（与 mcp-manager 同构语义）。
    zIndexBase: clampZIndexBase(src.zIndexBase, DEFAULT_UI_CONFIG.zIndexBase),
  };
}

/** 面板垂直定位纯函数（供 smoke 断言翻转分支；clamp 到视口内，不溢出）。 */
export function panelTopForAnchor(
  anchor: "top" | "bottom",
  pillTop: number,
  pillBottom: number,
  panelHeight: number,
  gap: number,
): number {
  return anchor === "bottom" ? Math.max(6, pillTop - panelHeight - gap) : Math.max(6, pillBottom + gap);
}

/** UI 配置持久化文件（historyRoot 下，0600）。 */
export function uiConfigFile(root: string): string {
  return join(root, "ui.json");
}

/** 读取 UI 配置（文件缺失/损坏回退默认）。 */
export async function readUiConfig(root: string): Promise<UiPlacementConfig> {
  try {
    const text = await readFile(uiConfigFile(root), "utf8");
    return normalizeUiConfig(JSON.parse(text));
  } catch {
    return { ...DEFAULT_UI_CONFIG };
  }
}

/** 原子写 UI 配置（tmp + rename，0600；根目录缺失时先建）。 */
export async function writeUiConfig(root: string, cfg: UiPlacementConfig): Promise<void> {
  const file = uiConfigFile(root);
  await mkdir(root, { recursive: true });
  const tmp = `${file}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(normalizeUiConfig(cfg)), { mode: 0o600 });
  await rename(tmp, file);
}

/** 序列化一帧 SSE data 行（同 dsh-mcp-manager 的 sseData 语义）。 */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}