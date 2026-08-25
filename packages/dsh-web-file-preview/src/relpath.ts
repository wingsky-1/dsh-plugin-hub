/**
 * dsh-web-file-preview — Markdown 相对引用路径展开（纯函数，双端共用）。
 *
 * U8 v2：供客户端把 md 内的相对图片/链接展开为可预览的绝对路径。纯逻辑、
 * 无 DOM / node 特定 API（宿主 tsc 与浏览器 esbuild 均可打包），可用 smoke 直测。
 *
 * 语义（对齐评审 §5.5 U8 v2 + issue #45）：
 *  - 相对引用（裸名 / ./ / ../）→ 相对「被预览文件所在目录」解析；
 *  - 绝对路径 `/x`、协议相对 `//host`、http(s)/mailto/tel/data/file URI → 不展开（null，保留原链接）；
 *  - query / fragment 尾巴丢弃（服务端只按 path 定位）；
 *  - `%20` 等编码在 pathname 上解码一次（文件名含空格/中文可正常解析）。
 * issue #45 新增：`resolveAbsolutePath`（绝对路径 → 规范化路径，供可预览后缀的
 * 绝对路径重写为 Modal 内跳转）与 `splitReferenceFragment`（剥离并解码
 * #fragment，供带锚点的文件引用在 Modal 内定位小节）。
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

/**
 * 把绝对路径引用解析为规范化绝对路径（POSIX 语义，基于 file:///）。
 * issue #45：模型生成的 md 文档常用仓库绝对路径互引（AGENTS.md / 设计文档尤甚）；
 * 服务端 file 路由本就接受绝对 path 参数（不做 cwd 逃逸拦截，见 src/routes.ts
 * 文件头约定），客户端据此把可预览后缀的绝对路径重写为 Modal 内跳转。
 * @param reference - 以单个 / 开头的文件系统绝对路径引用（/api/ 幂等与协议相对
 *   由调用方 rewriteTarget 先行排除；`//host` 协议相对形态此处拒绝）。
 * @returns 规范化绝对路径（. / .. 归一、%20 等编码解码一次）；不适用 → null。
 */
export function resolveAbsolutePath(reference: string): string | null {
  if (typeof reference !== "string" || !reference.startsWith("/")) return null;
  if (reference.startsWith("//")) return null; // //host 协议相对 ≠ 文件系统绝对路径
  try {
    const url = new URL("file://" + reference.replace(/\\/g, "/"));
    if (url.protocol !== "file:" || url.host !== "") return null;
    const pathname = url.pathname; // . / .. 已规范化；query/hash 不计入 pathname。
    return decodeSafePath(pathname);
  } catch {
    return null;
  }
}

/** 引用拆分结果：去掉 #fragment 后的待解析引用 + 解码后的 fragment（无则 null）。 */
export interface SplitRef {
  ref: string;
  fragment: string | null;
}

/**
 * 从引用中剥离 #fragment（issue #45 附带瑕疵：./f.md#g 此前 fragment 被丢弃，
 * Modal 内打开后无法定位到对应小节）。
 * 只按第一个 "#" 分割（此前 KEEP_RE 已排除带 scheme 的 URL，无 "##" 歧义面）；
 * fragment 做一次 %XX 解码（非法编码原样保留），与 GFM 标题 slug（未编码
 * unicode 文本）可直接比对。空 fragment（a.md#）视为无锚点。
 */
export function splitReferenceFragment(reference: string): SplitRef {
  const s = typeof reference === "string" ? reference : "";
  const hash = s.indexOf("#");
  if (hash < 0) return { ref: s, fragment: null };
  let decoded = s.slice(hash + 1);
  try {
    decoded = decodeURIComponent(decoded);
  } catch { /* 非法编码原样保留 */ }
  return { ref: s.slice(0, hash), fragment: decoded === "" ? null : decoded };
}