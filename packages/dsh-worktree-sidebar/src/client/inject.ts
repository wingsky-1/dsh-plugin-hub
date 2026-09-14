/**
 * 官方 entry inject 面的改写。本文件回答两件事：
 * 1. `hooks.sessions` 指向按会话的改写源（官方正文读到的 cwd）；
 * 2. **树根的播种时机**——覆盖 `start`/`load`，把「根 = 首帧读到的 cwd」改成「根 = 绑定解析后的生效根」。
 *
 * 为什么必须覆盖 `start`：官方只在 `state === undefined` 时用当帧的 cwd 播一次种
 * （dsh-client-ui-sidebar-files/lib/client.js:426-428），之后 cwd 再变也不会重设根；
 * 刷新按钮只走 `actions.reset` + 按已展开路径重新 `load`（同文件 :455-458、:659-661），
 * 同样不重设根。所以「读到新绑定但树还指着旧根」只能在这一层堵住。
 *
 * 请求只在用户可感知的时机发出：挂载页签（`start` 前读一次）、点刷新（`load` 命中已播种的根时读一次）、
 * 窗口重新可见/获得焦点（读一次）。**没有定时轮询**——轮询既改不了已挂载页签的根，也白花请求。
 *
 * 作用域仍是**本 entry**：只改我们注册的那条正文。探测官方 entries 与三步注册在 `takeover.ts`；
 * 两块零互引（ESLint 块间隔离），装配根把 `viewFor` 接进来、再把产出接到那边的 `wrapInject` 上。
 */
import type { SessionContribution, SessionView, ViewFor, WrapInject } from "./shared/ports.ts";

/** 官方 files face 里被我们覆盖的两个方法（其余成员原样透传）。 */
type FaceStart = (tabId: string, root: string, signal?: AbortSignal) => void;
type FaceLoad = (tabId: string, path: string, signal?: AbortSignal) => void;

/** 一个已挂载页签：最近播种的根、回退根，以及它的存活信号。 */
interface WatchedTab {
  /** 最近一次播种进去的根；`load` 靠它认出「刷新按钮的根那一跳」。 */
  seeded: string;
  /** 官方正文递进来的 cwd：绑定不可用时回退到它。 */
  readonly fallback: string;
  readonly signal: AbortSignal | undefined;
}

/** 造一个改写器：外包官方工厂、保留它产出的一切，只改 hooks 与那两个播种方法。 */
export function createInjectWrapper(viewFor: ViewFor): WrapInject {
  return (official) => {
    return (...args: unknown[]): Record<string, unknown> => {
      const face: Record<string, unknown> = official === undefined ? {} : official(...args);
      // 渲染器把 binding.key 作为第一个参数传进来（runInject）；取不到会话 id 时宁可让树显示真实 cwd。
      const sessionId = args.find((arg): arg is string => typeof arg === "string");
      if (sessionId === undefined) return face;
      const view = viewFor(sessionId);
      const bound: Record<string, unknown> = { ...face, hooks: mergeSessions(face, view) };
      // 官方面不成形时不改写：没有 start 就没有可播种的树，改了只会让树进不了状态。
      return typeof face["start"] === "function" ? { ...bound, ...seeding(view, face) } : bound;
    };
  };
}

/** 官方 face 里已有的 hooks 源要保留：我们只覆盖 sessions 一项。 */
function mergeSessions(
  face: Record<string, unknown>,
  view: SessionView,
): SessionContribution["hooks"] {
  const existing = face["hooks"];
  const hooks =
    typeof existing === "object" && existing !== null
      ? (existing as SessionContribution["hooks"])
      : {};
  return { ...hooks, sessions: view.source };
}

/**
 * 以生效根播种的 `start`/`load`。
 *
 * 订阅只在**有页签挂载**期间存在（首个 `start` 建立、最后一个 abort 撤销）：
 * 只有开着 Files 页签的会话才有请求与订阅，关掉即回收——不需要另做"会话还在不在"的推断。
 */
function seeding(view: SessionView, face: Record<string, unknown>): Record<string, unknown> {
  const officialStart = face["start"] as FaceStart;
  const officialLoad = face["load"] as FaceLoad | undefined;
  const watched = new Map<string, WatchedTab>();
  let unsubscribe: (() => void) | undefined;
  let detachVisible: (() => void) | undefined;

  const refresh = (): void => {
    void view.root.refresh();
  };

  /** 生效根变了：把每个在挂页签重新播一次种（官方 `start` 会重设根并重新列目录）。 */
  const reseed = (): void => {
    const next = view.root.getSnapshot();
    for (const [tabId, tab] of [...watched]) {
      if (tab.signal?.aborted === true) continue;
      const root = next ?? tab.fallback;
      tab.seeded = root;
      officialStart(tabId, root, tab.signal);
    }
  };

  const release = (): void => {
    unsubscribe?.();
    unsubscribe = undefined;
    detachVisible?.();
    detachVisible = undefined;
  };

  const attach = (
    tabId: string,
    fallback: string,
    seeded: string,
    signal: AbortSignal | undefined,
  ): void => {
    watched.set(tabId, { seeded, fallback, signal });
    unsubscribe ??= view.root.subscribe(reseed);
    detachVisible ??= refreshWhenVisible(refresh);
    signal?.addEventListener(
      "abort",
      () => {
        watched.delete(tabId);
        if (watched.size === 0) release();
      },
      { once: true },
    );
  };

  const start: FaceStart = (tabId, root, signal) => {
    // 先读一次绑定再播种：首帧树根必须是生效根，否则官方会把 cwd 一直钉在树上。
    void view.root.refresh().then(() => {
      if (signal?.aborted === true) return;
      const seeded = view.root.getSnapshot() ?? root;
      attach(tabId, root, seeded, signal);
      officialStart(tabId, seeded, signal);
    });
  };

  const load: FaceLoad = (tabId, path, signal) => {
    // 官方刷新 = `actions.reset` + 对每个已展开路径调 load；根那一跳就是重读绑定的时机。
    // 展开子目录（路径更深）不触发，否则点开 20 个目录就是 20 次请求。
    if (watched.get(tabId)?.seeded === path) refresh();
    officialLoad?.(tabId, path, signal);
  };

  return officialLoad === undefined ? { start } : { start, load };
}

/**
 * 窗口重新可见或重新获得焦点时读一次：覆盖「切走一会儿再回来」——那时 agent 多半刚登记过。
 * 没有 DOM（单测/非浏览器环境）时退化为无触发，其余时机不受影响。
 */
function refreshWhenVisible(refresh: () => void): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => undefined;
  const onVisible = (): void => {
    if (!document.hidden) refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  };
}
