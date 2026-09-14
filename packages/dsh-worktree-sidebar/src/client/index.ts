/**
 * dsh-worktree-sidebar 浏览器端入口（干净模块：只 apply/inject，外壳由构建链生成）。
 *
 * 这里只做适配：把 `ctx` 收窄成各模块认得的窄面，把每会话的绑定状态与快照源接起来。
 * 判断本身都在 `takeover.ts` / `source.ts` / `bindings.ts` 里，那三个模块不需要浏览器。
 */
import type { BindingResponse } from "../contract.ts";
import { ROUTES } from "../contract.ts";
import { createBindingState } from "./bindings.ts";
import type { BindingState } from "./bindings.ts";
import type {
  ClientSlotsPort,
  ObservablePort,
  ReadBinding,
  SessionsSnapshotLike,
  TabsPort,
} from "./ports.ts";
import { createSessionsSource } from "./source.ts";
import { installTakeover } from "./takeover.ts";

/**
 * 宿主端 `ROUTES` 经构建期 define 注入 `__DSH_ROUTES__`（bundle-host.ts）。
 *
 * 兜底必须写成 `typeof` 守卫：`declare const` 只活在类型层，非 bundle 环境（源码直接 import、
 * 单测、构建期收集）里这个标识符根本不存在，裸引用会当场 ReferenceError。所以契约常量留在
 * `src/contract.ts` 根，注入缺失时用它——也是本包路由的单一事实源。
 */
declare const __DSH_ROUTES__: Record<string, string> | undefined;
const ROUTES_INJECTED = typeof __DSH_ROUTES__ !== "undefined" ? __DSH_ROUTES__ : ROUTES;
const BINDINGS_URL = ROUTES_INJECTED.bindings;

/** 绑定刷新间隔。绑定只由 agent 工具改变，这个频率足以让「刚摘掉登记」在下一次用到树之前传过来。 */
const REFRESH_MS = 5_000;

/** 读一次宿主绑定。任何失败都回 undefined，由调用方保持上次成功态（G6）。 */
const readBinding: ReadBinding = async (sessionId) => {
  try {
    const response = await fetch(BINDINGS_URL + "?session=" + encodeURIComponent(sessionId), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    // 响应形状来自根契约的单点定义：字段名在这里改不动，改了当场编译失败。
    const body = (await response.json()) as Partial<BindingResponse>;
    if (typeof body.revision !== "number") return undefined;
    return {
      revision: body.revision,
      worktreePath: typeof body.worktreePath === "string" ? body.worktreePath : null,
    };
  } catch {
    // 网络/解析失败与「没绑定」是两件事：这里回 undefined 而不是 null，
    // 调用方因此会保留上次成功态，而不是把根弹回 cwd。
    return undefined;
  }
};

/** 一个会话的改写源，以及它对应的释放动作。 */
interface LiveSource {
  readonly source: ObservablePort<SessionsSnapshotLike>;
  /** 释放 state 到改写源的通知订阅；剪枝时调用，否则这条订阅随状态一起留在内存里。 */
  readonly release: () => void;
}

/**
 * 「该会话已从宿主快照里消失」的保守判据：三项都是存活证据，三项都读得到且都说「不在」才成立。
 *
 * 任一项缺失或形态不符一律返回 false——把「读不到」当成「已消失」会让一次快照形态变化把
 * 在册会话全剪掉，而渲染器按源缓存订阅，剪掉就得重建。
 */
function isGone(sessionId: string, snapshot: SessionsSnapshotLike): boolean {
  const ids = snapshot.ids;
  if (!Array.isArray(ids)) return false;
  const byId: unknown = snapshot.byId;
  if (byId === null || typeof byId !== "object") return false;
  // 键存在而值为 undefined（当前没有寻址任何会话）是有效读数；键整个缺失才是读不到。
  if (!("current" in snapshot)) return false;
  const current = snapshot.current;
  if (current !== undefined && typeof current !== "string") return false;
  return !ids.includes(sessionId) && !(sessionId in byId) && sessionId !== current;
}

/**
 * 浏览器端上下文的窄面。刻意不用 `any`：这几个面正是 `inject` 声明的那几个，
 * 写成结构类型之后，「多用一个服务却忘了声明」会在类型层先露出来。
 */
interface ClientContext {
  readonly slots: ClientSlotsPort;
  readonly sidebarRightTabs: TabsPort;
  /** 服务对象本身**不是**快照源：数据在 `ISessions.list` 上（真机实测见 ports.ts 的注释）。 */
  readonly sessions: { readonly list: ObservablePort<SessionsSnapshotLike> };
  readonly effect: (execute: () => () => void, label?: string) => unknown;
}

export function apply(ctx: ClientContext): void {
  try {
    const states = new Map<string, BindingState>();
    const sources = new Map<string, LiveSource>();

    const stateFor = (sessionId: string): BindingState => {
      let state = states.get(sessionId);
      if (state === undefined) {
        state = createBindingState(readBinding, sessionId);
        states.set(sessionId, state);
      }
      return state;
    };

    /** 每个会话一条改写源；绑定刷新时通知它重算快照。同一 id 恒回同一对象（渲染器按源缓存订阅）。 */
    const sourceFor = (sessionId: string): ObservablePort<SessionsSnapshotLike> => {
      let live = sources.get(sessionId);
      if (live === undefined) {
        const state = stateFor(sessionId);
        const created = createSessionsSource(ctx.sessions.list, sessionId, () =>
          state.getSnapshot(),
        );
        live = { source: created, release: state.subscribe(() => created.notify()) };
        sources.set(sessionId, live);
        void state.refresh();
      }
      return live.source;
    };

    const restore = installTakeover({
      slots: ctx.slots,
      tabs: ctx.sidebarRightTabs,
      logger: { warn: (message: string) => console.warn(message) },
      sourceFor,
    });

    /**
     * 剪掉宿主快照里已经消失的会话：曾 materialize 过的会话否则永久占一份状态，
     * 并让下面的定时器永久每 5s 为它拉一次路由。
     *
     * 两个 Map 一一对应（state 只在 sourceFor 里连同它的源一起入册），所以按源剪一遍即可；
     * 仍然在册的 id 一律不动——同一 id 必须恒回同一对象（渲染器按源缓存订阅）。
     */
    const pruneGone = (): void => {
      let snapshot: SessionsSnapshotLike;
      try {
        snapshot = ctx.sessions.list.getSnapshot();
      } catch {
        // 读不到快照时保持现状：剪枝是回收，不是正确性前提。
        return;
      }
      // 端口声明了返回对象，运行时不归它管：非对象的读数一律不剪，也不让定时器抛。
      if (!snapshot) return;
      for (const [sessionId, live] of [...sources]) {
        if (!isGone(sessionId, snapshot)) continue;
        sources.delete(sessionId);
        states.delete(sessionId);
        try {
          live.release();
        } catch {
          // 释放失败不阻断其余剪枝：这条状态已经不在册。
        }
      }
    };

    const timer = setInterval(() => {
      // 同一个 tick 里先剪枝再刷新：被剪掉的会话不该再为这一轮贡献一次拉取。
      pruneGone();
      for (const state of states.values()) void state.refresh();
    }, REFRESH_MS);

    ctx.effect(
      () => () => {
        clearInterval(timer);
        restore();
        states.clear();
        sources.clear();
      },
      "dsh-worktree-sidebar: 会话快照源与 files 页签接管",
    );
  } catch (error) {
    // 挂载失败一律降级：不注册任何东西，右栏保持官方行为。可感知地什么都不做，好过静默显示错的地方。
    console.warn("[dsh-worktree-sidebar] mount failed:", error);
  }
}

/**
 * 客户端契约。`slots` / `sidebarRightTabs` 是接管的两个面，`sessions.list` 是真实快照的来源，
 * `locale` 随官方组件的完整装配面一起被继承（本包不自带文案）。漏声明会在属性访问处抛
 * "without inject"；`sidebarRightTabs` 不存在时整体不激活——那说明官方包不在，我们无话可说。
 */
export const inject: string[] = ["slots", "sidebarRightTabs", "sessions", "locale"];
