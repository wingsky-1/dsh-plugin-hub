/**
 * dsh-web-file-preview — 引用 → 预览目标重写决策（纯函数，无 DOM 依赖）。
 *
 * 从 rewrite.ts 抽出的「能不能重写、重写成什么」决策层（issue #45）：rewrite.ts
 * 负责 DOM 后处理，本模块只做字符串→预览目标的判定，可被 node smoke 经 esbuild
 * bundle 后直测（同 link-resolver 模式），不拖入 DOMPurify。
 *
 * issue #45 语义：
 *  - 相对可预览引用（U8 v2 既有）→ 预览 API URL；
 *  - 绝对路径且可预览后缀（新增）→ 同样重写为 Modal 内跳转（服务端 file 路由
 *    本就接受绝对 path；模型生成 md 常用仓库绝对路径互引，此前点击整页跳走）；
 *  - fragment 不再丢弃：./f.md#g 拆出锚点随 RewrittenRef.fragment 返回，
 *    由调用方写入 data-fp-frag 供 Modal 打开后定位小节；
 *  - 纯锚点 / 协议相对 / 外域 / data: / blob: / 不可预览后缀 / /api/ 幂等 → null
 *    （rewriteAnchor 对 null 结果追加 target=_blank 新标签兜底，绝不整页导航）。
 * issue #479 P2 新增：
 *  - 目录引用（解析后以路径分隔符结尾，如 [diagrams/](diagrams/)）→ rewriteTarget
 *    仍返回 null（目录不可预览），但配套 dirResolvedPathOf 给出「目录语义」判定，
 *    rewrite.ts 据此标 data-fp-dir，点击 toast 提示而非新标签打开错误 URL。
 */

import { groupOfPath } from "../grouping.ts";
import { resolveRelativePath, resolveAbsolutePath, splitReferenceFragment } from "../relpath.ts";

/** 预览 API 路由（与宿主 ROUTES.file 一致，契约 smoke 校验字面量）。 */
export const REWRITE_API_PATH = "/api/dsh-file-preview/file";

/** 重写后 URL 的 path 参数最长字节（评审实测：Node 431 @ ~16KB；8KB 余量足够）。 */
export const MAX_REWRITE_PATH = 8000;

/** 重写前后缀匹配（URL 协议/协议相对/data/blob/file → 保留）。 */
const KEEP_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/;

export interface RewriteOpts {
  /** 会话 cwd（拼进预览 URL；可缺省，绝对路径预览仍有效）。 */
  cwd?: string;
  /** 被预览文件的完整路径（相对引用的解析基目录）。 */
  basePath: string;
}

export interface RewrittenRef {
  /** 预览 API URL。 */
  url: string;
  /** 解析后的绝对路径。 */
  path: string;
  /** 引用携带的 #fragment（已解码；无则 null），供 Modal 打开后定位小节。 */
  fragment: string | null;
}

/** 解析后的绝对路径 → 预览 API URL。 */
export function makePreviewUrl(resolved: string, cwd: string | undefined): string {
  const params = new URLSearchParams();
  if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
  params.set("path", resolved);
  return `${REWRITE_API_PATH}?${params.toString()}`;
}

/** 解析后的绝对路径是否目录形态（以路径分隔符结尾；resolve* 已统一为 /）。 */
export function isDirResolvedPath(path: string): boolean {
  return typeof path === "string" && path.length > 0 && (path.endsWith("/") || path.endsWith("\\"));
}

/**
 * 引用 → 解析后的绝对路径 + fragment（公共解析前缀，rewriteTarget / dirResolvedPathOf
 * 共用，避免两处重复「幂等 / 溢出 / 锚点 / 相对-绝对」判定漂移）。
 * 不可解析（协议相对 / 外域 / data / blob / /api/ 幂等 / 空 / 溢出 / 纯锚点）→ resolved null。
 */
function resolveRef(
  ref: string,
  opts: RewriteOpts,
): { resolved: string | null; fragment: string | null } {
  if (typeof ref !== "string" || ref === "" || KEEP_RE.test(ref)) return { resolved: null, fragment: null };
  if (ref.startsWith(REWRITE_API_PATH) || ref.startsWith("/api/")) return { resolved: null, fragment: null }; // 幂等
  if (ref.length > MAX_REWRITE_PATH) return { resolved: null, fragment: null }; // 防溢出
  if (ref.startsWith("#")) return { resolved: null, fragment: null }; // 纯锚点走滚动定位链路
  const { ref: pathRef, fragment } = splitReferenceFragment(ref);
  if (pathRef === "") return { resolved: null, fragment: null };
  const resolved = resolveRelativePath(opts.basePath, pathRef)
    ?? (pathRef.startsWith("/") ? resolveAbsolutePath(pathRef) : null);
  return { resolved, fragment };
}

/**
 * 解析引用 → 可重写的预览目标；不可重写返回 null。
 * 相对引用优先按「被预览文件所在目录」解析（U8 v2 语义不变）；以单个 / 开头
 * 且相对解析不适用时按文件系统绝对路径解析（issue #45）；fragment 剥离后保留。
 */
export function rewriteTarget(ref: string, opts: RewriteOpts): RewrittenRef | null {
  const { resolved, fragment } = resolveRef(ref, opts);
  if (resolved === null) return null;
  // issue #479 P2：目录引用（[diagrams/](diagrams/) 等）不可预览 → null（由 rewrite.ts
  // 经 dirResolvedPathOf 标记为目录语义，点击 toast 提示），且不得落入下方预览重写。
  if (isDirResolvedPath(resolved)) return null;
  // D2(a)：不可预览后缀（zip/pdf 等）保留原链接（浏览器下载语义），不重写。
  if (groupOfPath(resolved).group === "other") return null;
  return { url: makePreviewUrl(resolved, opts.cwd), path: resolved, fragment };
}

/**
 * 目录引用专用判定（issue #479 P2）：引用解析后为目录形态时返回其绝对路径，
 * 否则 null。供 rewrite.ts 在 rewriteTarget 返回 null 后区分「目录」与「不可预览
 * 文件/外域」（目录 → data-fp-dir 提示，其余 → target=_blank 下载/新标签兜底）。
 */
export function dirResolvedPathOf(ref: string, opts: RewriteOpts): string | null {
  const { resolved } = resolveRef(ref, opts);
  return resolved !== null && isDirResolvedPath(resolved) ? resolved : null;
}
