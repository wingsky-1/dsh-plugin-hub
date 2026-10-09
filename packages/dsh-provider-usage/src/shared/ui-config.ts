/**
 * dsh-provider-usage — 胶囊位置 UI 配置（纯函数 + 持久化文件读写）
 * + 包内原子写原语（temporaryNameFor / atomicWrite，tmp+rename 的唯一实现）。
 *
 * 自 index.ts 抽离，导出面由 index.ts 转发 re-export
 * 保持不变（外部消费者仍从 lib/index.js 导入）。
 *
 * 原子写原语也落在本文件：`shared/` 下只有这里是持久化读写落点（其余文件零 node
 * 依赖），`shared/interface.ts` 是门面不含实现，故包内 11 处 tmp+rename 统一经
 * `interface.ts` 取用这里的实现，不另开 file-io 叶。域侧一律经门面，不直引本文件
 * 的这两个符号以外的实现细节。
 */

import { randomBytes } from "node:crypto";
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
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
  /** 层级基准（clamp 1–9000；胶囊与点击后弹出的主面板 computed z-index 均取该配置值）。 */
  zIndexBase: number;
}

/** 默认胶囊/面板位置：右上角、右侧对齐（offsetX=0 贴容器右缘）；offsetY=48 让
 *  胶囊默认位于 dsh-mcp-manager 浮窗（默认 top-right、offsetY=8、高约 26px）下方，
 *  保证两胶囊默认互不重叠（去避让后以固定默认值错开；跨包避让契约，
 *  不可回退——见两包 README 与 docs/DEVELOPMENT.md「浮窗移动端适配约定」）。 */
export const DEFAULT_UI_CONFIG: UiPlacementConfig = {
  placement: "top-right",
  offsetX: 0,
  offsetY: 48,
  panelOffsetY: 10,
  zIndexBase: DEFAULT_Z_INDEX_BASE,
};

const UI_PLACEMENTS: UiPlacementConfig["placement"][] = [
  "top-right",
  "top-left",
  "bottom-right",
  "bottom-left",
];

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
    // 层级基准 clamp 到 [1,9000]，非法回退默认（与 mcp-manager 同构语义）。
    zIndexBase: clampZIndexBase(src.zIndexBase, DEFAULT_UI_CONFIG.zIndexBase),
  };
}

// 面板垂直定位纯函数改由 interface.ts 直接从 placement-math.ts 转出（单源，
// 此处不再中转——目录门面是唯一出口）。

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
  await mkdir(root, { recursive: true });
  await atomicWrite(uiConfigFile(root), JSON.stringify(normalizeUiConfig(cfg)));
}

// ------------------------------------------------------------------ 原子写原语（包内单一实现）

/**
 * 唯一临时名：进程号 + 毫秒时间戳（36 进制）+ 12 hex 随机后缀。
 *
 * 为什么三样都要：只带 `Date.now()` 会让同进程毫秒级并发双写共用同一个临时名——两路
 * `writeFile` 截断同一路径，先写的那份内容被后写的截断（本包原有 6 处即此形态）；
 * pid 挡跨进程同名，时间戳 + 随机后缀挡同进程同时刻同名。形态与仓库另两包
 * `src/server/shared/file-io.ts` 的 `temporaryNameFor` 同源（口径出处：
 * `.agents/notes/rejected/architecture/2026-09-21-disk-io-shared-extraction.md` 的采纳方案
 * ——统一临时名、各包自持，故这里不建跨包共享层）。
 *
 * 只保证「每次写各落各的临时名、内容各自完整」：并发下 `rename` 的先后仍无保证，
 * 后写的可能先 rename，那属于各调用点的串行/合并职责（per-root 链、单飞队列），
 * 不在本原语里解决。
 */
export function temporaryNameFor(file: string): string {
  return `${file}.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
}

/**
 * 原子写全文（0600，tmp + rename；失败即清临时名并把**原错误**上抛）。
 *
 * 父目录由调用方补齐：各落点的目录 mode 不同（ui/config 无 mode、schedule/upgrade 带
 * 0700），mkdir 收进这里等于让「只改一个落点的目录权限」变成改公共面，故不收。
 * mode 恒定 0600——本包全部落点都是这个值，落盘面里有凭据与非公开用量数据。
 *
 * 落点选在本文件的理由：`shared/interface.ts` 是门面（自身不含实现），`shared/` 下其余
 * 文件零 node 依赖，只有本文件是持久化读写落点——把 tmp+rename 提成单一实现正好落在
 * 它身上，不必新开文件（新文件要另登变异面与目录基线，见交付报告）。
 */
export async function atomicWrite(file: string, data: string): Promise<void> {
  const temporary = temporaryNameFor(file);
  try {
    await writeFile(temporary, data, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (cause) {
    // 清理失败不得覆盖原错误：调用方要判的是「为什么没写进去」，不是「清理为什么也没成」。
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}
