/**
 * dsh-web-file-preview — 客户端 resolved 路径权威化辅助（issue #486）。
 *
 * 宿主端 file/alloc 响应回传真实 resolved 绝对路径（可能经 ③ cwd 内 basename
 * 搜索纠正，与请求 path 不同）：/file 走 `X-File-Path` 响应头（encodeURIComponent），
 * /alloc 走 JSON `path` 字段。客户端各 fetch 成功回调在**首次渲染前**用本模块
 * 更新 state.currentPath（评审 P0-2：先改 currentPath 再渲染，禁止渲染后补改），
 * 使 md basePath、展示标题、返回栈、后续跳转全部以宿主权威值为准。
 *
 * 老响应（无头/无 path 字段）→ 保持原值（兼容降级，不报错）。
 */

import type { FilePreviewState } from "./state.ts";
import { renderGroupFor } from "./renderer.ts";

/** 从 /file 响应读真实 resolved 路径；坏/缺头 → fallback（原请求 path）。 */
export function resolvedFromFileResponse(res: Response, fallback: string): string {
  const raw = res.headers.get("x-file-path");
  if (raw === null || raw === "") return fallback;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === "" ? fallback : decoded;
  } catch {
    return fallback; // 非法编码 → 降级原值
  }
}

/**
 * 把宿主回传的 resolved 设为权威 currentPath，并同步 currentGroup（分组按
 * resolved 扩展名——入口 `foo.txt` 经搜索命中真实 `foo.html` 时分组变化）。
 *
 * @returns 分组是否相对入口变化（true → 调用方需整体重建 UI：tab 栏/按钮按
 *   入口分组已建好，正文渲染前必须用新分组重建，否则 tab 语义错乱）。
 */
export function applyResolvedPath(state: FilePreviewState, resolved: string): boolean {
  const groupChanged = renderGroupFor(resolved).group !== state.currentGroup?.group;
  state.currentPath = resolved;
  if (groupChanged) {
    state.currentGroup = renderGroupFor(resolved);
  }
  return groupChanged;
}
