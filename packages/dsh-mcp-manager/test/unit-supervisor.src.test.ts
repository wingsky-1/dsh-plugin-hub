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
import assert from "node:assert/strict";
import { pollUntil } from "./helpers.ts";

const {
  ConnectionSupervisor,
  resolveReconnect,
  RECONNECT_DEFAULTS,
  SCOPE_GLOBAL,
} = await import("../src/index.ts");

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

// ---- resolveReconnect ----

{
  assert.deepEqual(resolveReconnect(undefined), { ...RECONNECT_DEFAULTS });
  assert.deepEqual(resolveReconnect({}), { ...RECONNECT_DEFAULTS }, "空对象全默认");
  assert.deepEqual(
    resolveReconnect({ enabled: false, initialDelayMs: 10 }),
    { enabled: false, initialDelayMs: 10, maxDelayMs: RECONNECT_DEFAULTS.maxDelayMs, maxAttempts: RECONNECT_DEFAULTS.maxAttempts },
    "部分字段覆盖其余默认",
  );
}

// ---- constructor 初始态 ----

{
  const { manager } = makeManagerLog();
  const sup = new ConnectionSupervisor(manager, failServer);
  assert.equal(sup.scope, SCOPE_GLOBAL, "scope 缺省 global");
  assert.equal(sup.status, "stopped");
  assert.equal(sup.failedAttempts, 0);
  assert.equal(sup.connectedAt, undefined);
  assert.equal(sup.disposed, false);
  assert.equal(sup.tools.length, 0);
  assert.equal(sup.client, undefined);
  assert.deepEqual(resolveReconnect(sup.reconnectPolicy), RECONNECT_DEFAULTS);
}

// ---- setStatus / enqueueSync ----

{
  const { manager, log } = makeManagerLog();
  const sup = new ConnectionSupervisor(manager, failServer);
  sup.setStatus("connecting");
  assert.equal(sup.status, "connecting");
  assert.equal(sup.error, undefined);
  sup.setStatus("failed", new Error("x"));
  assert.equal(sup.error.message, "x");
  assert.ok(log.emits >= 2, "每次 setStatus 都广播");

  // enqueueSync 串行且吞掉失败不影响链条。
  const order = [];
  sup.enqueueSync(() => order.push(1));
  sup.enqueueSync(async () => {
    throw new Error("swallowed");
  });
  await sup.enqueueSync(() => order.push(2));
  assert.deepEqual(order, [1, 2], "失败任务不阻塞后续任务");
}

// ---- connect 早退：disposed / 已连接 / disabled ----

{
  const { manager } = makeManagerLog();

  const disposedSup = new ConnectionSupervisor(manager, failServer);
  disposedSup.disposed = true;
  await disposedSup.connect();
  assert.equal(disposedSup.status, "stopped", "disposed 早退不改状态");
  assert.equal(disposedSup.transport, undefined, "disposed 早退不创建传输");

  const busySup = new ConnectionSupervisor(manager, failServer);
  busySup.client = {};
  await busySup.connect();
  assert.equal(busySup.transport, undefined, "已有 client 早退");

  const offSup = new ConnectionSupervisor(manager, { ...failServer, enabled: false });
  await offSup.connect();
  assert.equal(offSup.status, "disabled", "禁用服务器 → disabled");
}

// ---- connect 失败路径：policy disabled → failed；warn 日志 ----

{
  const { manager, log } = makeManagerLog();
  const sup = new ConnectionSupervisor(manager, { ...failServer, reconnect: { enabled: false } });
  await sup.connect({ startup: true });
  assert.ok(log.warn.some((m) => /connection attempt failed/.test(m)), "失败 warn 日志");
  assert.equal(sup.status, "failed", "重连禁用 → failed");
  assert.equal(sup.client, undefined, "失败后清空代际");
  assert.equal(sup.transport, undefined);
  assert.ok(log.error.length === 0);
}

// ---- connect 失败路径：指数退避重连直至预算耗尽 ----

{
  const { manager, log } = makeManagerLog();
  const sup = new ConnectionSupervisor(manager, {
    ...failServer,
    reconnect: { enabled: true, initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
  });
  const t0 = Date.now();
  await sup.connect();
  assert.equal(sup.status, "reconnecting", "第一次失败安排重连");
  assert.equal(sup.failedAttempts, 1);
  assert.ok(sup.reconnectTimer !== undefined, "重连 timer 已安排");
  assert.equal(sup.reconnectTimer._idleTimeout, 10, "首次退避 = initialDelayMs");

  // 轮询等重连循环自行耗尽预算（10ms + 20ms + 误差），事件驱动替代固定 sleep。
  await pollUntil("预算耗尽 status==='failed'", () => sup.status === "failed");
  assert.equal(sup.status, "failed", "预算耗尽 → failed");
  assert.match(sup.error.message, /gave up after 2 attempts/);
  assert.ok(Date.now() - t0 >= 25, "确实经历了退避等待");
  assert.equal(sup.reconnectTimer, undefined, "gave up 后不再安排 timer");
  assert.ok(log.warn.some((m) => /reconnect in 20ms \(attempt 2\/2\)/.test(m)), "第二次退避封顶 maxDelayMs");
  // 清理可能残留 timer（防御）。
  if (sup.reconnectTimer !== undefined) clearTimeout(sup.reconnectTimer);
}

// ---- closeHandler 代际守卫：旧代际关闭不误伤 ----

{
  const { manager } = makeManagerLog();
  const sup = new ConnectionSupervisor(manager, {
    ...failServer,
    reconnect: { enabled: true, initialDelayMs: 5000, maxDelayMs: 5000, maxAttempts: 5 },
  });
  const p = sup.connect();
  const generation = sup.client;
  assert.ok(generation !== undefined, "同步段已建立代际");
  await p;

  // 失败处理完成后 client 已清空；再触发旧代际 close → 守卫拦截，无副作用。
  const beforeWarn = 0;
  sup.transport?.sdk?.onclose?.();
  assert.equal(sup.failedAttempts, 1, "旧代际 close 不重复计数");
  assert.ok(sup.warnUnchanged !== true);

  // disposed 后再触发 → 同样无动作（不安排新 timer）。
  await sup.disconnect();
  const timerBefore = sup.reconnectTimer;
  sup.transport?.sdk?.onclose?.();
  assert.equal(sup.reconnectTimer, timerBefore, "disposed 守卫生效");
  assert.equal(beforeWarn, 0);
}

// ---- teardownGeneration 直调：代际清理 / schedule=false ----

{
  const { manager, log } = makeManagerLog();
  const sup = new ConnectionSupervisor(manager, { ...failServer, reconnect: { enabled: false } });

  // 无 client：仅状态推进。
  sup.teardownGeneration(new Error("bare"), false);
  assert.equal(sup.status, "failed", "schedule=false → failed");

  // 有 client：注销工具、清空引用、close 被调用。
  sup.toolDisposers.set("t", () => log.disposed.push("tool:t"));
  sup.tools = ["t"];
  sup.client = { transport: { close: async () => log.info.push("closed") } };
  sup.teardownGeneration(new Error("gone"));
  assert.equal(sup.client, undefined);
  await sup.syncChain;
  assert.deepEqual(log.disposed, ["tool:t"], "代际工具注销");
  assert.deepEqual(sup.tools, []);
  // transport.close 是 fire-and-forget 异步：轮询等其落定（事件驱动替代固定 sleep）。
  await pollUntil("transport.close 调用", () => log.info.includes("closed"));
  assert.ok(log.info.includes("closed"), "transport.close 调用");

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
  assert.equal(sup.status, "failed");

  // disposed 短路：清理任务与状态更新都不做。
  sup.client = { transport: undefined };
  sup.setStatus("connected");
  sup.disposed = true;
  sup.teardownGeneration(new Error("late"), false);
  assert.equal(sup.status, "connected", "disposed 后不覆盖状态");
  sup.disposed = false;
}

// ---- scheduleReconnect 直调：老化重置 / 超限 gave up ----

{
  const { manager, log } = makeManagerLog();
  const sup = new ConnectionSupervisor(manager, {
    ...failServer,
    reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 60, maxAttempts: 1 },
  });

  // 长连接老化（connectedAt 远早于 maxDelayMs）→ 计数重置后从 1 起。
  sup.connectedAt = Date.now() - RECONNECT_DEFAULTS.maxDelayMs * 10;
  sup.scheduleReconnect(new Error("drop"));
  assert.equal(sup.failedAttempts, 1, "老化连接计数重置");
  clearTimeout(sup.reconnectTimer);

  // 新鲜连接连续失败：第 2 次超过 maxAttempts=1 → gave up。
  sup.connectedAt = Date.now();
  sup.scheduleReconnect(new Error("again"));
  const pending = sup.reconnectTimer;
  clearTimeout(pending);
  sup.scheduleReconnect(new Error("final"));
  assert.equal(sup.reconnectTimer, pending, "超限不再安排新 timer");
  assert.match(sup.status, /^failed$/);
  assert.match(sup.error.message, /gave up after 1 attempt/);

  // 超限同时注销全部工具（经 syncChain 异步队列）。
  sup.toolDisposers.set("t", () => {});
  sup.scheduleReconnect(new Error("over"));
  await sup.syncChain;
  assert.equal(sup.toolDisposers.size, 0, "gave up 注销工具");
}

// ---- syncTools：注册 / 排序 / 分页 / 重复名 / 回滚 ----

{
  const { manager, log } = makeManagerLog();
  const sup = new ConnectionSupervisor(manager, { name: "srv", transport: "stdio", command: "echo", enabled: true });
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
  assert.deepEqual(sup.tools, ["mcp__srv__alpha", "mcp__srv__beta", "mcp__srv__gamma"], "公共名排序");
  assert.equal(log.registered.length, 3);
  assert.equal(sup.toolMeta.get("mcp__srv__alpha").description, "a-tool");
  assert.equal(sup.toolMeta.get("mcp__srv__gamma").description, "", "缺描述归一空串");
  assert.deepEqual(log.catalog[0], ["srv", ["mcp__srv__alpha", "mcp__srv__beta", "mcp__srv__gamma"]], "目录摘要上报");
  assert.equal(sup.toolDisposers.size, 3);

  // 二次同步整体替换：旧 disposer 全部执行。
  log.disposed.length = 0;
  await sup.syncTools({ listTools: async () => ({ tools: [{ name: "solo" }] }) }, false);
  assert.equal(log.disposed.length, 3, "旧代际注销");
  assert.deepEqual(sup.tools, ["mcp__srv__solo"]);

  // 重复工具名（服务器列表返回同名工具）→ 抛错。
  await assert.rejects(
    () => sup.syncTools({ listTools: async () => ({ tools: [{ name: "dup" }, { name: "dup" }] }) }, false),
    /listed tool .* more than once/,
  );
  // 非法字符不同名不碰撞（各自派生独立 hash 后缀）。
  await sup.syncTools({ listTools: async () => ({ tools: [{ name: "a.b" }, { name: "a_c" }] }) }, false);

  // 注册中途抛错 → 已注册的回滚；startup=false 吞掉并保持空工具集。
  log.disposed.length = 0;
  const failingMgr = makeManagerLog();
  failingMgr.manager.ctx.tools.register = (def) => {
    if (def.name.includes("second")) throw new Error("registry full");
    return () => log.disposed.push(def.name);
  };
  const supFail = new ConnectionSupervisor(failingMgr.manager, { name: "srv", transport: "stdio", command: "echo", enabled: true });
  supFail.toolDisposers.set("old", () => log.disposed.push("old"));
  supFail.tools = ["old"];
  await supFail.syncTools(
    { listTools: async () => ({ tools: [{ name: "first" }, { name: "second" }] }) },
    false,
  );
  assert.deepEqual([...log.disposed].sort(), ["mcp__srv__first", "old"], "失败回滚已注册 + 清理旧代际");
  // 现状语义：startup=false 注册失败直接 return，tools/toolDisposers 保持旧引用
  // （旧 disposer 已执行，工具实际已注销；数组内容不再代表可用集合）。
  assert.deepEqual(supFail.tools, ["old"]);
  assert.ok(failingMgr.log.error.some((m) => /tool registration failed/.test(m)));

  // startup=true 时注册失败向上 rethrow。
  const throwMgr = makeManagerLog();
  throwMgr.manager.ctx.tools.register = () => {
    throw new Error("boom");
  };
  const supRethrow = new ConnectionSupervisor(throwMgr.manager, { name: "srv", transport: "stdio", command: "echo", enabled: true });
  await assert.rejects(() => supRethrow.syncTools({ listTools: async () => ({ tools: [{ name: "boom" }] }) }, true), /boom/);

  // cursor 为空串/null 终止循环。
  const supEmpty = new ConnectionSupervisor(makeManagerLog().manager, { name: "z", transport: "stdio", command: "echo", enabled: true });
  await supEmpty.syncTools({ listTools: async () => ({ tools: [{ name: "t" }], nextCursor: "" }) }, false);
  assert.deepEqual(supEmpty.tools, ["mcp__z__t"]);
}

// ---- disconnect：timer / close 抛错 / 终态 ----

{
  const { manager } = makeManagerLog();
  const sup = new ConnectionSupervisor(manager, failServer);
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
  assert.equal(sup.disposed, true);
  assert.equal(sup.reconnectTimer, undefined, "timer 清理");
  assert.equal(sup.client, undefined);
  assert.equal(sup.toolDisposers.size, 0);
  assert.equal(sup.status, "stopped", "终态 stopped");
}

console.log("  ok   unit-supervisor: 连接状态机与重连策略");
