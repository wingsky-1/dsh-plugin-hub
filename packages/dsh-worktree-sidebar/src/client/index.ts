/**
 * dsh-worktree-sidebar 浏览器端入口（干净模块：只 apply/inject，外壳由构建链生成）。
 *
 * 这里只做适配：把 `ctx` 收窄成接管逻辑认得的三个窄面，把每会话的绑定状态与快照源接起来。
 * 判断本身都在 `takeover.ts` / `source.ts` / `bindings.ts` 里，那三个模块不需要浏览器。
 */
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

/** 宿主端 `ROUTES.bindings` 经构建期注入；注入缺失时用同一条字面路径兜底。 */
declare const __DSH_ROUTES__: Record<string, string> | undefined;
const BINDINGS_URL = __DSH_ROUTES__?.bindings ?? "/api/dsh-worktree-sidebar/bindings";

/** 绑定刷新间隔。绑定只由 agent 工具改变，这个频率足以让「刚摘掉登记」在下一次用到树之前传过来。 */
const REFRESH_MS = 5_000;

/** 读一次宿主绑定。任何失败都回 undefined，由调用方保持上次成功态（G6）。 */
const readBinding: ReadBinding = async (sessionId) => {
  try {
    const response = await fetch(BINDINGS_URL + "?session=" + encodeURIComponent(sessionId), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { revision?: unknown; worktreePath?: unknown };
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
 * 浏览器端上下文的窄面。刻意不用 `any`：这四个面正是 `inject` 声明的那四个，
 * 写成结构类型之后，「多用一个服务却忘了声明」会在类型层先露出来。
 */
interface ClientContext {
  readonly slots: ClientSlotsPort;
  readonly sidebarRightTabs: TabsPort;
  readonly sessions: ObservablePort<SessionsSnapshotLike>;
  readonly effect: (execute: () => () => void, label?: string) => unknown;
}

export function apply(ctx: ClientContext): void {
  try {
    const states = new Map<string, BindingState>();
    const sources = new Map<string, ObservablePort<SessionsSnapshotLike>>();

    const stateFor = (sessionId: string): BindingState => {
      let state = states.get(sessionId);
      if (state === undefined) {
        state = createBindingState(readBinding, sessionId);
        states.set(sessionId, state);
      }
      return state;
    };

    /** 每个会话一条改写源；绑定刷新时通知它重算快照。 */
    const sourceFor = (sessionId: string): ObservablePort<SessionsSnapshotLike> => {
      let source = sources.get(sessionId);
      if (source === undefined) {
        const state = stateFor(sessionId);
        const created = createSessionsSource(ctx.sessions, sessionId, () => state.getSnapshot());
        state.subscribe(() => created.notify());
        sources.set(sessionId, created);
        source = created;
        void state.refresh();
      }
      return source;
    };

    const restore = installTakeover({
      slots: ctx.slots,
      tabs: ctx.sidebarRightTabs,
      logger: { warn: (message: string) => console.warn(message) },
      sourceFor,
    });

    const timer = setInterval(() => {
      for (const state of states.values()) void state.refresh();
    }, REFRESH_MS);

    ctx.effect(
      () => () => {
        clearInterval(timer);
        restore();
        states.clear();
        sources.clear();
      },
      "dsh-worktree-sidebar: files 页签接管",
    );
  } catch (error) {
    // 挂载失败一律降级：不注册任何东西，右栏保持官方行为。可感知地什么都不做，好过静默显示错的地方。
    console.warn("[dsh-worktree-sidebar] mount failed:", error);
  }
}

/**
 * 客户端契约。`slots` / `sidebarRightTabs` 是接管的两个面，`sessions` 是真实快照的来源，
 * `locale` 随官方组件的完整装配面一起被继承（本包不自带文案）。漏声明会在属性访问处抛
 * "without inject"；`sidebarRightTabs` 不存在时整体不激活——那说明官方包不在，我们无话可说。
 */
export const inject: string[] = ["slots", "sidebarRightTabs", "sessions", "locale"];
