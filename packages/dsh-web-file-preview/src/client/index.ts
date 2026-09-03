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
import { finalizeSession, onKeyDown, syncFullscreenState } from "./preview.ts";
import { onClickCapture } from "./intercept.ts";
import { wrapOpenPath } from "./wrapper.ts";
import { watchMermaidTheme, watchMermaidAnchorSafety } from "./mermaid.ts";
import { isFullscreenActive } from "./fullscreen-math.ts";
import { bindLocale } from "../../../../shared/client/i18n.js";
import { zh, en, type FilePreviewLocaleKey } from "./locales.ts";
// 显式类型导入，先把 @deepseek-ai/dsh-client-ui-slots 拉进模块解析图：上游发布物
// lib/types/*.d.ts 相对导入保留 .ts 后缀，declare module 增强的模块名解析会判
// TS2664（microsoft/TypeScript#63960 同类；上游修复发布物后此行可删）。
import type { LocaleNamespaceMap } from "@deepseek-ai/dsh-client-ui-slots";

// i18n（issue #348）：字典命名空间 + LocaleNamespaceMap 声明合并（官方 ui-jobs 同款）。
const NS = "filePreview";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** dsh-web-file-preview 预览 Modal/灯箱/错误态文案。 */
    "filePreview": FilePreviewLocaleKey;
  }
}

export function apply(ctx: any): void {
  const state: FilePreviewState = createState();
  // 将 state 注入 onKeyDown 闭包（onKeyDown 作为 document 事件监听器无法直接接收参数）
  (onKeyDown as any).__state = state;

  try {
    // i18n（issue #348 → #378 抽取 shared/client/i18n.js）：注册本插件字典；
    // t 经共享模块活绑定（多文件 client 共用），语言切换 subscribe 重绑
    // （下次打开预览即生效）。unsubLocale 供 effect 卸载时解绑（T4，
    // 对齐 provider-usage 范式），防重复 apply 后旧订阅持续重绑已停用实例。
    // #486-fix：客户端服务经 ctx 属性直访（ctx.locale/ctx.sessions/ctx.remote，
    // 官方 model-selection / provider-usage #383 同款）——宿主风格 ctx.get 在
    // 客户端注入代理上按属性校验 inject，未声明即抛 "without inject"。
    const locale: any = ctx.locale;
    let unsubLocale: (() => void) | undefined;
    if (locale && typeof locale.register === "function") {
      try {
        locale.register(NS, { zh: zh, en: en });
        bindLocale(locale, NS);
        if (typeof locale.subscribe === "function" && typeof locale.getSnapshot === "function") {
          unsubLocale = locale.subscribe(function () {
            bindLocale(locale, NS);
          });
        }
      } catch (error) {
        console.warn("[dsh-web-file-preview] locale 注册失败：", error);
      }
    }

    ensureStyle();
    // 包装捕获函数，使 onClickCapture 能访问 state
    const captureHandler = (event: any) => onClickCapture(event, state);
    // B：document 捕获阶段拦截文件链接点击（含"只输出、无打开操作"的路径）。
    document.addEventListener("click", captureHandler, true);
    // 暴露当前会话 cwd（经 inject 的 sessions 服务，惰性读取；ctx 属性直访）。
    try { (window as any).__DSH_CWD_SESSIONS__ = ctx ? ctx.sessions : undefined; } catch { /* 兼容 */ }
    // A：openPath 调用点收口。
    const restoreOpenPath = wrapOpenPath(ctx, state);
    // issue #104：系统明暗切换时对已渲染 mermaid 图就地重渲染（v11 无 setTheme，
    // re-initialize 路线，见 mermaid.ts）；解绑进同一 disposer，卸载无残留监听。
    const unwatchMermaidTheme = watchMermaidTheme(state);
    // issue #293 D2：Modal 内 <a> 外链点击安全拦截（同 tab 导航防御，见 mermaid.ts）。
    const unwatchAnchorSafety = watchMermaidAnchorSafety(state);
    // issue #344：全屏态同步——浏览器元素全屏进入/退出（含 Esc 原生退全屏）触发
    // fullscreenchange，据此刷新 state.fsActive 并同步按钮文案/aria/降级 class；
    // 与 onKeyDown 同生命周期挂/卸（webkit 前缀兼容 Safari <16.4 之前的旧事件名）。
    const syncFs = () => { state.fsActive = isFullscreenActive(document); syncFullscreenState(state); };
    document.addEventListener("fullscreenchange", syncFs);
    document.addEventListener("webkitfullscreenchange", syncFs);
    ctx.effect(() => () => {
      state.disposed = true;
      unwatchMermaidTheme();
      unwatchAnchorSafety();
      if (unsubLocale !== undefined) unsubLocale();
      document.removeEventListener("fullscreenchange", syncFs);
      document.removeEventListener("webkitfullscreenchange", syncFs);
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
// 需要 sessions 服务以跟随当前会话（cwd 用于拼预览 URL）；locale 用于字典注册与 t 装配；
// remote（+ remote.session 深层）用于 openWorkspacePath 调用点收口包装（wrapper.ts）——
// 客户端注入代理按本数组校验 ctx 属性访问，漏声明即抛 "without inject"（#486-fix，
// provider-usage #383 同款面）。
export const inject: string[] = ["sessions", "locale", "remote", "remote.session"];