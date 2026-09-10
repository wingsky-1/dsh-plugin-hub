/**
 * dsh-web-file-preview — 「打开文件」改走官方右侧栏预览的客户端装配。
 *
 * 官方两条外开入口（presented 卡片菜单、助手最终回复里的交付物提及）最终都发
 * POST /api/present.open，所以在 fetch 调用点统一收口。该请求的 query 只带
 * sessionId/seq/index、不带路径，而客户端 remote 没有 sessionQuery 命名空间可
 * 反查事件，因此路径由捕获阶段的点击记录提供（见 src/present-open.ts）。
 *
 * 采集只用官方显式标记：卡片的 data-presented-file，以及卡片覆盖按钮与正文提及
 * 的 title。官方其余类名是 CSS Modules 哈希，不可作为选择器。
 *
 * 必须用捕获阶段：菜单面板由 portal 渲染到 body 且自带 onClick stopPropagation，
 * 冒泡阶段看不到菜单项点击。
 */
import {
  fileAddressFor,
  isOpenRequest,
  looksLikeFilePath,
  sessionIdOf,
  usablePending,
  type PendingEntry,
} from "../present-open.ts";

/** 挂载所需服务：旧版 dsh 没有它，靠 inject 门控静默不激活。 */
export const REDIRECT_SERVICE = "sidebarRight";

/** presented 卡片根（官方显式标记，覆盖按钮的 title 带绝对路径）。 */
const CARD_ROOT = "[data-presented-file]";

/** 助手回复正文的交付物提及：`<code><button title=路径>`。 */
const MENTION = "code > button[title]";

/** 从最近的作用域节点上取 title；节点缺失或没有该属性时返回 null。 */
function titleFrom(target: any, selector: string): string | null {
  const node = target.closest(selector);
  if (node === null || node === undefined) return null;
  const value = node.getAttribute("title");
  return typeof value === "string" ? value : null;
}

/** 本次点击声明的文件路径；不是文件路径点击时返回 null。 */
function pickPath(target: any): string | null {
  const card = target.closest(CARD_ROOT);
  if (card !== null && card !== undefined) {
    const titled = card.querySelector("button[title]");
    const value = titled?.getAttribute("title") ?? card.getAttribute("title");
    if (typeof value === "string" && looksLikeFilePath(value)) return value.trim();
  }
  const mention = titleFrom(target, MENTION);
  return mention !== null && looksLikeFilePath(mention) ? mention.trim() : null;
}

/** 会话工作区根；读不到就不折叠（地址仍可用，只是可能与卡片点击产生两个 tab）。 */
function sessionCwd(ctx: any, sessionId: string): string | undefined {
  try {
    const snapshot = ctx?.sessions?.list?.getSnapshot?.();
    const cwd = snapshot?.byId?.[sessionId]?.cwd;
    return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 安装重定向；返回还原器。
 *
 * 命中且能拿到路径时不出网：直接请官方侧栏打开该地址，并合成官方调用方读得懂的
 * 成功响应（它只判 `response.ok` 与 `status === 422`）。任何一步失败都显式重放原始
 * 请求——先吞请求再失败会让用户点了没反应。
 */
export function installPresentOpenRedirect(ctx: any): () => void {
  let pending: PendingEntry | undefined;

  const onClick = (event: any): void => {
    try {
      const target = event?.target;
      if (target === null || target === undefined || typeof target.closest !== "function") return;
      const path = pickPath(target);
      if (path !== null) pending = { path, at: Date.now() };
    } catch {
      /* 采集失败只影响下一次重定向，不该打断用户点击 */
    }
  };
  document.addEventListener("click", onClick, true);

  const original = window.fetch;
  const redirecting = function (input: any, init?: any): Promise<Response> {
    if (!isOpenRequest(input, init)) return original.call(window, input, init);
    const sessionId = sessionIdOf(input);
    const path = usablePending(pending, Date.now());
    if (sessionId === null || path === null) return original.call(window, input, init);
    try {
      ctx.sidebarRight.openResource(fileAddressFor(sessionId, sessionCwd(ctx, sessionId), path));
      return Promise.resolve(new Response(null, { status: 204 }));
    } catch {
      // openResource 对无人认领的地址同步抛错，此时原生请求尚未发出，必须重放。
      return original.call(window, input, init);
    }
  };
  window.fetch = redirecting as typeof fetch;

  return () => {
    document.removeEventListener("click", onClick, true);
    // 身份比对：重复 apply / HMR 后不能摘掉别人的包装。
    if ((window.fetch as unknown) === redirecting) window.fetch = original;
  };
}
