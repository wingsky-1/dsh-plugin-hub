/**
 * dsh-web-file-preview — 大文件渲染/快照防御阈值（issue #344，无 DOM 依赖）。
 *
 * 20M 上限放行后，超大文本若走 marked/highlight 同步渲染会秒级阻塞主线程；返回栈
 * 快照若保留超大 rawText 会在 MAX_BACK=32 层累积下常驻数百 MB。本模块用纯常量 +
 * 谓词把两层防御的阈值集中为单一事实源，node smoke 直测（见 test/smoke.ts
 * 「issue #344：render-limit 渲染防御阈值」）。
 *
 * 口径说明：`rawText.length` 是 UTF-16 码元数（非字节），仅作渲染取舍的启发式阈值
 * ——服务端 413 按字节判、客户端渲染按码元判是两层独立防线，互不干扰。
 */

/** 超过该码元数的文本默认路径降级为「仅 <pre> 原样展示 + 截断 + 提示」，
 * 不走 marked/highlight 同步渲染（≈1MB UTF-16，防主线程秒级阻塞）。 */
export const TEXT_RENDER_LIMIT_CODEPOINTS = 1024 * 1024;

/** 超过该码元数的 rawText 不纳入返回栈快照（仅存 path，返回时重新拉取），
 * 防 MAX_BACK=32 × 20M 常驻（≈1MB，与渲染阈值同量级）。 */
export const SNAPSHOT_TEXT_LIMIT_CODEPOINTS = 1024 * 1024;

/** 是否应降级渲染（验收 A2b：>1MB 文本走纯 <pre> 截断路径）。 */
export function exceedsTextRenderLimit(textLength: number): boolean {
  return textLength > TEXT_RENDER_LIMIT_CODEPOINTS;
}

/** 是否应纳入返回栈快照（大文件不入栈）。 */
export function textFitsSnapshot(textLength: number): boolean {
  return textLength <= SNAPSHOT_TEXT_LIMIT_CODEPOINTS;
}