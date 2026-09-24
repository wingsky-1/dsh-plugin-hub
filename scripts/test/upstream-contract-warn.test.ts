#!/usr/bin/env node
"use strict";
/**
 * upstream-contract-warn 自测（上游消解 warn-job，v2 口径加 C1-C6）。
 *
 * fixture（F1-F4）与反向用例：
 *   F1 动态透传（worktree index.ts:63 形）进 S1；单跳 const 进事件；
 *   F2 loader 形无类型服务进 S2 有名清单；C2 超阈（两未命中）与新名反向；
 *   F3 计算键（declare module 内 sdkApi 成员）不透明、provide 祝福不对 B 断言；
 *   C3 闭包形状（export 星展开、循环截断、.ts 归一）与双版本 exit2；
 *   F4 注释样例（trend.ts:16 形）零派生，证 AST（grep 会误报）；
 *   C1 多行 ctx.on 收齐机制；S1 双动态与 S3 级联反向；R2、R4-lite 缺失反向。
 * 真实仓库锚：脚本 exit 0（只 warn 不阻塞）、S1 为 F1 一处、S2 具名、C1 为 20。
 * fixture 零落盘：内存片段为主，文件级夹具一律 mkdtempSync 隔离并清场。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as acorn from "acorn";
import {
  analyzeAFile,
  checkPeerVersions,
  closureMembers,
  evaluate,
  extractDeclareModules,
  formatReport,
  readCatalog,
} from "../maintenance/upstream-contract-warn.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "maintenance", "upstream-contract-warn.mjs");

interface Site {
  rel: string;
  line: number;
}

interface Named extends Site {
  name: string;
}

interface AIn {
  services: Named[];
  provides: Named[];
  events: Named[];
  calls: (Site & { svc: string; method: string })[];
  svcCalls: (Site & { svc: string })[];
  svcRefs: Site[];
  dynamics: Site[];
  forwarding: Site[];
  blessed: Named[];
  cascades: Site[];
  injectArrays: Site[];
  blessedValues: Set<string>;
}

interface BIn {
  services: Set<string>;
  events: Set<string>;
  methodTables: Map<string, Set<string>>;
  links: Map<string, string>;
}

function emptyA(): AIn {
  return {
    services: [],
    provides: [],
    events: [],
    calls: [],
    svcCalls: [],
    svcRefs: [],
    dynamics: [],
    forwarding: [],
    blessed: [],
    cascades: [],
    injectArrays: [],
    blessedValues: new Set(),
  };
}

function emptyB(): BIn {
  return { services: new Set(), events: new Set(), methodTables: new Map(), links: new Map() };
}

function site(rel: string, line: number): Site {
  return { rel, line };
}

function named(rel: string, line: number, name: string): Named {
  return { rel, line, name };
}

function analyze(src: string): unknown {
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true });
  return analyzeAFile(ast);
}

test("F1：动态透传进 S1（worktree index.ts:63 形）", () => {
  const r = analyze(
    "const bind = { on: (event, handler) => ctx.on(event, handler) };",
  ) as unknown as {
    dynamics: Site[];
    events: Named[];
  };
  assert.equal(r.dynamics.length, 1);
  assert.equal(r.events.length, 0);
});

test("F1b：同文件 const 单跳进事件", () => {
  const r = analyze("const E = 'session/event'; ctx.on(E, h);") as unknown as { events: Named[] };
  assert.deepEqual(
    r.events.map((e) => e.name),
    ["session/event"],
  );
});

test("F2：loader 形进 S2 有名清单（单已知不 FAIL）", () => {
  const r = analyze("const loader = ctx.get('loader');") as unknown as { services: Named[] };
  const A = emptyA();
  A.services = r.services;
  const R = evaluate(A, emptyB()) as unknown as {
    untracked: { name: string; count: number }[];
    s2fail: boolean;
  };
  assert.equal(R.untracked.length, 1);
  assert.equal(R.untracked[0].name, "loader");
  assert.equal(R.untracked[0].count, 1);
  assert.equal(R.s2fail, false);
});

test("C2 反向：两未命中超阈 FAIL", () => {
  const A = emptyA();
  A.services = [named("p/f.ts", 1, "loader"), named("p/g.ts", 2, "mystery")];
  const R = evaluate(A, emptyB()) as unknown as { s2fail: boolean };
  assert.equal(R.s2fail, true);
});

test("C2 反向：单个新名即 FAIL", () => {
  const A = emptyA();
  A.services = [named("p/f.ts", 1, "brandnew")];
  const R = evaluate(A, emptyB()) as unknown as { s2fail: boolean };
  assert.equal(R.s2fail, true);
});

test("F3：计算键不透明、祝福不对 B 断言", () => {
  const mods = extractDeclareModules(
    'declare module "c" { interface Context { [sdkApi.X]: T; plain: S; } }',
  ) as unknown as {
    parsed: { ifaces: Map<string, { members: Set<string>; opaque: number }> };
  }[];
  assert.equal(mods.length, 1);
  const ctx = mods[0].parsed.ifaces.get("Context");
  assert.ok(ctx !== undefined);
  assert.ok(!ctx.members.has("sdkApi.X"));
  assert.ok(ctx.members.has("plain"));
  const r = analyze("ctx.provide(sdkApi.X, svc);") as unknown as {
    blessed: Named[];
    services: Named[];
  };
  assert.equal(r.blessed.length, 1);
  assert.equal(r.services.length, 0);
  const A = emptyA();
  A.blessed = r.blessed;
  const R = evaluate(A, emptyB()) as unknown as { untracked: unknown[]; s2fail: boolean };
  assert.equal(R.untracked.length, 0);
  assert.equal(R.s2fail, false);
});

test("C3：闭包形状（星展开、循环截断、ts 归一）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ucw-closure-"));
  try {
    writeFileSync(
      join(dir, "entry.d.ts"),
      'export * from "./sub.ts";\nexport interface Root { a: string; }\n',
    );
    writeFileSync(
      join(dir, "sub.d.ts"),
      'import type { Root } from "./entry.d.ts";\nexport interface Sub { [sdkApi.K]: V; name: Root; }\n',
    );
    const closed = closureMembers(join(dir, "entry.d.ts")) as unknown as {
      ifaces: Map<string, { members: Set<string>; opaque: number }>;
      files: number;
    };
    assert.ok(closed.ifaces.has("Root"));
    assert.ok(closed.ifaces.has("Sub"));
    assert.equal(closed.files, 2);
    const sub = closed.ifaces.get("Sub");
    assert.ok(sub !== undefined);
    assert.ok(sub.members.has("name"));
    assert.ok(!sub.members.has("sdkApi.K"));
    assert.ok(sub.opaque >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3：同名双版本 exit2（fixture 根实跑）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ucw-multiver-"));
  try {
    const mk = (pkg: string, ver: string): void => {
      const d = join(dir, "packages", pkg, "node_modules", "@t", "foo");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@t/foo", version: ver }));
    };
    mkdirSync(join(dir, "packages", "a", "src"), { recursive: true });
    writeFileSync(join(dir, "packages", "a", "src", "x.ts"), "export const a = 1;\n");
    mkdirSync(join(dir, "shared"), { recursive: true });
    writeFileSync(join(dir, "pnpm-workspace.yaml"), 'catalog:\n  "@t/foo": "1.0.0"\n');
    mk("a", "1.0.0");
    mk("b", "2.0.0");
    mkdirSync(join(dir, "packages", "b", "src"), { recursive: true });
    writeFileSync(join(dir, "packages", "b", "src", "y.ts"), "export const b = 2;\n");
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.ok(String(r.stderr).includes("门禁故障"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("事件动词含 bail（与 on 同收）", () => {
  const r = analyze("ctx.bail('a/b', h);") as unknown as { events: Named[] };
  assert.deepEqual(
    r.events.map((e) => e.name),
    ["a/b"],
  );
});

test("C3：裸 side-effect import 进闭包（context 链形）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ucw-bare-"));
  try {
    writeFileSync(
      join(dir, "context.d.ts"),
      'import "./fiber";\nexport interface Context { svc: string; }\n',
    );
    writeFileSync(join(dir, "fiber.d.ts"), "export interface Fiber { run(): void; }\n");
    const closed = closureMembers(join(dir, "context.d.ts")) as unknown as {
      ifaces: Map<string, { members: Set<string> }>;
      files: number;
    };
    assert.ok(closed.ifaces.has("Context"));
    assert.ok(closed.ifaces.has("Fiber"));
    assert.equal(closed.files, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCatalog 兼容无引号与单引号键", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ucw-catalog-"));
  try {
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "catalog:\n  @deepseek-ai/foo: 1.0.0\n  '@deepseek-ai/bar': 2.0.0\n",
    );
    const v = readCatalog(dir) as unknown as Map<string, string>;
    assert.equal(v.get("@deepseek-ai/foo"), "1.0.0");
    assert.equal(v.get("@deepseek-ai/bar"), "2.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R4-lite：无类型服务打印名与 sites", () => {
  const A = emptyA();
  A.calls = [{ ...site("p/a.ts", 7), svc: "mystery", method: "doThing" }];
  const B = {
    ...emptyB(),
    peers: [],
    versions: new Map(),
    files: 0,
    opaque: 0,
  };
  const R = evaluate(A, B) as unknown as { untypedSvcs: [string, string[]][] };
  assert.equal(R.untypedSvcs.length, 1);
  const lines = formatReport(A, B, R) as unknown as string[];
  assert.ok(lines.some((l) => l.includes("mystery") && l.includes("p/a.ts:7")));
});

test("F4：注释零派生（trend.ts:16 形，AST 确认）", () => {
  const src = [
    "// ctx.on('session/event', h);",
    '/* 数据源口径（0.1.5-rc.1 起，唯一事实源 = ctx.on("session/event") 官方契约）： */',
    "const x = 1;",
  ].join("\n");
  const r = analyze(src) as unknown as { events: Named[]; services: Named[] };
  assert.equal(r.events.length, 0);
  assert.equal(r.services.length, 0);
});

test("C1 机制：多行 ctx.on 收齐", () => {
  const r = analyze(
    "trendDisposers.push(\n  ctx.on(\n    'internal/service',\n    handler,\n  ),\n);",
  ) as unknown as {
    events: Named[];
  };
  assert.deepEqual(
    r.events.map((e) => e.name),
    ["internal/service"],
  );
});

test("S1 反向：双动态即 FAIL", () => {
  const A = emptyA();
  A.dynamics = [site("p/a.ts", 1), site("p/b.ts", 2)];
  const R = evaluate(A, emptyB()) as unknown as { s1fail: boolean };
  assert.equal(R.s1fail, true);
});

test("S3 反向：级联非零即 FAIL", () => {
  const r = analyze("const X = getName(); ctx.on(X, h);") as unknown as { cascades: Site[] };
  assert.equal(r.cascades.length, 1);
  const A = emptyA();
  A.cascades = r.cascades;
  const R = evaluate(A, emptyB()) as unknown as { s3fail: boolean };
  assert.equal(R.s3fail, true);
});

test("R2 反向：事件缺席即 FAIL", () => {
  const A = emptyA();
  A.events = [named("p/a.ts", 1, "nope/event")];
  const R = evaluate(A, emptyB()) as unknown as { r2fail: boolean; missingEvents: string[] };
  assert.equal(R.r2fail, true);
  assert.deepEqual(R.missingEvents, ["nope/event"]);
});

test("R4-lite 反向：已定型服务缺方法即 FAIL", () => {
  const A = emptyA();
  A.calls = [{ ...site("p/a.ts", 1), svc: "webServer", method: "nope" }];
  const B = emptyB();
  B.methodTables.set("WebServer", new Set(["register"]));
  B.links.set("webServer", "WebServer");
  const R = evaluate(A, B) as unknown as { r4fail: boolean };
  assert.equal(R.r4fail, true);
});

test("checkPeerVersions：同名同版并集不抛", () => {
  const peers = [
    { pkg: "a", name: "@t/foo", dir: "/x", version: "1.0.0" },
    { pkg: "b", name: "@t/foo", dir: "/y", version: "1.0.0" },
    { pkg: "a", name: "@deepseek-ai/cordis", dir: "/c", version: "4.0.2" },
  ];
  const catalog = new Map([
    ["@t/foo", "1.0.0"],
    ["@deepseek-ai/cordis", "4.0.2"],
  ]);
  const out = checkPeerVersions(peers, catalog) as unknown as Map<
    string,
    { version: string; dirs: string[] }
  >;
  assert.equal(out.get("@t/foo")?.version, "1.0.0");
  assert.deepEqual(out.get("@t/foo")?.dirs, ["/x", "/y"]);
});

test("真实仓库锚：脚本 exit 0（只 warn 不阻塞）", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, String(r.stderr).slice(0, 500));
});

test("真实仓库锚：S1 为 F1 一处、S2 具名、C1 为 20", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0);
  const out = String(r.stdout) + String(r.stderr);
  assert.ok(out.includes("S1 动态 1") && out.includes("src/index.ts:66")); // 当前 worktree 同一 S1 动态 site
  assert.ok(out.includes("loader"));
  assert.ok(out.includes("字面量 20 处"));
  assert.ok(out.includes("internal/service"));
  assert.ok(out.includes("R2-cordis 事件 OK"));
  assert.ok(out.includes("R4-lite 方法 OK"));
});

test("真实仓库锚：S2 校准后 7 名全绿（L1 裁决）", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0);
  const out = String(r.stdout) + String(r.stderr);
  assert.ok(out.includes("S2 无类型服务 7（基线 7"));
  for (const name of [
    "attachments",
    "configForms",
    "connection",
    "loader",
    "locale",
    "sessionPersistence",
    "slots",
  ]) {
    assert.ok(out.includes(name) && out.includes("跟踪："), name);
  }
  assert.ok(!out.includes("::warning::"));
  assert.ok(out.includes("S2 无类型服务 7") && out.includes("）OK"));
  assert.ok(out.includes("R1 服务 OK"));
});
