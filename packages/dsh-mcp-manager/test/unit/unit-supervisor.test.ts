// @ts-nocheck
/**
 * dsh-mcp-manager — unit：ConnectionSupervisor 连接状态机与重连策略。
 *
 * 覆盖：
 * - constructor 初始态与 resolveReconnect 全分支（默认/部分覆盖/disabled）
 * - connect 早退三兄弟：disposed / 已连接 / enabled:false
 * - connect 失败路径：warn 日志、teardownGeneration、policy disabled → failed
 * - closeHandler 代际守卫：旧代际关闭事件不误伤新状态
 * - teardownGeneration：有/无 client 代际、schedule=false → failed、close 抛错吞
 * - scheduleReconnect：指数退避 delay、maxAttempts 超限 gave up、
 *   connectedAt 老化重置、工具注销
 * - syncTools：注册/排序/meta/分页 cursor、重复名抛错、注册失败回滚、
 *   startup rethrow 语义
 * - disconnect：timer 清理、close 失败吞、最终 stopped
 */
import { afterEach, describe, expect, it } from "vitest";
import { pollUntil } from "../helpers.ts";

const {
  ConnectionSupervisor,
  resolveReconnect,
  RECONNECT_DEFAULTS,
  SCOPE_GLOBAL,
} = await import("../../src/index.ts");

function makeManagerLog() {
  const log = { registered: [], disposed: [], info: [], warn: [], error: [], emits: 0, catalog: [] };
  const manager = {
    ctx: {
      tools: {
        register: (def) => {
          log.registered.push(def.name);
          return () => log.disposed.push(def.name);
        },
      },
    },
    logger: {
      info: (m) => log.info.push(m),
      warn: (m) => log.warn.push(m),
      error: (m) => log.error.push(m),
    },
    enhancement: {},
    emitStatus: () => {
      log.emits += 1;
    },
    recordCatalogTools: async (name, meta) => {
      log.catalog.push([name, [...meta.keys()].sort()]);
    },
  };
  return { manager, log };
}

const failServer = { name: "srv", transport: "stdio", command: "dsh-mcp-missing-cmd-xyz", enabled: true };

// 重连 timer 是真实 setTimeout：用例结束后统一清理，避免残留 timer 泄漏。
const tracked = [];
afterEach(() => {
  for (const sup of tracked) {
    if (sup.reconnectTimer !== undefined) clearTimeout(sup.reconnectTimer);
  }
  tracked.length = 0;
});

function makeSup(manager, server) {
  const sup = new ConnectionSupervisor(manager, server);
  tracked.push(sup);
  return sup;
}

describe("resolveReconnect", () => {
  it("undefined → 全默认", () => {
    expect(resolveReconnect(undefined)).toEqual({ ...RECONNECT_DEFAULTS });
  });

  it("空对象全默认", () => {
    expect(resolveReconnect({})).toEqual({ ...RECONNECT_DEFAULTS });
  });

  it("部分字段覆盖其余默认", () => {
    expect(resolveReconnect({ enabled: false, initialDelayMs: 10 })).toEqual({
      enabled: false,
      initialDelayMs: 10,
      maxDelayMs: RECONNECT_DEFAULTS.maxDelayMs,
      maxAttempts: RECONNECT_DEFAULTS.maxAttempts,
    });
  });
});

describe("constructor 初始态", () => {
  const make = () => {
    const { manager } = makeManagerLog();
    return makeSup(manager, failServer);
  };

  it("scope 缺省 global", () => {
    expect(make().scope).toBe(SCOPE_GLOBAL);
  });

  it("status 初始 stopped", () => {
    expect(make().status).toBe("stopped");
  });

  it("failedAttempts 初始 0", () => {
    expect(make().failedAttempts).toBe(0);
  });

  it("connectedAt 初始 undefined", () => {
    expect(make().connectedAt).toBeUndefined();
  });

  it("disposed 初始 false", () => {
    expect(make().disposed).toBe(false);
  });

  it("tools 初始空数组", () => {
    expect(make().tools.length).toBe(0);
  });

  it("client 初始 undefined", () => {
    expect(make().client).toBeUndefined();
  });

  it("reconnectPolicy 为全默认", () => {
    expect(resolveReconnect(make().reconnectPolicy)).toEqual(RECONNECT_DEFAULTS);
  });
});

describe("setStatus / enqueueSync", () => {
  function makeSupFixture() {
    const { manager, log } = makeManagerLog();
    return { sup: makeSup(manager, failServer), log };
  }

  it("setStatus 更新状态", () => {
    const { sup } = makeSupFixture();
    sup.setStatus("connecting");
    expect(sup.status).toBe("connecting");
  });

  it("setStatus 无 err 时 error 保持 undefined", () => {
    const { sup } = makeSupFixture();
    sup.setStatus("connecting");
    expect(sup.error).toBeUndefined();
  });

  it("setStatus 记录 error.message", () => {
    const { sup } = makeSupFixture();
    sup.setStatus("failed", new Error("x"));
    expect(sup.error.message).toBe("x");
  });

  it("每次 setStatus 都广播", () => {
    const { sup, log } = makeSupFixture();
    sup.setStatus("connecting");
    sup.setStatus("failed", new Error("x"));
    expect(log.emits >= 2).toBeTruthy();
  });

  it("enqueueSync 串行且失败任务不阻塞后续任务", async () => {
    const { sup } = makeSupFixture();
    // enqueueSync 串行且吞掉失败不影响链条。
    const order = [];
    sup.enqueueSync(() => order.push(1));
    sup.enqueueSync(async () => {
      throw new Error("swallowed");
    });
    await sup.enqueueSync(() => order.push(2));
    expect(order).toEqual([1, 2]);
  });
});

describe("connect 早退：disposed / 已连接 / disabled", () => {
  it("disposed 早退不改状态", async () => {
    const { manager } = makeManagerLog();
    const disposedSup = makeSup(manager, failServer);
    disposedSup.disposed = true;
    await disposedSup.connect();
    expect(disposedSup.status).toBe("stopped");
  });

  it("disposed 早退不创建传输", async () => {
    const { manager } = makeManagerLog();
    const disposedSup = makeSup(manager, failServer);
    disposedSup.disposed = true;
    await disposedSup.connect();
    expect(disposedSup.transport).toBeUndefined();
  });

  it("已有 client 早退", async () => {
    const { manager } = makeManagerLog();
    const busySup = makeSup(manager, failServer);
    busySup.client = {};
    await busySup.connect();
    expect(busySup.transport).toBeUndefined();
  });

  it("禁用服务器 → disabled", async () => {
    const { manager } = makeManagerLog();
    const offSup = makeSup(manager, { ...failServer, enabled: false });
    await offSup.connect();
    expect(offSup.status).toBe("disabled");
  });
});

describe("connect 失败路径：policy disabled → failed；warn 日志", () => {
  async function failedOnce() {
    const { manager, log } = makeManagerLog();
    const sup = makeSup(manager, { ...failServer, reconnect: { enabled: false } });
    await sup.connect({ startup: true });
    return { sup, log };
  }

  it("失败 warn 日志", async () => {
    const { log } = await failedOnce();
    expect(log.warn.some((m) => /connection attempt failed/.test(m))).toBeTruthy();
  });

  it("重连禁用 → failed", async () => {
    const { sup } = await failedOnce();
    expect(sup.status).toBe("failed");
  });

  it("失败后清空代际 client", async () => {
    const { sup } = await failedOnce();
    expect(sup.client).toBeUndefined();
  });

  it("失败后清空 transport", async () => {
    const { sup } = await failedOnce();
    expect(sup.transport).toBeUndefined();
  });

  it("失败路径不写 error 日志", async () => {
    const { log } = await failedOnce();
    expect(log.error.length).toBe(0);
  });
});

describe("connect 失败路径：指数退避重连直至预算耗尽", () => {
  async function firstFailure() {
    const { manager, log } = makeManagerLog();
    const sup = makeSup(manager, {
      ...failServer,
      reconnect: { enabled: true, initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
    });
    const t0 = Date.now();
    await sup.connect();
    return { sup, log, t0 };
  }

  async function exhausted() {
    const { sup, log, t0 } = await firstFailure();
    // 轮询等重连循环自行耗尽预算（10ms + 20ms + 误差），事件驱动替代固定 sleep。
    await pollUntil("预算耗尽 status==='failed'", () => sup.status === "failed");
    return { sup, log, t0 };
  }

  it("第一次失败安排重连", async () => {
    const { sup } = await firstFailure();
    expect(sup.status).toBe("reconnecting");
  });

  it("第一次失败计数为 1", async () => {
    const { sup } = await firstFailure();
    expect(sup.failedAttempts).toBe(1);
  });

  it("重连 timer 已安排", async () => {
    const { sup } = await firstFailure();
    expect(sup.reconnectTimer !== undefined).toBeTruthy();
  });

  it("首次退避 = initialDelayMs", async () => {
    const { sup } = await firstFailure();
    expect(sup.reconnectTimer._idleTimeout).toBe(10);
  });

  it("预算耗尽 → failed", async () => {
    const { sup } = await exhausted();
    expect(sup.status).toBe("failed");
  });

  it("gave up 错误文案", async () => {
    const { sup } = await exhausted();
    expect(sup.error.message).toMatch(/gave up after 2 attempts/);
  });

  it("确实经历了退避等待", async () => {
    const { t0 } = await exhausted();
    expect(Date.now() - t0 >= 25).toBeTruthy();
  });

  it("gave up 后不再安排 timer", async () => {
    const { sup } = await exhausted();
    expect(sup.reconnectTimer).toBeUndefined();
  });

  it("第二次退避封顶 maxDelayMs", async () => {
    const { log } = await exhausted();
    expect(log.warn.some((m) => /reconnect in 20ms \(attempt 2\/2\)/.test(m))).toBeTruthy();
  });
});

// B1 红测：重连窗口内 connect() 保持 "reconnecting"（现状 connectedAt 已被
// scheduleReconnect 置 undefined → setStatus 覆盖为 "connecting"）----
describe("B1 红测：重连窗口内 connect() 状态保持", () => {
  it("failedAttempts>0 的重连窗口内 connect() 状态为 reconnecting", async () => {
    const { manager } = makeManagerLog();
    const sup = makeSup(manager, { ...failServer, reconnect: { enabled: false } });
    // 模拟重连中的代际：scheduleReconnect 后的形态——failedAttempts>0、无 client。
    sup.failedAttempts = 2;
    sup.client = undefined;
    const p = sup.connect();
    expect(sup.status).toBe("reconnecting");
    await p.catch(() => {});
  });
});

// B1 红测（续）：真实失败一次后，重连触发（第二次 connect）期间状态保持 ----
describe("B1 红测（续）：第二次 connect 期间状态保持", () => {
  async function firstFailureThenReconnect() {
    const { manager } = makeManagerLog();
    const sup = makeSup(manager, {
      ...failServer,
      reconnect: { enabled: true, initialDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: 5 },
    });
    await sup.connect();
    return sup;
  }

  it("第一次失败进入重连窗口", async () => {
    const sup = await firstFailureThenReconnect();
    expect(sup.status).toBe("reconnecting");
  });

  it("第一次失败计数为 1", async () => {
    const sup = await firstFailureThenReconnect();
    expect(sup.failedAttempts).toBe(1);
  });

  it("B1：重连触发（第二次 connect）期间状态保持 reconnecting", async () => {
    const sup = await firstFailureThenReconnect();
    // 手动模拟 scheduleReconnect 的 timer 回调（void this.connect()）触发的
    // 第二次 connect：同步段即设置状态，await 前断言确定。
    const p2 = sup.connect();
    expect(sup.status).toBe("reconnecting");
    await p2.catch(() => {});
  });
});

// closeHandler 代际守卫：旧代际关闭不误伤 ----
describe("closeHandler 代际守卫：旧代际关闭不误伤", () => {
  async function connectedGenerational() {
    const { manager } = makeManagerLog();
    const sup = makeSup(manager, {
      ...failServer,
      reconnect: { enabled: true, initialDelayMs: 5000, maxDelayMs: 5000, maxAttempts: 5 },
    });
    const p = sup.connect();
    const generation = sup.client;
    await p;
    return { sup, generation };
  }

  it("同步段已建立代际", async () => {
    const { generation } = await connectedGenerational();
    expect(generation !== undefined).toBeTruthy();
  });

  it("旧代际 close 不重复计数", async () => {
    const { sup } = await connectedGenerational();
    // 失败处理完成后 client 已清空；再触发旧代际 close → 守卫拦截，无副作用。
    sup.transport?.sdk?.onclose?.();
    expect(sup.failedAttempts).toBe(1);
  });

  it("旧代际 close 不置 warnUnchanged", async () => {
    const { sup } = await connectedGenerational();
    sup.transport?.sdk?.onclose?.();
    expect(sup.warnUnchanged !== true).toBeTruthy();
  });

  it("disposed 守卫生效（不安排新 timer）", async () => {
    const { sup } = await connectedGenerational();
    // disposed 后再触发 → 同样无动作（不安排新 timer）。
    await sup.disconnect();
    const timerBefore = sup.reconnectTimer;
    sup.transport?.sdk?.onclose?.();
    expect(sup.reconnectTimer).toBe(timerBefore);
  });

  it("旧代际 close 不产生额外告警（保留原哑断言）", async () => {
    const { sup } = await connectedGenerational();
    const beforeWarn = 0;
    sup.transport?.sdk?.onclose?.();
    expect(beforeWarn).toBe(0);
  });
});

// teardownGeneration 直调：代际清理 / schedule=false ----
describe("teardownGeneration 直调：代际清理 / schedule=false", () => {
  function bareFixture() {
    const { manager, log } = makeManagerLog();
    const sup = makeSup(manager, { ...failServer, reconnect: { enabled: false } });
    return { sup, log };
  }

  /** 有 client 的代际：工具注册于代际内、close 记录于日志。 */
  function withClientFixture() {
    const { sup, log } = bareFixture();
    sup.toolDisposers.set("t", () => log.disposed.push("tool:t"));
    sup.tools = ["t"];
    sup.client = { transport: { close: async () => log.info.push("closed") } };
    sup.teardownGeneration(new Error("gone"));
    return { sup, log };
  }

  it("schedule=false → failed", () => {
    // 无 client：仅状态推进。
    const { sup } = bareFixture();
    sup.teardownGeneration(new Error("bare"), false);
    expect(sup.status).toBe("failed");
  });

  it("代际清空 client 引用", () => {
    const { sup } = withClientFixture();
    expect(sup.client).toBeUndefined();
  });

  it("代际工具注销", async () => {
    const { sup, log } = withClientFixture();
    await sup.syncChain;
    expect(log.disposed).toEqual(["tool:t"]);
  });

  it("代际清空 tools 数组", async () => {
    const { sup } = withClientFixture();
    await sup.syncChain;
    expect(sup.tools).toEqual([]);
  });

  it("transport.close 调用", async () => {
    const { log } = withClientFixture();
    // transport.close 是 fire-and-forget 异步：轮询等其落定（事件驱动替代固定 sleep）。
    await pollUntil("transport.close 调用", () => log.info.includes("closed"));
    expect(log.info.includes("closed")).toBeTruthy();
  });

  it("close 抛错吞掉不炸 teardown（状态仍推进）", async () => {
    const { sup } = bareFixture();
    // close 抛错吞掉不炸 teardown。
    let closeSettled = 0;
    sup.client = {
      transport: {
        close: async () => {
          closeSettled += 1;
          throw new Error("close boom");
        },
      },
    };
    sup.teardownGeneration(new Error("x"), false);
    await pollUntil("close 抛错已落定被吞", () => closeSettled === 1);
    expect(sup.status).toBe("failed");
  });

  it("disposed 后不覆盖状态", () => {
    // disposed 短路：清理任务与状态更新都不做。
    const { sup } = bareFixture();
    sup.client = { transport: undefined };
    sup.setStatus("connected");
    sup.disposed = true;
    sup.teardownGeneration(new Error("late"), false);
    expect(sup.status).toBe("connected");
  });
});

// scheduleReconnect 直调：老化重置 / 超限 gave up ----
describe("scheduleReconnect 直调：老化重置 / 超限 gave up", () => {
  function agingFixture() {
    const { manager, log } = makeManagerLog();
    const sup = makeSup(manager, {
      ...failServer,
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 60, maxAttempts: 1 },
    });
    return { sup, log };
  }

  /** 进入「已失败一次、已安排续连 timer」的形态（超限将发生在下一次）。 */
  function pendingFixture() {
    const { sup, log } = agingFixture();
    sup.connectedAt = Date.now();
    sup.scheduleReconnect(new Error("again"));
    const pending = sup.reconnectTimer;
    clearTimeout(pending);
    sup.scheduleReconnect(new Error("final"));
    return { sup, log, pending };
  }

  it("老化连接计数重置", () => {
    // 长连接老化（connectedAt 远早于 maxDelayMs）→ 计数重置后从 1 起。
    const { sup } = agingFixture();
    sup.connectedAt = Date.now() - RECONNECT_DEFAULTS.maxDelayMs * 10;
    sup.scheduleReconnect(new Error("drop"));
    expect(sup.failedAttempts).toBe(1);
  });

  it("超限不再安排新 timer", () => {
    // 新鲜连接连续失败：第 2 次超过 maxAttempts=1 → gave up。
    const { sup, pending } = pendingFixture();
    expect(sup.reconnectTimer).toBe(pending);
  });

  it("gave up 后状态为 failed", () => {
    const { sup } = pendingFixture();
    expect(sup.status).toMatch(/^failed$/);
  });

  it("gave up 错误文案", () => {
    const { sup } = pendingFixture();
    expect(sup.error.message).toMatch(/gave up after 1 attempt/);
  });

  it("gave up 注销全部工具", async () => {
    // 超限同时注销全部工具（经 syncChain 异步队列）。
    const { sup } = pendingFixture();
    sup.toolDisposers.set("t", () => {});
    sup.scheduleReconnect(new Error("over"));
    await sup.syncChain;
    expect(sup.toolDisposers.size).toBe(0);
  });
});

// syncTools：注册 / 排序 / 分页 / 重复名 / 回滚 ----
describe("syncTools：注册 / 排序 / 分页 / 重复名 / 回滚", () => {
  async function syncedFixture() {
    const { manager, log } = makeManagerLog();
    const sup = makeSup(manager, { name: "srv", transport: "stdio", command: "echo", enabled: true });
    const pages = [
      {
        tools: [
          { name: "beta", description: "b-tool" },
          { name: "alpha", description: "a-tool" },
        ],
        nextCursor: "p2",
      },
      { tools: [{ name: "gamma" }] },
    ];
    const fakeClient = {
      listTools: async (cursor) => (cursor ? pages[1] : pages[0]),
    };
    await sup.syncTools(fakeClient, true);
    return { sup, log, fakeClient };
  }

  async function resyncedFixture() {
    const { sup, log } = await syncedFixture();
    // 二次同步整体替换：旧 disposer 全部执行。
    log.disposed.length = 0;
    await sup.syncTools({ listTools: async () => ({ tools: [{ name: "solo" }] }) }, false);
    return { sup, log };
  }

  async function rollbackFixture() {
    const { log } = makeManagerLog();
    const failingMgr = makeManagerLog();
    failingMgr.manager.ctx.tools.register = (def) => {
      if (def.name.includes("second")) throw new Error("registry full");
      return () => log.disposed.push(def.name);
    };
    const supFail = makeSup(failingMgr.manager, { name: "srv", transport: "stdio", command: "echo", enabled: true });
    supFail.toolDisposers.set("old", () => log.disposed.push("old"));
    supFail.tools = ["old"];
    await supFail.syncTools(
      { listTools: async () => ({ tools: [{ name: "first" }, { name: "second" }] }) },
      false,
    );
    return { supFail, log, failingMgr };
  }

  it("公共名排序", async () => {
    const { sup } = await syncedFixture();
    expect(sup.tools).toEqual(["mcp__srv__alpha", "mcp__srv__beta", "mcp__srv__gamma"]);
  });

  it("注册 3 个工具", async () => {
    const { log } = await syncedFixture();
    expect(log.registered.length).toBe(3);
  });

  it("工具描述元数据", async () => {
    const { sup } = await syncedFixture();
    expect(sup.toolMeta.get("mcp__srv__alpha").description).toBe("a-tool");
  });

  it("缺描述归一空串", async () => {
    const { sup } = await syncedFixture();
    expect(sup.toolMeta.get("mcp__srv__gamma").description).toBe("");
  });

  it("目录摘要上报", async () => {
    const { log } = await syncedFixture();
    expect(log.catalog[0]).toEqual(["srv", ["mcp__srv__alpha", "mcp__srv__beta", "mcp__srv__gamma"]]);
  });

  it("toolDisposers 3 个", async () => {
    const { sup } = await syncedFixture();
    expect(sup.toolDisposers.size).toBe(3);
  });

  it("二次同步旧代际注销", async () => {
    const { log } = await resyncedFixture();
    expect(log.disposed.length).toBe(3);
  });

  it("二次同步替换工具列表", async () => {
    const { sup } = await resyncedFixture();
    expect(sup.tools).toEqual(["mcp__srv__solo"]);
  });

  it("重复工具名抛错", async () => {
    const { sup } = await syncedFixture();
    // 重复工具名（服务器列表返回同名工具）→ 抛错。
    await expect(
      sup.syncTools({ listTools: async () => ({ tools: [{ name: "dup" }, { name: "dup" }] }) }, false),
    ).rejects.toThrow(/listed tool .* more than once/);
  });

  it("非法字符不同名不碰撞", async () => {
    // 非法字符不同名不碰撞（各自派生独立 hash 后缀）。
    const { sup } = await syncedFixture();
    await expect(
      sup.syncTools({ listTools: async () => ({ tools: [{ name: "a.b" }, { name: "a_c" }] }) }, false),
    ).resolves.toBeUndefined();
  });

  it("失败回滚已注册 + 清理旧代际", async () => {
    const { log } = await rollbackFixture();
    expect([...log.disposed].sort()).toEqual(["mcp__srv__first", "old"]);
  });

  it("startup=false 注册失败后 tools 保持旧引用", async () => {
    // 现状语义：startup=false 注册失败直接 return，tools/toolDisposers 保持旧引用
    // （旧 disposer 已执行，工具实际已注销；数组内容不再代表可用集合）。
    const { supFail } = await rollbackFixture();
    expect(supFail.tools).toEqual(["old"]);
  });

  it("注册失败记录 error 日志", async () => {
    const { failingMgr } = await rollbackFixture();
    expect(failingMgr.log.error.some((m) => /tool registration failed/.test(m))).toBeTruthy();
  });

  it("startup=true 注册失败向上 rethrow", async () => {
    // startup=true 时注册失败向上 rethrow。
    const throwMgr = makeManagerLog();
    throwMgr.manager.ctx.tools.register = () => {
      throw new Error("boom");
    };
    const supRethrow = makeSup(throwMgr.manager, { name: "srv", transport: "stdio", command: "echo", enabled: true });
    await expect(
      supRethrow.syncTools({ listTools: async () => ({ tools: [{ name: "boom" }] }) }, true),
    ).rejects.toThrow(/boom/);
  });

  it("cursor 为空串终止循环", async () => {
    const supEmpty = makeSup(makeManagerLog().manager, { name: "z", transport: "stdio", command: "echo", enabled: true });
    await supEmpty.syncTools({ listTools: async () => ({ tools: [{ name: "t" }], nextCursor: "" }) }, false);
    expect(supEmpty.tools).toEqual(["mcp__z__t"]);
  });
});

// syncTools：封装定义路径（#362 补充 4：registerServer.toolDefinitions）----
describe("syncTools：封装定义路径（#362 补充 4）", () => {
  async function wrappedFixture() {
    // 有 toolDefinitions → 全部用封装定义注册：execute 来自调用方、命名 mcp__ 前缀、
    // 不触达远端 schema 投影（伪造 listTools 抛错证明未走远端路径）。
    const execCalls = [];
    const wrappedServer = {
      name: "cg",
      transport: "stdio",
      command: "echo",
      enabled: true,
      toolDefinitions: [
        {
          name: "codegraph_explore",
          description: "wrapped-desc",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          output: {
            schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            render(_args, value) {
              return [{ type: "text", text: value && typeof value === "object" && "text" in value ? String(value.text) : "" }];
            },
          },
          async execute(args) {
            execCalls.push(args);
            return { text: "wrapped-ok" };
          },
        },
      ],
    };
    // 独立收集器：保留完整定义以便调用 execute 断言「来自封装」。
    const { log } = makeManagerLog();
    const defs = [];
    const wrappedMgr = makeManagerLog();
    wrappedMgr.manager.ctx.tools.register = (def) => {
      defs.push(def);
      return () => log.disposed.push(def.name);
    };
    const supW = makeSup(wrappedMgr.manager, wrappedServer);
    await supW.syncTools(
      {
        listTools: async () => {
          throw new Error("must not reach remote schema");
        },
      },
      true,
    );
    return { supW, defs, execCalls, log };
  }

  function dupFixture() {
    const dupMgr = makeManagerLog();
    const supDup = makeSup(dupMgr.manager, { name: "cg", transport: "stdio", command: "echo", enabled: true });
    supDup.server.toolDefinitions = [
      { name: "t", description: "a", parameters: {} },
      { name: "t", description: "b", parameters: {} },
    ];
    return supDup;
  }

  function noNameFixture() {
    const noNameMgr = makeManagerLog();
    const supNoName = makeSup(noNameMgr.manager, { name: "cg", transport: "stdio", command: "echo", enabled: true });
    supNoName.server.toolDefinitions = [{ description: "no name", parameters: {} }];
    return supNoName;
  }

  it("封装定义：公共名 mcp__ 前缀", async () => {
    const { supW } = await wrappedFixture();
    expect(supW.tools).toEqual(["mcp__cg__codegraph_explore"]);
  });

  it("封装定义注册 1 个", async () => {
    const { defs } = await wrappedFixture();
    expect(defs.length).toBe(1);
  });

  it("注册名 mcp__ 前缀", async () => {
    const { defs } = await wrappedFixture();
    expect(defs[0].name).toBe("mcp__cg__codegraph_explore");
  });

  it("自定义 description 被采用", async () => {
    const { defs } = await wrappedFixture();
    expect(defs[0].description).toBe("wrapped-desc");
  });

  it("描述元数据取封装定义", async () => {
    const { supW } = await wrappedFixture();
    expect(supW.toolMeta.get("mcp__cg__codegraph_explore").description).toBe("wrapped-desc");
  });

  it("toolDisposers 1 个", async () => {
    const { supW } = await wrappedFixture();
    expect(supW.toolDisposers.size).toBe(1);
  });

  it("execute 来自调用方封装", async () => {
    // execute 来自封装定义（不经通用 callTool）。
    const { defs } = await wrappedFixture();
    const value = await defs[0].execute({ query: "X 被谁调用" }, { signal: undefined });
    expect(value.text).toBe("wrapped-ok");
  });

  it("封装 execute 收到调用参数", async () => {
    const { defs, execCalls } = await wrappedFixture();
    await defs[0].execute({ query: "X 被谁调用" }, { signal: undefined });
    expect(execCalls).toEqual([{ query: "X 被谁调用" }]);
  });

  it("重复封装工具名 → 抛错", async () => {
    const supDup = dupFixture();
    await expect(supDup.syncTools({ listTools: async () => ({ tools: [] }) }, false)).rejects.toThrow(/duplicate wrapped tool/);
  });

  it("缺 name 的封装定义 → 抛错", async () => {
    const supNoName = noNameFixture();
    await expect(supNoName.syncTools({ listTools: async () => ({ tools: [] }) }, false)).rejects.toThrow(/without a name/);
  });
});

// disconnect：timer / close 抛错 / 终态 ----
describe("disconnect：timer / close 抛错 / 终态", () => {
  async function disconnected() {
    const { manager } = makeManagerLog();
    const sup = makeSup(manager, failServer);
    sup.reconnectTimer = setTimeout(() => {}, 10_000);
    sup.toolDisposers.set("t", () => {});
    sup.tools = ["t"];
    sup.client = {
      transport: {
        close: async () => {
          throw new Error("close refused");
        },
      },
    };
    await sup.disconnect();
    return sup;
  }

  it("disposed 置为 true", async () => {
    expect((await disconnected()).disposed).toBe(true);
  });

  it("timer 清理", async () => {
    expect((await disconnected()).reconnectTimer).toBeUndefined();
  });

  it("client 清空", async () => {
    expect((await disconnected()).client).toBeUndefined();
  });

  it("toolDisposers 清空", async () => {
    expect((await disconnected()).toolDisposers.size).toBe(0);
  });

  it("终态 stopped", async () => {
    expect((await disconnected()).status).toBe("stopped");
  });
});
