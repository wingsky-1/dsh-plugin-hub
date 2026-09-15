/**
 * dsh-web-file-preview — 「打开文件」改走官方右侧栏预览的客户端装配。
 *
 * 官方两条外开入口（presented 卡片菜单、助手最终回复里的交付物提及）最终都发
 * POST /api/present.open，所以在 fetch 调用点统一收口。该请求的 query 只带
 * sessionId/seq/index、不带路径，而客户端 remote 没有 sessionQuery 命名空间可
 * 反查事件，因此路径由捕获阶段的点击记录提供（见 src/shared/present-open.ts）。
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
} from "../shared/interface.ts";

/** 挂载所需服务：旧版 dsh 没有它，靠 inject 门控静默不激活。 */
export const REDIRECT_SERVICE = "sidebarRight";

/** 点击目标的最小 DOM 面：只用于向上找作用域节点与读 title，不依赖任何渲染实现。 */
export interface ClickTarget {
  closest(selector: string): ClickTarget | null;
  querySelector(selector: string): ClickTarget | null;
  getAttribute(name: string): string | null;
}

/** 装配所需的最小宿主面：会话快照（折叠 cwd）与官方右侧栏导航。 */
export interface RedirectContext {
  readonly sessions?: {
    readonly list?: {
      readonly getSnapshot?: () => {
        readonly byId?: Record<string, { readonly cwd?: unknown } | undefined>;
      };
    };
  };
  readonly sidebarRight: { readonly openResource: (address: string) => void };
}

/** 客户端装配面：官方注入的服务 + cordis 的 effect 清理注册。 */
export interface ClientContext extends RedirectContext {
  readonly effect: (setup: () => () => void, label: string) => void;
}

/** presented 卡片根（官方显式标记，覆盖按钮的 title 带绝对路径）。 */
const CARD_ROOT = "[data-presented-file]";

/** 助手回复正文的交付物提及：`<code><button title=路径>`。 */
const MENTION = "code > button[title]";

/** 点击目标收窄：非元素（null / 非对象 / 没有 closest）一律返回 null。 */
function asClickTarget(value: unknown): ClickTarget | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as { closest?: unknown };
  return typeof candidate.closest === "function" ? (value as ClickTarget) : null;
}

function titleFrom(target: ClickTarget, selector: string): string | null {
  const node = target.closest(selector);
  if (node === null || node === undefined) return null;
  const value = node.getAttribute("title");
  return typeof value === "string" ? value : null;
}

function pickPath(target: ClickTarget): string | null {
  const card = target.closest(CARD_ROOT);
  if (card !== null && card !== undefined) {
    const titled = card.querySelector("button[title]");
    // 官方卡片根当前不带 title；末段是前向兼容，将来卡片根自带路径时无需再改采集。
    const value = titled?.getAttribute("title") ?? card.getAttribute("title");
    if (typeof value === "string" && looksLikeFilePath(value)) return value.trim();
  }
  const mention = titleFrom(target, MENTION);
  return mention !== null && looksLikeFilePath(mention) ? mention.trim() : null;
}

/** 会话工作区根；读不到就不折叠（地址仍可用，只是可能与卡片点击产生两个 tab）。 */
function sessionCwd(ctx: RedirectContext, sessionId: string): string | undefined {
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
export function installPresentOpenRedirect(ctx: RedirectContext): () => void {
  let pending: PendingEntry | undefined;

  const onClick = (event: unknown): void => {
    try {
      const target = asClickTarget((event as { target?: unknown } | null | undefined)?.target);
      if (target === null) return;
      const path = pickPath(target);
      if (path !== null) pending = { path, at: Date.now() };
    } catch {
      /* 采集失败只影响下一次重定向，不该打断用户点击 */
    }
  };
  document.addEventListener("click", onClick, true);

  const original = window.fetch;
  /** 原样交给原生 fetch：包装器面对的是 fetch 的宽松入参面，故在此统一收敛类型。 */
  const passThrough = (input: unknown, init: unknown): Promise<Response> =>
    original.call(window, input as RequestInfo, init as RequestInit);

  const redirecting = function (input: unknown, init?: unknown): Promise<Response> {
    if (!isOpenRequest(input, init)) return passThrough(input, init);
    const sessionId = sessionIdOf(input);
    const path = usablePending(pending, Date.now());
    if (sessionId === null || path === null) return passThrough(input, init);
    // 取用即清：pending 是单槽且不绑定会话，留到下一次请求会把「没有前置点击」的 POST 引到
    // 上一次的路径。清在这里 = 只有真正接管的那一次才消费；上面两处透传（非目标请求、缺
    // 会话或路径）都不动它；openResource 抛错重放那条出口已消费——用户会重新点击，捕获阶段重写。
    pending = undefined;
    try {
      ctx.sidebarRight.openResource(fileAddressFor(sessionId, sessionCwd(ctx, sessionId), path));
      return Promise.resolve(new Response(null, { status: 204 }));
    } catch {
      // openResource 对无人认领的地址同步抛错，此时原生请求尚未发出，必须重放。
      return passThrough(input, init);
    }
  };
  window.fetch = redirecting as typeof fetch;

  return () => {
    document.removeEventListener("click", onClick, true);
    // 身份比对：cordis 按 LIFO 逆序清栈，同 fiber 重复 apply 时逐层摘除成立；跨 fiber 的
    // 「先装新、后卸旧」顺序下身份不符即不摘——宁可留一层空壳透传，也不摘掉别人的包装。
    if ((window.fetch as unknown) === redirecting) window.fetch = original;
  };
}
