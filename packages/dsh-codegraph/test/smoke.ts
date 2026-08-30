// @ts-nocheck
// dsh-codegraph 冒烟测试 —— 无外部依赖、不发起真实网络/进程连接。
//
// 覆盖：
//   - 契约导出（name / inject）
//   - isCodegraphInstalled（PATH 探测分支）
//   - installGuidance（引导文案含安装命令）
//   - findGitRoot / isGitRepo（.git 目录 / .git 文件(worktree) / 非 git 三分支）
//   - shouldInject（cwd 判定）
//   - guardedExplore（无 projectPath → 补全/拒绝；无索引 → 引导；sync 失败 → 拒绝）
//   - 工具注册定义（#356 回归）：buildGuardToolDefinition 字段名契约
//     （parameters 而非 inputSchema）+ 真实 dsh-tools 注册投影不抛错
//   - apply（enabled:false / 不读 ctx.session 回归 / 探测未装引导 / 注册 / 纪律工具注册）
//
// 运行：node dsh-codegraph/test/smoke.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const pkgDir = join(new URL("..", import.meta.url).pathname);
const mod = await import(pathToFileURL(join(pkgDir, "lib/index.js")).href);
const { apply, name, inject } = mod;
const { isCodegraphInstalled, installGuidance } = mod;
const { findGitRoot, isGitRepo, guardedExplore } = mod;
const { shouldInject, DISCIPLINE_TEXT } = mod;
const { buildGuardToolDefinition } = mod;

// 解析真实 dsh-tools + cordis（#356 回归投影断言用）。
// 候选顺序：依赖树解析 → DSH_TOOLS_PATH / DSH_CORDIS_PATH 环境变量 → Volta 全局
// 安装布局。全部失败时警告而非静默跳过（避免"测试通过但覆盖缺失"的假象）。
// 先例：dsh-mcp-manager test/smoke.ts 的 dsh-tools 解析（同款候选策略）。
async function resolveModule(name, envVar) {
  const candidates = [];
  try {
    candidates.push(import.meta.resolve(name));
  } catch {
    // 不在依赖树，继续尝试其他候选
  }
  if (typeof process.env[envVar] === "string" && process.env[envVar] !== "") {
    candidates.push(pathToFileURL(process.env[envVar]).href);
  }
  try {
    const voltaPackages = join(dirname(dirname(dirname(process.execPath))), "packages");
    candidates.push(pathToFileURL(join(voltaPackages, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", name, "lib", "index.js")).href);
  } catch {
    // 非 Volta 环境，跳过布局候选
  }
  let lastError;
  for (const url of candidates) {
    try {
      return await import(url);
    } catch (error) {
      lastError = error;
    }
  }
  return { error: lastError };
}

const failures = [];
function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.error(`FAIL ${label}: ${error.message}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.error(`FAIL ${label}: ${error.message}`);
  }
}

// ---- 契约 ----
check("契约: name = codegraph", () => assert.equal(name, "codegraph"));
check("契约: inject 包含 agents", () => assert.ok(inject.includes("agents")));

// ---- 工具注册定义（#356 回归）----
// 根因：注册定义误用 MCP 风格字段 inputSchema，而 dsh-tools 契约要求 parameters，
// 导致 schema 投影时 parameters===undefined → 抛 "must be lossless JSON"。
{
  const definition = buildGuardToolDefinition();
  check("工具定义: 使用 parameters 字段（非 inputSchema，#356）", () => {
    assert.ok(definition.parameters, "parameters 必须存在");
    assert.equal(definition.inputSchema, undefined, "inputSchema 不应存在");
  });
  check("工具定义: parameters 为合法对象 schema", () => {
    assert.equal(definition.parameters.type, "object");
    assert.ok(definition.parameters.properties.query, "query 属性存在");
    assert.ok(definition.parameters.properties.projectPath, "projectPath 属性存在");
    assert.deepEqual(definition.parameters.required, ["query"]);
  });
  check("工具定义: output 契约完整（schema + render）", () => {
    assert.ok(definition.output, "output 必须存在");
    assert.ok(definition.output.schema, "output.schema 必须存在");
    assert.equal(typeof definition.output.render, "function", "output.render 必须是函数");
  });

  // 真实 dsh-tools 注册 + 投影：注册定义后调用 schemas() 不抛错（堵住 mock 盲区——
  // 此前 smoke 的 tools.register 是 mock，不触发真实 schemaOf 投影，契约字段错误溜过门禁）。
  checkAsync("工具定义: 真实 dsh-tools 注册 + schemas() 投影不抛错（#356 回归）", async () => {
    const dshTools = await resolveModule("@deepseek-ai/dsh-tools", "DSH_TOOLS_PATH");
    const cordis = await resolveModule("@deepseek-ai/cordis", "DSH_CORDIS_PATH");
    if (dshTools.error || cordis.error) {
      console.warn(`smoke: @deepseek-ai/dsh-tools / @deepseek-ai/cordis 不可解析（dsh-tools: ${dshTools.error?.message ?? "无候选"}；cordis: ${cordis.error?.message ?? "无候选"}）——真实投影断言跳过；可设置 DSH_TOOLS_PATH / DSH_CORDIS_PATH`);
      return;
    }
    const { Context } = cordis;
    const ToolRuntime = dshTools.default ?? dshTools.ToolRuntime;
    const ctx = new Context();
    ctx.provide("systemPrompt", {
      tools: () => () => {},
      section: () => () => {},
    });
    const tools = new ToolRuntime(ctx, { mode: "native" });
    tools.register(buildGuardToolDefinition());
    const schemas = tools.schemas();
    assert.equal(schemas.length, 1, "投影出 1 个工具");
    assert.equal(schemas[0].name, "codegraph_explore");
    assert.ok(schemas[0].parameters, "投影 parameters 存在");
    assert.equal(schemas[0].parameters.properties.query.type, "string");
  });
}

// ---- install.ts ----
{
  // PATH 含 codegraph → 已装
  const dir = mkdtempSync(join(tmpdir(), "cg-install-"));
  writeFileSync(join(dir, "codegraph"), "#!/bin/sh\n");
  check("isCodegraphInstalled: PATH 命中", () =>
    assert.equal(isCodegraphInstalled({ PATH: dir }), true),
  );
  // PATH 不含 → 未装
  check("isCodegraphInstalled: PATH 未命中", () =>
    assert.equal(isCodegraphInstalled({ PATH: "/nonexistent" }), false),
  );
  check("installGuidance 含安装命令", () =>
    assert.ok(installGuidance("npm i -g x").includes("npm i -g x")),
  );
  rmSync(dir, { recursive: true, force: true });
}

// ---- guard.ts ----
{
  const dir = mkdtempSync(join(tmpdir(), "cg-guard-"));
  // git 目录
  mkdirSync(join(dir, "repo", ".git"), { recursive: true });
  // worktree（.git 是文件）
  mkdirSync(join(dir, "wt"), { recursive: true });
  writeFileSync(join(dir, "wt", ".git"), "gitdir: ../repo/.git/worktrees/wt\n");
  // 非 git
  mkdirSync(join(dir, "nongit"), { recursive: true });

  check("findGitRoot: git 目录", () => assert.equal(findGitRoot(join(dir, "repo")), join(dir, "repo")));
  check("findGitRoot: 子目录向上命中", () => assert.equal(findGitRoot(join(dir, "repo", "sub")), join(dir, "repo")));
  check("findGitRoot: worktree（.git 文件）", () => assert.equal(findGitRoot(join(dir, "wt")), join(dir, "wt")));
  check("findGitRoot: 非 git 返回 undefined", () => assert.equal(findGitRoot(join(dir, "nongit")), undefined));
  check("isGitRepo: 非 git false", () => assert.equal(isGitRepo(join(dir, "nongit")), false));
  check("shouldInject: git 仓 true", () => assert.equal(shouldInject(join(dir, "repo")), true));
  check("shouldInject: 非 git false", () => assert.equal(shouldInject(join(dir, "nongit")), false));

  // guardedExplore：无 projectPath + 非 git cwd → 拒绝
  checkAsync("guardedExplore: 无 projectPath 非 git → 拒绝", async () => {
    const out = await guardedExplore({ query: "x" }, join(dir, "nongit"));
    assert.ok(out.includes("被纪律拦截"), `实际: ${out.slice(0, 50)}`);
  });
  // guardedExplore：有 projectPath 但无索引 → 引导 init
  checkAsync("guardedExplore: 有 projectPath 无索引 → 引导", async () => {
    const out = await guardedExplore({ query: "x", projectPath: join(dir, "repo") });
    assert.ok(out.includes("codegraph init"), `实际: ${out.slice(0, 50)}`);
  });
  rmSync(dir, { recursive: true, force: true });
}

// ---- apply ----
{
  const makeCtx = (overrides = {}) => {
    const state = { disposers: [], registered: [], hooks: [], logs: [], tools: [], sections: [], createdCbs: [] };
    const ctx = {
      logger: { warn: (m) => state.logs.push(`warn:${m}`), info: (m) => state.logs.push(`info:${m}`) },
      // inject 强依赖：ctx.mcpManager 直接可用（不再 get 探测）。
      mcpManager: overrides.mcpManager ?? {
        registerServer: async () => { state.registered.push("codegraph"); return { name: "codegraph", existing: false }; },
        unregisterServer: async () => {},
        getStatus: () => undefined,
        getTools: () => [],
        list: () => [],
      },
      // inject 强依赖：ctx.tools 直接可用（纪律工具注册；此前未 inject 导致 cordis
      // Proxy 抛 "cannot get property tools without inject" 启动失败）。
      tools: { register: (d) => { state.tools.push(d); return () => {}; } },
      // inject 强依赖：ctx.systemPrompt（纪律段注册，agent scope 继承）。
      systemPrompt: { section: (opts) => { state.sections.push(opts); return () => {}; } },
      on: (event, cb) => { if (event === "agent/created") state.createdCbs.push(cb); return () => {}; },
      effect: (fn) => { const d = fn(); state.disposers.push(d); return d; },
    };
    return { ctx, state };
  };

  check("契约: inject 含 agents/mcpManager/tools/systemPrompt（强依赖声明）", () => {
    for (const svc of ["agents", "mcpManager", "tools", "systemPrompt"]) {
      assert.ok(inject.includes(svc), `inject 应含 ${svc}，实际 ${JSON.stringify(inject)}`);
    }
  });

  // 回归（启动崩溃根因）：apply 不读取 ctx.session（无 session 字段也能 apply）。
  // 此前 apply 读 ctx.session 但未 inject session → cordis Proxy 抛
  // "cannot get property session without inject" → dsh web 启动失败。
  checkAsync("apply: 不读取 ctx.session（无 session 也能 apply，回归启动崩溃）", async () => {
    const { ctx, state } = makeCtx(); // fake ctx 无 session 字段
    await apply(ctx, {});
    assert.ok(state.disposers.length >= 1, "apply 正常完成并注册 effect disposer");
  });

  // #356 回归：apply 注册的纪律工具定义必须用 parameters（非 inputSchema）字段。
  checkAsync("apply: 纪律工具注册定义用 parameters 字段（#356 回归）", async () => {
    const { ctx, state } = makeCtx();
    await apply(ctx, {});
    assert.equal(state.tools.length, 1, "注册了 1 个工具");
    const definition = state.tools[0];
    assert.equal(definition.name, "codegraph_explore");
    assert.ok(definition.parameters, "parameters 必须存在（非 inputSchema）");
    assert.equal(definition.inputSchema, undefined, "inputSchema 不应存在");
  });

  // enabled:false → 不做事
  checkAsync("apply: enabled:false 静默返回", async () => {
    const { ctx, state } = makeCtx();
    await apply(ctx, { enabled: false });
    assert.equal(state.disposers.length, 0);
  });

  // 正常路径：codegraph 未装（PATH 空）→ 引导日志，注册降级
  checkAsync("apply: codegraph 未装 → 引导日志", async () => {
    const { ctx, state } = makeCtx();
    // 隔离 PATH（不探测到真实 codegraph）
    const prevPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await apply(ctx, {});
    } finally {
      process.env.PATH = prevPath;
    }
    assert.ok(state.logs.some((l) => l.includes("codegraph CLI 未安装") || l.includes("安装")), "有引导日志");
    assert.ok(state.disposers.length >= 1, "仍有 effect disposer（工具/钩子照常注册）");
  });

  // mcpManager（inject 保证在场）+ codegraph 已装（PATH 指向 fake）→ 注册服务器
  checkAsync("apply: mcpManager + 已装 → registerServer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-apply2-"));
    writeFileSync(join(dir, "codegraph"), "#!/bin/sh\n");
    let registered = false;
    const ctx = {
      logger: { warn: () => {}, info: () => {} },
      mcpManager: {
        registerServer: async () => { registered = true; return { name: "codegraph", existing: false }; },
        unregisterServer: async () => {},
        getStatus: () => ({ name: "codegraph", transport: "stdio", scope: "global", status: "connected", tools: [], enabled: true }),
        getTools: () => [],
        list: () => [],
      },
      tools: { register: () => () => {} },
      on: () => () => {},
      effect: (fn) => { const d = fn(); return d; },
    };
    const prevPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      await apply(ctx, {});
    } finally {
      process.env.PATH = prevPath;
    }
    assert.equal(registered, true, "registerServer 被调用");
    rmSync(dir, { recursive: true, force: true });
  });

  // #359：纪律注入迁移到 systemPrompt.section（order 161，agent scope 注册，
  // 非 git 不注册）——替代原 pre-step user 消息注入。
  {
    // 模拟 agent/created：git 仓会话 → 注册纪律段；非 git 会话 → 不注册。
    // 注意：目录在 checkAsync 内部自建自删（防 flake 纪律——共享外层目录 +
    // 未 await 的异步断言会在 finally 清理后执行 findGitRoot 而失败）。
    const emitCreated = (state, cwd) => {
      for (const cb of state.createdCbs) {
        cb({ agent: { session: { header: { cwd } }, ctx: { systemPrompt: { section: (opts) => { state.sections.push(opts); return () => {}; } } } } });
      }
    };
    checkAsync("discipline: git 仓会话注册纪律段（order 161，MCP 目录段之后）", async () => {
      const dir = mkdtempSync(join(tmpdir(), "cg-disc-git-"));
      mkdirSync(join(dir, "repo", ".git"), { recursive: true });
      try {
        const { ctx, state } = makeCtx();
        const { registerDisciplineHook, DISCIPLINE_SECTION_NAME, DISCIPLINE_SECTION_ORDER } = await import(pathToFileURL(join(pkgDir, "lib/index.js")).href);
        registerDisciplineHook(ctx);
        emitCreated(state, join(dir, "repo"));
        assert.equal(state.sections.length, 1, "git 仓注册 1 个纪律段");
        assert.equal(state.sections[0].name, DISCIPLINE_SECTION_NAME);
        assert.equal(state.sections[0].order, DISCIPLINE_SECTION_ORDER);
        assert.ok(state.sections[0].order > 160, "纪律段必须在 MCP 目录段（160）之后");
        assert.ok(typeof state.sections[0].text === "string" && state.sections[0].text.includes("codegraph_explore"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    checkAsync("discipline: 非 git 会话不注册纪律段（零注入）", async () => {
      const dir = mkdtempSync(join(tmpdir(), "cg-disc-nongit-"));
      mkdirSync(join(dir, "nongit"), { recursive: true });
      try {
        const { ctx, state } = makeCtx();
        const { registerDisciplineHook } = await import(pathToFileURL(join(pkgDir, "lib/index.js")).href);
        registerDisciplineHook(ctx);
        emitCreated(state, join(dir, "nongit"));
        assert.equal(state.sections.length, 0, "非 git 不注册纪律段");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
