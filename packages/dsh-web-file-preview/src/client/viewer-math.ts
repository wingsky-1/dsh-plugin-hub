/**
 * dsh-web-file-preview — Mermaid 全屏查看器纯逻辑（issue #293，无 DOM 依赖）。
 *
 * 与 link-resolver / mermaid-core 同一模式：把查看器的纯逻辑（clamp / transform
 * 字符串 / 触发与安全谓词）抽在此模块，node smoke 经 esbuild 内存打包直测真实源码
 * （见 test/smoke.ts「issue #293：viewer-math 查看器纯逻辑直测」）；DOM 胶水在
 * viewer.ts / mermaid.ts（薄层只做事件接线与状态搬运，不承载分支逻辑）。
 *
 * 可测性：谓词以 ViewerTargetLike 投影为入参（只依赖 closest / querySelector /
 * getAttribute / classList 语义），真实 HTMLElement / SVGElement 结构性兼容，
 * smoke 用最小投影直测判定路径，不依赖真实 DOM。
 */

/** 查看器谓词所需的最小 DOM 投影（真实 Element 结构性兼容）。 */
export interface ViewerTargetLike {
  /** 沿祖先链查找首个匹配选择器的节点（含自身）；无匹配返回 null。 */
  closest(selector: string): ViewerTargetLike | null;
  /** 在子树内查找首个匹配选择器的节点；无匹配返回 null。 */
  querySelector(selector: string): ViewerTargetLike | null;
  /** 读取属性值；无该属性返回 null。 */
  getAttribute(name: string): string | null;
  /** 类名集合（真实 Element 均有）；缺省时回退 getAttribute("class") 解析。 */
  classList?: { contains(token: string): boolean };
}

/** 缩放值夹于 [min, max]（图片灯箱与 mermaid 查看器共用；默认 0.2–8 倍防拖丢）。 */
export function clampScale(value: number, min = 0.2, max = 8): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 查看器 CSS 变换字符串：与图片灯箱原 applyLboxTransform（image.ts）逐字节一致——
 * 泛化重构下「图片路径零回归」的可测接缝（验收 A2 / B1）。双路径共用同一字符串
 * 生成，保证 <img> 与克隆 <svg> 的缩放平移语义完全一致。
 */
export function viewerTransform(tx: number, ty: number, scale: number): string {
  return `translate(${tx}px, ${ty}px) scale(${scale})`;
}

/**
 * 是否应打开 Mermaid 全屏查看器（验收 A3，holder 级判定）：
 * - 命中 .fwp-mermaid 容器（沿祖先链，含自身）；
 * - 且非 .fwp-mermaid-fallback（失败回退块保留代码展示，不弹查看器）；
 * - 且容器内 querySelector("svg") 非空（成功渲染才可查看）。
 *
 * 绑定语义（维护者 P1-1）：判定与监听必须落 holder（.fwp-mermaid）而非 SVG 子元素
 * ——rerenderForTheme 用 holder.innerHTML 整体换图，SVG 子元素绑定会在系统明暗切换
 * 后「静默消失」；holder 级绑定随 innerHTML 换图保持有效（C12 持久性）。
 */
export function shouldOpenMermaidViewer(target: ViewerTargetLike | null): boolean {
  if (target === null) return false;
  const holder = target.closest(".fwp-mermaid");
  if (holder === null) return false;
  if (typeof holder.classList?.contains === "function" && holder.classList.contains("fwp-mermaid-fallback")) {
    return false;
  }
  const cls = holder.getAttribute("class");
  if (cls !== null && cls.split(/\s+/).includes("fwp-mermaid-fallback")) return false;
  return holder.querySelector("svg") !== null;
}

/**
 * 是否可拦截的绝对 http(s) 外链锚点（安全接缝，验收 A4 / D1 / D2）：
 * - target 沿祖先链命中 <a>；
 * - href 取 xlink:href 优先（mermaid setLink 在 strict 下产出、DOMPurify svg profile
 *   放行 xlink:href 且剥除 target 的链接形态），fallback href；
 * - 仅绝对 http(s) 视为外链——内部锚点 / 相对链接 / 非 http(s) 协议一律不拦，
 *   保留既有行为（md 相对引用走 data-fp-ref / data-fp-anchor 委托，不属本谓词范围）。
 */
export function isExternalClickableAnchor(target: ViewerTargetLike | null): boolean {
  if (target === null) return false;
  const anchor = target.closest("a");
  if (anchor === null) return false;
  const href = anchor.getAttribute("xlink:href") ?? anchor.getAttribute("href");
  if (href === null) return false;
  return /^https?:\/\//i.test(href);
}
