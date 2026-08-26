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
import { runMermaidHydration, type MermaidApiLike } from "./mermaid-core.js";
import type { FilePreviewState } from "./state.js";

/** 已加载的 mermaid API 引用（供主题切换 setTheme；动态 import 自带模块缓存）。 */
let loadedApi: MermaidApiLike | undefined;

/** 当前偏好主题（明暗自适应约定：prefers-color-scheme dark → dark，否则 default）。 */
function themeOf(): "dark" | "default" {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "default";
}

/**
 * 注册系统明暗切换监听：库已加载时实时 setTheme 跟随；未加载则无需动作
 * （下次 hydration 的 initialize 会读取最新主题）。返回解绑函数（apply disposer 用）。
 */
export function watchMermaidTheme(): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (): void => {
    try {
      loadedApi?.setTheme?.(themeOf());
    } catch (error) {
      console.warn("[dsh-web-file-preview] mermaid setTheme failed:", error);
    }
  };
  mq.addEventListener?.("change", onChange);
  return () => mq.removeEventListener?.("change", onChange);
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
      onReplaced: (index, svgHtml) => replaceWithSvg(codes[index], svgHtml),
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

/** 成功路径：以消毒后的 SVG 替换整个 <pre> 围栏。 */
function replaceWithSvg(code: HTMLElement | undefined, svgHtml: string): void {
  const pre = code?.parentElement;
  if (!pre || !pre.parentElement) return;
  const holder = document.createElement("div");
  holder.className = "fwp-mermaid";
  holder.innerHTML = svgHtml;
  pre.replaceWith(holder);
}

/** 失败路径：保留原代码块并加可见提示（role="status"，对齐「降级不静默」约定）。 */
function fallbackToCode(code: HTMLElement | undefined): void {
  const pre = code?.parentElement;
  if (!pre || !pre.parentElement) return;
  pre.classList.add("fwp-mermaid-fallback");
  const note = document.createElement("div");
  note.className = "fwp-mermaid-note";
  note.setAttribute("role", "status");
  note.textContent = "图表渲染失败，已回退为代码展示";
  pre.parentElement.insertBefore(note, pre);
}
