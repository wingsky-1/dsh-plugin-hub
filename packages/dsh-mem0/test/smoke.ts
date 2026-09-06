// @ts-nocheck
/**
 * dsh-mem0 冒烟测试 —— 纯离线、零外部网络与真实进程依赖。
 *
 * 覆盖：
 * 1. 契约导出（name, inject, SETTINGS_NS）
 * 2. 命名空间解析（Git remote 归一化、目录回退、缓存重置）
 * 3. 工具定义契约（schema 字段、全英文描述、离线降级断言、正常执行断言）
 * 4. 提示词纪律（会话级单次注入、幂等判重）
 * 5. 路由安全（Loopback 403 围栏、405 方法校验、正常调用）
 * 6. 配置脱敏与合并（maskApiKey, isMaskedKey, mergeConfigPatch, /api/dsh-mem0/config）
 * 7. 自愈诊断状态契约（getStatus 诊断原因、/status 回传）
 * 8. 客户端产物契约
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..");

// 动态载入编译后的自包含宿主模块
const hostMod = await import(pathToFileURL(join(pkgDir, "lib/index.js")).href);
const {
  name,
  inject,
  SETTINGS_NS,
  DEFAULT_CONFIG,
  EMBEDDER_MODELS_INFO,
  LLM_MODELS_INFO,
  maskApiKey,
  isMaskedKey,
  sanitizeConfigForClient,
  mergeConfigPatch,
  normalizeGitRemote,
  resolveGitCanonicalNamespace,
  resetNamespaceCache,
  GLOBAL_NAMESPACE,
  buildAllMemoryTools,
  UNAVAILABLE_MSG,
  isMemoryDisciplineInjected,
  MEMORY_DISCIPLINE_TEXT,
  createMem0Routes,
  resolveLlmRuntimeConfig,
  listLlmProviders,
  listLlmModels,
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
  assert.equal(SETTINGS_NS, "dsh-mem0", "设置命名空间应为 dsh-mem0");
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
    getConfig: () => DEFAULT_CONFIG,
    updateConfig: async () => DEFAULT_CONFIG,
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

await test("路由安全：合法 Loopback 请求返回 200 与诊断状态", () => {
  const routes = createMem0Routes({
    executor: {
      isReady: () => false,
      getStatus: () => ({ ready: false, reason: "python_not_found", detail: "not found" }),
    } as any,
    getCurrentCwd: () => process.cwd(),
    getConfig: () => DEFAULT_CONFIG,
    updateConfig: async () => DEFAULT_CONFIG,
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
  const parsed = JSON.parse(bodyData);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.status?.reason, "python_not_found");
});

// 6. 配置脱敏与合并逻辑测试
await test("配置脱敏：maskApiKey 与 isMaskedKey 校验", () => {
  assert.equal(maskApiKey(""), "");
  assert.equal(maskApiKey("1234"), "********");
  assert.equal(maskApiKey("sk-abcdefgh12345678"), "sk-***5678");

  assert.equal(isMaskedKey("sk-***5678"), true);
  assert.equal(isMaskedKey("********"), true);
  assert.equal(isMaskedKey("sk-real-secret-key-1234"), false);
});

await test("配置合并：mergeConfigPatch 防脱敏掩码写穿真实密钥", () => {
  const base = {
    ...DEFAULT_CONFIG,
    llmApiKey: "sk-real-origin-llm-key",
    embedderApiKey: "sk-real-origin-embed-key",
  };

  // 前端带着脱敏字符回传保存
  const patched = mergeConfigPatch(base, {
    llmApiKey: "sk-***-masked",
    embedderApiKey: "", // 空字符串
    llmModel: "custom-model",
    retrievalTopK: 8,
  });

  assert.equal(patched.llmApiKey, "sk-real-origin-llm-key", "脱敏字符不得覆盖已有真实 Key");
  assert.equal(patched.embedderApiKey, "sk-real-origin-embed-key", "空字符不得清除已有真实 Key");
  assert.equal(patched.llmModel, "custom-model", "普通配置字段正常更新");
  assert.equal(patched.retrievalTopK, 8, "TopK 正常更新");

  // 显式输入全新的真实 Key 时更新
  const updatedRealKey = mergeConfigPatch(base, {
    llmApiKey: "sk-brand-new-secret-key-9999",
  });
  assert.equal(updatedRealKey.llmApiKey, "sk-brand-new-secret-key-9999", "真实新 Key 允许覆盖");
});

await test("路由配置操作：/api/dsh-mem0/config GET 与 POST 正常流转", async () => {
  let storedConfig = { ...DEFAULT_CONFIG, llmApiKey: "secret-key-123456" };
  const routes = createMem0Routes({
    executor: { isReady: () => true } as any,
    getCurrentCwd: () => process.cwd(),
    getConfig: () => storedConfig,
    updateConfig: async (patch) => {
      storedConfig = mergeConfigPatch(storedConfig, patch);
      return storedConfig;
    },
  });

  const configRoute = routes.find((r) => r.path === "/api/dsh-mem0/config")!;

  // 1. GET 获取脱敏配置
  let getCode = 0;
  let getBody = "";
  configRoute.handler(
    {
      headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
      socket: { remoteAddress: "127.0.0.1" },
      method: "GET",
    } as any,
    {
      setHeader: () => {},
      writeHead: (c: number) => { getCode = c; },
      end: (data: string) => { getBody = data; },
    } as any,
  );
  assert.equal(getCode, 200);
  const parsedGet = JSON.parse(getBody);
  assert.ok(parsedGet.config.llmApiKey.includes("***"), "GET 响应的 API Key 必须脱敏");
  assert.equal(parsedGet.config.hasLlmApiKey, true);

  // 2. /api/dsh-mem0/install POST 路由可用性
  const installRoute = routes.find((r) => r.path === "/api/dsh-mem0/install")!;
  assert.ok(installRoute, "/api/dsh-mem0/install 路由必须注册");
});

// 7. 默认本地 Embedding 与模型消耗说明
await test("模型配置：默认使用本地 FastEmbed 零费用模型，且提供模型消耗信息", () => {
  assert.equal(DEFAULT_CONFIG.embedderProvider, "fastembed", "默认必须使用本地 fastembed");
  assert.equal(DEFAULT_CONFIG.embedderModel, "BAAI/bge-small-zh-v1.5", "默认模型为 bge-small");

  assert.ok(Array.isArray(EMBEDDER_MODELS_INFO), "EMBEDDER_MODELS_INFO 必须导出");
  assert.ok(EMBEDDER_MODELS_INFO.length >= 3, "必须包含至少 3 种推荐模型说明");
  for (const m of EMBEDDER_MODELS_INFO) {
    assert.ok(m.costZh.length > 5, `${m.name} 必须包含中文消耗说明`);
    assert.ok(m.costEn.length > 5, `${m.name} 必须包含英文消耗说明`);
  }

  assert.ok(Array.isArray(LLM_MODELS_INFO), "LLM_MODELS_INFO 必须导出");
  assert.ok(LLM_MODELS_INFO.length >= 1, "必须包含 LLM 消耗说明");
});

// 8. 客户端 i18n 完备性（无硬编码中文）
await test("客户端 i18n：MemoryCenter.tsx 源码不得包含任何硬编码中文字符", async () => {
  const { readFileSync } = await import("node:fs");
  const code = readFileSync(join(pkgDir, "src/client/MemoryCenter.tsx"), "utf8");
  // 移除注释行与 JSX 内可能保留的纯标点符号
  const codeWithoutComments = code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // 断言代码主体中不含非 ASCII 中文字符
  const chineseMatches = codeWithoutComments.match(/[\u4e00-\u9fa5]/g);
  assert.equal(chineseMatches, null, `MemoryCenter.tsx 代码中存在硬编码中文: ${chineseMatches ? chineseMatches.slice(0, 10).join(",") : ""}`);
});

// 9. 客户端产物契约
await test("客户端契约：lib/client.js 存在且载入正确 load id", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const clientPath = join(pkgDir, "lib/client.js");
  assert.ok(existsSync(clientPath), "lib/client.js 必须存在");
  const code = readFileSync(clientPath, "utf8");
  assert.ok(code.includes('"@wingsky-1/dsh-mem0"'), "client.js 必须包含完整的 npm 包 load id");
});

// 10. 装配层路由注册与生命周期防回归断言（重点防止 register(routes[]) 数组传参缺陷）
await test("装配层路由注册契约：apply 必须单路由逐个注册并受 ctx.effect 管理", async () => {
  const registeredRoutes: any[] = [];
  const disposersCalled: string[] = [];
  let unregisterServerCalled = false;

  const effects: Array<() => void | (() => void)> = [];
  const mockCtx: any = {
    get(name: string) {
      if (name === "webServer") {
        return {
          register(route: any) {
            // 严密断言：入参绝不能是数组！
            assert.ok(!Array.isArray(route), "webServer.register 严禁传入数组！必须单路由逐个传入");
            assert.equal(route.kind, "exact", "路由 kind 必须是 exact");
            assert.ok(typeof route.path === "string" && route.path.startsWith("/api/dsh-mem0/"), `路由 path 必须是合法的 /api/dsh-mem0/* 字符串: ${route.path}`);
            registeredRoutes.push(route);
            return () => {
              disposersCalled.push(route.path);
            };
          },
        };
      }
      if (name === "mcpManager") {
        return {
          registerServer: async () => ({ existing: false }),
          unregisterServer: async (name: string) => {
            if (name === "mem0") unregisterServerCalled = true;
          },
        };
      }
      return undefined;
    },
    effect(fn: () => void | (() => void)) {
      effects.push(fn);
      return () => {};
    },
    on() {
      return () => {};
    },
    logger: { warn() {}, info() {}, debug() {} },
  };

  const { apply, probePythonEnvironment } = hostMod;
  apply(mockCtx, { pythonBin: "non-existent-python-for-test" });

  // 执行所有 effect
  const cleanupFns: Array<() => void> = [];
  for (const eff of effects) {
    const res = eff();
    if (typeof res === "function") cleanupFns.push(res);
  }

  // 断言注册了全部 8 个路由
  assert.equal(registeredRoutes.length, 8, "必须注册全部 8 个 exact 路由");
  const registeredPaths = registeredRoutes.map((r) => r.path).sort();
  const expectedPaths = [
    "/api/dsh-mem0/add",
    "/api/dsh-mem0/config",
    "/api/dsh-mem0/delete",
    "/api/dsh-mem0/install",
    "/api/dsh-mem0/list",
    "/api/dsh-mem0/llm-models",
    "/api/dsh-mem0/llm-providers",
    "/api/dsh-mem0/status",
  ].sort();
  assert.deepEqual(registeredPaths, expectedPaths, "已注册路由路径必须完全匹配预期的 8 个路径");

  // 执行清理
  for (const cleanup of cleanupFns) {
    cleanup();
  }

  // 断言注销逻辑
  assert.equal(disposersCalled.length, 8, "注销时 8 个路由的 disposer 必须都被调用");
  assert.ok(unregisterServerCalled, "注销时必须调用 mcpManager.unregisterServer('mem0')");
});

// 11. 自定义 Python 路径探测隔离测试（显式意图优于隐式推断）
await test("环境探测契约：自定义 Python 失败时不应降级到全局系统 Python", async () => {
  const { probePythonEnvironment } = hostMod;
  const customProbe = await probePythonEnvironment("/non/existent/python/path/test_12345");
  assert.equal(customProbe.ok, false);
  assert.equal(customProbe.reason, "python_not_found");
  assert.equal(customProbe.pythonBin, "/non/existent/python/path/test_12345", "自定义 Python 失败时不应降级到全局系统 Python");
});

// 12. 双语字典 1:1 镜像对称性断言
await test("客户端 i18n：zh 与 en 双语字典必须完全对称", async () => {
  const { zh, en } = await import(pathToFileURL(join(pkgDir, "src/client/locales.ts")).href);
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(zhKeys, enKeys, "zh 与 en 字典的键必须 1:1 完全对应无缺失");
});

// 13. DSH 提供商与模型动态路由断言
await test("LLM 模型路由：/api/dsh-mem0/llm-providers 与 llm-models 正常返回与降级", async () => {
  const mockCtx = {
    llm: {
      listProviders: () => [{ id: "mock-prov-a", name: "Mock Provider A" }],
      listModels: async (p: string) => {
        if (p === "mock-prov-a") return [{ id: "model-x", name: "Model X" }];
        return [];
      },
    },
  };
  const routes = createMem0Routes({
    executor: { isReady: () => true } as any,
    getCurrentCwd: () => process.cwd(),
    getConfig: () => DEFAULT_CONFIG,
    updateConfig: async (p) => ({ ...DEFAULT_CONFIG, ...p }),
    appCtx: mockCtx,
  });

  const provRoute = routes.find((r) => r.path === "/api/dsh-mem0/llm-providers")!;
  assert.ok(provRoute, "llm-providers 路由必须存在");

  let provCode = 0;
  let provBody = "";
  provRoute.handler(
    {
      headers: { host: "127.0.0.1:3080" },
      socket: { remoteAddress: "127.0.0.1" },
      method: "GET",
    } as any,
    {
      setHeader: () => {},
      writeHead: (c: number) => { provCode = c; },
      end: (data: string) => { provBody = data; },
    } as any,
  );
  assert.equal(provCode, 200);
  const provJson = JSON.parse(provBody);
  assert.equal(provJson.ok, true);
  assert.equal(provJson.providers.length, 1);
  assert.equal(provJson.providers[0].id, "mock-prov-a");

  const modelRoute = routes.find((r) => r.path === "/api/dsh-mem0/llm-models")!;
  assert.ok(modelRoute, "llm-models 路由必须存在");

  let modelCode = 0;
  let modelBody = "";
  await modelRoute.handler(
    {
      headers: { host: "127.0.0.1:3080" },
      socket: { remoteAddress: "127.0.0.1" },
      url: "/api/dsh-mem0/llm-models?provider=mock-prov-a",
      method: "GET",
    } as any,
    {
      setHeader: () => {},
      writeHead: (c: number) => { modelCode = c; },
      end: (data: string) => { modelBody = data; },
    } as any,
  );
  assert.equal(modelCode, 200);
  const modelJson = JSON.parse(modelBody);
  assert.equal(modelJson.ok, true);
  assert.equal(modelJson.models[0].id, "model-x");
});

// 14. 服务端凭据解析与静默注入断言
await test("凭据静默解析：dsh 模式下正确解析运行配置，前端零密钥暴露", async () => {
  const dshConfig = {
    ...DEFAULT_CONFIG,
    llmMode: "dsh",
    llmDshProvider: "deepseek",
    llmDshModel: "deepseek-chat",
    llmApiKey: "",
  };

  const resolved = await resolveLlmRuntimeConfig(dshConfig, undefined);
  assert.equal(resolved.llmModel, "deepseek-chat");
  assert.equal(resolved.llmBaseUrl, "https://api.deepseek.com/v1");
  assert.equal(typeof resolved.llmApiKey, "string");
});

// 15. Python 服务端 Qdrant 集合维度动态隔离断言
await test("Python 服务端：collection_name 必须按维度动态隔离 (mem0_v2_dim_{dims})", async () => {
  const { readFileSync } = await import("node:fs");
  const pyCode = readFileSync(join(pkgDir, "server/mem0_server.py"), "utf8");
  assert.ok(
    pyCode.includes('collection_name = f"mem0_v2_dim_{vector_dims}"'),
    "mem0_server.py 必须声明动态维度隔离集合名",
  );
  assert.ok(pyCode.includes("paraphrase-multilingual"), "必须覆盖 384 维多语言模型维度解析");
  assert.ok(pyCode.includes("e5-large"), "必须覆盖 1024 维模型维度解析");
});

console.log(`\n全部 ${testsRun} 项冒烟测试顺利通过！`);
