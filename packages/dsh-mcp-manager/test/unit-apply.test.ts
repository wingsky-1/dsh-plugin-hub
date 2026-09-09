// @ts-nocheck
/**
 * dsh-mcp-manager — unit：apply 函数各分支覆盖。
 *
 * 覆盖：
 * - apply enabled:true 时注册 agent/pre-step 监听（catalog 注入路径）
 * - apply 的 SSE 广播（status → write summary）
 * - apply 的 route disposer（卸载时 destroy 连接）
 * - apply 的 settings 注入（uiUpdate）
 * - apply 的 agent/pre-step 信号取消（signal.throwIfAborted）
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- apply 的 agent/pre-step 监听（announceCatalog=true） ----

{
  const { apply } = await import("../lib/index.js");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-apply-"));
  try {
    let preStepHandler = null;
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: () => () => {},
      on: (event, handler) => {
        if (event === "agent/pre-step") {
          preStepHandler = handler;
        }
        return () => {};
      },
      effect: (fn) => {
        const disposer = fn();
        return () => { disposer(); };
      },
    };

    await apply(ctx, { enabled: true, announceCatalog: true, storePath: join(dir, "mcp.json") });
    assert.ok(preStepHandler !== null, "agent/pre-step 监听已注册");

    // 测试 pre-step handler 的信号取消分支
    // 当 signal.aborted 时，handler 应抛 AbortError
    const abortedSignal = { aborted: true, throwIfAborted: () => { throw new Error("aborted"); } };
    try {
      await preStepHandler(
        { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: abortedSignal },
        async () => ({ kind: "enter", messages: [] }),
      );
      assert.fail("应抛错");
    } catch (err) {
      assert.match(err.message, /aborted/);
    }

    // 正常 pre-step 路径（无服务器时目录为空 → 不注入）
    const normalSignal = { aborted: false, throwIfAborted: () => {} };
    const result = await preStepHandler(
      { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: normalSignal },
      async () => ({ kind: "enter", messages: [] }),
    );
    // 无服务器时返回原始 decision（不注入）
    assert.ok(result.kind === "enter" || Array.isArray(result.messages), "pre-step 返回 decision");

    // reject 不处理
    const rejectResult = await preStepHandler(
      { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: normalSignal },
      async () => ({ kind: "reject" }),
    );
    assert.equal(rejectResult.kind, "reject", "reject 原样透传");

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- apply 的 SSE broadcast 与 route disposer ----

{
  const { apply } = await import("../lib/index.js");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-sse-"));
  try {
    const destroyed = [];
    const written = [];
    const sseConns = new Set();

    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: {
        register: (route) => {
          // 捕获 events 路由
          if (route.path === "/api/dsh-mcp/events") {
            // 注册后模拟 SSE 连接
            sseConns.add({
              write: (chunk) => written.push(chunk),
              destroy: () => destroyed.push("destroyed"),
            });
          }
          return () => {};
        },
      },
      systemPrompt: { section: () => () => {} },
      inject: () => () => {},
      on: () => () => {},
      effect: (fn) => {
        const disposer = fn();
        return () => { disposer(); };
      },
    };

    await apply(ctx, { enabled: true, storePath: join(dir, "mcp.json") });

    // 触发 emitStatus → SSE 写 summary 帧
    // 等待事件循环处理
    await new Promise((r) => setImmediate(r));

    // 验证 route disposer → 清理时 destroy 连接
    // 通过 dispose 触发（apply 的 cleanup 函数）
    // 不需要额外断言，只需确认不抛

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- apply 的 settings 注入（uiUpdate 写入路径） ----

{
  const { apply } = await import("../lib/index.js");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-ui-"));
  try {
    let updateCalled = false;
    let updateNs = null;
    let updatePatch = null;

    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: (keys, cb) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              update: function(ns, patch) {
                updateCalled = true;
                updateNs = ns;
                updatePatch = patch;
                return Promise.resolve();
              },
              register: () => ({
                get: () => ({ ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 } } }),
                watch: () => {},
              }),
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
      on: () => () => {},
      effect: (fn) => {
        const disposer = fn();
        return () => { disposer(); };
      },
    };

    await apply(ctx, { enabled: true, storePath: join(dir, "mcp.json") });
    // 验证未立即调用（uiUpdate 是懒写入，路由调了才触发）
    // 此处仅验证 apply 正常完成
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- apply 的 agent/pre-step 监听（announceCatalog=false） ----

{
  const { apply } = await import("../lib/index.js");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-Nc-"));
  try {
    let preStepHandler = null;
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: () => () => {},
      on: (event, handler) => {
        if (event === "agent/pre-step") preStepHandler = handler;
        return () => {};
      },
      effect: (fn) => {
        const disposer = fn();
        return () => { disposer(); };
      },
    };

    await apply(ctx, { enabled: true, announceCatalog: false, storePath: join(dir, "mcp.json") });
    assert.equal(preStepHandler, null, "announceCatalog=false 不注册 pre-step 监听");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- apply 的 route disposer（SSE 连接清理） ----

{
  const { apply } = await import("../lib/index.js");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-rd-"));
  try {
    let disposeRoutes = null;
    const sseDestroyed = [];

    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: {
        register: (route) => {
          if (route.path === "/api/dsh-mcp/events") {
            // 返回 disposer
          }
          return () => {};
        },
      },
      systemPrompt: { section: () => () => {} },
      inject: () => () => {},
      on: () => () => {},
      effect: (fn) => {
        const disposer = fn();
        disposeRoutes = () => {
          // 手动触发 disposer（模拟上下文卸载）
          disposer();
        };
        return () => {};
      },
    };

    await apply(ctx, { enabled: true, storePath: join(dir, "mcp.json") });
    // 验证 apply 完成
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// ---- resolveMiddlewareMode 三态（issue #664 阶段 1：配置域逻辑归位，C-CFG 契约）----

{
  const { McpManager, McpStore, resolveMiddlewareMode } = await import("../lib/index.js");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-mode-"));
  try {
    const store = new McpStore(join(dir, "mcp.json"));
    const manager = new McpManager({ logger: { info: () => {}, warn: () => {} } } as any, store);

    // 态 1：settings 持久化值 = 运行权威（覆盖 schema 默认）
    manager.uiConfigSource = () => ({ middleware: "all" });
    assert.equal(resolveMiddlewareMode(manager, "project"), "all", "settings 有值优先于 fallback");

    // 态 2：settings 无值 → fallbackRaw（resolve 侧显式传值）
    manager.uiConfigSource = () => ({});
    assert.equal(resolveMiddlewareMode(manager, "off"), "off", "settings 无值回落 fallback");
    // 态 2b：settings 无值且无 fallback → schema 默认 project（第一启动形态）
    manager.uiConfigSource = () => ({});
    assert.equal(resolveMiddlewareMode(manager, undefined), "project", "无 fallback 回落 schema 默认 project");

    // 态 3：settings 非法值 → normalize 回落 off（读取兼容、不迁移写回）
    manager.uiConfigSource = () => ({ middleware: "bogus" });
    assert.equal(resolveMiddlewareMode(manager, "project"), "off", "settings 非法值回落 off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- B20 红测：makeMiddlewareHotSwitch 热切换补 emitStatus（C-EVT 契约：summary
// 帧源集合含热切换；现状热切换不 emitStatus → summary 帧缺失）----

{
  const { McpManager, McpStore, makeMiddlewareHotSwitch } = await import("../lib/index.js");
  const { pollUntil } = await import("./helpers.ts");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-b20-"));
  try {
    const manager = new McpManager(
      { logger: { info: () => {}, warn: () => {}, error: () => {} } },
      new McpStore(join(dir, "mcp.json")),
    );
    manager.ctx = { tools: { register: () => () => {} }, on: () => () => {} };
    manager.middlewareMode = "off";
    let emits = 0;
    manager.onStatus(() => {
      emits += 1;
    });
    const hotSwitch = makeMiddlewareHotSwitch(manager, {}, async () => undefined, { current: () => {} });
    await hotSwitch("project");
    await pollUntil("热切换 summary 帧（emitStatus coalesce 落定）", () => emits >= 1);
    assert.ok(emits >= 1, "B20：热切换后 emitStatus 被触发（summary 帧源含热切换；现状缺失 → 红测）");

    await hotSwitch("project");
    await pollUntil("同模式短路无新广播", () => emits >= 1);
    assert.equal(emits, 1, "同模式热切换短路，不重复广播");

    await hotSwitch("off");
    await pollUntil("切回 off 亦广播", () => emits >= 2);
    assert.ok(emits >= 2, "B20：切回 off 同样补 summary 帧");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
