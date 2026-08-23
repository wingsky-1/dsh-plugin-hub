/**
 * dsh-web-file-preview — 客户端 openPath 收口包装。
 *
 * 在 `workspaces.openPath` 调用点统一收口：路径命中预览分组 → 走 web 预览，
 * 不触底 host.openPath；否则放行原方法（原生打开）。
 */

import type { FilePreviewState } from "./state.js";
import { isPreviewablePath, activeCwd } from "./intercept.js";
import { openPreview } from "./preview.js";

/**
 * A：在 `workspaces.openPath` 调用点统一收口。
 * conversation 的 `openFile()`（产出文件 chip + 行内文件引用）以及第三方
 * 壳（如文件树）最终都汇到这一个入口。包装其方法：路径命中后缀白名单 →
 * 走 web 预览且不触底 `host.openPath`；否则放行原方法（原生打开）。
 * 返回一个 thenable，兼容调用方 `.catch(() => {})` 写法。
 */
export function wrapOpenPath(ctx: any, state: FilePreviewState): () => void {
  let ws: any;
  let orig: ((path: string) => unknown) | undefined;
  try {
    ws = ctx && ctx.get ? ctx.get("workspaces") : undefined;
    if (ws && typeof ws.openPath === "function") {
      orig = ws.openPath.bind(ws);
      ws.openPath = function (path: string): unknown {
        const p = String(path);
        if (isPreviewablePath(p)) {
          openPreview(state, p, activeCwd());
          return Promise.resolve();
        }
        return orig!(p);
      };
    }
  } catch (error) {
    console.warn("[dsh-web-file-preview] wrap openPath failed:", error);
  }
  return () => {
    if (ws && orig && typeof ws.openPath === "function") {
      try { ws.openPath = orig; } catch { /* 还原失败忽略 */ }
    }
  };
}