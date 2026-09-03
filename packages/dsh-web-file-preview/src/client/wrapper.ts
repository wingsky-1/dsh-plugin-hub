/**
 * dsh-web-file-preview — 客户端 openPath 收口包装（0.1.2 适配）。
 *
 * dsh 0.1.2-alpha.2 移除 `ctx.workspaces.openPath`，对话 `openFile()` 统一经
 * `ctx.remote.session.openWorkspacePath({path})`（Remote 网关，返回
 * `RemoteResult`，调用方检查 `result.ok`）。本包装仍在调用点统一收口：
 * 路径命中预览分组 → 走 web 预览（返回成功结果、不触底原生打开）；
 * 否则放行原方法（原生打开，错误/信号面原样透传由调用方处理）。
 */

import type { FilePreviewState } from "./state.ts";
import { isPreviewablePath, activeCwd } from "./intercept.ts";
import { openPreview } from "./preview.ts";

/**
 * A：在 `ctx.remote.session.openWorkspacePath` 调用点统一收口（0.1.2-alpha.2）。
 * 命中路径的调用方（上游对话 openFile、第三方壳）读到 `result.ok` 判定成败；
 * 包装命中预览分组 → 原地打开 web 预览并返回成功，不触底原生 open；
 * 否则放行原方法。返回 disposer 还原原方法（防御式：仅持有存在时才包装/还原）。
 */
export function wrapOpenPath(ctx: any, state: FilePreviewState): () => void {
  let session: any;
  let orig: ((req: unknown, signal?: AbortSignal) => Promise<unknown>) | undefined;
  try {
    // #486-fix：客户端服务经 ctx 属性直访（provider-usage #383 同款）——宿主风格
    // ctx.get("remote") 在客户端注入代理上抛 "cannot get property ... without
    // inject"。remote 服务须在 inject 声明 "remote"（+ "remote.session" 深层），
    // 访问链 remote.session 才不触发代理校验。
    const remote = ctx ? ctx.remote : undefined;
    session = remote && typeof remote === "object" ? remote.session : undefined;
    if (session && typeof session.openWorkspacePath === "function") {
      orig = session.openWorkspacePath.bind(session);
      session.openWorkspacePath = async (req: unknown, signal?: AbortSignal) => {
        const p = String((req as { path?: unknown } | undefined)?.path ?? "");
        if (isPreviewablePath(p)) {
          openPreview(state, p, activeCwd());
          // 调用方只检查 result.ok（上游 ui-chat apply.ts:125）；预览接管视作打开成功
          return { ok: true, value: { opened: false } };
        }
        return orig!(req, signal);
      };
    }
  } catch (error) {
    console.warn("[dsh-web-file-preview] wrap openWorkspacePath failed:", error);
  }
  return () => {
    if (session && orig && typeof session.openWorkspacePath === "function") {
      try { session.openWorkspacePath = orig; } catch { /* 还原失败忽略 */ }
    }
  };
}