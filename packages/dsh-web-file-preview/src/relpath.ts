/**
 * dsh-web-file-preview — Markdown 相对引用路径展开（纯函数，双端共用）。
 *
 * U8 v2：供客户端把 md 内的相对图片/链接展开为可预览的绝对路径。纯逻辑、
 * 无 DOM / node 特定 API（宿主 tsc 与浏览器 esbuild 均可打包），可用 smoke 直测。
 *
 * 语义（对齐评审 §5.5 U8 v2）：
 *  - 相对引用（裸名 / ./ / ../）→ 相对「被预览文件所在目录」解析；
 *  - 绝对路径 `/x`、协议相对 `//host`、http(s)/mailto/tel/data/file URI → 不展开（null，保留原链接）；
 *  - query / fragment 尾巴丢弃（服务端只按 path 定位）；
 *  - `%20` 等编码在 pathname 上解码一次（文件名含空格/中文可正常解析）。
 */

/**
 * 把相对引用解析为绝对路径（POSIX 语义，基于 file: URL）。
 * @param baseFile - 被预览文件的完整路径（如 /home/u/work/src/a.md）。
 * @param reference - md 内的引用（相对路径 / 绝对路径 / URL）。
 * @returns 规范化绝对路径；不适用（协议相对/外域/绝对根/无法解析）→ null。
 */
export function resolveRelativePath(baseFile: string, reference: string): string | null {
  if (typeof reference !== "string" || reference === "") return null;
  // 已是服务端 API 前缀（幂等保护：二次渲染不再重写）。
  if (reference.startsWith("/api/")) return null;
  // 绝对路径（/x）与 web 根语义保留（v2 约定：不重写）。
  if (reference.startsWith("/")) return null;
  // 锚点/查询-only ≠ 文件引用。
  if (reference.startsWith("#")) return null;
  // 协议相对与外域一律保留；data:/blob/file 等非文件语义保留。
  if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(reference)) return null;
  try {
    const url = new URL(reference, "file://" + baseFile.replace(/\\/g, "/"));
    // file: 之外的协议（理论上不会到这，稳妥起见）不展开。
    if (url.protocol !== "file:") return null;
    // //host 形态会被并入 host：外域引用不展开。
    if (url.host !== "") return null;
    const pathname = url.pathname; // 已做 . / .. 规范化；query/hash 不计入 pathname。
    return decodeSafePath(pathname);
  } catch {
    return null;
  }
}

/** 解码 URL pathname（%20 等）；非法编码序列原样保留。 */
function decodeSafePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}