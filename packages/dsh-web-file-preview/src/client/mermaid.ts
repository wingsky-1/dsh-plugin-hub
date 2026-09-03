/**
 * dsh-web-file-preview — Mermaid 懒加载渲染（DOM 胶水层，issue #104）。
 *
 * md 渲染链尾的后处理：` ```mermaid ` 代码块 → 动态 import 宿主 chunk 路由
 * （/api/dsh-file-preview/mermaid，变量 URL——esbuild 对变量 import() 原样保留为
 * 浏览器运行时动态加载，IIFE 产物内不内联）→ mermaid.render 串行出图 →
 * DOMPurify svg profile 二次消毒后替换原代码块。
 *
 * 安全与健壮性（issue #104 复核批复口径）：
 * - securityLevel:"strict" + htmlLabels:false 由 mermaid-core 统一下发；
 * - 二次消毒 USE_PROFILES:{svg,svgFilters} 且 ADD_TAGS 刻意不含 foreignobject
 *   （默认剔除，实测确需再放行）；ADD_TAGS 补 "style"——mermaid SVG 内嵌
 *   <style> 承载箭头/字体模板样式，svg profile 默认剥掉会导致图面劣化，
 *   其内容由库模板生成、结构受控，且 strict 层已先行消毒一次（纵深第二道）；
 * - 失败回退：单块语法错误 / 整个 chunk 加载失败都收敛为「原代码块 + 可见提示」，
 *   绝不让 md 预览白屏或静默空块；
 * - 竞态：openSeq 代数 + 容器 isConnected 双校验（防同 Modal 快速切 tab 的旧代
 *   写回），render id 全局单调递增防同文档元素 id 冲突；
 * - 解析时机 requestIdleCallback（带 setTimeout 兜底，iOS <16.4 无此 API）
 *   延迟拉取与解析，避开 Modal 打开瞬间的首帧主线程。
 */

import DOMPurify from "dompurify";
import { runMermaidHydration, mermaidBaseConfig, type MermaidApiLike } from "./mermaid-core.ts";
import type { FilePreviewState } from "./state.ts";
import { openViewer, closeLightbox } from "./viewer.ts";
import { t } from "../../../../shared/client/i18n.js";
import { shouldOpenMermaidViewer, isExternalClickableAnchor } from "./viewer-math.ts";

/** 已加载的 mermaid API 引用（动态 import 自带模块缓存，此处仅存引用）。 */
let loadedApi: MermaidApiLike | undefined;

/** 当前偏好主题（明暗自适应约定：prefers-color-scheme dark → dark，否则 default）。 */
function themeOf(): "dark" | "default" {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "default";
}

/**
 * 注册系统明暗切换监听（apply disposer 负责解绑）。
 *
 * ⚠️ mermaid@11 官方接口没有 setTheme——主题切换走业界通行 re-initialize 路线：
 * 重下发安全基线 + 新主题，并对当前 Modal 内已渲染块就地重渲染（rerenderForTheme）；
 * 库未加载 / 无活跃图时零动作（下次 hydration 的 initialize 自然读取最新主题）。
 */
export function watchMermaidTheme(state: FilePreviewState): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (): void => {
    void rerenderForTheme(state);
  };
  mq.addEventListener?.("change", onChange);
  return () => mq.removeEventListener?.("change", onChange);
}

/**
 * 明暗切换后的存量图重渲染：对注册表内已渲染块逐个 render 并就地替换 innerHTML。
 * 竞态与降级语义与首渲一致：Modal 已关闭/导航（openSeq 变化或容器脱离）即停；
 * 单块重渲染失败保留旧配色图（console.warn），不破坏预览、不回退代码块。
 */
async function rerenderForTheme(state: FilePreviewState): Promise<void> {
  const api = loadedApi;
  const reg = state.activeMermaidHydration;
  if (api === undefined || reg === undefined || reg.entries.length === 0) return;
  if (state.openSeq !== reg.seq || !reg.container.isConnected) return;
  // issue #293 C9（P2）：主题切换时查看器若开着先关闭——查看器内克隆 SVG 是旧配色
  // 快照（查看器只做视觉容器、不重渲染），直接关闭避免「陈旧主题残留」；随后
  // rerenderForTheme 整体换图，用户重新点击打开新配色图（不自动重开）。
  if (state.lboxEl !== undefined) closeLightbox(state);
  api.initialize(mermaidBaseConfig(themeOf()));
  for (const entry of reg.entries) {
    if (!entry.el.isConnected) continue;
    try {
      const rendered = await api.render(`fwp-mermaid-${++state.mermaidRenderId}`, entry.source);
      const svg = rendered?.svg ?? "";
      if (typeof svg !== "string" || svg === "") throw new Error("mermaid returned empty svg");
      // 渲染期间 Modal 被关闭/切 tab → 旧代结果不写回。
      if (!entry.el.isConnected || state.openSeq !== reg.seq) return;
      entry.el.innerHTML = sanitizeMermaidSvg(svg);
    } catch (error) {
      console.warn("[dsh-web-file-preview] mermaid theme rerender failed:", error);
    }
  }
}

/**
 * md 渲染后处理入口（text.ts renderTabBody 的 md 分支调用）。
 * 无 mermaid 块时同步快速返回——零 fetch、零调度、零开销。
 */
export function hydrateMermaid(container: HTMLElement, state: FilePreviewState): void {
  const codes = container.querySelectorAll<HTMLElement>("pre > code.language-mermaid");
  if (codes.length === 0) return;
  const seq = state.openSeq;
  // requestIdleCallback 带 setTimeout fallback（iOS <16.4 缺失该 API）；
  // timeout 上限兜底保证低负载下也不会无限推迟。
  const win = window as any;
  const schedule = typeof win.requestIdleCallback === "function"
    ? (cb: () => void): number => win.requestIdleCallback(cb, { timeout: 2000 })
    : (cb: () => void): number => window.setTimeout(cb, 32);
  schedule(() => {
    if (!container.isConnected || seq !== state.openSeq) return;
    // textContent 还原 marked 写入的实体转义源码（--&gt; → -->）；trim 去围栏首尾
    // 空白。不 filter 空串：sources 必须与 codes 按索引严格对齐（回调按索引落盘），
    // 空源码由 render 报错自然走回退路径。
    const sources = Array.from(codes).map((c) => (c.textContent ?? "").trim());
    if (sources.length === 0) return;
    // 活跃 hydration 注册表：供明暗切换对存量图重渲染；下次 hydration 覆盖、
    // closeModal 清空，不跨 Modal 累积引用。
    const registry = {
      seq,
      container,
      entries: [] as Array<{ el: HTMLElement; source: string }>,
    };
    state.activeMermaidHydration = registry;
    void runMermaidHydration(sources, {
      loadModule: async () => {
        // 变量 URL 动态 import：必须保持非字面量形态，否则 esbuild 会静态解析
        // 并把 chunk 内联回 client.js（懒加载失效）——已实验证实的关键约束。
        const mod = (await import(state.API.mermaid)) as { default: MermaidApiLike };
        loadedApi = mod.default;
        return loadedApi;
      },
      themeOf,
      nextId: () => `fwp-mermaid-${++state.mermaidRenderId}`,
      liveCheck: () => state.openSeq === seq && container.isConnected,
      sanitizeSvg: sanitizeMermaidSvg,
      onReplaced: (index, svgHtml) => {
        const holder = replaceWithSvg(codes[index], svgHtml);
        if (holder !== undefined) {
          // issue #293 C1/C12：查看器触发绑定必须落 holder 级（.fwp-mermaid 容器，
          // 不绑 SVG 子元素）——rerenderForTheme 用 holder.innerHTML 整体换图，
          // 子元素绑定会随换图静默消失；holder 级监听在主题切换后依旧有效（P1-1）。
          // 命中判定走 shouldOpenMermaidViewer 谓词（排除 fallback、svg 非空守卫）。
          holder.addEventListener("click", () => {
            if (shouldOpenMermaidViewer(holder)) openMermaidViewer(holder, state);
          });
          registry.entries.push({ el: holder, source: sources[index] });
        }
      },
      onFallback: (index, error) => {
        console.warn(`[dsh-web-file-preview] mermaid block ${index} render failed:`, error);
        fallbackToCode(codes[index]);
      },
    });
  });
}

/** SVG 二次消毒（纵深防御，只作用于 mermaid 自身产出、结构受控的 SVG）。 */
function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // style 标签/属性承载布局配色模板（见文件头）；dominant-baseline 为 mermaid
    // 文本定位所需。foreignObject 不在白名单——strict 下默认剔除（复核决议）。
    ADD_TAGS: ["style"],
    ADD_ATTR: ["class", "style", "dominant-baseline"],
  });
}

/** 成功路径：以消毒后的 SVG 替换整个 <pre> 围栏，返回容器（注册表记录用）。 */
function replaceWithSvg(code: HTMLElement | undefined, svgHtml: string): HTMLElement | undefined {
  const pre = code?.parentElement;
  if (!pre || !pre.parentElement) return undefined;
  const holder = document.createElement("div");
  holder.className = "fwp-mermaid";
  holder.innerHTML = svgHtml;
  pre.replaceWith(holder);
  return holder;
}

/** 失败路径：保留原代码块并加可见提示（role="status"，对齐「降级不静默」约定）。 */
function fallbackToCode(code: HTMLElement | undefined): void {
  const pre = code?.parentElement;
  if (!pre || !pre.parentElement) return;
  pre.classList.add("fwp-mermaid-fallback");
  const note = document.createElement("div");
  note.className = "fwp-mermaid-note";
  note.setAttribute("role", "status");
  note.textContent = t("mermaidFailNote");
  pre.parentElement.insertBefore(note, pre);
}

/**
 * 打开 Mermaid 全屏查看器（issue #293 C1）：克隆 holder 内 SVG（不移动原节点，
 * 保持 Modal 正文完好）传入通用查看器，交互（按钮/滚轮缩放、指针/单指拖拽、双指
 * 捏合、Esc/遮罩/关闭退出、clamp 0.2–8）与图片灯箱逐字节对齐（viewer.ts）。
 *
 * E3 现状接受（注释显式记录）：mermaid SVG 根/defs 带 id，cloneNode(true) 后同文档
 * 存在双份重复 id——依赖「查看器先于 Modal 关闭」生命周期（preview.ts closeModal
 * 先 closeLightbox），查看器关闭后克隆体即移除；双份 id 期间仅影响 SVG 内部样式/
 * 动画引用，查看器交互（缩放/平移）不受影响。不做 id 重写（避免破坏 mermaid 内部
 * 引用关系），维护者复核确认此取舍。
 */
function openMermaidViewer(holder: HTMLElement, state: FilePreviewState): void {
  const svg = holder.querySelector("svg");
  if (svg === null) return;
  const clone = svg.cloneNode(true) as SVGElement;
  // E2 初始尺寸策略（显式决策）：按视口宽（≤90vw 且 ≤82vh，viewBox 保持纵横比），
  // 不保持 Modal 内渲染宽度——查看器语义是看大图，视口基准更合理（样式见 style.css
  // .fwp-lbox-content-svg，保证初始渲染不溢出 stage）。
  clone.classList.add("fwp-lbox-content-svg");
  openViewer(clone, state, { ariaLabel: t("chartAria"), restoreFocusTo: holder });
}

/**
 * Modal 内 <a> 外链点击安全拦截（issue #293 D2，既存同域缺陷并入一并修）：
 * strict 下 mermaid setLink 产出的 <a xlink:href>（DOMPurify svg profile 放行
 * xlink:href、剥除 target）在预览 Modal 内直接点击会同 tab 整页导航离开 DSH web
 * ——与查看器 stage 内同一机制（viewer.ts D1）。此处 document 捕获阶段只拦 Modal
 * （state.overlay）内的外链锚点：preventDefault + 停传播，改 window.open
 * ("_blank","noopener")。查看器（stage 内）由 openViewer 自带拦截负责；md 相对
 * 引用（data-fp-ref / data-fp-anchor）不属绝对 http(s) 外链，不在此范围，保持
 * 既有 Modal 内跳转/锚点委托行为。
 */
export function watchMermaidAnchorSafety(state: FilePreviewState): () => void {
  const handler = (event: Event): void => {
    if (state.disposed) return;
    const target = event.target instanceof Node ? (event.target as Node) : null;
    if (target === null || state.overlay === undefined || !state.overlay.contains(target)) return;
    const elT = target instanceof Element ? (target as Element) : null;
    if (elT === null || !isExternalClickableAnchor(elT)) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = elT.closest("a");
    const href = anchor !== null ? (anchor.getAttribute("xlink:href") || anchor.getAttribute("href")) : null;
    if (href !== null && href !== "") window.open(href, "_blank", "noopener");
  };
  document.addEventListener("click", handler, true);
  return () => document.removeEventListener("click", handler, true);
}
