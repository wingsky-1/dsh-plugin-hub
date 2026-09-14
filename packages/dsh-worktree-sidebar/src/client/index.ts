/**
 * dsh-worktree-sidebar 浏览器端入口（干净模块：只 apply/inject，外壳由构建链生成）。
 *
 * 这里只做适配：把 `ctx` 收窄成各模块认得的窄面，把每个会话的绑定状态接成「改写源 + 生效根读数」。
 * 判断本身都在 `takeover.ts` / `inject.ts` / `source.ts` / `bindings.ts` 里。
 *
 * **没有定时轮询**：请求只在三个用户可感知的时机发出——打开 Files 页签、点官方刷新按钮、
 * 窗口重新可见/获得焦点（三处都在 `inject.ts` 的播种面里）；cwd 的改写只在 Files 正文内生效。
 */
import type { BindingResponse } from "../contract.ts";
import { ROUTES } from "../contract.ts";
import { createBindingState } from "./bindings.ts";
import { createInjectWrapper } from "./inject.ts";
import type {
  ClientSlotsPort,
  ObservablePort,
  ReadBinding,
  SessionView,
  SessionsSnapshotLike,
  TabsPort,
  ViewFor,
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
    const views = new Map<string, SessionView>();

    /** 每个会话一套视图。同一 id 恒回同一对象：改写源与生效根读数都必须稳定。 */
    const viewFor: ViewFor = (sessionId) => {
      let view = views.get(sessionId);
      if (view === undefined) {
        const state = createBindingState(readBinding, sessionId);
        const source = createSessionsSource(ctx.sessions.list, sessionId, () =>
          state.getSnapshot(),
        );
        // 绑定一变就通知渲染层重算快照：引用稳定的前提下，这是「树读到新 cwd」的唯一通道。
        // 订阅与视图同寿命（整包卸载时 views.clear() 一起丢掉），不另做存活性推断。
        state.subscribe(() => source.notify());
        view = { source, root: state };
        views.set(sessionId, view);
      }
      return view;
    };

    // 接管块与 inject 改写块零互引：会话视图在这里绑进改写器，再交给接管块当依赖。
    const restore = installTakeover({
      slots: ctx.slots,
      tabs: ctx.sidebarRightTabs,
      logger: { warn: (message: string) => console.warn(message) },
      wrapInject: createInjectWrapper(viewFor),
    });

    ctx.effect(
      () => () => {
        restore();
        views.clear();
      },
      "dsh-worktree-sidebar: 会话视图与 files 页签接管",
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
