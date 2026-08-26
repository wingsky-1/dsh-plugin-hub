/**
 * dsh-web-file-preview — 客户端后缀分组（复用 src/grouping.ts 单一事实源）。
 *
 * 与宿主 src/mime.ts 共用同一份后缀分组表（见 grouping.ts），把路径映射到
 * 渲染分组：image → 图片灯箱；md → Markdown 渲染(可切原始)；code → 代码高亮
 * (可切原始)；text → 等宽；other → 不可预览。
 */
import { groupOfPath, type GroupOfResult, type PreviewGroupKind } from "../grouping.ts";

/** 渲染分组（与宿主/grouping 预览分组一致）。 */
export type RenderGroup = PreviewGroupKind;

/** 分组判定结果。 */
export type GroupResult = GroupOfResult;

/** 按路径（basename 扩展名）判定渲染分组。 */
export const renderGroupFor = groupOfPath;
