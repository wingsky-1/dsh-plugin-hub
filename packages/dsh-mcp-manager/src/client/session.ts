/**
 * dsh-mcp-manager — 客户端会话跟随。
 *
 * 监听当前会话变化（cwd），通知宿主切换项目级 MCP 并刷新 UI。
 * 跨模块动作（refresh）经 actions 注入，不直接引用 panel 模块。
 */

import { api } from "./dom.ts";
import type { McpState, UiActions } from "./state.ts";

/** 跟随当前会话：cwd 变化 → 通知宿主切换项目级 MCP + 刷新浮窗。 */
export function bindSession(ctx: any, state: McpState, actions: UiActions): () => void {
  const list = ctx.sessions?.list;
  if (list === undefined || typeof list.getSnapshot !== "function") return () => {};
  const sync = () => {
    let cwd: any;
    try {
      const snapshot = list.getSnapshot();
      const sessionId = snapshot?.current;
      cwd = sessionId === undefined ? undefined : snapshot?.byId?.[sessionId]?.cwd;
    } catch {
      cwd = undefined;
    }
    const prevCwd = state.currentCwd;
    state.currentCwd = cwd;
    state.updateFloatState?.();
    if (cwd === prevCwd) return;
    // 无论 cwd 是否为空都通知宿主切换：空 cwd（blank 会话/新会话还没选
    // 工作区）也要显式清空宿主的项目级 MCP，否则宿主全局单例会残留
    // 上一个会话的项目级服务器，别的会话就串台显示了。
    void api(state.API.session, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: typeof cwd === "string" ? cwd : "" }),
    }).then(() => actions.refresh()).catch(() => {});
  };
  sync();
  if (typeof list.subscribe === "function") return list.subscribe(sync);
  return () => {};
}