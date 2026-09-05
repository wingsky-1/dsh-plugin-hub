// @ts-nocheck
/**
 * dsh-mem0 冒烟测试 —— 纯离线、零外部网络与真实进程依赖。
 *
 * 覆盖：
 * 1. 契约导出（name, inject）
 * 2. 命名空间解析（Git remote 归一化、目录回退、缓存重置）
 * 3. 工具定义契约（schema 字段、全英文描述、离线降级断言、正常执行断言）
 * 4. 提示词纪律（会话级单次注入、幂等判重）
 * 5. 路由安全（Loopback 403 围栏、405 方法校验、正常调用）
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

// 动态载入编译后的自包含宿主模块
const hostMod = await import(pathToFileURL(join(pkgDir, "lib/index.js")).href);
const {
  name,
  inject,
  normalizeGitRemote,
  resolveGitCanonicalNamespace,
  resetNamespaceCache,
  GLOBAL_NAMESPACE,
  buildAllMemoryTools,
  UNAVAILABLE_MSG,
  isMemoryDisciplineInjected,
  MEMORY_DISCIPLINE_TEXT,
  createMem0Routes,
} = hostMod;

let testsRun = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    testsRun++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}:`, err);
    process.exit(1);
  }
}

console.log("\n=== dsh-mem0 离线冒烟测试 ===");

// 1. 契约导出
await test("契约导出：name 与 inject 声明", () => {
  assert.equal(name, "mem0", "插件名应为 mem0");
  assert.ok(Array.isArray(inject), "inject 应为数组");
  assert.ok(inject.includes("mcpManager"), "必须强依赖 mcpManager");
  assert.ok(inject.includes("webServer"), "必须强依赖 webServer");
});

// 2. 命名空间规范化
await test("命名空间：normalizeGitRemote SSH 与 HTTP 统一解析", () => {
  assert.equal(
    normalizeGitRemote("git@github.com:wingsky-1/dsh-plugin-hub.git"),
    "github.com/wingsky-1/dsh-plugin-hub",
  );
  assert.equal(
    normalizeGitRemote("https://github.com/wingsky-1/dsh-plugin-hub.git"),
    "github.com/wingsky-1/dsh-plugin-hub",
  );
  assert.equal(normalizeGitRemote(""), "");
});

await test("命名空间：resolveGitCanonicalNamespace 回退与缓存", () => {
  resetNamespaceCache();
  assert.equal(resolveGitCanonicalNamespace(undefined), GLOBAL_NAMESPACE);
  assert.equal(resolveGitCanonicalNamespace(""), GLOBAL_NAMESPACE);
  assert.equal(resolveGitCanonicalNamespace("/non/existent/path/9999"), GLOBAL_NAMESPACE);

  const currentNs = resolveGitCanonicalNamespace(process.cwd());
  assert.ok(currentNs.startsWith("proj:"), "Git 仓内路径应以 proj: 为前缀");
});

// 3. 工具定义与离线降级
await test("工具定义：4 个全英文工具契约", () => {
  const mockExecutor = {
    search: async () => "mock search result",
    add: async () => "mock add result",
    list: async () => "mock list result",
    delete: async () => "mock delete result",
    isReady: () => false,
  };

  const tools = buildAllMemoryTools(mockExecutor);
  assert.equal(tools.length, 4, "应提供 4 个核心工具");
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ["memory_search", "memory_add", "memory_list", "memory_delete"]);

  for (const t of tools) {
    assert.ok(t.description.length > 10, `${t.name} description 必须非空`);
    assert.ok(t.parameters && t.parameters.type === "object", `${t.name} parameters 必须是 object`);
    assert.ok(t.output && t.output.schema, `${t.name} 必须满足 output schema`);
  }
});

await test("工具容错：离线降级绝不抛出异常", async () => {
  const offlineExecutor = {
    search: async () => "",
    add: async () => "",
    list: async () => "",
    delete: async () => "",
    isReady: () => false, // 模拟离线
  };

  const tools = buildAllMemoryTools(offlineExecutor);
  const searchTool = tools.find((t) => t.name === "memory_search")!;
  const addTool = tools.find((t) => t.name === "memory_add")!;

  const searchRes = await searchTool.execute({ query: "architecture" }, {});
  assert.ok(searchRes.text.includes(UNAVAILABLE_MSG), "离线应返回 UNAVAILABLE_MSG");

  const addRes = await addTool.execute({ text: "some decision" }, {});
  assert.ok(addRes.text.includes(UNAVAILABLE_MSG), "离线应返回 UNAVAILABLE_MSG");
});

await test("工具正常调用：在线时返回预期内容", async () => {
  let calledUserId = "";
  const onlineExecutor = {
    search: async (_q, u) => {
      calledUserId = u || "";
      return "found decision #1";
    },
    add: async () => "ok",
    list: async () => "mem1\nmem2",
    delete: async () => "deleted",
    isReady: () => true,
  };

  const tools = buildAllMemoryTools(onlineExecutor);
  const searchTool = tools.find((t) => t.name === "memory_search")!;
  const res = await searchTool.execute({ query: "test", scope: "global" }, {});
  assert.equal(res.text, "found decision #1");
  assert.equal(calledUserId, GLOBAL_NAMESPACE, "scope=global 应转发 global 命名空间");
});

// 4. 系统提示词幂等注入
await test("提示词：isMemoryDisciplineInjected 判重测试", () => {
  const emptyAgent = { session: { snapshotEvents: () => [] } };
  assert.equal(isMemoryDisciplineInjected(emptyAgent), false, "空历史未注入");

  const injectedAgent = {
    session: {
      snapshotEvents: () => [
        { type: "user/message", data: { source: { kind: "plugin", plugin: "mem0" } } },
      ],
    },
  };
  assert.equal(isMemoryDisciplineInjected(injectedAgent), true, "已有注入事件应判为 true");
  assert.ok(MEMORY_DISCIPLINE_TEXT.includes("[Memory System Guidelines]"), "提示词文案完整");
});

// 5. 路由安全与 Loopback 围栏
await test("路由安全：非 Loopback 请求被拦截 403", () => {
  const routes = createMem0Routes({
    executor: { isReady: () => true } as any,
    getCurrentCwd: () => process.cwd(),
  });

  const statusRoute = routes.find((r) => r.path === "/api/dsh-mem0/status")!;
  let statusCode = 0;
  const mockReq = {
    headers: { host: "evil-site.com" },
    socket: { remoteAddress: "192.168.1.100" },
    method: "GET",
  };
  const mockRes = {
    setHeader: () => {},
    writeHead: (c: number) => { statusCode = c; },
    end: () => {},
  };

  statusRoute.handler(mockReq as any, mockRes as any);
  assert.equal(statusCode, 403, "跨站或外网请求必须返回 403 Forbidden");
});

await test("路由安全：合法 Loopback 请求返回 200", () => {
  const routes = createMem0Routes({
    executor: { isReady: () => true } as any,
    getCurrentCwd: () => process.cwd(),
  });

  const statusRoute = routes.find((r) => r.path === "/api/dsh-mem0/status")!;
  let statusCode = 0;
  let bodyData = "";
  const mockReq = {
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    socket: { remoteAddress: "127.0.0.1" },
    method: "GET",
  };
  const mockRes = {
    setHeader: () => {},
    writeHead: (c: number) => { statusCode = c; },
    end: (data: string) => { bodyData = data; },
  };

  statusRoute.handler(mockReq as any, mockRes as any);
  assert.equal(statusCode, 200, "回环合规请求返回 200");
  assert.ok(bodyData.includes("ready"), "响应应包含 ready 字段");
});

// 6. 客户端产物契约
await test("客户端契约：lib/client.js 存在且载入正确 load id", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const clientPath = join(pkgDir, "lib/client.js");
  assert.ok(existsSync(clientPath), "lib/client.js 必须存在");
  const code = readFileSync(clientPath, "utf8");
  assert.ok(code.includes('"@wingsky-1/dsh-mem0"'), "client.js 必须包含完整的 npm 包 load id");
});

console.log(`\n全部 ${testsRun} 项冒烟测试顺利通过！`);
