/**
 * dsh-web-file-preview — 浏览器端客户端入口。
 *
 * 装配各模块，挂在 apply() 内连线生命周期。仅含装配逻辑，不含业务实现。
 * 业务实现在 dom/preview/text/image/intercept/wrapper 各模块中。
 *
 * 拦截对话中"可点击的文件链接"（deliverables 的产出文件 chip / 正文行内文件
 * 引用，特征：元素带 title=完整路径，或 <a href=相对路径>），点击不再走桌面
 * 原生打开，而是弹出一个 web 端预览 Modal：
 *  - 图片 → 同源 <img> 直接加载；
 *  - 文本 → fetch 后以等宽 <pre> 渲染（明暗主题自适应 CSS 变量）；
 *  - 附「复制路径」「在新标签打开」动作，Esc / 点遮罩关闭。
 *
 * 实现要点：document 捕获阶段委托（先于 React 在 root 的委托），对命中的
 * 文件链接 preventDefault + stopPropagation，从而既拦截原生打开、又不会误伤
 * 其它普通点击。零依赖纯 DOM，数组型约定见文件尾。
 *
 * 客户端干净模块：只导出 apply/inject，契约外壳（IIFE/load/Symbol.toStringTag 装配）
 * 由 scripts/build/build-client.ts 统一生成——源码不写任何 loader 痕迹。
 * 第三方库（DOMPurify/diff2html/marked/highlight.js）经 build-client 内联进产物
 *（package.json 声明 dsh.client.inlineBareImports: true，非宿主注入 external）。
 */

import { ensureStyle } from "./dom.ts";
import { createState, type FilePreviewState } from "./state.ts";
import { finalizeSession, onKeyDown } from "./preview.ts";
import { onClickCapture } from "./intercept.ts";
import { wrapOpenPath } from "./wrapper.ts";
import { watchMermaidTheme } from "./mermaid.ts";

export function apply(ctx: any): void {
  const state: FilePreviewState = createState();
  // 将 state 注入 onKeyDown 闭包（onKeyDown 作为 document 事件监听器无法直接接收参数）
  (onKeyDown as any).__state = state;

  try {
    ensureStyle();
    // 包装捕获函数，使 onClickCapture 能访问 state
    const captureHandler = (event: any) => onClickCapture(event, state);
    // B：document 捕获阶段拦截文件链接点击（含"只输出、无打开操作"的路径）。
    document.addEventListener("click", captureHandler, true);
    // 暴露当前会话 cwd（通过 inject 的 sessions 服务，惰性读取）。
    try { (window as any).__DSH_CWD_SESSIONS__ = ctx && ctx.get ? ctx.get("sessions") : undefined; } catch { /* 兼容 */ }
    // A：openPath 调用点收口。
    const restoreOpenPath = wrapOpenPath(ctx, state);
    // issue #104：系统明暗切换时对已渲染 mermaid 图就地重渲染（v11 无 setTheme，
    // re-initialize 路线，见 mermaid.ts）；解绑进同一 disposer，卸载无残留监听。
    const unwatchMermaidTheme = watchMermaidTheme(state);
    ctx.effect(() => () => {
      state.disposed = true;
      unwatchMermaidTheme();
      document.removeEventListener("click", captureHandler, true);
      document.removeEventListener("keydown", onKeyDown);
      finalizeSession(state, "unmount");
      restoreOpenPath();
      const style = document.querySelector("style[data-dsh-web-file-preview-style]");
      if (style !== null && style.parentElement !== null) style.remove();
      delete (window as any).__DSH_CWD_SESSIONS__;
    }, "dsh-web-file-preview: ui");
  } catch (error) {
    console.warn("[dsh-web-file-preview] mount failed:", error);
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块，第三方内联）----
// 需要 sessions 服务以跟随当前会话（cwd 用于拼预览 URL）。
export const inject: string[] = ["sessions"];