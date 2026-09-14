/**
 * 装配根（src/client/index.ts）—— 契约层用例：递手写假 ctx 驱动 `apply`。
 *
 * 这是契约层而不是 unit 的同域白盒面：装配根的依赖面就是宿主给的 `ctx`，
 * 不递假面就无法驱动它。
 *
 * 静态 import 本身就是一条判据：非 bundle 环境里没有构建期注入的 `__DSH_ROUTES__`，
 * 装配根靠 `typeof` 守卫回落到 `src/shared/contract.ts` 的 `ROUTES`，模块求值得当场成功。
 * 先往 globalThis 挂一个桩再 import，会把这条判据遮掉。
 *
 * 为什么允许打桩 `globalThis.fetch`：读宿主绑定的唯一出口就是它，不桩会真的发出网络请求
 * （离线纪律）。这里只用它当调用计数器与响应源，不伪造别的进程事实。
 *
 * 时间纪律：客户端**没有定时器**（请求只由页签挂载 / 官方刷新 / 窗口重新可见触发），
 * 所以本文件不假时间；异步等待一律用 `settleMicrotasks` 排空队列，不写真实 sleep。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { apply } from "../../src/client/index.ts";
import type {
  SessionsSnapshotLike,
  TabDefinitionLike,
  TabsPort,
} from "../../src/client/shared/ports.ts";
import { createFakeSlots } from "../helpers.ts";
import { BODY_SLOT, FILES_KIND, SHADOW_PRIORITY } from "../../src/client/takeover.ts";

const OFFICIAL_ID = "@deepseek-ai/dsh-client-ui-sidebar-files/files";
const SESSION_ID = "s1";
const TAB_ID = "tab-1";
/** 官方正文递进来的 cwd：绑定不可用时的回退根。 */
const CWD = "/cwd";

/** 官方正文每次被播种 / 列目录都记一笔：这是断言「播的是哪个根」的唯一证据面。 */
const officialStarts: Array<{ tabId: string; root: string }> = [];
const officialLoads: Array<{ tabId: string; path: string }> = [];

/** 官方正文条目的两个承载面：组件与 inject 工厂（登记进假座位表，装配根从原始账里找它）。 */
const OFFICIAL_BODY = {
  component: { name: "FilesBody" },
  inject: () => ({
    useFiles: "official-useFiles",
    start: (tabId: string, root: string) => {
      officialStarts.push({ tabId, root });
    },
    load: (tabId: string, path: string) => {
      officialLoads.push({ tabId, path });
    },
    toggle: () => undefined,
  }),
};

const OFFICIAL_DEFINITION: TabDefinitionLike = {
  id: OFFICIAL_ID,
  kind: FILES_KIND,
  priority: "builtin",
  title: () => "Files",
};

/** 排空在飞的微任务链：`start` 的播种是异步的（先读一次绑定）。 */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 一个会话在册的快照。 */
function liveSnapshot(): SessionsSnapshotLike {
  return { byId: { [SESSION_ID]: { title: "t" } } };
}

/** 我们注册的那条正文的 inject 面（已包装）。 */
interface Face {
  start?: (tabId: string, root: string, signal?: AbortSignal) => void;
  load?: (tabId: string, path: string, signal?: AbortSignal) => void;
  [key: string]: unknown;
}

interface Mounted {
  /** 假 sessions.list 当前返回的真实快照。 */
  readonly snapshot: { value: SessionsSnapshotLike };
  /** 装配时注册正文传进去的那份 inject（我们的包装产物）。 */
  capturedInject(): (...args: unknown[]) => Record<string, unknown>;
  /** 该会话累计发起的绑定拉取次数。 */
  fetchesFor(sessionId: string): number;
  /** 官方 `start` 收到的每次播种。 */
  starts(): ReadonlyArray<{ tabId: string; root: string }>;
  /** 官方 `load` 收到的每次列目录。 */
  loads(): ReadonlyArray<{ tabId: string; path: string }>;
  /** 调 ctx.effect 收下的 disposer（整包卸载）。 */
  dispose(): void;
}

let active: Mounted | undefined;
const savedFetch = globalThis.fetch;

afterEach(() => {
  active?.dispose();
  active = undefined;
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
  officialStarts.length = 0;
  officialLoads.length = 0;

  // 假座位表复刻官方语义（优先级最低者当值）：没有它，「我们的条目是否当值」这条
  // 自检会判否，装配根会当场退位——用例就会在一条并不存在的失败上变绿。
  const fake = createFakeSlots();
  fake.slots.register(
    { name: BODY_SLOT, key: OFFICIAL_ID, inject: OFFICIAL_BODY.inject },
    OFFICIAL_BODY.component,
  );
  const sidebarRightTabs: TabsPort = {
    get: (kind) => (kind === FILES_KIND ? OFFICIAL_DEFINITION : undefined),
  };

  globalThis.fetch = async (input) => {
    fetchUrls.push(String(input));
    return respond();
  };

  apply({
    slots: fake.slots,
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
    // 我们那条正文的 inject（按遮蔽 priority 认自己）：官方那条被遮蔽，是看不到它的。
    capturedInject: () => {
      const entry = fake
        .entries(BODY_SLOT)
        .find((candidate) => candidate.options.priority === SHADOW_PRIORITY);
      if (entry?.inject === undefined) throw new Error("我们那条正文没有登记上");
      return entry.inject;
    },
    fetchesFor: (sessionId) =>
      fetchUrls.filter((url) => url.endsWith("?session=" + sessionId)).length,
    starts: () => officialStarts.slice(),
    loads: () => officialLoads.slice(),
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

/**
 * 树根播种。这是**换根真正生效**的地方：官方只在 `state === undefined` 时播一次种
 * （sidebar-files/lib/client.js:426-428），刷新按钮也只重列已展开的路径（同文件 :455-458），
 * 所以"绑定后树根自动正确"必须由我们覆盖 `start`/`load` 来保证。
 */
describe("树根播种：只在用户可感知的时机读绑定（没有定时轮询）", () => {
  it("没有页签挂载时一个请求都不发", () => {
    const h = mount(bindingResponse);
    h.capturedInject()(SESSION_ID);
    expect(h.fetchesFor(SESSION_ID)).toBe(0);
  });

  it("打开页签：先读一次绑定，再按生效根播种（而不是首帧的 cwd）", async () => {
    const h = mount(bindingResponse);
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();

    expect(h.fetchesFor(SESSION_ID)).toBe(1);
    expect(h.starts()).toEqual([{ tabId: TAB_ID, root: "/wt" }]);
  });

  it("点刷新（load 命中已播种的根）会重读绑定；worktree 变了就用官方 start 重根", async () => {
    let body: Record<string, unknown> = { revision: 1, worktreePath: "/wt" };
    const h = mount(() => new Response(JSON.stringify(body), { status: 200 }));
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();
    expect(h.starts()).toEqual([{ tabId: TAB_ID, root: "/wt" }]);

    body = { revision: 2, worktreePath: "/wt2" };
    face.load?.(TAB_ID, "/wt");
    await settleMicrotasks();

    expect(h.starts()).toEqual([
      { tabId: TAB_ID, root: "/wt" },
      { tabId: TAB_ID, root: "/wt2" },
    ]);
    // 官方那次 load 仍要发生：我们只补一次重读，不吞掉官方刷新动作。
    expect(h.loads()).toEqual([{ tabId: TAB_ID, path: "/wt" }]);
  });

  it("绑定被摘掉（worktreePath: null）时回退到官方递进来的 cwd", async () => {
    let body: Record<string, unknown> = { revision: 1, worktreePath: "/wt" };
    const h = mount(() => new Response(JSON.stringify(body), { status: 200 }));
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();

    body = { revision: 2, worktreePath: null };
    face.load?.(TAB_ID, "/wt");
    await settleMicrotasks();

    expect(h.starts()).toEqual([
      { tabId: TAB_ID, root: "/wt" },
      { tabId: TAB_ID, root: CWD },
    ]);
  });

  it("展开子目录（load 更深路径）不触发请求，但官方 load 照旧", async () => {
    const h = mount(bindingResponse);
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();
    const before = h.fetchesFor(SESSION_ID);

    face.load?.(TAB_ID, "/wt/sub");
    await settleMicrotasks();

    expect(h.fetchesFor(SESSION_ID)).toBe(before);
    expect(h.loads()).toEqual([{ tabId: TAB_ID, path: "/wt/sub" }]);
  });

  it("页签关闭（abort）后不再为它重读绑定", async () => {
    const h = mount(bindingResponse);
    const face = h.capturedInject()(SESSION_ID) as Face;
    const controller = new AbortController();
    face.start?.(TAB_ID, CWD, controller.signal);
    await settleMicrotasks();
    const before = h.fetchesFor(SESSION_ID);

    controller.abort();
    face.load?.(TAB_ID, "/wt", controller.signal);
    await settleMicrotasks();

    expect(h.fetchesFor(SESSION_ID)).toBe(before);
  });
});

/**
 * 路由字面量哨兵：客户端只认 `src/shared/contract.ts` 的 `ROUTES`（构建期由 bundle-host 注入
 * `__DSH_ROUTES__`）。客户端里任何一处手写 `/api/...` 都会在宿主改路由时静默漂移，
 * 而两端各自的单测都不会红——所以这条扫源码文本，守的是真实的双端 ABI，不是代码风格。
 */
describe("路由单一事实源：客户端没有硬编码路由字面量", () => {
  it("src/client/** 里 /api/ 出现次数为 0", () => {
    const dir = fileURLToPath(new URL("../../src/client", import.meta.url));
    const names = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) =>
      name.endsWith(".ts"),
    );
    // 非空锚：扫描面真的走到了客户端目录（否则下一条断言会因为「一个文件都没扫」而恒真）。
    expect(names).toContain("index.ts");
    const withLiterals = names.filter((name) =>
      readFileSync(join(dir, name), "utf8").includes("/api/"),
    );
    expect(withLiterals).toEqual([]);
  });
});
