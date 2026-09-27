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
  ObservablePort,
  SessionsSnapshotLike,
  TabDefinitionLike,
  TabsPort,
} from "../../src/client/shared/ports.ts";
import { createFakeSlots } from "../helpers.ts";
import { BODY_SLOT, FILES_KIND } from "../../src/client/takeover.ts";

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

/** 排空在飞的微任务链：`start` 之后还有一次异步的绑定读取与纠正播种。 */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 官方 root（官方正文递进来的 cwd）那一次播种：改用例时读起来比裸 CWD 常量清楚。 */
const OFFICIAL_SEED = { tabId: TAB_ID, root: CWD };

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
function mount(respond: () => Response | Promise<Response>): Mounted {
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
    // 我们那条正文的 inject：认自己不能靠一个常量（priority 是按官方那条算出来的），
    // 但官方那条在夹具里**没有声明 priority**，所以「有 priority 的那条」就是我们。
    capturedInject: () => {
      const entry = fake
        .entries(BODY_SLOT)
        .find((candidate) => candidate.options.priority !== undefined);
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

  it("打开页签：先按官方 cwd 播种，绑定到达后再纠正到生效根（首帧不空白）", async () => {
    const h = mount(bindingResponse);
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();

    expect(h.fetchesFor(SESSION_ID)).toBe(1);
    expect(h.starts()).toEqual([OFFICIAL_SEED, { tabId: TAB_ID, root: "/wt" }]);
  });

  it("查询参数完整编码会话标识，并声明 JSON 响应类型", async () => {
    const requests: Array<{ url: string; accept: string | null }> = [];
    const h = mount(bindingResponse);
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), accept: new Headers(init?.headers).get("accept") });
      return bindingResponse();
    };
    const face = h.capturedInject()("会话 /?&=+#") as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();
    expect(requests).toEqual([
      {
        url: "/api/dsh-worktree-sidebar/bindings?session=%E4%BC%9A%E8%AF%9D%20%2F%3F%26%3D%2B%23",
        accept: "application/json",
      },
    ]);
  });

  it.each([
    [
      "invalid revision",
      () => new Response(JSON.stringify({ revision: "2", worktreePath: "/other" })),
    ],
    ["invalid JSON", () => new Response("not-json")],
    ["network rejection", () => Promise.reject(new Error("offline"))],
  ])("%s 保留上次已确认的根", async (_name, failure) => {
    let calls = 0;
    const h = mount(() => (++calls === 1 ? bindingResponse() : failure()));
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();
    expect(h.starts()).toEqual([OFFICIAL_SEED, { tabId: TAB_ID, root: "/wt" }]);
    face.load?.(TAB_ID, "/wt");
    await settleMicrotasks();
    expect(h.starts()).toEqual([OFFICIAL_SEED, { tabId: TAB_ID, root: "/wt" }]);
  });

  it("绑定查询永不返回时，官方那一帧照播（树不会一直空白）", async () => {
    // 端点慢/挂起时，官方正文的 state 会停在 undefined 并渲染 null；把首帧挂在这次 fetch 上，
    // 等于让**所有会话**（含从未登记的）的 Files 树一起空白。所以必须先播官方 root。
    const h = mount(() => new Promise<Response>(() => undefined));
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();

    expect(h.starts()).toEqual([OFFICIAL_SEED]);
  });

  it("拉取失败保持上次成功态：HTTP 失败不等于「没有绑定」", async () => {
    let status = 200;
    const h = mount(() =>
      status === 200 ? bindingResponse() : new Response(null, { status: 500 }),
    );
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();
    expect(h.starts()).toEqual([OFFICIAL_SEED, { tabId: TAB_ID, root: "/wt" }]);

    status = 500;
    face.load?.(TAB_ID, "/wt");
    await settleMicrotasks();

    // 失败被当成「未绑定」的话，这里会多出一次回退到 cwd 的播种——那正是「看错地方」。
    expect(h.starts()).toEqual([OFFICIAL_SEED, { tabId: TAB_ID, root: "/wt" }]);
  });

  it("乱序返回：更早发出的请求带着更小 revision 后到时不回退快照", async () => {
    const gates: Array<(response: Response) => void> = [];
    const h = mount(() => new Promise<Response>((resolve) => gates.push(resolve)));
    const face = h.capturedInject()(SESSION_ID) as Face;

    face.start?.(TAB_ID, CWD); // 请求 1
    await settleMicrotasks();
    face.load?.(TAB_ID, CWD); // 请求 2（官方刷新那一跳）
    await settleMicrotasks();
    expect(gates.length).toBe(2);

    // 新的先回（revision 2 /new）→ 播种 /new
    gates[1]?.(
      new Response(JSON.stringify({ revision: 2, worktreePath: "/new" }), { status: 200 }),
    );
    await settleMicrotasks();
    expect(h.starts()).toEqual([OFFICIAL_SEED, { tabId: TAB_ID, root: "/new" }]);

    // 旧的后回（revision 1 /old）→ 必须被丢掉，否则快照与树根一起回退
    gates[0]?.(
      new Response(JSON.stringify({ revision: 1, worktreePath: "/old" }), { status: 200 }),
    );
    await settleMicrotasks();
    expect(h.starts()).toEqual([OFFICIAL_SEED, { tabId: TAB_ID, root: "/new" }]);
  });

  it("点刷新（load 命中已播种的根）会重读绑定；worktree 变了就用官方 start 重根", async () => {
    let body: Record<string, unknown> = { revision: 1, worktreePath: "/wt" };
    const h = mount(() => new Response(JSON.stringify(body), { status: 200 }));
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();
    expect(h.starts()).toEqual([OFFICIAL_SEED, { tabId: TAB_ID, root: "/wt" }]);

    body = { revision: 2, worktreePath: "/wt2" };
    face.load?.(TAB_ID, "/wt");
    await settleMicrotasks();

    expect(h.starts()).toEqual([
      OFFICIAL_SEED,
      { tabId: TAB_ID, root: "/wt" },
      { tabId: TAB_ID, root: "/wt2" },
    ]);
    // 官方那次 load 仍要发生：我们只补一次重读，不吞掉官方刷新动作。
    expect(h.loads()).toEqual([{ tabId: TAB_ID, path: "/wt" }]);
  });

  it("绑定变了但生效根没变：不重播官方 start（官方每次 start 都会再加一个 abort 监听）", async () => {
    let body: Record<string, unknown> = { revision: 1, worktreePath: "/wt" };
    const h = mount(() => new Response(JSON.stringify(body), { status: 200 }));
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();

    // revision 涨了、路径没变：状态会通知，但根没变，因此不该再调一次官方 start。
    body = { revision: 2, worktreePath: "/wt" };
    face.load?.(TAB_ID, "/wt");
    await settleMicrotasks();

    expect(h.starts()).toEqual([OFFICIAL_SEED, { tabId: TAB_ID, root: "/wt" }]);
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
      OFFICIAL_SEED,
      { tabId: TAB_ID, root: "/wt" },
      { tabId: TAB_ID, root: CWD },
    ]);
  });

  it("信号在 start 之前就已 abort：不再为它重播（reseed 的 aborted 跳过）", async () => {
    let body: Record<string, unknown> = { revision: 1, worktreePath: "/wt" };
    const h = mount(() => new Response(JSON.stringify(body), { status: 200 }));
    const face = h.capturedInject()(SESSION_ID) as Face;
    const controller = new AbortController();
    controller.abort();
    face.start?.(TAB_ID, CWD, controller.signal);
    await settleMicrotasks();
    const before = h.starts().length;
    // 刷新那一跳认的是「最近播种进去的根」：用实际播过的根去触发，免得判据依赖某个固定字符串。
    const seeded = h.starts().at(-1)?.root ?? CWD;

    // 已经 abort 的信号不会再触发 abort 事件，页签因此留在 watched 里；
    // 重播时的 aborted 判断就是它不把树重设到一个已经关掉的页签上的唯一闸门。
    body = { revision: 2, worktreePath: "/wt2" };
    face.load?.(TAB_ID, seeded, controller.signal);
    await settleMicrotasks();

    expect(h.starts().length).toBe(before);
  });

  it("没有 signal 的播种面在整包卸载时被收口：卸载后绑定变化不再重播", async () => {
    // 官方界面包现在总是把页签 signal 传进来，但那是它的实现细节：没有 signal 时
    // 「最后一个页签 abort」永远不会发生，watched 与两条订阅会一直挂在单例座位注册表上。
    let body: Record<string, unknown> = { revision: 1, worktreePath: "/wt" };
    const h = mount(() => new Response(JSON.stringify(body), { status: 200 }));
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    await settleMicrotasks();
    const before = h.starts().length;

    h.dispose();
    body = { revision: 2, worktreePath: "/wt2" };
    face.load?.(TAB_ID, "/wt");
    await settleMicrotasks();

    expect(h.starts().length).toBe(before);
  });

  it("卸载时仍在等待的绑定响应到达后，不再调用官方 start", async () => {
    let resolveBinding!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveBinding = resolve;
    });
    const h = mount(() => pending);
    const face = h.capturedInject()(SESSION_ID) as Face;
    face.start?.(TAB_ID, CWD);
    expect(h.starts()).toEqual([OFFICIAL_SEED]);

    h.dispose();
    resolveBinding(bindingResponse());
    await settleMicrotasks();

    expect(h.starts()).toEqual([OFFICIAL_SEED]);
  });

  it("视图缓存有上限：最冷的会话被淘汰，仍然在缓存的会话引用稳定", () => {
    const h = mount(bindingResponse);
    const inject = h.capturedInject();
    const sourceOf = (sessionId: string): ObservablePort<SessionsSnapshotLike> =>
      (inject(sessionId)["hooks"] as { sessions: ObservablePort<SessionsSnapshotLike> }).sessions;

    const cold = sourceOf("s-cold");
    for (let i = 0; i < 200; i += 1) sourceOf("s-" + i);

    // 被挤出缓存之后重建：同一个 id 拿到的是另一套状态（它自己仍会读同一份宿主事实）。
    expect(sourceOf("s-cold")).not.toBe(cold);
    // 缓存内的会话仍然恒回同一对象（渲染层按源缓存订阅，换了对象会被当成状态一直在变）。
    const hot = sourceOf("s-hot");
    expect(sourceOf("s-hot")).toBe(hot);
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
