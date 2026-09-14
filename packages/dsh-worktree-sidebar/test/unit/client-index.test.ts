/**
 * 装配根（src/client/index.ts）—— 契约层用例：递手写假 ctx 驱动 `apply`。
 *
 * 这是契约层而不是 unit 的同域白盒面：装配根的依赖面就是宿主给的 `ctx`，
 * 不递假面就无法驱动它。
 *
 * **临时前提（S3 的 B2 会消掉）**：`src/client/index.ts` 现在直接引用构建期注入的
 * `__DSH_ROUTES__` 标识符（裸引用）。非 bundle 环境里它不存在，模块求值即 ReferenceError，
 * 所以本文件必须**先**把它挂到 globalThis、再动态 import 装配根——静态 import 会被提升到
 * 赋值之前。B2 把它改成 `typeof` 守卫之后，这段前置即可删除。
 *
 * 为什么允许打桩 `globalThis.fetch`：装配根在会话 materialize 时就拉一次宿主路由，
 * 不桩会真的发出网络请求（离线纪律）。这里只用它当调用计数器与响应源，不伪造别的进程事实。
 *
 * 时间纪律：只假 `setInterval` / `clearInterval`（不钉 `Date`），异步等待用
 * `settleMicrotasks` 排空队列，不写真实 sleep。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClientSlotsPort,
  ObservablePort,
  SessionsSnapshotLike,
  StoredEntryLike,
  TabDefinitionLike,
  TabsPort,
} from "../../src/client/ports.ts";
import { BODY_SLOT, FILES_KIND } from "../../src/client/takeover.ts";

Object.assign(globalThis, {
  __DSH_ROUTES__: {
    bindings: "/api/dsh-worktree-sidebar/bindings",
    health: "/api/dsh-worktree-sidebar/health",
  },
});

const { apply } = await import("../../src/client/index.ts");

const OFFICIAL_ID = "@deepseek-ai/dsh-client-ui-sidebar-files/files";
const SESSION_ID = "s1";

/** 官方正文条目：装配根找得到它才会走注册（找不到就零注册）。 */
const BODY: StoredEntryLike = {
  component: { name: "FilesBody" },
  options: { key: OFFICIAL_ID },
  inject: () => ({ useFiles: "official-useFiles" }),
};

const OFFICIAL_DEFINITION: TabDefinitionLike = {
  id: OFFICIAL_ID,
  kind: FILES_KIND,
  priority: "builtin",
  title: () => "Files",
};

/** 排空在飞的微任务链：钉了 setInterval 也不能用真实 sleep（见文件头时间纪律）。 */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 一个会话还在册的快照。 */
function liveSnapshot(): SessionsSnapshotLike {
  return { ids: [SESSION_ID], byId: { [SESSION_ID]: { title: "t" } }, current: SESSION_ID };
}

/** 该会话已从宿主快照消失的形态。 */
function emptySnapshot(): SessionsSnapshotLike {
  return { ids: [], byId: {}, current: undefined };
}

interface Mounted {
  /** 假 sessions.list 当前返回的真实快照，可直接替换成「会话已消失」的形态。 */
  readonly snapshot: { value: SessionsSnapshotLike };
  /** 装配时注册正文传进去的那份 inject。 */
  capturedInject(): (...args: unknown[]) => Record<string, unknown>;
  /** 该会话累计发起的绑定拉取次数。 */
  fetchesFor(sessionId: string): number;
  /** 调 ctx.effect 收下的 disposer（整包卸载）。 */
  dispose(): void;
}

let active: Mounted | undefined;
const savedFetch = globalThis.fetch;

afterEach(() => {
  active?.dispose();
  active = undefined;
  vi.useRealTimers();
  globalThis.fetch = savedFetch;
});

/**
 * 装一次假 ctx 并调 apply。
 *
 * 假面必须复刻装配根真正用到的形状：`sessions` 服务对象本身**没有** `getSnapshot`，
 * 快照在 `sessions.list` 上——这正是本文件要钉住的那条接缝。
 */
function mount(respond: () => Response): Mounted {
  const snapshot: { value: SessionsSnapshotLike } = { value: liveSnapshot() };
  const fetchUrls: string[] = [];
  const disposers: Array<() => void> = [];
  let captured: unknown;

  const slots: ClientSlotsPort = {
    entriesOfSlot: (key) => (key === BODY_SLOT ? [BODY] : []),
    register: (options) => {
      if (options["name"] === BODY_SLOT) captured = options["inject"];
      return () => undefined;
    },
    subscribe: () => () => undefined,
    onEntryError: () => () => undefined,
  };
  const sidebarRightTabs: TabsPort = {
    get: (kind) => (kind === FILES_KIND ? OFFICIAL_DEFINITION : undefined),
    register: () => () => undefined,
  };

  globalThis.fetch = async (input) => {
    fetchUrls.push(String(input));
    return respond();
  };

  apply({
    slots,
    sidebarRightTabs,
    sessions: {
      list: {
        getSnapshot: () => snapshot.value,
        subscribe: () => () => undefined,
      },
    },
    effect: (execute) => {
      disposers.push(execute());
      return () => undefined;
    },
  });

  const mounted: Mounted = {
    snapshot,
    capturedInject: () => captured as (...args: unknown[]) => Record<string, unknown>,
    fetchesFor: (sessionId) =>
      fetchUrls.filter((url) => url.endsWith("?session=" + sessionId)).length,
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
  active = mounted;
  return mounted;
}

/** 一次成功的绑定读取。 */
function bindingResponse(): Response {
  return new Response(JSON.stringify({ revision: 1, worktreePath: "/wt" }), { status: 200 });
}

describe("entry 注入面的 sessions 接在真快照源上（A2）", () => {
  it("hooks.sessions.getSnapshot() 回的是宿主快照", () => {
    const h = mount(() => new Response(null, { status: 404 }));
    const face = h.capturedInject()(SESSION_ID);
    const sessions = (face["hooks"] as { sessions: { getSnapshot(): SessionsSnapshotLike } })
      .sessions;
    // 只断「hooks.sessions 存在」是恒真断言：接错面（换成 ctx.sessions）时构造期不抛、
    // typeof 也仍是 function，只有真的调用一次才会 TypeError。
    expect(sessions.getSnapshot()).toBe(h.snapshot.value);
  });
});

describe("按会话剪枝：宿主快照里消失的会话不再被拉取（P1 泄漏）", () => {
  it("会话从快照消失后，定时器不再为它拉绑定", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const h = mount(bindingResponse);
    h.capturedInject()(SESSION_ID);
    expect(h.fetchesFor(SESSION_ID)).toBe(1);

    h.snapshot.value = emptySnapshot();
    vi.advanceTimersByTime(5_000);

    expect(h.fetchesFor(SESSION_ID)).toBe(1);
  });

  it("剪枝释放订阅：之后到达的绑定变化不再通知到改写源", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const h = mount(bindingResponse);
    const face = h.capturedInject()(SESSION_ID);
    const source = (face["hooks"] as { sessions: ObservablePort<SessionsSnapshotLike> }).sessions;
    let notified = 0;
    const unsubscribe = source.subscribe(() => {
      notified += 1;
    });

    h.snapshot.value = emptySnapshot();
    vi.advanceTimersByTime(5_000);
    await settleMicrotasks();

    // 剪枝时若不调用 state.subscribe 的退订，这条已在飞的绑定变化会经改写源通知出去。
    expect(notified).toBe(0);
    unsubscribe();
  });
});
