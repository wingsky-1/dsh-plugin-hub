/**
 * dsh-web-file-preview — 客户端点击拦截与文件识别。
 *
 * 捕获阶段委托拦截文件链接点击、文件路径识别、预览能力判定、folder 提示、
 * 会话 cwd 读取。openPreview 来自 preview.ts（无循环依赖：text→preview→intercept
 * 不构成环，因 intercept 不逆向引用 text）。
 */

import { el } from "./dom.ts";
import type { FilePreviewState } from "./state.ts";
import { resolveFileLink, decideGate, SCOPE_SELECTORS } from "./link-resolver.ts";
import { groupOfPath } from "../grouping.ts";
import { openPreview } from "./preview.ts";

/** 是否属于可 web 预览的分组（A：openPath 收口判定；B：静态路径判定；单一事实源 src/grouping.ts）。 */
export function isPreviewablePath(value: string): boolean {
  return groupOfPath(String(value)).group !== "other";
}

/**
 * 把真实 Element 祖先链适配为 ResolverNode 投影后委托纯逻辑解析
 *（issue #37：两阶段算法与决策顺序见 src/client/link-resolver.ts）。
 * textContent 仅在四类嗅探标签上读取（大容器 DIV 不读，避免大串拼接开销；
 * 评审 U5：不扩 DIV——父容器文本常是多段拼接，保留防误拦）。
 */
export function findFileLink(target: any): { path: string | null; kind: "file" | "folder" } | null {
  const chain: any[] = [];
  let node: any = target;
  while (node && node !== document && node.nodeType === 1) {
    chain.push(node);
    node = node.parentNode;
  }
  if (chain.length === 0) return null;
  let parentLink: any = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const elN = chain[i];
    const get = (name: string): string => {
      try { return elN.getAttribute ? (elN.getAttribute(name) || "") : ""; } catch { return ""; }
    };
    const sniffable = elN.tagName === "CODE" || elN.tagName === "SPAN" || elN.tagName === "A" || elN.tagName === "BUTTON";
    parentLink = {
      tag: String(elN.tagName || ""),
      attrs: { title: get("title"), href: get("href"), "data-ref-chip": get("data-ref-chip") },
      text: sniffable ? (elN.textContent || "") : "",
      parent: parentLink,
    };
  }
  const hit = resolveFileLink(parentLink);
  return hit === null ? null : { path: hit.path, kind: hit.kind };
}

/** 从客户端 sessions 服务读取当前会话 cwd（拿不到返回 undefined）。 */
export function activeCwd(): string | undefined {
  try {
    const sessions = (window as any).__DSH_CWD_SESSIONS__;
    if (!sessions || !sessions.list) return undefined;
    const snap = sessions.list.getSnapshot();
    if (!snap || !snap.current || !snap.byId) return undefined;
    const entry = snap.byId[snap.current];
    return entry && entry.cwd ? entry.cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 轻量 toast 提示（issue #3：folder 引用点击给出友好反馈，不开 Modal）。
 * `role="status"` 底部居中、自动消失、可点关闭；样式走主题变量 + 浅色回退，
 * 不遮挡 chip（触控目标 ≥44px 由样式表 coarse 媒体查询保证）。
 * 文案硬编码，非外部输入，无注入面。
 */
export function showFolderNotice(): void {
  const existing = document.querySelector(".fwp-folder-notice");
  if (existing !== null && existing.parentElement !== null) {
    existing.parentElement.removeChild(existing);
  }
  const notice = el("div", {
    class: "fwp-folder-notice",
    text: "文件夹无法在 web 端预览，请使用文件树打开",
    attrs: { role: "status", "data-dsh-web-file-preview-notice": "" },
  });
  notice.addEventListener("click", () => {
    notice.remove();
  });
  document.body.appendChild(notice);
  window.setTimeout(() => { if (notice.parentElement !== null) notice.remove(); }, 4000);
}

/** 捕获阶段点击拦截：文件链接 → web 预览；folder → toast 提示。 */
export function onClickCapture(event: any, state: FilePreviewState): void {
  if (state.disposed) return;
  // 命中我们自己的预览 Modal 内部时不再重复拦截（避免点标题又开一次）。
  if (state.overlay !== undefined && state.overlay.contains(event.target)) return;
  // 页面存在文本选区（长按选择 / 鼠标划选）时不拦截，避免打断「我要复制文字」的
  // 意图（评审 U5；移动端长按选中后松手产生的 click 不再误弹预览）。
  const selection = window.getSelection ? window.getSelection() : null;
  if (selection !== null && selection.toString() !== "") return;
  // 点击闸门（issue #37，决策顺序见 link-resolver.decideGate）：
  // 1) 豁免属性 data-dsh-no-preview 优先于作用域（跨区域生效）；
  // 2) 仅对话流子树（宿主 [data-chat-flow] / [data-chat-anchor-key]）内才做
  //    链接嗅探与拦截——第三方插件 UI（文件树等）天然出圈，不再被全局劫持。
  const targetEl = event.target instanceof Element ? (event.target as Element) : null;
  if (targetEl === null) return;
  // closest 对非法选择器会抛 SyntaxError——全局捕获回调绝不能整体抛错
  //（否则后续所有点击拦截失效），异常一律降级为"未命中"。
  const gate = decideGate({
    matches: (sel: string) => {
      try { return targetEl.closest(sel) !== null; } catch { return false; }
    },
  }, SCOPE_SELECTORS);
  if (gate === "pass") return;
  const hit = findFileLink(targetEl);
  if (hit === null) return;
  // folder 引用：轻量提示，不开 Modal（ref-chip 权威优先，拦截默认行为）。
  if (hit.kind === "folder") {
    event.preventDefault();
    event.stopPropagation();
    showFolderNotice();
    return;
  }
  // 命中文件链接（file / 既有 deliverable / 行内路径）：拦截原生打开，改走 web 预览。
  event.preventDefault();
  event.stopPropagation();
  const cwd = activeCwd();
  if (hit.path !== null) openPreview(state, hit.path, cwd);
}