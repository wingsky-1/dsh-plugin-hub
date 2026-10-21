#!/usr/bin/env node
"use strict";
/**
 * verify-host-seams 自测（结构门禁 R1-R4 上线收口）。
 *
 * 三层断言缺一不可：
 *   1. T1-T7 收集向量：any-depth N1-N7 的收与不收；
 *   2. 锚定：R1 位置允许与 src 根 shared 段锚定、R2 basename 允许集、R3 装配点、
 *      R4 分组 disposition、receiver 不限名、fail-closed 唯二出口；
 *   3. 真实仓库锚：收敛后树上门禁 exit 0 且观察表含 triple 与镜像对。
 *
 * fixture 零落盘：向量均为内存源码片段，真仓锚只读不写。
 * 本文件在 scripts 下 strict 编译面内，故不用 ts-nocheck，用最小接口归一形状。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as acorn from "acorn";
import {
  analyzeAst,
  decideGroup,
  groupByPkgValue,
  isR1Allowed,
  isR2Allowed,
  isR2LDeduped,
  isR3Allowed,
  isSlashDef,
  isSrcRootShared,
} from "../gate/verify-host-seams.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(ROOT, "scripts", "gate", "verify-host-seams.mjs");

interface SlashHit {
  value: string;
  fallback: boolean;
}

interface OnHit {
  name: string;
}

interface Analysis {
  r1static: OnHit[];
  r1dynamic: number;
  r2l: { value: string }[];
  r2c: { value: string }[];
  r2b: { kind: string }[];
  r3: { kind: string; name: string }[];
  r4defs: SlashHit[];
}

function analyze(src: string): Analysis {
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true });
  return analyzeAst(ast) as unknown as Analysis;
}

function defValues(src: string): string[] {
  return analyze(src)
    .r4defs.map((d) => d.value)
    .sort();
}

/** dsh-settings 的两个历史形态：0.1.x 有 get(ns)，0.2.x 只有 describe/update/replace/mutate。 */
function settingsDts(withGet: boolean): string {
  const get = withGet ? "get(ns: string): unknown; " : "";
  return `export interface SettingsForms { ${get}describe(): unknown; update(): void; replace(): void; mutate(): void; }
`;
}

/**
 * R5 的最小仓 fixture：catalog 锁版 + cordis Context 声明 settings + dsh-settings 的
 * .d.ts（旧/新两形态）+ 一个消费点。只换 B 侧 .d.ts，源码不变，证明判红来自方法表。
 */
function writeMethodFixture(dir: string, withGet: boolean): void {
  const write = (rel: string, text: string): void => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  };
  write(
    "pnpm-workspace.yaml",
    "catalog:\n  @deepseek-ai/cordis: 4.0.5\n  @deepseek-ai/dsh-settings: 0.2.1\n",
  );
  write("packages/p/package.json", '{ "name": "p", "version": "1.0.0" }\n');
  write(
    "packages/p/src/server/x.ts",
    'export function read(anyCtx: { get?: (name: string) => any }): unknown {\n  const settings = anyCtx.get?.("settings");\n  return settings.get("ns");\n}\n',
  );
  write(
    "packages/p/node_modules/@deepseek-ai/cordis/package.json",
    '{ "name": "@deepseek-ai/cordis", "version": "4.0.5", "types": "index.d.ts" }\n',
  );
  write(
    "packages/p/node_modules/@deepseek-ai/cordis/index.d.ts",
    "export interface Context { settings: SettingsForms; }\n",
  );
  write(
    "packages/p/node_modules/@deepseek-ai/dsh-settings/package.json",
    '{ "name": "@deepseek-ai/dsh-settings", "version": "0.2.1", "types": "index.d.ts" }\n',
  );
  write("packages/p/node_modules/@deepseek-ai/dsh-settings/index.d.ts", settingsDts(withGet));
}

test("T1：cond 两支都收", () => {
  assert.deepEqual(defValues("const A = cond ? '/a' : '/b';"), ["/a", "/b"]);
});

test("T2：空值合并右操作数收且标 fallback", () => {
  const found = analyze("const C = X ?? '/api/dsh-p/c';");
  assert.deepEqual(
    found.r4defs.map((d) => d.value),
    ["/api/dsh-p/c"],
  );
  assert.equal(found.r4defs[0].fallback, true);
  assert.equal(found.r2b.filter((h) => h.kind === "nullish-right").length, 1);
});

test("T3：register 数组对象内路径收", () => {
  assert.deepEqual(defValues("register([{ path: '/d' }]);"), ["/d"]);
});

test("T4：return 收", () => {
  assert.deepEqual(defValues("function f() { return '/e'; }"), ["/e"]);
});

test("T5：MIME 不收", () => {
  assert.deepEqual(defValues("const m = 'application/json';"), []);
  assert.equal(isSlashDef("application/json"), false);
});

test("T6：句中 GET 不收", () => {
  assert.deepEqual(defValues("const s = 'GET /api/x';"), []);
  assert.equal(isSlashDef("GET /api/x"), false);
});

test("N6：类属性初值与参数默认收", () => {
  assert.deepEqual(defValues("class A { p = '/n6a'; }"), ["/n6a"]);
  assert.deepEqual(defValues("function f(p = '/n6b') {}"), ["/n6b"]);
});

test("R2-L/R2-B 同站去重（同行留更具体的 R2-B）", () => {
  assert.equal(isR2LDeduped({ line: 3, value: "/api/dsh-x" }, [{ line: 3, kind: "plus" }]), true);
  assert.equal(
    isR2LDeduped({ line: 3, value: "/api/dsh-other" }, [
      { line: 3, kind: "nullish-right", value: "/api/dsh-x" },
    ]),
    false,
  );
  assert.equal(isR2LDeduped({ line: 4, value: "/api/dsh-x" }, [{ line: 3, kind: "plus" }]), false);
});

test("T7：空串与单斜线不收", () => {
  assert.deepEqual(defValues("const e = '';"), []);
  assert.equal(isSlashDef(""), false);
  assert.equal(isSlashDef("/"), false);
});

test("锚定 R1：位置允许", () => {
  assert.equal(isR1Allowed("packages/a/src/index.ts"), true);
  assert.equal(isR1Allowed("packages/a/src/apply/apply.ts"), true);
  assert.equal(isR1Allowed("packages/a/src/server/x.ts"), true);
  assert.equal(isR1Allowed("packages/a/src/client/index.ts"), false);
  assert.equal(isR1Allowed("packages/a/src/shared/x.ts"), false);
  assert.equal(isR1Allowed("packages/a/src/client/core.ts"), false);
});

test("锚定 R1：src 根 shared 段", () => {
  assert.equal(isSrcRootShared("packages/a/src/shared/x.ts"), true);
  assert.equal(isSrcRootShared("packages/a/src/server/shared/x.ts"), false);
  assert.equal(isSrcRootShared("packages/a/src/client/shared/x.ts"), false);
  assert.equal(isSrcRootShared("packages/a/src/index.ts"), false);
});

test("锚定 R1：receiver 不限名且仅 on", () => {
  const found = analyze("foo.on('/a/b', h); ctx.on('/c/d', h); ctx.emit('/e', x);");
  assert.deepEqual(found.r1static.map((h) => h.name).sort(), ["/a/b", "/c/d"]);
});

test("锚定 R1：非静态首参只观察计数", () => {
  const found = analyze("ctx.on(event, handler);");
  assert.equal(found.r1static.length, 0);
  assert.equal(found.r1dynamic, 1);
});

test("锚定 R2：basename 允许集", () => {
  assert.equal(isR2Allowed("packages/a/src/shared/routes.ts"), true);
  assert.equal(isR2Allowed("packages/a/src/client/shared/contract.ts"), true);
  assert.equal(isR2Allowed("packages/a/src/client/index.ts"), true);
  assert.equal(isR2Allowed("packages/a/src/client/index.tsx"), true);
  assert.equal(isR2Allowed("packages/a/src/apply/apply.ts"), true);
  assert.equal(isR2Allowed("packages/a/src/server/config/routes.ts"), true);
  assert.equal(isR2Allowed("packages/a/src/shared/contract.ts"), true);
  assert.equal(isR2Allowed("packages/a/src/server/api/x.ts"), true);
  assert.equal(isR2Allowed("packages/a/src/client/core.ts"), false);
  assert.equal(isR2Allowed("packages/a/src/client/report.tsx"), false);
  assert.equal(isR2Allowed("packages/a/src/server/config/model.ts"), false);
});

test("锚定 R2-C：调用实参直写即收", () => {
  assert.equal(analyze("fetch('/api/dsh-x/y');").r2c.length, 1);
  assert.equal(analyze("fetch(URL_CONST);").r2c.length, 0);
});

test("锚定 R2-B：拼接形态收，标识符右操作数净", () => {
  assert.equal(analyze("const u = BASE + '/api/dsh-x';").r2b.length, 1);
  assert.equal(analyze("const u = X ?? '/api/dsh-x';").r2b.length, 1);
  assert.equal(analyze("const u = X ?? FALLBACK;").r2b.length, 0);
  assert.equal(analyze("const u = X || '/api/dsh-x';").r2b.length, 1);
  assert.equal(analyze("xs.join('/api/dsh-x');").r2b.length, 1);
});

test("锚定 R3：仅 client index 装配", () => {
  assert.equal(isR3Allowed("packages/a/src/client/index.ts"), true);
  assert.equal(isR3Allowed("packages/a/src/client/index.tsx"), true);
  assert.equal(isR3Allowed("packages/a/src/client/takeover.ts"), false);
  assert.equal(isR3Allowed("packages/a/src/index.ts"), false);
  const inject = analyze("slotHost.inject('settings.section', function () {});");
  assert.equal(inject.r3.length, 1);
  const regObj = analyze("slots.register({ name: 'settings.section', id: 'x' }, fn);");
  assert.equal(regObj.r3.length, 1);
  assert.equal(analyze("slots.register({ name: BODY_SLOT, key: id }, fn);").r3.length, 0);
});

test("锚定 R4：分组 disposition", () => {
  const groups = groupByPkgValue([
    { pkg: "p", value: "/api/dsh-p/a", rel: "packages/p/src/apply/a.ts", fallback: false },
    { pkg: "p", value: "/api/dsh-p/a", rel: "packages/p/src/client/shared/c.ts", fallback: true },
    { pkg: "p", value: "/api/dsh-p/b", rel: "packages/p/src/shared/r.ts", fallback: false },
    { pkg: "p", value: "/api/dsh-p/c", rel: "packages/p/src/shared/r.ts", fallback: false },
    { pkg: "p", value: "/api/dsh-p/c", rel: "packages/p/src/server/s.ts", fallback: false },
    { pkg: "p", value: "/api/remote.mux", rel: "packages/p/src/a.ts", fallback: false },
    { pkg: "p", value: "/api/remote.mux", rel: "packages/p/src/b.ts", fallback: false },
    { pkg: "p", value: "/api/remote.mux", rel: "packages/p/src/c.ts", fallback: false },
  ]);
  const disp = (pkg: string, value: string): string => {
    const g = groups.get(pkg + "||" + value);
    assert.ok(g !== undefined);
    return decideGroup({ pkg: pkg, value: value, holders: new Set(g.holders) });
  };
  assert.equal(disp("p", "/api/dsh-p/a"), "mirror-pass");
  assert.equal(disp("p", "/api/dsh-p/b"), "single");
  assert.equal(disp("p", "/api/dsh-p/c"), "mirror-noclient-red");
  assert.equal(disp("p", "/api/remote.mux"), "upstream-triple");
});

test("fail-closed 三出口（调用点恰三处：范围 / 管线 / R5 B 侧基线）", () => {
  // R5 新增第三处：B 侧 .d.ts 闭包不可解析（缺 catalog/peer/声明入口）时不得读成
  // 「全部无类型服务」放行，必须 exit 2。三处分别是 establishScope、scanAll、collectMethodGaps。
  const text = readFileSync(GATE, "utf8");
  const parts = text.split("failClosed(");
  assert.equal(parts.length - 1, 3);
});

test("fail-closed：禁 --package", () => {
  const r = spawnSync(process.execPath, [GATE, "--package", "dsh-notifier"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.ok(String(r.stderr).includes("门禁故障"));
});

test("fail-closed：坏 root", () => {
  const r = spawnSync(process.execPath, [GATE, "--root", join(ROOT, "no-such-dir-xyz")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
});

test("红路径：越位文件真跑 exit 1 且判词格式", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-vhs-red-"));
  try {
    mkdirSync(join(dir, "packages", "p", "src", "shared"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "p", "src", "shared", "x.ts"),
      "export function reg(ctx: any) { ctx.on('a/b', () => {}); }\n",
    );
    // 小 fixture 无 node_modules/catalog：--no-methods 关掉 R5，聚焦 R1-R4 判词。
    const r = spawnSync(process.execPath, [GATE, "--root", dir, "--no-methods"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    const err = String(r.stderr);
    assert.ok(err.includes("verify-host-seams: R1 根共享越位"));
    assert.ok(err.includes("FAIL（1 项"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("红路径：R2-L/R2-B 同站真跑只报 R2-B 一条", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-vhs-dedup-"));
  try {
    mkdirSync(join(dir, "packages", "p", "src", "server", "config"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "p", "src", "server", "config", "model.ts"),
      "export const u = X ?? '/api/dsh-x/y';\n",
    );
    const r = spawnSync(process.execPath, [GATE, "--root", dir, "--no-methods"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    const err = String(r.stderr);
    assert.ok(err.includes("R2-B 拼接越位"));
    assert.ok(!err.includes("R2-L 定义越位"));
    assert.ok(err.includes("FAIL（1 项"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5 历史 fixture：旧 d.ts 有 get 通过、新 d.ts 无 get 判红", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-vhs-r5-"));
  try {
    // 0.1.x 形态：Context 的 settings 面有 get(ns) —— 同一源码必须通过。
    writeMethodFixture(dir, true);
    const ok = spawnSync(process.execPath, [GATE, "--root", dir], { encoding: "utf8" });
    assert.equal(ok.status, 0, String(ok.stderr).slice(0, 800));
    assert.ok(String(ok.stdout).includes("R5 方法 OK"));
    // 0.2.x 形态：只删 get，源码与其余声明不变 —— 必须判红，且定位到 settings.get。
    writeMethodFixture(dir, false);
    const red = spawnSync(process.execPath, [GATE, "--root", dir], { encoding: "utf8" });
    assert.equal(red.status, 1, String(red.stdout).slice(0, 800));
    const err = String(red.stderr);
    assert.ok(err.includes("R5 方法越位"));
    assert.ok(err.includes("settings.get"));
    assert.ok(err.includes("已定型服务缺方法"));
    assert.ok(err.includes("FAIL（1 项"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5 关闭开关：--no-methods 下同一判红 fixture 只跑 R1-R4", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-vhs-r5-off-"));
  try {
    writeMethodFixture(dir, false);
    const r = spawnSync(process.execPath, [GATE, "--root", dir, "--no-methods"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, String(r.stderr).slice(0, 800));
    assert.ok(String(r.stdout).includes("R5 方法未启用"));
    assert.ok(!String(r.stdout).includes("R5 方法 OK"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail-closed：R5 B 侧基线不可解析 exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-vhs-r5-broken-"));
  try {
    mkdirSync(join(dir, "packages", "p", "src", "server"), { recursive: true });
    writeFileSync(join(dir, "packages", "p", "src", "server", "x.ts"), "export const a = 1;\n");
    const r = spawnSync(process.execPath, [GATE, "--root", dir], { encoding: "utf8" });
    assert.equal(r.status, 2, String(r.stdout).slice(0, 800));
    const err = String(r.stderr);
    assert.ok(err.includes("门禁故障"));
    assert.ok(err.includes("R5 B 侧基线不可解析"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("真实仓库锚：R5 方法面默认开启且 OK", () => {
  const r = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, String(r.stderr).slice(0, 800));
  assert.ok(String(r.stdout).includes("R5 方法 OK"));
});

test("真实仓库锚：收敛后 exit 0", () => {
  const r = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, String(r.stderr).slice(0, 800));
});

test("真实仓库锚：观察表含 triple 与镜像对", () => {
  const r = spawnSync(process.execPath, [GATE, "--observe"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0);
  const out = String(r.stdout);
  assert.ok(out.includes("upstream-triple") && out.includes("/api/remote.mux"));
  assert.ok(out.includes("fallback"));
  assert.ok(out.includes("mirror-pass") && out.includes("dsh-provider-usage"));
});
