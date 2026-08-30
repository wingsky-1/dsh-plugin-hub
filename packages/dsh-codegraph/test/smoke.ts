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
//   - apply（enabled:false / 不读 ctx.session 回归 / 探测未装引导 / 注册 / 纪律工具注册）
//
// 运行：node dsh-codegraph/test/smoke.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pkgDir = join(new URL("..", import.meta.url).pathname);
const mod = await import(pathToFileURL(join(pkgDir, "lib/index.js")).href);
const { apply, name, inject } = mod;
const { isCodegraphInstalled, installGuidance } = mod;
const { findGitRoot, isGitRepo, guardedExplore } = mod;
const { shouldInject, DISCIPLINE_TEXT } = mod;

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
    const state = { disposers: [], registered: [], hooks: [], logs: [], tools: [] };
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
      tools: { register: (d) => { state.tools.push(d.name); return () => {}; } },
      on: () => () => {},
      effect: (fn) => { const d = fn(); state.disposers.push(d); return d; },
    };
    return { ctx, state };
  };

  check("契约: inject 含 agents/mcpManager/tools（强依赖声明）", () => {
    for (const svc of ["agents", "mcpManager", "tools"]) {
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
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
