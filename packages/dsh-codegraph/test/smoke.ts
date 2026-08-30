// @ts-nocheck
// dsh-codegraph 冒烟测试 —— 无外部依赖、不发起真实网络/进程连接。
//
// 覆盖：
//   - 契约导出（name / inject）
//   - isCodegraphInstalled（PATH 探测分支）
//   - installGuidance（引导文案含安装命令）
//   - findGitRoot / isGitRepo（.git 目录 / .git 文件(worktree) / 非 git 三分支）
//   - shouldInject（cwd 判定）
//   - guardedExplore / guardedCodegraph（无 projectPath → 补全/拒绝；无索引 →
//     引导；sync 失败 → 拒绝；CLI 未装；空结果 vs 命令失败；TTL 缓存）
//   - 工具注册定义（#356 回归）：buildGuardToolDefinition 字段名契约
//     （parameters 而非 inputSchema）+ 真实 dsh-tools 注册投影不抛错
//   - #363：6 个新工具注册定义契约（parameters、output schema+render、
//     参数 schema 与 CLI 对齐无幽灵参数）+ 真实 dsh-tools 投影 7 个工具
//   - apply（enabled:false / 不读 ctx.session 回归 / 探测未装引导 / 注册 /
//     纪律工具注册 7 个 / discipline 文案含新工具 + 禁用声明 + 双轨说明）
//
// 运行：node dsh-codegraph/test/smoke.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const pkgDir = join(new URL("..", import.meta.url).pathname);
const mod = await import(pathToFileURL(join(pkgDir, "lib/index.js")).href);
const { apply, name, inject } = mod;
const { isCodegraphInstalled, installGuidance } = mod;
const { findGitRoot, isGitRepo, guardedExplore, guardedCodegraph, syncCodegraphCached, runCodegraph, isNoResultOutput, resetSyncCache } = mod;
const { shouldInject, DISCIPLINE_TEXT } = mod;
const { buildGuardToolDefinition, buildImpactToolDefinition, buildNodeToolDefinition, buildCallersToolDefinition, buildCalleesToolDefinition, buildSearchToolDefinition, buildFilesToolDefinition } = mod;

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
// 收集所有 checkAsync 的 promise——结尾统一 await（防「假绿」：checkAsync 不
// await 的话，异步断言失败会晚于 "all checks passed" 打印，exit 0 溜过门禁）。
const asyncChecks = [];
function registerAsync(label, fn) {
  asyncChecks.push(checkAsync(label, fn));
}

// ---- 契约 ----
check("契约: name = codegraph", () => assert.equal(name, "codegraph"));
check("契约: inject 包含 agents", () => assert.ok(inject.includes("agents")));

// ---- 工具注册定义（#356 回归）----
// 根因：注册定义误用 MCP 风格字段 inputSchema，而 dsh-tools 契约要求 parameters，
// 导致 schema 投影时 parameters===undefined → 抛 "must be lossless JSON"。
{
  const builders = [
    ["codegraph_explore", buildGuardToolDefinition],
    ["codegraph_impact", buildImpactToolDefinition],
    ["codegraph_node", buildNodeToolDefinition],
    ["codegraph_callers", buildCallersToolDefinition],
    ["codegraph_callees", buildCalleesToolDefinition],
    ["codegraph_search", buildSearchToolDefinition],
    ["codegraph_files", buildFilesToolDefinition],
  ];
  check("#363: 7 个裸名纪律工具定义齐全", () => {
    const names = builders.map(([n]) => n);
    for (const n of ["codegraph_explore", "codegraph_impact", "codegraph_node", "codegraph_callers", "codegraph_callees", "codegraph_search", "codegraph_files"]) {
      assert.ok(names.includes(n), `缺 ${n}`);
    }
  });

  for (const [toolName, builder] of builders) {
    const definition = builder();
    check(`工具定义 ${toolName}: 使用 parameters 字段（非 inputSchema，#356）`, () => {
      assert.ok(definition.parameters, "parameters 必须存在");
      assert.equal(definition.inputSchema, undefined, "inputSchema 不应存在");
    });
    check(`工具定义 ${toolName}: parameters 为合法对象 schema`, () => {
      assert.equal(definition.parameters.type, "object");
      assert.ok(definition.parameters.properties, "properties 必须存在");
    });
    check(`工具定义 ${toolName}: output 契约完整（schema + render）`, () => {
      assert.ok(definition.output, "output 必须存在");
      assert.ok(definition.output.schema, "output.schema 必须存在");
      assert.equal(typeof definition.output.render, "function", "output.render 必须是函数");
    });
    check(`工具定义 ${toolName}: isConcurrencySafe 函数返回 true`, () => {
      assert.equal(typeof definition.isConcurrencySafe, "function", "isConcurrencySafe 应为函数");
      assert.equal(definition.isConcurrencySafe({}), true, "调用应返回 true（只读查询可并行）");
    });
  }

  // #363 验收 7：参数 schema 与 CLI 实测对齐（无 file/line 幽灵参数、files 用 filter）
  check("参数对齐: impact 无 file、有 depth(1-5)", () => {
    const p = buildImpactToolDefinition().parameters.properties;
    assert.equal(p.file, undefined, "impact 不应有 file（CLI 不支持）");
    assert.equal(p.line, undefined, "impact 不应有 line");
    assert.ok(p.symbol && p.depth && p.projectPath);
    assert.deepEqual(buildImpactToolDefinition().parameters.required, ["symbol"]);
  });
  check("参数对齐: node 无 line、symbol/file 互斥、有 offset/limit/symbolsOnly", () => {
    const p = buildNodeToolDefinition().parameters.properties;
    assert.equal(p.line, undefined, "node 不应有 line（CLI 不存在）");
    assert.ok(p.symbol && p.file && p.offset && p.limit && p.symbolsOnly && p.projectPath);
  });
  check("参数对齐: callers/callees 无 file、有 limit(1-100)", () => {
    for (const b of [buildCallersToolDefinition, buildCalleesToolDefinition]) {
      const p = b().parameters.properties;
      assert.equal(p.file, undefined, "callers/callees 不应有 file（CLI 不支持）");
      assert.ok(p.symbol && p.limit && p.projectPath);
      assert.deepEqual(b().parameters.required, ["symbol"]);
    }
  });
  check("参数对齐: search 有 query/kind/limit（映射 CLI query 子命令）", () => {
    const p = buildSearchToolDefinition().parameters.properties;
    assert.ok(p.query && p.kind && p.limit && p.projectPath);
    assert.deepEqual(buildSearchToolDefinition().parameters.required, ["query"]);
  });
  check("参数对齐: files 用 filter 而非 path、有 pattern/format/maxDepth", () => {
    const p = buildFilesToolDefinition().parameters.properties;
    assert.equal(p.path, undefined, "files 不应有 path（CLI 用 --filter）");
    assert.equal(p.line, undefined);
    assert.ok(p.filter && p.pattern && p.format && p.maxDepth && p.projectPath);
  });

  // 真实 dsh-tools 注册 + 投影：注册定义后调用 schemas() 不抛错（堵住 mock 盲区——
  // 此前 smoke 的 tools.register 是 mock，不触发真实 schemaOf 投影，契约字段错误溜过门禁）。
  registerAsync("工具定义: 真实 dsh-tools 注册 7 个 + schemas() 投影不抛错（#356 回归）", async () => {
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
    for (const [, builder] of builders) tools.register(builder());
    const schemas = tools.schemas();
    assert.equal(schemas.length, 7, "投影出 7 个工具");
    const names = schemas.map((s) => s.name).sort();
    assert.deepEqual(names, ["codegraph_callees", "codegraph_callers", "codegraph_explore", "codegraph_files", "codegraph_impact", "codegraph_node", "codegraph_search"]);
    for (const s of schemas) {
      assert.ok(s.parameters, `投影 parameters 存在（${s.name}）`);
    }
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
  registerAsync("guardedExplore: 无 projectPath 非 git → 拒绝", async () => {
    const out = await guardedExplore({ query: "x" }, join(dir, "nongit"));
    assert.ok(out.includes("被纪律拦截"), `实际: ${out.slice(0, 50)}`);
  });
  // guardedExplore：有 projectPath 但无索引 → 引导 init
  registerAsync("guardedExplore: 有 projectPath 无索引 → 引导", async () => {
    const out = await guardedExplore({ query: "x", projectPath: join(dir, "repo") });
    assert.ok(out.includes("codegraph init"), `实际: ${out.slice(0, 50)}`);
  });
  rmSync(dir, { recursive: true, force: true });
}

// ---- guardedCodegraph 8 类分支（#363 补充）----
// 用 fake CLI（PATH 隔离）验证 8 类异常分支 + TTL 缓存 + 空结果判定；
// 真实 CLI 分支见下方「真实 codegraph CLI 分支」（环境有 codegraph 才跑）。
{
  const makeFakeBin = (dir, script) => {
    writeFileSync(join(dir, "codegraph"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  };
  const FAKE_SYNC_OK = "if [ \"$1\" = sync ]; then exit 0; fi;";
  // 带 .codegraph 索引的 git 仓（绕过索引校验，直测 run 分支）
  const makeIndexedRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-idx-"));
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    mkdirSync(join(dir, "repo", ".codegraph"), { recursive: true });
    return join(dir, "repo");
  };

  // 分支 4：CLI 未装 → sync 阶段识别未装，guardedCodegraph 中文提示
  registerAsync("guardedCodegraph: CLI 未装 → 中文提示 + 安装命令", async () => {
    resetSyncCache();
    const repo = makeIndexedRepo();
    const noCliEnv = { PATH: "/nonexistent" };
    const out = await guardedCodegraph(
      { projectPath: repo },
      undefined,
      async () => runCodegraph(["impact", "x"], noCliEnv),
      "codegraph_impact",
      noCliEnv,
    );
    assert.ok(out.includes("codegraph CLI 未安装"), `实际: ${out.slice(0, 60)}`);
    assert.ok(out.includes("npm install -g"), `实际: ${out.slice(0, 60)}`);
    rmSync(dirname(repo), { recursive: true, force: true });
  });

  // 分支 5：符号未找到（stdout 空结果提示）→ 空结果提示而非错误
  registerAsync("guardedCodegraph: 符号未找到 → 空结果提示（非错误）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-fake-"));
    makeFakeBin(dir, `${FAKE_SYNC_OK}\necho 'ℹ Symbol "NoSuch" not found'`);
    resetSyncCache();
    const repo = makeIndexedRepo();
    const fakeEnv = { PATH: `${dir}:${process.env.PATH ?? ""}` };
    const out = await guardedCodegraph(
      { projectPath: repo },
      undefined,
      async () => runCodegraph(["impact", "NoSuch"], fakeEnv),
      "codegraph_impact",
      fakeEnv,
    );
    assert.ok(out.includes("查询无结果"), `实际: ${out.slice(0, 60)}`);
    assert.ok(out.includes("codegraph_search"), `实际: ${out.slice(0, 60)}`);
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirname(repo), { recursive: true, force: true });
  });

  // 分支 8：命令失败（stderr + 退出码 1）→ 错误提示
  registerAsync("guardedCodegraph: 命令失败（stderr+退出码 1）→ 错误提示", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-fake2-"));
    makeFakeBin(dir, `${FAKE_SYNC_OK}\necho 'error: unknown option' >&2; exit 1`);
    resetSyncCache();
    const repo = makeIndexedRepo();
    const fakeEnv = { PATH: `${dir}:${process.env.PATH ?? ""}` };
    const out = await guardedCodegraph(
      { projectPath: repo },
      undefined,
      async () => runCodegraph(["impact", "x"], fakeEnv),
      "codegraph_impact",
      fakeEnv,
    );
    assert.ok(out.includes("执行失败"), `实际: ${out.slice(0, 60)}`);
    assert.ok(!out.includes("查询无结果"), "命令失败不应误判为空结果");
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirname(repo), { recursive: true, force: true });
  });

  // 分支 7：空结果（找到符号但无调用者）→ 空结果提示
  registerAsync("guardedCodegraph: 无调用者 → 空结果提示", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-fake3-"));
    makeFakeBin(dir, `${FAKE_SYNC_OK}\necho 'ℹ No callers found for "x"'`);
    resetSyncCache();
    const repo = makeIndexedRepo();
    const fakeEnv = { PATH: `${dir}:${process.env.PATH ?? ""}` };
    const out = await guardedCodegraph(
      { projectPath: repo },
      undefined,
      async () => runCodegraph(["callers", "x"], fakeEnv),
      "codegraph_callers",
      fakeEnv,
    );
    assert.ok(out.includes("查询无结果"), `实际: ${out.slice(0, 60)}`);
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirname(repo), { recursive: true, force: true });
  });

  // 分支 2：无索引 → 引导 init（有 projectPath）
  registerAsync("guardedCodegraph: 无 .codegraph 索引 → 引导 init", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-fake4-"));
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    resetSyncCache();
    const out = await guardedCodegraph(
      { projectPath: join(dir, "repo") },
      undefined,
      async () => ({ stdout: "", stderr: "", code: 0 }),
      "codegraph_impact",
    );
    assert.ok(out.includes("codegraph init"), `实际: ${out.slice(0, 60)}`);
    rmSync(dir, { recursive: true, force: true });
  });

  // 分支 1：非 git + 无 projectPath → 拒绝
  registerAsync("guardedCodegraph: 非 git 无 projectPath → 拒绝", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-fake5-"));
    mkdirSync(join(dir, "nongit"), { recursive: true });
    resetSyncCache();
    const out = await guardedCodegraph(
      {},
      join(dir, "nongit"),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      "codegraph_impact",
    );
    assert.ok(out.includes("非 git 仓"), `实际: ${out.slice(0, 60)}`);
    rmSync(dir, { recursive: true, force: true });
  });

  // 分支 3：sync 失败 → 拒绝
  registerAsync("guardedCodegraph: sync 失败 → 拒绝", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-fake6-"));
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    mkdirSync(join(dir, "repo", ".codegraph"), { recursive: true });
    makeFakeBin(dir, "if [ \"$1\" = sync ]; then exit 1; fi;");
    resetSyncCache();
    const fakeEnv = { PATH: `${dir}:${process.env.PATH ?? ""}` };
    const out = await guardedCodegraph(
      { projectPath: join(dir, "repo") },
      undefined,
      async () => ({ stdout: "", stderr: "", code: 0 }),
      "codegraph_impact",
      fakeEnv,
    );
    assert.ok(out.includes("sync 失败"), `实际: ${out.slice(0, 60)}`);
    rmSync(dir, { recursive: true, force: true });
  });

  // sync TTL 缓存（#363 验收 9）：30s 内同 projectPath 不重复 sync；
  // 用 fake sync 计数验证；查询结果不缓存（每次重新执行）。
  registerAsync("sync TTL: 30s 内同 projectPath 只 sync 一次（查询不缓存）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-ttl-"));
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    mkdirSync(join(dir, "repo", ".codegraph"), { recursive: true });
    // fake codegraph：sync 追加计数到 sync.log + 每次查询输出递增序号（验证查询结果不缓存）
    writeFileSync(
      join(dir, "codegraph"),
      [
        "#!/bin/sh",
        `if [ "$1" = sync ]; then echo "sync" >> ${dir}/sync.log; exit 0; fi`,
        `count=$(cat ${dir}/qcount 2>/dev/null || echo 0); count=$((count+1)); echo "$count" > ${dir}/qcount; echo "result-$count"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    // 自定义 env：PATH 指向 fake，且让子进程能读同一计数文件
    // PATH 前缀 fake bin 目录 + 保留系统 PATH（fake 脚本内部用 cat 等外部命令）
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
    resetSyncCache();
    const call = async () => guardedCodegraph(
      { projectPath: join(dir, "repo") },
      undefined,
      async () => runCodegraph(["impact", "x"], env),
      "codegraph_impact",
      env,
    );
    const first = await call();
    const second = await call();
    const third = await call();
    assert.equal(first.trim(), "result-1", "首次查询结果");
    assert.equal(second.trim(), "result-2", "第二次查询结果（查询不缓存）");
    assert.equal(third.trim(), "result-3", "第三次查询结果（查询不缓存）");
    const syncLines = String(readFileSync(join(dir, "sync.log"))).trim().split("\n").filter(Boolean);
    assert.equal(syncLines.length, 1, `3 次调用只 sync 1 次（TTL 生效），实际 ${syncLines.length}`);
    rmSync(dir, { recursive: true, force: true });
  });
}

// ---- 真实 codegraph CLI 分支（#363 验收 4：输出与 CLI 一致）----
// 环境装有 codegraph（PATH 命中）才跑；用临时 git 仓 + 真实索引验证。
{
  const hasCli = isCodegraphInstalled();
  if (!hasCli) {
    console.warn("smoke: 本机未装 codegraph CLI——真实 CLI 分支跳过（可先 npm install -g @colbymchenry/codegraph）");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "cg-real-"));
    // 临时 git 仓 + 一个源文件（真实索引）
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    mkdirSync(join(dir, "repo", "src"), { recursive: true });
    writeFileSync(
      join(dir, "repo", "src", "a.ts"),
      "export function hello(name: string): string { return `hi ${name}`; }\n\nexport function main(): void { hello('world'); }\n",
    );
    const repo = join(dir, "repo");
    // 建索引（真实 CLI）
    const { execFileSync } = await import("node:child_process");
    execFileSync("codegraph", ["init", repo], { stdio: "ignore" });
    resetSyncCache();
    // 捕获当前 PATH 快照：apply 区块测试会临时改全局 PATH（/nonexistent），
    // 而本分支的 checkAsync 与之并发（都 await 挂起）——显式传快照 env 隔离。
    // 合并为单个 checkAsync：真实 CLI 的 sync 有锁（并发 sync 冲突），须串行。
    const realEnv = { ...process.env };
    registerAsync("真实 CLI: 6 子命令输出与 CLI 一致（串行）", async () => {
      try {
        const impact = await guardedCodegraph(
          { projectPath: repo },
          undefined,
          async () => runCodegraph(["impact", "hello", "--path", repo], realEnv),
          "codegraph_impact",
          realEnv,
        );
        assert.ok(impact.includes("Impact of changing"), `impact 实际: ${impact.slice(0, 80)}`);
        assert.ok(impact.includes("main"), `impact 实际: ${impact.slice(0, 80)}`);

        const callers = await guardedCodegraph(
          { projectPath: repo },
          undefined,
          async () => runCodegraph(["callers", "hello", "--path", repo], realEnv),
          "codegraph_callers",
          realEnv,
        );
        assert.ok(callers.includes("Callers of"), `callers 实际: ${callers.slice(0, 80)}`);
        const callees = await guardedCodegraph(
          { projectPath: repo },
          undefined,
          async () => runCodegraph(["callees", "main", "--path", repo], realEnv),
          "codegraph_callees",
          realEnv,
        );
        assert.ok(callees.includes("Callees of"), `callees 实际: ${callees.slice(0, 80)}`);

        const node = await guardedCodegraph(
          { projectPath: repo },
          undefined,
          async () => runCodegraph(["node", "hello", "--path", repo], realEnv),
          "codegraph_node",
          realEnv,
        );
        assert.ok(node.includes("hello"), `node 实际: ${node.slice(0, 80)}`);

        const q = await guardedCodegraph(
          { projectPath: repo },
          undefined,
          async () => runCodegraph(["query", "hello", "--path", repo], realEnv),
          "codegraph_search",
          realEnv,
        );
        assert.ok(q.includes("Search Results"), `query 实际: ${q.slice(0, 80)}`);
        const f = await guardedCodegraph(
          { projectPath: repo },
          undefined,
          async () => runCodegraph(["files", "--path", repo, "--format", "flat"], realEnv),
          "codegraph_files",
          realEnv,
        );
        assert.ok(f.includes("Files"), `files 实际: ${f.slice(0, 80)}`);

        const missing = await guardedCodegraph(
          { projectPath: repo },
          undefined,
          async () => runCodegraph(["impact", "NoSuchSymbolZZ", "--path", repo], realEnv),
          "codegraph_impact",
          realEnv,
        );
        assert.ok(missing.includes("查询无结果"), `未找到实际: ${missing.slice(0, 80)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
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
  registerAsync("apply: 不读取 ctx.session（无 session 也能 apply，回归启动崩溃）", async () => {
    const { ctx, state } = makeCtx(); // fake ctx 无 session 字段
    await apply(ctx, {});
    assert.ok(state.disposers.length >= 1, "apply 正常完成并注册 effect disposer");
  });

  // #356 回归：apply 注册的纪律工具定义必须用 parameters（非 inputSchema）字段。
  registerAsync("apply: 纪律工具注册定义用 parameters 字段（#356 回归）", async () => {
    const { ctx, state } = makeCtx();
    await apply(ctx, {});
    assert.equal(state.tools.length, 7, "注册了 7 个纪律工具（explore + #363 六个）");
    const names = state.tools.map((d) => d.name).sort();
    assert.deepEqual(names, ["codegraph_callees", "codegraph_callers", "codegraph_explore", "codegraph_files", "codegraph_impact", "codegraph_node", "codegraph_search"]);
    for (const definition of state.tools) {
      assert.ok(definition.parameters, `parameters 必须存在（非 inputSchema，${definition.name}）`);
      assert.equal(definition.inputSchema, undefined, `inputSchema 不应存在（${definition.name}）`);
    }
  });

  // enabled:false → 不做事
  registerAsync("apply: enabled:false 静默返回", async () => {
    const { ctx, state } = makeCtx();
    await apply(ctx, { enabled: false });
    assert.equal(state.disposers.length, 0);
  });

  // 正常路径：codegraph 未装（PATH 空）→ 引导日志，注册降级
  registerAsync("apply: codegraph 未装 → 引导日志", async () => {
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
  registerAsync("apply: mcpManager + 已装 → registerServer", async () => {
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
    registerAsync("discipline: git 仓会话注册纪律段（order 161，MCP 目录段之后）", async () => {
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
        // #363 验收 6：纪律文案含新工具引导 + P0-2 声明 + 双轨说明
        const text = state.sections[0].text;
        for (const tool of ["codegraph_impact", "codegraph_node", "codegraph_callers", "codegraph_callees", "codegraph_search", "codegraph_files"]) {
          assert.ok(text.includes(tool), `纪律文案应引导 ${tool}`);
        }
        assert.ok(text.includes("工具级禁用只作用于 mcp-manager 管辖的 mcp__ 前缀工具"), "含禁用只作用于 mcp__ 声明");
        assert.ok(text.includes("双轨说明"), "含双轨说明");
        assert.ok(text.includes("mcp__codegraph__impact"), "双轨说明提到官方工具名");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    registerAsync("discipline: 非 git 会话不注册纪律段（零注入）", async () => {
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

// 结尾统一 await 所有异步检查（防假绿——异步断言失败不得晚于结果判定）。
await Promise.all(asyncChecks);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
