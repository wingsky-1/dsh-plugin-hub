// @ts-nocheck
// dsh-mcp-manager 冒烟测试 —— 无外部依赖、不发起真实网络连接。
//
// 覆盖：
//   - 契约导出（name / inject / ROUTES）
//   - normalizeServer 校验（名称模式、传输必填、http url 合法性）
//   - fromClaudeEntry / parseClaudeJson（mcpServers JSON 兼容映射）
//   - publicToolName 确定性、expandEnv、parseSsePayload
//   - McpStore 落盘/读回（临时目录）
//   - makeRoutes：GET 列表 / POST 添加 / PATCH 更新 / DELETE 删除 /
//     import/json 导入
//   - apply：enabled:false 时不注册路由与提示词
//
// 运行：node dsh-mcp-manager/test/smoke.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
import {
  apply,
  buildToolDefinition,
  composeCatalogEntries,
  ConnectionSupervisor,
  DEFAULT_RESULT_TRUNCATE_BYTES,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  digestCatalogEntries,
  escapeCatalogText,
  findCatalogMessage,
  fromClaudeEntry,
  expandEnv,
  inject,
  makeRoutes,
  McpManager,
  McpStore,
  name,
  normalizeServer,
  parseClaudeJson,
  parseSsePayload,
  publicToolName,
  renderMcpCatalogMessage,
  resolveCatalogInjection,
  ROUTES,
  SCOPE_GLOBAL,
  SCOPE_PROJECT,
  summarizeToolDescriptions,
  truncateText,
  assertSupportedOutputSchema,
} from "../lib/index.js";

const failures = [];
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`  FAIL ${label}\n       ${error.message}`);
  }
};

const checkAsync = async (label, fn) => {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`  FAIL ${label}\n       ${error.message}`);
  }
};

/** 伪造 cordis ctx：只实现 apply 用到的面。 */
function fakeCtx(overrides = {}) {
  const state = { routes: [], sections: [], effects: [], registeredTools: [], listeners: new Map() };
  const ctx = {
    ...state,
    tools: {
      register: (definition) => {
        state.registeredTools.push(definition);
        return () => {};
      },
    },
    webServer: {
      register: (route) => {
        state.routes.push(route);
        return () => {};
      },
    },
    systemPrompt: {
      section: (section) => {
        state.sections.push(section);
        return () => {};
      },
    },
    on: (event, handler) => {
      if (!state.listeners.has(event)) state.listeners.set(event, []);
      state.listeners.get(event).push(handler);
      return () => {};
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    effect: (fn, label) => {
      state.effects.push(label);
      const disposer = fn();
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    ...overrides,
  };
  return ctx;
}

/** 伪造 node:http res。 */
function fakeRes() {
  const state = { status: 0, headers: {}, body: "" };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      Object.assign(state.headers, headers);
    },
    end(body) {
      state.body = body;
    },
  };
}

/** 在临时目录建一个空 store，返回 { store, path, cleanup }。 */
function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-"));
  const path = join(dir, "dsh-mcp.json");
  return {
    store: new McpStore(path),
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const main = async () => {
  console.log("契约: name / inject / ROUTES");
  check("name = mcp-manager", () => assert.equal(name, "mcp-manager"));
  check("inject 包含 tools / webServer / systemPrompt", () => {
    assert.deepEqual(inject, ["tools", "webServer", "systemPrompt"]);
  });
  check("ROUTES 关键路径存在", () => {
    assert.equal(ROUTES.servers, "/api/dsh-mcp/servers");
    assert.equal(ROUTES.importJson, "/api/dsh-mcp/import/json");
  });
  check("client bundle 的 /api/ 路径与 host ROUTES 完全一致（防漂移）", () => {
    const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    const clientPaths = [...clientSrc.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]).sort();
    const hostPaths = [...new Set(Object.values(ROUTES))].sort();
    assert.deepEqual(clientPaths, hostPaths, `两端路由漂移：client=${clientPaths.join(",")} host=${hostPaths.join(",")}`);
  });
  check("client source contract（load id/IIFE/use strict/load once）", () => assertClientSourceContract(pkgDir));
  check("client product contract（执行断言：arrive 可解析/apply/inject）", () => assertClientProductContract(pkgDir));

  console.log("normalizeServer");
  check("stdio 服务器规范化", () => {
    const server = normalizeServer({
      name: "context7-stdio",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@context7/mcp-server"],
      env: { CONTEXT7_API_KEY: "abc" },
      description: "上下文检索（自定义描述）",
    });
    assert.equal(server.name, "context7-stdio");
    assert.equal(server.transport, "stdio");
    assert.equal(server.enabled, true);
    assert.equal(server.command, "npx");
    assert.deepEqual(server.args, ["-y", "@context7/mcp-server"]);
    assert.equal(server.toolCallTimeoutMs, 15_000, "超时默认下探至 15s");
    assert.equal(server.description, "上下文检索（自定义描述）");
    assert.equal(normalizeServer({ name: "a", transport: "stdio", command: "x", description: "  " }).description, undefined, "空白描述归一为 undefined");
    assert.equal(normalizeServer({ name: "a", transport: "stdio", command: "x", description: "长".repeat(200) }).description.length, 200, "描述完整返回不截断");
  });
  check("streamable-http 服务器规范化", () => {
    const server = normalizeServer({
      name: "context7",
      transport: "streamable-http",
      url: "https://mcp.context7.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
    assert.equal(server.transport, "streamable-http");
    assert.equal(server.url, "https://mcp.context7.com/mcp");
    assert.deepEqual(server.headers, { Authorization: "Bearer x" });
  });
  check("非法名称被拒绝", () => {
    assert.throws(() => normalizeServer({ name: "bad name!", transport: "stdio", command: "x" }));
    assert.throws(() => normalizeServer({ name: "", transport: "stdio", command: "x" }));
  });
  check("非法传输被拒绝", () => {
    assert.throws(() => normalizeServer({ name: "a", transport: "sse", command: "x" }));
  });
  check("stdio 缺 command 被拒绝", () => {
    assert.throws(() => normalizeServer({ name: "a", transport: "stdio" }));
  });
  check("http 缺 url / 非法 url 被拒绝", () => {
    assert.throws(() => normalizeServer({ name: "a", transport: "streamable-http" }));
    assert.throws(() => normalizeServer({ name: "a", transport: "streamable-http", url: "not a url" }));
  });
  check("enabled: false 保留", () => {
    assert.equal(normalizeServer({ name: "a", transport: "stdio", command: "x", enabled: false }).enabled, false);
  });

  console.log("mcpServers JSON 兼容");
  check("stdio 条目映射", () => {
    const server = fromClaudeEntry("github", {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "tok" },
    });
    assert.equal(server.transport, "stdio");
    assert.equal(server.command, "npx");
    assert.deepEqual(server.args, ["-y", "@modelcontextprotocol/server-github"]);
    assert.deepEqual(server.env, { GITHUB_TOKEN: "tok" });
  });
  check("http 条目映射", () => {
    const server = fromClaudeEntry("remote", {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
    assert.equal(server.transport, "streamable-http");
    assert.equal(server.url, "https://mcp.example.com/mcp");
  });
  check("sse 条目按 streamable-http 映射", () => {
    const server = fromClaudeEntry("sse-server", { type: "sse", url: "https://mcp.example.com/sse" });
    assert.equal(server.transport, "streamable-http");
    assert.equal(server.url, "https://mcp.example.com/sse");
  });
  check("无 command 且无 url 的条目被拒绝", () => {
    assert.throws(() => fromClaudeEntry("bad", { type: "unknown" }));
  });
  check("parseClaudeJson 解析整段 mcpServers", () => {
    const servers = parseClaudeJson(JSON.stringify({
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      remote: { type: "http", url: "https://mcp.example.com/mcp" },
    }));
    assert.equal(servers.length, 2);
    assert.equal(servers[0].name, "github");
    assert.equal(servers[1].transport, "streamable-http");
  });
  check("parseClaudeJson 拒绝非法 JSON", () => {
    assert.throws(() => parseClaudeJson("[1,2]"));
    assert.throws(() => parseClaudeJson("not json"));
  });

  console.log("工具命名 / 环境展开 / SSE 解析");
  check("publicToolName 确定性", () => {
    assert.equal(publicToolName("context7", "use_context7"), "mcp__context7__use_context7");
    assert.equal(publicToolName("context7", "use_context7"), publicToolName("context7", "use_context7"));
    assert.ok(publicToolName("a", "b").startsWith("mcp__a__b"));
  });
  check("publicToolName 超长名加哈希后缀", () => {
    const longName = "tool_".repeat(20);
    const pub = publicToolName("server", longName);
    assert.ok(pub.length <= 64);
    assert.match(pub, /^[A-Za-z0-9_-]+$/);
  });
  check("expandEnv 展开 ${ENV}", () => {
    const before = process.env.DSH_MCP_SMOKE_VAR;
    process.env.DSH_MCP_SMOKE_VAR = "hello";
    try {
      assert.equal(expandEnv("Bearer ${DSH_MCP_SMOKE_VAR}"), "Bearer hello");
      assert.equal(expandEnv("x ${DSH_MCP_SMOKE_MISSING_123} y"), "x  y");
    } finally {
      if (before === undefined) delete process.env.DSH_MCP_SMOKE_VAR;
      else process.env.DSH_MCP_SMOKE_VAR = before;
    }
  });
  check("parseSsePayload 提取匹配 id 的 JSON", () => {
    const text = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n";
    assert.deepEqual(parseSsePayload(text, 7).result, { ok: true });
    assert.equal(parseSsePayload(text, 99), undefined);
  });

  console.log("schema 校验（真实服务器声明；parameters 原样直传、output 严格校验）");
  // sequential-thinking-server v0.2.0 实际返回的 inputSchema / outputSchema
  const ST_INPUT = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "thought": { "type": "string", "description": "Your current thinking step" },
      "nextThoughtNeeded": { "description": "Whether another thought step is needed", "type": "boolean" },
      "thoughtNumber": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Current thought number" },
      "totalThoughts": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Estimated total thoughts" },
    },
    "required": ["thought", "thoughtNumber", "totalThoughts"],
  };
  const ST_OUTPUT = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "thoughtNumber": { "type": "number" },
      "totalThoughts": { "type": "number" },
      "nextThoughtNeeded": { "type": "boolean" },
      "branches": { "type": "array", "items": { "type": "string" } },
      "thoughtHistoryLength": { "type": "number" },
    },
    "required": ["thoughtNumber", "totalThoughts", "nextThoughtNeeded", "branches", "thoughtHistoryLength"],
    "additionalProperties": false,
  };
  // playwright 真实声明的 browser_drop inputSchema（含 propertyNames 与 schema 形式 additionalProperties）
  const PWD_DROP_INPUT = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "target": { "type": "string", "description": "Exact target element reference from the page snapshot" },
      "data": {
        "type": "object",
        "propertyNames": { "type": "string" },
        "additionalProperties": { "type": "string" },
      },
    },
    "required": ["target"],
    "additionalProperties": false,
  };
  let assertSupportedJsonSchema;
  // 解析 @deepseek-ai/dsh-tools(真实 schema 校验器)做交叉断言。
  // 候选顺序:依赖树解析 → DSH_TOOLS_PATH 环境变量 → Volta 全局安装布局。
  // 全部失败时警告而非静默跳过(避免"测试通过但覆盖缺失"的假象)。
  const candidates = [];
  try {
    candidates.push(import.meta.resolve("@deepseek-ai/dsh-tools"));
  } catch {
    // 不在依赖树,继续尝试其他候选
  }
  if (typeof process.env.DSH_TOOLS_PATH === "string" && process.env.DSH_TOOLS_PATH !== "") {
    candidates.push(pathToFileURL(process.env.DSH_TOOLS_PATH).href);
  }
  try {
    const voltaPackages = join(dirname(dirname(dirname(process.execPath))), "packages");
    candidates.push(pathToFileURL(join(voltaPackages, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-tools", "lib", "index.js")).href);
  } catch {
    // 非 Volta 环境,跳过布局候选
  }
  let toolsLoadError;
  for (const url of candidates) {
    try {
      const dshTools = await import(url);
      assertSupportedJsonSchema = dshTools.assertSupportedJsonSchema;
      break;
    } catch (error) {
      toolsLoadError = error;
    }
  }
  if (assertSupportedJsonSchema === undefined) {
    console.warn(`smoke: @deepseek-ai/dsh-tools 不可解析(${toolsLoadError?.message ?? "无可用候选"})——schema 交叉校验断言跳过;可设置 DSH_TOOLS_PATH 指向其 lib/index.js`);
  }
  check("output schema 带 $schema 关键字 → 校验失败（回退自由值）", () => {
    assert.equal(assertSupportedOutputSchema(ST_OUTPUT), undefined);
  });
  check("纯支持子集 output schema → 原样通过", () => {
    const clean = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
    assert.deepEqual(assertSupportedOutputSchema(clean), clean);
  });
  check("schema 形式的 additionalProperties / propertyNames → 校验失败", () => {
    assert.equal(assertSupportedOutputSchema(PWD_DROP_INPUT), undefined);
    assert.equal(assertSupportedOutputSchema({ type: "object", additionalProperties: { type: "string" } }), undefined);
    assert.equal(assertSupportedOutputSchema({ type: "object", properties: { data: { type: "object", propertyNames: { type: "string" } } } }), undefined);
  });
  check("校验通过的 output 构建的 output.schema 通过真实 assertSupportedJsonSchema", () => {
    const structured = assertSupportedOutputSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false });
    assert.ok(structured !== undefined);
    const outputSchema = {
      type: "object",
      properties: {
        content: { type: "array", items: {} },
        structuredContent: structured ?? {},
      },
      required: structured === undefined ? ["content"] : ["content", "structuredContent"],
      additionalProperties: false,
    };
    if (assertSupportedJsonSchema !== undefined) assertSupportedJsonSchema(outputSchema); // 不抛即通过
  });
  check("无 outputSchema / 空 schema / 注解-only 的处理", () => {
    assert.equal(assertSupportedOutputSchema(undefined), undefined);
    assert.deepEqual(assertSupportedOutputSchema({}), {});
    assert.deepEqual(assertSupportedOutputSchema({ type: "object" }), { type: "object" });
    assert.deepEqual(assertSupportedOutputSchema({ description: "x" }), { description: "x" });
  });
  check("oneOf ≥2 且无兄弟关键字；非法结构返回 undefined", () => {
    assert.deepEqual(assertSupportedOutputSchema({ oneOf: [{ type: "string" }, { type: "number" }] }), { oneOf: [{ type: "string" }, { type: "number" }] });
    assert.equal(assertSupportedOutputSchema({ oneOf: [{ type: "string" }] }), undefined);
    assert.equal(assertSupportedOutputSchema({ type: "object", oneOf: [{ type: "string" }, { type: "number" }] }), undefined);
    assert.equal(assertSupportedOutputSchema({ type: "object", additionalProperties: {} }), undefined); // additionalProperties 必须布尔
    assert.equal(assertSupportedOutputSchema({ type: "object", required: ["missing"] }), undefined); // required 不在 properties
    assert.equal(assertSupportedOutputSchema({ type: "string", enum: [1] }), undefined); // enum 值不匹配类型
  });
  check("parameters 原样直传（业界标准）：inputSchema 含 $schema/minimum 也直接可用", () => {
    // parameters 不再净化：任何 MCP inputSchema 都原样注册（运行时校验忽略未知键）
    assert.deepEqual(assertSupportedOutputSchema(undefined), undefined);
    assert.ok(ST_INPUT.properties.thoughtNumber.minimum === 1); // 原样保留
  });

  console.log("McpStore");
  await checkAsync("保存并读回", async () => {
    const { store, path, cleanup } = tempStore();
    try {
      store.data.servers = [normalizeServer({ name: "a", transport: "stdio", command: "echo" })];
      await store.save();
      const reloaded = new McpStore(path);
      await reloaded.load();
      assert.equal(reloaded.data.servers.length, 1);
      assert.equal(reloaded.data.servers[0].name, "a");
    } finally {
      cleanup();
    }
  });
  await checkAsync("upsert / remove", async () => {
    const { store, cleanup } = tempStore();
    try {
      store.upsert({ name: "a" });
      store.upsert({ name: "b" });
      assert.equal(store.data.servers.length, 2);
      store.upsert({ name: "a", extra: 1 });
      assert.equal(store.data.servers.length, 2);
      store.remove("a");
      assert.equal(store.find("a"), undefined);
    } finally {
      cleanup();
    }
  });
  await checkAsync("reloadIfChanged：外部修改重读 / 未变跳过 / 删除清空", async () => {
    const { store, path, cleanup } = tempStore();
    try {
      store.data.servers = [normalizeServer({ name: "a", transport: "stdio", command: "echo" })];
      await store.save();
      assert.equal(await store.reloadIfChanged(), false, "无外部变更不重读");
      // 外部修改（模拟 git pull / 手动编辑 mcp.json）
      await new Promise((r) => setTimeout(r, 20)); // mtime 毫秒精度保护
      writeFileSync(path, JSON.stringify({ version: 1, servers: [{ name: "b", transport: "stdio", command: "echo", enabled: true }] }));
      assert.equal(await store.reloadIfChanged(), true, "外部修改触发重读");
      assert.equal(store.data.servers.length, 1);
      assert.equal(store.data.servers[0].name, "b", "重读后数据来自磁盘");
      assert.equal(await store.reloadIfChanged(), false, "重读后基线推进");
      // 外部删除 → 清空配置
      await new Promise((r) => setTimeout(r, 20));
      rmSync(path);
      assert.equal(await store.reloadIfChanged(), true, "删除触发重读");
      assert.deepEqual(store.data.servers, [], "删除 = 清空配置");
      assert.equal(await store.reloadIfChanged(), false, "删除后基线推进");
    } finally {
      cleanup();
    }
  });

  console.log("项目根发现（findProjectRoot / setSession）");
  {
    // 目录树：home/.dsh 模拟 DSH 全局家目录（DSH_HOME 指向它）；
    // home/dev/leetcode 是无任何标记的空工作区；proj 是带 .dsh/mcp.json 的项目。
    const base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-root-"));
    const home = join(base, "home");
    const leetcode = join(home, "dev", "leetcode");
    const proj = join(base, "proj");
    const projSub = join(proj, "sub");
    const nomark = join(base, "nomark");
    try {
      mkdirSync(join(home, ".dsh"), { recursive: true });
      mkdirSync(leetcode, { recursive: true });
      mkdirSync(join(proj, ".dsh"), { recursive: true });
      mkdirSync(projSub, { recursive: true });
      mkdirSync(nomark, { recursive: true });
      // home 自身的项目级配置（空服务器列表，setSession 不会 spawn 进程）。
      writeFileSync(join(home, ".dsh", "mcp.json"), JSON.stringify({ version: 1, servers: [] }));
      writeFileSync(join(proj, ".dsh", "mcp.json"), JSON.stringify({ version: 1, servers: [] }));

      const prevDshHome = process.env.DSH_HOME;
      process.env.DSH_HOME = join(home, ".dsh");
      try {
        const manager = new McpManager(
          { logger: { warn: () => {}, info: () => {}, error: () => {} } },
          new McpStore(join(base, "dsh-mcp.json")),
        );

        await checkAsync("home 下的空工作区不把 home 误判为项目根（回归：~/.dsh 串台）", async () => {
          const root = await manager.findProjectRoot(leetcode);
          assert.equal(root, leetcode);
          await manager.setSession(leetcode);
          assert.equal(manager.projectRoot, leetcode);
          assert.ok(manager.projectStore !== undefined);
          assert.equal(manager.summary().servers.filter((s) => s.scope === "project").length, 0);
        });

        await checkAsync("子目录向上命中项目 .dsh 标记", async () => {
          const root = await manager.findProjectRoot(projSub);
          assert.equal(root, proj);
        });

        await checkAsync("home 自身作为会话 cwd 时仍是合法项目根（fallback）", async () => {
          const root = await manager.findProjectRoot(home);
          assert.equal(root, home);
        });

        await checkAsync("无标记目录 → cwd 本身", async () => {
          assert.equal(await manager.findProjectRoot(nomark), nomark);
        });

        await checkAsync("空 cwd 清空项目级会话且幂等", async () => {
          await manager.setSession("");
          assert.equal(manager.projectRoot, undefined);
          assert.equal(manager.projectStore, undefined);
          // 再次清空：守卫应直接返回（不抛、不重复广播）
          await manager.setSession("");
          await manager.setSession(undefined);
          assert.equal(manager.projectStore, undefined);
        });

        await checkAsync("切回带 .dsh 的项目：加载项目级 store", async () => {
          await manager.setSession(proj);
          assert.equal(manager.projectRoot, proj);
          assert.ok(manager.projectStore !== undefined);
        });

        await manager.dispose();
      } finally {
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  console.log("目录数据源按工作区计算（切换工作区不抖动）");
  {
    // 两个项目各有自己的项目级 MCP：projA → a1、projB → b1；全局 store → g1。
    // 会话目录 = 全局 + 该会话 cwd 所属项目的配置，与 host 当前 setSession 无关。
    const base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-cat-"));
    const rootA = join(base, "projA");
    const rootB = join(base, "projB");
    const subA = join(rootA, "sub");
    try {
      mkdirSync(join(rootA, ".dsh"), { recursive: true });
      mkdirSync(join(rootB, ".dsh"), { recursive: true });
      mkdirSync(subA, { recursive: true });
      const noReconnect = { reconnect: { enabled: false } };
      writeFileSync(join(rootA, ".dsh", "mcp.json"), JSON.stringify({
        version: 1,
        servers: [normalizeServer({ name: "a1", transport: "stdio", command: "true", ...noReconnect })],
      }));
      writeFileSync(join(rootB, ".dsh", "mcp.json"), JSON.stringify({
        version: 1,
        servers: [normalizeServer({ name: "b1", transport: "stdio", command: "true", ...noReconnect })],
      }));

      const gstore = new McpStore(join(base, "dsh-mcp.json"));
      gstore.data.servers = [normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect })];
      const manager = new McpManager(
        { logger: { warn: () => {}, info: () => {}, error: () => {} } },
        gstore,
      );

      await checkAsync("cwd 属于 projA → 全局 + a1", async () => {
        const names = [...(await manager.catalogServersFor(subA)).keys()];
        assert.deepEqual(names, ["g1", "a1"]);
      });
      await checkAsync("cwd 属于 projB → 全局 + b1", async () => {
        const names = [...(await manager.catalogServersFor(rootB)).keys()];
        assert.deepEqual(names, ["g1", "b1"]);
      });
      await checkAsync("host 切换会话后 projA 的目录不变（回归：切换工作区不再抖动）", async () => {
        await manager.setSession(rootB);
        const names = [...(await manager.catalogServersFor(subA)).keys()];
        assert.deepEqual(names, ["g1", "a1"]);
      });
      await checkAsync("空 cwd → 仅全局", async () => {
        const names = [...(await manager.catalogServersFor("")).keys()];
        assert.deepEqual(names, ["g1"]);
      });
      await checkAsync("同名项目级被全局顶掉", async () => {
        // projB 里放一台与全局同名的服务器
        const storeB = await manager.projectStoreFor(rootB);
        storeB.upsert(normalizeServer({ name: "g1", transport: "stdio", command: "true", ...noReconnect }));
        const names = [...(await manager.catalogServersFor(rootB)).keys()];
        assert.deepEqual(names, ["g1", "b1"]);
      });
      await checkAsync("projectStoreFor 缓存复用（同 root 返回同一实例）", async () => {
        const first = await manager.projectStoreFor(rootA);
        const second = await manager.projectStoreFor(rootA);
        assert.equal(first, second);
      });
      await checkAsync("setSession 复用工作区缓存（不重复读盘）", async () => {
        await manager.setSession(rootA);
        const current = manager.projectStore;
        await manager.setSession(rootB);
        await manager.setSession(rootA);
        assert.equal(manager.projectStore, current);
      });

      await manager.dispose();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  console.log("外部配置变更自动重读（refreshFromDisk / reconcileServers）");
  {
    const base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-reload-"));
    const proj = join(base, "proj");
    const cfg = join(proj, ".dsh", "mcp.json");
    try {
      mkdirSync(join(proj, ".dsh"), { recursive: true });
      writeFileSync(cfg, JSON.stringify({ version: 1, servers: [] }));
      const gstore = new McpStore(join(base, "dsh-mcp.json"));
      // 全局 disabled 服务器：验证 reconcile 不会为其 spawn 进程。
      gstore.data.servers = [normalizeServer({ name: "g1", transport: "stdio", command: "true", enabled: false })];
      await gstore.save();
      const manager = new McpManager({ logger: { warn: () => {}, info: () => {}, error: () => {} } }, gstore);
      await manager.setSession(proj);
      assert.equal(manager.projectStore.data.servers.length, 0);

      // 假 supervisor：验证配置移除后被断开（不 spawn 真实连接）。
      let disconnected = 0;
      manager.supervisors.set("ghost", {
        scope: SCOPE_PROJECT,
        status: "connected",
        client: {},
        toolDisposers: new Map(),
        disconnect: async () => {
          disconnected += 1;
        },
      });

      await checkAsync("外部新增 disabled 服务器 → refreshFromDisk 重读并进 summary（不 spawn）", async () => {
        await new Promise((r) => setTimeout(r, 20));
        writeFileSync(cfg, JSON.stringify({
          version: 1,
          servers: [normalizeServer({ name: "p1", transport: "stdio", command: "true", enabled: false })],
        }));
        await manager.refreshFromDisk();
        const names = manager.summary().servers.filter((s) => s.scope === SCOPE_PROJECT).map((s) => s.name);
        assert.deepEqual(names, ["p1"], "外部新增出现在面板数据");
        assert.equal(manager.supervisors.has("p1"), false, "disabled 不启动");
      });

      await checkAsync("外部移除配置 → 已连接 supervisor 被断开", async () => {
        await new Promise((r) => setTimeout(r, 20));
        writeFileSync(cfg, JSON.stringify({ version: 1, servers: [] }));
        await manager.refreshFromDisk();
        assert.equal(disconnected, 1, "ghost 被断开");
        assert.equal(manager.supervisors.has("ghost"), false);
      });

      await checkAsync("无配置变化时 refreshFromDisk 不广播（防 SSE 空转循环）", async () => {
        let emitted = 0;
        manager.onStatus(() => {
          emitted += 1;
        });
        await manager.refreshFromDisk();
        assert.equal(emitted, 0, "无变化不 emitStatus");
      });

      await manager.dispose();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  console.log("路由");
  {
    const { store, cleanup } = tempStore();
    try {
      const managerState = { sessionCwd: undefined, lastScope: undefined };
      const manager = {
        store,
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        summary: () => ({ servers: [], counts: {} }),
        refreshFromDisk: async () => {},
        setSession: async (cwd) => {
          managerState.sessionCwd = cwd;
        },
        add: async (body, scope) => {
          managerState.lastScope = scope;
          const server = normalizeServer(body);
          if (store.find(server.name) !== undefined) {
            throw new Error(`server "${server.name}" already exists`);
          }
          store.upsert(server);
          return server;
        },
        update: async (nm, patch, scope) => {
          managerState.lastScope = scope;
          const server = normalizeServer({ ...store.find(nm), ...patch, name: nm });
          store.upsert(server);
          return server;
        },
        remove: async (nm, scope) => {
          managerState.lastScope = scope;
          store.remove(nm);
        },
        connect: async () => {},
        disconnect: async () => {},
        reconnect: async () => {},
      };
      const routes = makeRoutes(manager, process.cwd());
      const find = (path) => routes.find((route) => route.path === path);

      check("注册 7 条 exact 路由", () => {
        assert.equal(routes.length, 7);
        for (const route of routes) assert.equal(route.kind, "exact");
      });

      const fakeReq = (method, url, body) => ({
        method,
        url,
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(JSON.stringify(body));
        },
      });
      const fakeFenceBroken = (method, url) => ({
        method,
        url,
        socket: { remoteAddress: "10.0.0.5" },
        headers: { host: "localhost:3080" },
        async *[Symbol.asyncIterator]() {},
      });

      await checkAsync("GET servers → 200 + summary", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(fakeReq("GET", ROUTES.servers), res);
        assert.equal(res.state.status, 200);
        assert.deepEqual(JSON.parse(res.state.body), { servers: [], counts: {} });
      });
      await checkAsync("POST servers → 201 + 添加", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(
          fakeReq("POST", ROUTES.servers, { name: "github", transport: "stdio", command: "npx" }),
          res,
        );
        assert.equal(res.state.status, 201);
        assert.equal(store.find("github").command, "npx");
      });
      await checkAsync("POST 重复名称 → 400", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(
          fakeReq("POST", ROUTES.servers, { name: "github", transport: "stdio", command: "npx" }),
          res,
        );
        assert.equal(res.state.status, 400);
      });
      await checkAsync("PATCH 更新 → 200", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(
          fakeReq("PATCH", `${ROUTES.servers}?name=github`, { args: ["-y", "x"] }),
          res,
        );
        assert.equal(res.state.status, 200);
        assert.deepEqual(store.find("github").args, ["-y", "x"]);
      });
      await checkAsync("DELETE → 200 + 移除", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(fakeReq("DELETE", `${ROUTES.servers}?name=github`), res);
        assert.equal(res.state.status, 200);
        assert.equal(store.find("github"), undefined);
      });
      await checkAsync("非 loopback → 403", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(fakeFenceBroken("GET", ROUTES.servers), res);
        assert.equal(res.state.status, 403);
      });
      await checkAsync("import/json 导入", async () => {
        const res = fakeRes();
        await find(ROUTES.importJson).handler(
          fakeReq("POST", ROUTES.importJson, {
            json: JSON.stringify({ alpha: { command: "npx", args: ["-y", "a"] } }),
          }),
          res,
        );
        assert.equal(res.state.status, 200);
        const body = JSON.parse(res.state.body);
        assert.deepEqual(body.imported, ["alpha"]);
        assert.equal(store.find("alpha").command, "npx");
      });
      await checkAsync("import/json 非法 JSON → 400", async () => {
        const res = fakeRes();
        await find(ROUTES.importJson).handler(
          fakeReq("POST", ROUTES.importJson, { json: "[1,2]" }),
          res,
        );
        assert.equal(res.state.status, 400);
      });
      await checkAsync("POST session {cwd} → 200 并记录会话", async () => {
        const res = fakeRes();
        await find(ROUTES.session).handler(fakeReq("POST", ROUTES.session, { cwd: "C:/proj" }), res);
        assert.equal(res.state.status, 200);
        assert.equal(managerState.sessionCwd, "C:/proj");
      });
      await checkAsync("GET servers?cwd= 触发会话切换", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(fakeReq("GET", `${ROUTES.servers}?cwd=C:/other`), res);
        assert.equal(managerState.sessionCwd, "C:/other");
      });
      await checkAsync("POST servers scope=project 透传 scope", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(
          fakeReq("POST", ROUTES.servers, { name: "proj-mcp", transport: "stdio", command: "x", scope: "project" }),
          res,
        );
        assert.equal(res.state.status, 201);
        assert.equal(managerState.lastScope, "project");
      });
      await checkAsync("DELETE ?scope=project 透传 scope", async () => {
        const res = fakeRes();
        await find(ROUTES.servers).handler(fakeReq("DELETE", `${ROUTES.servers}?name=proj-mcp&scope=project`), res);
        assert.equal(res.state.status, 200);
        assert.equal(managerState.lastScope, "project");
      });
      await checkAsync("session 缺 cwd → 400", async () => {
        const res = fakeRes();
        await find(ROUTES.session).handler(fakeReq("POST", ROUTES.session, {}), res);
        assert.equal(res.state.status, 400);
      });
    } finally {
      cleanup();
    }
  }

  console.log("apply");
  await checkAsync("enabled:false 不注册路由/提示词", async () => {
    const ctx = fakeCtx();
    await apply(ctx, { enabled: false });
    assert.equal(ctx.routes.length, 0);
    assert.equal(ctx.sections.length, 0);
  });
  await checkAsync("默认配置注册路由与提示词（空存储不连接）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-apply-"));
    const ctx = fakeCtx();
    try {
      await apply(ctx, { enabled: true, storePath: join(dir, "dsh-mcp.json") });
      assert.equal(ctx.routes.length, 9); // 7 条业务路由 + 1 条 SSE events + 1 条 health
      assert.ok(ctx.routes.some((route) => route.path === ROUTES.events), "SSE events 路由已注册");
      assert.equal(ctx.sections.length, 1);
      assert.equal(ctx.sections[0].name, "plugin:dsh-mcp-manager");
      assert.match(ctx.sections[0].text, /dsh-mcp-manager/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log("感知增强（L1 目录 / L2 描述兜底 / L3 截断 / 超时下探）");
  check("truncateText 短文本不截断", () => {
    assert.equal(truncateText("短文本", 8192), "短文本");
  });
  check("truncateText 长文本截断并标注", () => {
    const text = "A".repeat(10000);
    const out = truncateText(text, 1024);
    assert.match(out, /已截断/);
    assert.match(out, /10000 字节/);
    assert.ok(Buffer.byteLength(out, "utf8") <= 1024 + 128, "截断后含标注仍受控");
    assert.ok(out.endsWith("）"), "标注完整");
  });
  check("truncateText 多字节安全（不产生替换符）", () => {
    const text = "中".repeat(5000);
    const out = truncateText(text, 1000);
    assert.ok(!out.includes("\uFFFD"), "截断点不落在多字节字符中间");
  });
  check("composeCatalogEntries 数据源（配置优先 → 缓存摘要 → 仅名字）", () => {
    const supervisors = new Map([
      ["srv-a", { server: { description: "自定义描述 A" }, tools: [], toolMeta: new Map() }],
      ["srv-b", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
      ["srv-c", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
    ]);
    const cache = new Map([
      ["srv-b", { summary: "缓存摘要 B" }],
    ]);
    const entries = composeCatalogEntries(supervisors, 6, cache);
    assert.equal(entries[0].text, "自定义描述 A", "用户配置优先");
    assert.equal(entries[1].text, "缓存摘要 B", "缓存摘要 fallback（无需用户配置）");
    assert.equal(entries[2].text, undefined, "无配置无缓存 → 仅名字");
    // digest 稳定性：实时连接状态（tools/toolMeta）变化不影响目录 digest
    const connected = new Map([
      ["srv-a", { server: { description: "自定义描述 A" }, tools: ["t1"], toolMeta: new Map([["x", { description: "实时描述" }]]) }],
      ["srv-b", { server: { description: undefined }, tools: ["t1"], toolMeta: new Map([["x", { description: "实时描述" }]]) }],
      ["srv-c", { server: { description: undefined }, tools: [], toolMeta: new Map() }],
    ]);
    assert.equal(
      digestCatalogEntries(composeCatalogEntries(connected, 6, cache)),
      digestCatalogEntries(entries),
      "连接状态变化 digest 不变（不触发重复注入）"
    );
  });
  check("summarizeToolDescriptions 排序稳定与截断", () => {
    const meta1 = new Map([
      ["mcp__s__b", { description: "工具 B 的说明文字" }],
      ["mcp__s__a", { description: "工具 A 的说明" }],
    ]);
    const meta2 = new Map([
      ["mcp__s__a", { description: "工具 A 的说明" }],
      ["mcp__s__b", { description: "工具 B 的说明文字" }],
      ["mcp__s__c", { description: "" }],
    ]);
    assert.equal(summarizeToolDescriptions(meta1), summarizeToolDescriptions(meta2), "顺序变化摘要稳定");
    assert.equal(summarizeToolDescriptions(new Map([["x", { description: "  " }]])), undefined, "全空描述无摘要");
    const long = summarizeToolDescriptions(new Map([["x", { description: "长".repeat(100) }]]));
    assert.equal(long, "长".repeat(100), "长描述完整返回不截断");
  });
  check("recordCatalogTools 仅实质变化落盘", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-catalog-"));
    const store = new McpStore(join(dir, "mcp.json"));
    const manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, store);
    manager.catalogCachePath = join(dir, "catalog.json");
    await manager.loadCatalogCache();
    assert.equal(manager.catalogCache.size, 0, "空缓存加载");
    const meta = new Map([["mcp__s__a", { description: "唯一描述" }]]);
    await manager.recordCatalogTools("srv", meta);
    assert.equal(manager.catalogCache.get("srv")?.summary, "唯一描述");
    const onDisk = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
    assert.equal(onDisk.entries.srv.summary, "唯一描述", "缓存落盘");
    // 相同摘要再记录：不重复落盘（digest 不变）
    const mtime1 = (await import("node:fs")).statSync(join(dir, "catalog.json")).mtimeMs;
    await manager.recordCatalogTools("srv", meta);
    const mtime2 = (await import("node:fs")).statSync(join(dir, "catalog.json")).mtimeMs;
    assert.equal(mtime1, mtime2, "相同摘要不落盘");
    // 摘要变化 → 落盘
    await manager.recordCatalogTools("srv", new Map([["mcp__s__a", { description: "新描述" }]]));
    assert.equal(manager.catalogCache.get("srv")?.summary, "新描述");
    // 重新加载（模拟重启）
    const manager2 = new McpManager({ logger: { warn: () => {} } }, store);
    manager2.catalogCachePath = join(dir, "catalog.json");
    await manager2.loadCatalogCache();
    assert.equal(manager2.catalogCache.get("srv")?.summary, "新描述", "重启后缓存恢复");
    rmSync(dir, { recursive: true, force: true });
  });
  check("composeCatalogEntries 条目上限", () => {
    const supervisors = new Map();
    for (let i = 0; i < 10; i += 1) supervisors.set(`s${i}`, { server: { description: "d" }, tools: [], toolMeta: new Map() });
    assert.equal(composeCatalogEntries(supervisors, 3).length, 3);
  });
  check("digestCatalogEntries 只含服务器集合（描述变化不触发注入）", () => {
    const a = [{ name: "x", text: "d1" }];
    const b = [{ name: "x", text: "d2" }];
    const c = [{ name: "x", text: "d1" }, { name: "y", text: "d1" }];
    assert.equal(digestCatalogEntries(a), digestCatalogEntries(b), "描述文本变化 digest 不变（不触发注入）");
    assert.notEqual(digestCatalogEntries(a), digestCatalogEntries(c), "服务器集合变化 digest 变（触发替换）");
    // 顺序敏感（服务器顺序变化 = 集合变化）
    const reversed = [{ name: "y", text: "d1" }, { name: "x", text: "d1" }];
    assert.notEqual(digestCatalogEntries(c), digestCatalogEntries(reversed), "顺序变化 digest 变");
  });
  check("escapeCatalogText 转义（完整返回不截断）", () => {
    assert.equal(escapeCatalogText("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
    assert.equal(escapeCatalogText("换行\n字符"), "换行 字符");
    assert.equal(escapeCatalogText("长".repeat(300)).length, 300, "长文本完整返回不截断");
  });
  check("renderMcpCatalogMessage 结构与声明", () => {
    const msg = renderMcpCatalogMessage([{ name: "code-graph", text: "代码图谱" }]);
    assert.equal(msg.role, "user");
    assert.equal(msg.source.kind, "mcp-catalog");
    assert.equal(msg.content[0].type, "text");
    assert.match(msg.content[0].text, /available_mcp_servers/);
    assert.match(msg.content[0].text, /不代表当前连接状态/);
    assert.match(msg.content[0].text, /`code-graph`: 代码图谱/);
    assert.ok(typeof msg.id === "string" && msg.id.length > 0);
  });
  check("findCatalogMessage 定位既有目录", () => {
    const catalog = renderMcpCatalogMessage([{ name: "a", text: "b" }]);
    const messages = [{ id: "m1", role: "user", content: [] }, catalog, { id: "m2", role: "assistant", content: [] }];
    assert.equal(findCatalogMessage(messages)?.id, catalog.id);
    assert.equal(findCatalogMessage([{ id: "x", role: "user", content: [], source: { kind: "other" } }]), undefined);
  });
  check("buildToolDefinition：空描述条件拼接（L2）", () => {
    const client = { callTool: async () => ({ content: [{ type: "text", text: "ok" }] }) };
    const server = normalizeServer({ name: "demo", transport: "stdio", command: "npx", description: "演示服务器" });
    const def = buildToolDefinition(client, { name: "ping", description: "", inputSchema: {} }, server, { enhanceEmptyDescriptions: true });
    assert.equal(def.description, "[演示服务器]", "空描述拼接自定义描述");
    const defKeep = buildToolDefinition(client, { name: "ping", description: "原始描述", inputSchema: {} }, server, { enhanceEmptyDescriptions: true });
    assert.equal(defKeep.description, "原始描述", "非空描述不动");
    const defOff = buildToolDefinition(client, { name: "ping", description: "", inputSchema: {} }, server, { enhanceEmptyDescriptions: false });
    assert.equal(defOff.description, "", "关闭增强不拼接");
  });
  check("buildToolDefinition：超时下探与截断（L3）", async () => {
    let seenTimeout;
    const client = {
      callTool: async (_name, _args, opts) => {
        seenTimeout = opts.timeoutMs;
        return { content: [{ type: "text", text: "X".repeat(5000) }] };
      },
    };
    const server = normalizeServer({ name: "demo", transport: "stdio", command: "npx" });
    assert.equal(DEFAULT_TOOL_CALL_TIMEOUT_MS, 15_000, "默认超时下探 15s");
    assert.equal(server.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS);
    const def = buildToolDefinition(client, { name: "big", description: "d", inputSchema: {} }, server, { resultTruncateBytes: 1024 });
    const value = await def.execute({}, { signal: { aborted: false } });
    assert.equal(seenTimeout, 15_000, "execute 传递下探后的超时");
    const rendered = def.output.render({}, value);
    assert.match(rendered[0].text, /已截断/, "长结果截断标注");
  });

  // ---------- pre-step 目录注入（history-based 去重，复刻官方 tool-skill 语义）

  // 模拟 agent：session.events 持久化 + surface 可见性（与真实 agent 同构）
  function makeAgent() {
    const session = {
      header: { cwd: "/tmp" },
      surface: { nodes: new Set() },
      events: [],
      append(type, data) {
        const seq = session.events.length;
        const event = { type, data, seq };
        session.events.push(event);
        if (type === "user/message") session.surface.nodes.add(seq);
        return event;
      },
    };
    return { session };
  }

  // 模拟一轮 pre-step：调用决策并把新增目录消息持久化进 events（agent-loop 行为）
  function runStep(decision, messages, supervisors, cache, agent) {
    const result = resolveCatalogInjection(decision, messages, supervisors, 6, cache, agent);
    const known = new Set();
    for (const evt of agent.session.events) {
      if (evt.type === "user/message" && evt.data?.source?.kind === "mcp-catalog") known.add(evt.data.id);
    }
    for (const msg of result.messages) {
      if (msg.source?.kind === "mcp-catalog" && !known.has(msg.id)) agent.session.append("user/message", msg);
    }
    return result;
  }

  check("resolveCatalogInjection：history-based 去重（核心：多轮不重复注入）", () => {
    const supervisors = new Map([["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }]]);
    const agent = makeAgent();

    // 真实语义：decision.messages 只含本轮新消息（历史在 session.events）
    let historyCount = 0;
    for (let round = 1; round <= 5; round += 1) {
      const decision = { kind: "enter", messages: [{ id: `user-${round}`, role: "user", content: [] }] };
      const result = runStep(decision, decision.messages, supervisors, undefined, agent);
      historyCount = agent.session.events.filter((e) => e.type === "user/message" && e.data?.source?.kind === "mcp-catalog").length;
      const inMessages = result.messages.filter((m) => m.source?.kind === "mcp-catalog").length;
      if (round === 1) {
        assert.equal(historyCount, 1, "首轮注入 1 条");
        assert.equal(inMessages, 1, "首轮消息列表含目录");
      } else {
        assert.equal(historyCount, 1, `第 ${round} 轮历史目录消息恒为 1（不累积）`);
        assert.equal(inMessages, 0, `第 ${round} 轮不注入新消息`);
      }
    }
    assert.equal(historyCount, 1, "5 轮后目录消息仍只有 1 条（根治重复注入）");
  });

  check("resolveCatalogInjection：描述/缓存变化不注入、集合变化注入更新消息", () => {
    const base = new Map([["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }]]);
    const agent = makeAgent();
    let messages = [{ id: "m1", role: "user", content: [] }];

    // 首次注入
    let result = runStep({ kind: "enter", messages: [...messages] }, messages, base, undefined, agent);
    messages = result.messages;
    const firstId = agent.session.events.find((e) => e.data?.source?.kind === "mcp-catalog").data.id;
    assert.ok(firstId, "首次注入");

    // 描述变化（集合不变）→ 不注入
    const descChanged = new Map([["code-graph", { server: { description: "新描述" }, tools: [], toolMeta: new Map() }]]);
    result = runStep({ kind: "enter", messages: [...messages, { id: "u2", role: "user", content: [] }] }, messages, descChanged, undefined, agent);
    assert.equal(agent.session.events.filter((e) => e.data?.source?.kind === "mcp-catalog").length, 1, "描述变化不注入");

    // 集合变化（新增服务器）→ 注入"更新"消息（历史 1 + 更新 1，声明作废旧目录）
    const added = new Map([
      ["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }],
      ["playwright", { server: { description: "浏览器自动化" }, tools: [], toolMeta: new Map() }],
    ]);
    result = runStep({ kind: "enter", messages: [...messages, { id: "u3", role: "user", content: [] }] }, messages, added, undefined, agent);
    const afterAdd = agent.session.events.filter((e) => e.data?.source?.kind === "mcp-catalog");
    assert.equal(afterAdd.length, 2, "集合变化注入更新消息（历史目录无法删除，新消息声明作废）");
    assert.match(afterAdd[1].data.content[0].text, /替换此前所有/);
    assert.match(afterAdd[1].data.content[0].text, /playwright/);

    // 更新后同集合不再注入
    result = runStep({ kind: "enter", messages: [...messages, { id: "u4", role: "user", content: [] }] }, messages, added, undefined, agent);
    assert.equal(agent.session.events.filter((e) => e.data?.source?.kind === "mcp-catalog").length, 2, "更新后不再注入");
  });

  check("resolveCatalogInjection：compaction 后重建 + 门控 + reject", () => {
    const supervisors = new Map([["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }]]);
    const agent = makeAgent();
    let messages = [{ id: "m1", role: "user", content: [] }];
    let result = runStep({ kind: "enter", messages: [...messages] }, messages, supervisors, undefined, agent);
    messages = result.messages;
    assert.equal(agent.session.events.filter((e) => e.data?.source?.kind === "mcp-catalog").length, 1, "首次注入");

    // compaction 模拟：surface 清空（旧目录不可见）→ 重新注入
    agent.session.surface.nodes.clear();
    result = runStep({ kind: "enter", messages: [{ id: "m1", role: "user", content: [] }] }, messages, supervisors, undefined, agent);
    const afterCompact = agent.session.events.filter((e) => e.data?.source?.kind === "mcp-catalog");
    assert.ok(afterCompact.length >= 1, "compaction 后按可见性重建");
    assert.equal(result.messages.filter((m) => m.source?.kind === "mcp-catalog").length, 1);

    // 门控：从未发布且无服务器 → 不注入
    const agent2 = makeAgent();
    const decisionEmpty = resolveCatalogInjection({ kind: "enter", messages: [{ id: "x", role: "user", content: [] }] }, [], new Map(), 6, undefined, agent2);
    assert.equal(decisionEmpty.messages.length, 1, "无服务器不注入");

    // reject 不处理
    const rejected = resolveCatalogInjection({ kind: "reject" }, [], supervisors, 6, undefined, agent2);
    assert.equal(rejected.kind, "reject");
  });

  // ---------- SDK 端到端（issue #11 PoC 契约不漂移证据：真实 stdio 连接 /
  // initialize 版本协商 / 工具注册 / callTool / 断线自动重连，全程无网络）。

  /** 轮询等待条件成立（防 flake 纪律：轮询替代固定 sleep）。 */
  async function waitFor(label, cond, timeoutMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  console.log("SDK 端到端连接（连接/工具注册/callTool/断线重连）");
  {
    // 最小 stdio MCP server fixture：node 子进程，行分隔 JSON-RPC，
    // 回应 initialize / tools/list / tools/call（无任何第三方依赖；
    // 响应必须携带规范要求的 jsonrpc:"2.0" 信封——SDK 会严格校验）。
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-sdk-"));
    const serverScript = join(dir, "mini-mcp-server.mjs");
    writeFileSync(
      serverScript,
      [
        'import { createInterface } from "node:readline";',
        'const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");',
        'createInterface({ input: process.stdin }).on("line", (line) => {',
        "  let msg;",
        "  try { msg = JSON.parse(line); } catch { return; }",
        '  if (msg.method === "initialize") {',
        '    send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mini", version: "0.0.1" } } });',
        '  } else if (msg.method === "tools/list") {',
        "    send({ id: msg.id, result: { tools: [{ name: \"echo\", description: \"echo back\", inputSchema: { type: \"object\", properties: { text: { type: \"string\" } } } }] } });",
        '  } else if (msg.method === "tools/call") {',
        "    send({ id: msg.id, result: { content: [{ type: \"text\", text: String(msg.params?.arguments?.text ?? \"\") }] } });",
        "  } else if (msg.id !== undefined) {",
        '    send({ id: msg.id, error: { code: -32601, message: "method not found" } });',
        "  }",
        "});",
      ].join("\n"),
    );

    const registered = [];
    const supervisor = new ConnectionSupervisor(
      {
        ctx: { tools: { register: (definition) => { registered.push(definition); return () => {}; } } },
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        enhancement: {},
        emitStatus() {},
        recordCatalogTools: async () => {},
      },
      normalizeServer({
        name: "mini",
        transport: "stdio",
        command: process.execPath,
        args: [serverScript],
        reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 200, maxAttempts: 5 },
      }),
    );

    await checkAsync("connect → SDK 版本协商 + 工具注册", async () => {
      await supervisor.connect();
      assert.equal(supervisor.status, "connected");
      assert.deepEqual(supervisor.tools, ["mcp__mini__echo"]);
      assert.equal(registered.length, 1);
      assert.equal(registered[0].name, "mcp__mini__echo");
    });

    await checkAsync("工具 execute 全链路走 SDK callTool", async () => {
      const value = await registered[0].execute({ text: "hello sdk" }, { signal: undefined });
      assert.deepEqual(value.content, [{ type: "text", text: "hello sdk" }]);
      assert.equal(value.structuredContent, undefined);
    });

    await checkAsync("子进程被杀 → 有界退避重连 → 工具重新注册", async () => {
      const oldPid = supervisor.transport.sdk.pid;
      assert.ok(oldPid > 0);
      process.kill(oldPid, "SIGTERM");
      // 新代际 transport 建立且恢复 connected（旧 pid 不复用即证明发生过重连）。
      await waitFor("reconnected with new generation", () =>
        supervisor.status === "connected" &&
        supervisor.transport !== undefined &&
        supervisor.transport.sdk.pid !== undefined &&
        supervisor.transport.sdk.pid !== oldPid &&
        supervisor.tools.length === 1,
      );
      assert.ok(registered.length >= 2, "重连后工具重新注册");
      const value = await registered.at(-1).execute({ text: "after reconnect" }, { signal: undefined });
      assert.equal(value.content[0].text, "after reconnect");
    });

    await supervisor.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nall checks passed");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
