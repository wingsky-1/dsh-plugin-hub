/**
 * dsh-web-file-preview — Markdown 相对引用路径展开（纯函数，双端共用）。
 *
 * U8 v2：供客户端把 md 内的相对图片/链接展开为可预览的绝对路径。纯逻辑、
 * 无 DOM / node 特定 API（宿主 tsc 与浏览器 esbuild 均可打包），可用 smoke 直测。
 *
 * 语义（对齐评审 §5.5 U8 v2 + issue #45 + #479）：
 *  - 相对引用（裸名 / ./ / ../）→ 相对「被预览文件所在目录」解析；
 *  - 绝对路径 `/x`、协议相对 `//host`、http(s)/mailto/tel/data/file URI → 不展开（null，保留原链接）；
 *  - query / fragment 尾巴丢弃（服务端只按 path 定位）；
 *  - `%20` 等编码在 pathname 上解码一次（文件名含空格/中文可正常解析）。
 * issue #45 新增：`resolveAbsolutePath`（绝对路径 → 规范化路径，供可预览后缀的
 * 绝对路径重写为 Modal 内跳转）与 `splitReferenceFragment`（剥离并解码
 * #fragment，供带锚点的文件引用在 Modal 内定位小节）。
 * issue #479 新增：`normalizeBasePath`（openPreview 入参的「被预览文件路径」→
 * 绝对形态，供 md 内相对引用解析的 basePath 使用——修复相对路径打开 md 时
 * 文内相对图片/链接全部无法重写的问题）。
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

/**
 * 把 openPreview 入参的「被预览文件路径」规范化为绝对形态（issue #479）。
 *
 * ⚠️ legacy（issue #486）：客户端请求链路已不再调用本函数——#486 起客户端零
 * 预处理，路径解析/搜索全部交由宿主端（file/alloc 三级定位 + resolved 回传，
 * 见 routes.resolveFile / client/resolved-path.ts），md basePath 由宿主回传的
 * 真实绝对路径提供，比客户端预归一更权威。本函数保留为纯函数导出（smoke /
 * 既有单测 / 潜在外部消费方兼容），不再被生产客户端引用。
 *
 * 背景：md 渲染时以 `state.currentPath` 作 basePath 解析文内相对引用；当该路径是
 * 相对路径（对话流文本嗅探 / 相对 <a href> 点击传入）时，`resolveRelativePath` 内部
 * `new URL(reference, "file://" + 相对baseFile)` 会把首段解析为 host 导致解析失败，
 * 文内相对图片/链接全部不重写。本函数在 openPreview 入口把相对 path 用会话 cwd
 * 归一为绝对形态，使 basePath 从源头即绝对，下游全部消费者（md 渲染 / 返回栈 /
 * data-fp-cwd / fileUrl）天然正确。
 *
 * 输入面（与 resolveAbsolutePath 划界）：本函数处理 **openPreview 入参**（文件系统
 * 路径形态，可相对可绝对）；`resolveAbsolutePath` 处理 **md 内容里的 `/x` 引用**
 * （URL 语义，只收绝对）。两者的编码口径独立演进，改动时须同步核对（见 normalizeBasePath）。
 *
 * 规则（顺序敏感）：
 *  - 空串 / 纯裸名（不含 `/` 或 `\`）→ 原样返回——纯裸名归一会破坏服务端 #41
 *    basename 兜底（routes.ts 仅对非绝对路径触发 findUniqueByBasename），且裸名
 *    md 文内相对引用本就无目录上下文可解析，维持现状不构成回退；
 *  - 绝对形态 → 原样：`/` 开头、`~/`/`~\` 开头（家目录语义，服务端 untildify
 *    展开）、`C:\`/`C:/` 盘符开头、带 scheme、`//` 协议相对；
 *  - cwd 缺失/空/非绝对（非 `/` 开头且非盘符开头）→ 原样（显式分支，不依赖 URL
 *    副作用兜底——相对 cwd 无法作为 file: 基准）；
 *  - 其余 → 段级转义后经 `new URL` 拼绝对：路径段逐个 encodeURIComponent（保留
 *    `""`/`.`/`..` 段原样，分隔符与相对段语义不变），再经 file: URL 解析规范化；
 *    盘符形态（`/C:/...`）去前导 `/` 还原为 `C:/...`（win32 resolve 正确）；
 *    最终 decodeURIComponent 一次。任何异常 → 原样返回（openPreview 入口绝不因
 *    归一化抛错）。
 *
 * @param path - openPreview 收到的被预览文件路径（可相对可绝对）。
 * @param cwd  - 会话 cwd（可缺省；相对 path 缺 cwd 时无力归一，维持现状）。
 * @returns 绝对形态路径（可作 basePath / 预览 URL path 参数）；无法归一 → 原样。
 */
export function normalizeBasePath(path: string, cwd: string | undefined): string {
  if (typeof path !== "string" || path === "") return path;
  // 纯裸名：不含路径分隔符 → 不归一（保留服务端 #41 basename 兜底可达）。
  if (!path.includes("/") && !path.includes("\\")) return path;
  // 绝对形态 / 协议相对 / scheme / 家目录 / 盘符 → 原样。
  if (
    path.startsWith("/") ||
    path.startsWith("~/") ||
    path.startsWith("~\\") ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(path)
  ) {
    return path;
  }
  // cwd 缺失/空/非绝对 → 原样（显式分支；相对 cwd 无法作 file: 基准）。
  if (
    cwd === undefined ||
    cwd === "" ||
    (!cwd.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(cwd))
  ) {
    return path;
  }
  try {
    const baseCwd = cwd.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    // 段级转义：保留空段与 ./.. 相对段，其余段编码（防 #/?/字面 %XX 被 URL 吞掉）。
    const escaped = path
      .split("/")
      .map((seg) => (seg === "" || seg === "." || seg === ".." ? seg : encodeURIComponent(seg)))
      .join("/");
    const url = new URL(escaped, `file://${baseCwd}/`);
    if (url.protocol !== "file:" || url.host !== "") return path;
    let normalized = url.pathname; // . / .. 已由 URL 规范化。
    // 盘符形态（/C:/...）去前导 / → C:/...（win32 resolve 正确；POSIX 形态不变）。
    if (/^\/[a-zA-Z]:\//.test(normalized)) normalized = normalized.slice(1);
    return decodeSafePath(normalized);
  } catch {
    return path;
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