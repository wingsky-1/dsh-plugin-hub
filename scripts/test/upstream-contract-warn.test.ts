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
 * 真实仓库锚：脚本 exit 0（只 warn 不阻塞）、S1 为 F1 一处、S2 具名、C1 为 19，R2 允许 OK 或已知 system-prompt warning。
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
import type { CallExpression, MemberExpression } from "acorn";
import {
  analyzeAFile,
  atTopLevel,
  BRACKET_OTHER,
  BRACKET_TOP,
  checkPeerVersions,
  closureMembers,
  ctxCallProp,
  evaluate,
  extractDeclareModules,
  formatReport,
  HEAD_BRACKET,
  HEAD_IDENT,
  HEAD_OTHER,
  HEAD_PARAMS,
  HEAD_QUOTED,
  HEAD_SEP,
  headKindAt,
  isAstNode,
  isContractSvcName,
  isOwnedByParent,
  isTerminator,
  readCatalog,
  stepBracketAt,
  unquotedMemberName,
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

test("真实仓库锚：S1 为 F1 一处、S2 具名、C1 为 19，R2 已知 warning 显式保留", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0);
  const out = String(r.stdout) + String(r.stderr);
  assert.ok(out.includes("S1 动态 1") && out.includes("src/index.ts:66")); // 当前 worktree 同一 S1 动态 site
  assert.ok(out.includes("loader"));
  assert.ok(out.includes("字面量 19 处"));
  assert.ok(out.includes("internal/service"));
  const r2Known =
    out.includes("R2-cordis 事件 OK") ||
    (out.includes("R2-cordis 事件 FAIL") && out.includes("未命中 1：system-prompt/assemble"));
  assert.ok(r2Known, out);
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
  // 干净构建可能得到 R2 OK；增量构建可能只产生已知的 system-prompt/assemble warning。
  // 两种都接受，但过滤该唯一 warning 后不得再有其它非阻塞 warning。
  const withoutKnownR2 = out
    .split("\n")
    .filter((line) => !line.includes("R2-cordis 事件 FAIL"))
    .join("\n");
  assert.ok(!withoutKnownR2.includes("::warning::"));
  assert.ok(out.includes("S2 无类型服务 7") && out.includes("）OK"));
  assert.ok(out.includes("R1 服务 OK"));
});

// ── 拆出后各纯判据的直接单测（#732 E5）：每条锁一个判定，不经派生面间接观察 ──

test("isAstNode：只有带 type 字段的对象算节点", () => {
  assert.equal(isAstNode({ type: "Identifier" }), true);
  assert.equal(isAstNode({ type: 1 }), false);
  assert.equal(isAstNode(null), false);
  assert.equal(isAstNode(undefined), false);
  assert.equal(isAstNode([]), false);
  assert.equal(isAstNode("Identifier"), false);
  assert.equal(isAstNode(0), false);
});

test("isContractSvcName：框架内建与事件动词都不算服务面成员", () => {
  for (const name of ["webServer", "sessionPersistence", "a"]) {
    assert.equal(isContractSvcName(name), true, name);
  }
  for (const name of ["get", "provide", "inject", "effect", "plugin", "on", "emit", "waterfall"]) {
    assert.equal(isContractSvcName(name), false, name);
  }
});

/** 取一条源码的首条调用表达式；不是则抛错（夹具不该走到那）。 */
function firstCallOf(src: string): CallExpression {
  const stmt = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" }).body[0];
  if (stmt.type !== "ExpressionStatement") throw new Error(`非表达式语句：${src}`);
  const expr = stmt.expression;
  if (expr.type !== "CallExpression") throw new Error(`非调用表达式：${src}`);
  return expr;
}

/** 取一条源码首条调用的 callee 成员表达式（即 `ctx.<svc>` 那一层）。 */
function calleeMemberOf(src: string): MemberExpression {
  const callee = firstCallOf(src).callee;
  if (callee.type !== "MemberExpression") throw new Error(`callee 非成员表达式：${src}`);
  return callee;
}

test("ctxCallProp：只认 ctx.<prop>(...) 形态，其余返回 null", () => {
  const propOf = (src: string): string | null => ctxCallProp(firstCallOf(src));
  assert.equal(propOf("ctx.on('a', h);"), "on");
  assert.equal(propOf("ctx.get('svc');"), "get");
  assert.equal(propOf("other.on('a', h);"), null);
  assert.equal(propOf("on('a', h);"), null);
  const stmt = acorn.parse("ctx.on;", { ecmaVersion: "latest", sourceType: "module" }).body[0];
  if (stmt.type !== "ExpressionStatement") throw new Error("非表达式语句");
  assert.equal(ctxCallProp(stmt.expression), null);
});

test("isOwnedByParent：被调用与被挂在别人身上的 ctx 成员算有主", () => {
  // ctx.webServer(1)：ctx.webServer 就是调用的 callee。
  const direct = firstCallOf("ctx.webServer(1);");
  assert.equal(isOwnedByParent(direct.callee, direct), true);
  // ctx.webServer.register(1)：ctx.webServer 挂在 callee 上，是它的 object。
  const callee = calleeMemberOf("ctx.webServer.register(1);");
  const svcMember = callee.object;
  if (svcMember.type !== "MemberExpression") throw new Error("callee.object 非成员表达式");
  assert.equal(isOwnedByParent(svcMember, callee), true);
  assert.equal(isOwnedByParent(svcMember, null), false);
  assert.equal(isOwnedByParent(svcMember, { type: "ExpressionStatement" }), false);
  assert.equal(isOwnedByParent(svcMember, { type: "MemberExpression", object: svcMember }), true);
  assert.equal(
    isOwnedByParent(svcMember, { type: "MemberExpression", property: svcMember }),
    false,
  );
});

test("atTopLevel / isTerminator：三层槽全零才算顶层；终止符只有分号与逗号", () => {
  assert.equal(atTopLevel([0, 0, 0]), true);
  assert.equal(atTopLevel([0, -1, 0]), false);
  assert.equal(atTopLevel([1, 0, 0]), false);
  assert.equal(isTerminator(";"), true);
  assert.equal(isTerminator(","), true);
  assert.equal(isTerminator("}"), false);
  assert.equal(isTerminator("a"), false);
});

test("stepBracketAt：只有 } 撞底报终止，) 与 ] 撞底只把槽位退成负数", () => {
  const d0 = [0, 0, 0];
  assert.equal(stepBracketAt("{", d0), "opened");
  assert.deepEqual(d0, [1, 0, 0]);
  assert.equal(stepBracketAt("}", d0), "closed");
  assert.deepEqual(d0, [0, 0, 0]);
  assert.equal(stepBracketAt("}", d0), BRACKET_TOP);
  const d1 = [0, 0, 0];
  assert.equal(stepBracketAt(")", d1), "closed");
  assert.deepEqual(d1, [0, -1, 0]);
  const d2 = [0, 0, 0];
  assert.equal(stepBracketAt("]", d2), "closed");
  assert.deepEqual(d2, [0, 0, -1]);
  assert.equal(stepBracketAt("x", [0, 0, 0]), BRACKET_OTHER);
  const d3 = [0, 0, 0];
  stepBracketAt("(", d3);
  assert.equal(stepBracketAt(")", d3), "closed");
  assert.deepEqual(d3, [0, 0, 0]);
});

test("headKindAt：成员头六种形态各自归类", () => {
  assert.equal(headKindAt(";", 0), HEAD_SEP);
  assert.equal(headKindAt(",", 0), HEAD_SEP);
  assert.equal(headKindAt("(", 0), HEAD_PARAMS);
  assert.equal(headKindAt("[", 0), HEAD_BRACKET);
  assert.equal(headKindAt('"k"', 0), HEAD_QUOTED);
  assert.equal(headKindAt("'k'", 0), HEAD_QUOTED);
  assert.equal(headKindAt("name", 0), HEAD_IDENT);
  assert.equal(headKindAt("0", 0), HEAD_OTHER);
  assert.equal(headKindAt("*", 0), HEAD_OTHER);
  assert.equal(headKindAt(" ", 0), HEAD_OTHER);
  // 修饰符本身是标识符形态：它归 ident，由 headIdentAt 读完整串后由 skipModifiersAt 整段跳过。
  assert.equal(headKindAt("readonly", 0), HEAD_IDENT);
});

test("unquotedMemberName：带引号的键名可读，其余（计算键、模板串）不透明", () => {
  assert.equal(unquotedMemberName('"a"'), "a");
  assert.equal(unquotedMemberName("'a'"), "a");
  assert.equal(unquotedMemberName("key"), null);
  assert.equal(unquotedMemberName("`a`"), null);
  assert.equal(unquotedMemberName('"a'), null);
  assert.equal(unquotedMemberName(""), null);
  assert.equal(unquotedMemberName('"'), "");
});
