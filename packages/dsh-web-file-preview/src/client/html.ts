/**
 * dsh-web-file-preview — 客户端 HTML 预览（issue #73）。
 *
 * html 组「预览」tab = serve 虚拟伺服 iframe：先 alloc 拿 token（root = HTML
 * 文件所在目录），再以 `<iframe sandbox>` 渲染（无 allow-scripts / 无
 * allow-same-origin，G1/G4）——静态资源（css/js/img 相对路径）正常加载，
 * 但脚本不执行（首版边界 J1）。原始 tab 仍走 /file（text/plain）源码。
 *
 * 独立模块避免 preview.ts ↔ text.ts 循环依赖（text.ts 的 renderTabBody 切 tab
 * 时也要渲染 html 预览）。
 */
import { el, errorView } from "./dom.ts";
import type { FilePreviewState } from "./state.ts";

/** issue #73：serve token 分配 URL。 */
export function allocUrl(path: string, cwd: string | undefined, state: FilePreviewState): string {
  const params = new URLSearchParams();
  if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
  params.set("path", path);
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
    body.appendChild(makeHtmlFrame(state.serveSrc));
    return;
  }
  body.appendChild(el("div", { class: "fwp-state", text: "加载中…" }));
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
        errorView(body, "HTML 预览启动失败（响应异常）", rawFileUrl(state.currentPath, state.currentCwd, state));
        return;
      }
      state.serveToken = data.token;
      // encodeURI 保留 "/"（rest 是 POSIX 相对路径），编码空格/中文等字符。
      state.serveSrc = `${state.API.serve}/${data.token}/${encodeURI(data.rest)}`;
      body.textContent = "";
      body.appendChild(makeHtmlFrame(state.serveSrc));
    })
    .catch(() => {
      if (seq === state.openSeq) errorView(body, "请求失败（无法访问文件预览服务）", rawFileUrl(state.currentPath, state.currentCwd, state));
    });
}

/** 构造 sandbox iframe（G4：sandbox 属性精确为空集——无 allow-scripts、无 allow-same-origin）。 */
function makeHtmlFrame(src: string): HTMLElement {
  const frame = el("iframe", {
    class: "fwp-html-frame",
    attrs: {
      sandbox: "", // 空 token 集 = 最严格隔离；绝不同时开 allow-scripts + allow-same-origin（J9）
      referrerpolicy: "no-referrer",
      title: "HTML 预览（沙箱内渲染，不执行脚本）",
    },
  });
  frame.src = src;
  return frame;
}
