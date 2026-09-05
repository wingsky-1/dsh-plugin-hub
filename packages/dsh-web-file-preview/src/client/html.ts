/**
 * dsh-web-file-preview — 客户端 HTML 预览（issue #73 / #507）。
 *
 * html 组「预览」tab = serve 虚拟伺服 iframe：先 alloc 拿 token（root = HTML
 * 文件所在目录），再以 `<iframe sandbox>` 渲染（无 allow-scripts / 无
 * allow-same-origin，G1/G4）——静态资源（css/js/img 相对路径）正常加载，
 * 但脚本不执行（首版边界 J1）。原始 tab 仍走 /file（text/plain）源码。
 *
 * issue #507：「交互」态 = 用户手势 opt-in 后重建 iframe 加 `allow-scripts`
 * （保持无 allow-same-origin，J9 红线），使用**独立短 TTL token**（interactive
 * 桶），退出交互态（切 tab / 关闭 / 导航离开）即 release——脚本可读 location
 * 外泄 token 的窗口被压缩到交互会话期。teardownInteractive 是交互态清理的
 * 唯一出口（含心跳续命定时器清理）。
 *
 * 独立模块避免 preview.ts ↔ text.ts 循环依赖（text.ts 的 renderTabBody 切 tab
 * 时也要渲染 html 预览）。
 */
import { el, errorView, showToast } from "./dom.ts";
import { t } from "../../../../shared/client/i18n.js";
import type { FilePreviewState } from "./state.ts";
import { applyResolvedPath } from "./resolved-path.ts";

/** issue #73：serve token 分配 URL（#507：mode=interactive 分配交互桶短 TTL token）。 */
export function allocUrl(path: string, cwd: string | undefined, state: FilePreviewState, interactive = false): string {
  const params = new URLSearchParams();
  if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
  params.set("path", path);
  if (interactive) params.set("mode", "interactive");
  return `${state.API.alloc}?${params.toString()}`;
}

/** issue #73：serve token 释放 URL。 */
export function releaseUrl(token: string, state: FilePreviewState): string {
  const params = new URLSearchParams();
  params.set("token", token);
  return `${state.API.release}?${params.toString()}`;
}

/** 原文 URL（/file 仍 text/plain；与 preview.ts 的 fileUrl 同构，避免循环依赖）。 */
function rawFileUrl(path: string, cwd: string | undefined, state: FilePreviewState): string {
  const params = new URLSearchParams();
  if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
  params.set("path", path);
  return `${state.API.file}?${params.toString()}`;
}

/**
 * issue #73：html 预览「预览」tab 内容——alloc 拿 token 后渲染 `<iframe sandbox>`。
 * src 前缀：/api/dsh-file-preview/serve/<token>/<encodeURI(rest)>（rest = 相对 root
 * 的 POSIX 相对路径，G1）。alloc 失败 → errorView 兜底（可新标签打开原文）。
 */
export function renderHtmlPreview(body: HTMLElement, state: FilePreviewState, seq: number, abort: AbortSignal): void {
  // 已有 serveSrc（切 tab 往返 / 返回栈还原）→ 直接重建 iframe，免重复 alloc。
  if (state.serveSrc !== undefined && state.serveToken !== undefined) {
    body.appendChild(makeHtmlFrame(state.serveSrc, "static"));
    return;
  }
  body.appendChild(el("div", { class: "fwp-state", text: t("loading") }));
  const url = allocUrl(state.currentPath, state.currentCwd, state);
  void fetch(url, { signal: abort })
    .then(async (res) => {
      if (seq !== state.openSeq) return;
      if (!res.ok) {
        let msg = `HTML 预览启动失败（HTTP ${res.status}）`;
        try { const data = await res.json(); if (data && data.error) msg = String(data.error); } catch { /* 忽略 */ }
        errorView(body, msg, rawFileUrl(state.currentPath, state.currentCwd, state));
        return;
      }
      const data = await res.json().catch(() => null);
      if (seq !== state.openSeq) return;
      if (data === null || typeof data.token !== "string" || typeof data.rest !== "string") {
        errorView(body, t("htmlBootFail"), rawFileUrl(state.currentPath, state.currentCwd, state));
        return;
      }
      // issue #486：alloc 响应回传真实 resolved path（可能经 ③ 搜索纠正）→ 设
      // 权威 currentPath（html 组入口即 html，分组不变；老响应无 path 降级原值）。
      if (typeof data.path === "string" && data.path !== "") applyResolvedPath(state, data.path);
      state.serveToken = data.token;
      // encodeURI 保留 "/"（rest 是 POSIX 相对路径），编码空格/中文等字符。
      state.serveSrc = `${state.API.serve}/${data.token}/${encodeURI(data.rest)}`;
      state.onResolved?.();
      body.textContent = "";
      body.appendChild(makeHtmlFrame(state.serveSrc, "static"));
    })
    .catch(() => {
      if (seq === state.openSeq) errorView(body, t("fetchFail"), rawFileUrl(state.currentPath, state.currentCwd, state));
    });
}

// ---- issue #507：交互式预览（opt-in 脚本执行）----

/** 交互态心跳间隔（ms）：serve token 为 idle TTL 语义（serve 命中才刷 lastHit），
 * 单文件交互页首载后无子资源流量会静默过期——父页定期 GET serve URL 续命
 * （304 也经 store.get 刷新计时；teardownInteractive 清理 interval）。 */
export const INTERACTIVE_PING_MS = 2 * 60 * 1000;

/** 启动交互态心跳（幂等：已有 interval 不重复建）。 */
export function startInteractivePing(state: FilePreviewState): void {
  if (state.interactivePing !== undefined) return;
  state.interactivePing = window.setInterval(() => {
    // 代数守卫：交互态已退出（previewMode 被切走 / Modal 关闭）→ 自清理，不再续命。
    if (state.previewMode !== "interactive" || state.interactiveSrc === undefined) {
      teardownInteractive(state);
      return;
    }
    // 仅续命不渲染：GET serve URL，304/200 都经宿主 store.get 刷新 idle 计时。
    void fetch(state.interactiveSrc, { cache: "no-store" }).catch(() => { /* 续命失败静默：TTL 兜底 */ });
  }, INTERACTIVE_PING_MS);
}

/**
 * issue #507：交互态清理唯一出口（幂等）——release 交互 token + 清心跳 +
 * 复位交互态字段。调用点：切回静态预览/原始 tab、openPreview 导航离开
 * （closeModal 统一入口）、finalizeSession（终态关闭）、dispose（卸载）。
 * 交互 token 绝不进返回栈快照（NavEntry clamp 见 preview.ts）。
 */
export function teardownInteractive(state: FilePreviewState): void {
  if (state.interactivePing !== undefined) {
    window.clearInterval(state.interactivePing);
    state.interactivePing = undefined;
  }
  if (state.interactiveToken !== undefined) {
    const token = state.interactiveToken;
    state.interactiveToken = undefined;
    state.interactiveSrc = undefined;
    void fetch(releaseUrl(token, state), { method: "GET" }).catch(() => { /* 忽略：宿主 TTL 兜底 */ });
  }
}

/**
 * issue #507：html 组「交互」tab 内容——alloc **交互桶短 TTL token** 后渲染
 * `<iframe sandbox="allow-scripts">`（无 allow-same-origin，J9）。用户手势
 * opt-in 已由调用方确认；alloc 失败 → toast 提示并**回退静态预览**（重建
 * 静态 iframe，不 errorView 替换 body——静态预览仍可用，评审 P1-4）。
 */
export function renderHtmlInteractive(body: HTMLElement, state: FilePreviewState, seq: number, abort: AbortSignal): void {
  // 已有交互 src（切 tab 往返）→ 直接重建 iframe，免重复 alloc。
  if (state.interactiveSrc !== undefined && state.interactiveToken !== undefined) {
    body.appendChild(makeHtmlFrame(state.interactiveSrc, "interactive"));
    startInteractivePing(state);
    return;
  }
  body.appendChild(el("div", { class: "fwp-state", text: t("loading") }));
  const url = allocUrl(state.currentPath, state.currentCwd, state, true);
  void fetch(url, { signal: abort })
    .then(async (res) => {
      if (seq !== state.openSeq) return;
      if (!res.ok) {
        // 429（交互桶满）/网络失败：回退静态预览 + toast。
        let msg = `交互预览启动失败（HTTP ${res.status}）`;
        try { const data = await res.json(); if (data && data.error) msg = String(data.error); } catch { /* 忽略 */ }
        showToast(msg);
        fallbackToStatic(body, state);
        return;
      }
      const data = await res.json().catch(() => null);
      if (seq !== state.openSeq) return;
      if (data === null || typeof data.token !== "string" || typeof data.rest !== "string") {
        showToast(t("htmlBootFail"));
        fallbackToStatic(body, state);
        return;
      }
      if (typeof data.path === "string" && data.path !== "") applyResolvedPath(state, data.path);
      state.interactiveToken = data.token;
      state.interactiveSrc = `${state.API.serve}/${data.token}/${encodeURI(data.rest)}`;
      state.onResolved?.();
      body.textContent = "";
      body.appendChild(makeHtmlFrame(state.interactiveSrc, "interactive"));
      startInteractivePing(state);
    })
    .catch(() => {
      if (seq === state.openSeq) {
        showToast(t("fetchFail"));
        fallbackToStatic(body, state);
      }
    });
}

/** 交互 alloc 失败回退：previewMode 复位静态 + 重建静态 iframe（有静态 token 时）
 * + tab 高亮同步（data-mode 契约，防 UI 停在「交互」高亮）。 */
function fallbackToStatic(body: HTMLElement, state: FilePreviewState): void {
  state.previewMode = "preview";
  body.textContent = "";
  if (state.serveSrc !== undefined && state.serveToken !== undefined) {
    body.appendChild(makeHtmlFrame(state.serveSrc, "static"));
  } else {
    body.appendChild(el("div", { class: "fwp-state", text: t("htmlBootFail") }));
  }
  if (state.overlay !== undefined) {
    for (const raw of Array.from(state.overlay.querySelectorAll<HTMLElement>(".fwp-tab"))) {
      raw.classList.toggle("fwp-tab-active", raw.dataset.mode === "preview");
    }
  }
}

/**
 * 构造 sandbox iframe（G4：静态态 sandbox 属性精确为空集；#507：交互态
 * `allow-scripts`——**两者都绝不含 allow-same-origin，J9 红线**）。
 *
 * 必须用 `setAttribute("sandbox", ...)` 显式装配（qa 浏览器实测红线缺陷）：
 * `el()` 的 attrs 对非 class/text/html/dataset/data-* 键走 `node[key]=value`
 * 属性反射赋值，`iframe.sandbox=""` 是 DOMTokenList 反射赋值——**空串不会产生
 * sandbox 属性**，iframe 变同源、脚本在父页面执行（J1/J9 隔离失效的经典坑）。
 * 显式 setAttribute 保证 sandbox 真正生效；装配点唯一收敛于此（契约哨兵断言）。
 * 交互态额外带视觉标识：外框高亮 class + 「脚本已启用」徽标。
 */
function makeHtmlFrame(src: string, mode: "static" | "interactive"): HTMLElement {
  const interactive = mode === "interactive";
  const frame = el("iframe", {
    class: interactive ? "fwp-html-frame fwp-html-frame-interactive" : "fwp-html-frame",
    attrs: {
      referrerpolicy: "no-referrer",
      title: interactive ? t("htmlInteractiveTitle") : t("htmlSandboxTitle"),
    },
  });
  frame.setAttribute("sandbox", interactive ? "allow-scripts" : ""); // J9：永无 allow-same-origin
  frame.src = src;
  if (!interactive) return frame;
  const wrap = el("div", { class: "fwp-html-wrap" }, [
    el("div", { class: "fwp-interactive-badge", text: t("htmlInteractiveBadge") }),
    frame,
  ]);
  return wrap;
}
