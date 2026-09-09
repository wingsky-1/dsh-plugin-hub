#!/usr/bin/env node
// @ts-nocheck
/**
 * mutation-lib-to-src-loader 自测（node:test，issue #423 方案 A 增强）。
 *
 * 目标：防 resolve hook 静默失效——「测试 import lib 被重定向到 src」一旦
 * 失手，变异 gate 会悄悄测回产物，覆盖率/变异分失真。因此：
 *  - 直接测 loader 导出的可测试纯函数（canRedirectLibToSrc / pkgRootFromParent
 *    / resolve），不靠脆弱的产物字符串断言、不 sleep、不假定时序；
 *  - 覆盖 index / 非 index 子模块 / shared / node_modules / client 产物
 *    越界 / `..` 逃逸 / Windows 分隔符 / URL 编码 / 相对根守卫；
 *  - 子进程端到端：假仓库上以 `--import` 注入 hook 后动态 import，
 *    证明 redirect 真实发生（解析到的文件模块标记了 REDIRECT_PROOF）。
 *
 * 运行：node --test scripts/test/mutation-lib-to-src-loader.test.ts
 * （随 pnpm test:scripts 一起跑）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  canRedirectLibToSrc,
  candidateFrom,
  resolve,
  resolveForwardedLibTarget,
  toPosix,
} from "./mutation-lib-to-src-loader.mjs";

/** 临时 fake 仓库：<root>/packages/<pkg>/{lib,src,test} 骨架。 */
function fakeRepo(root, pkg = "dsh-x") {
  mkdirSync(join(root, "packages", pkg, "lib"), { recursive: true });
  mkdirSync(join(root, "packages", pkg, "src"), { recursive: true });
  mkdirSync(join(root, "packages", pkg, "test"), { recursive: true });
  return { root, pkg };
}

function lib(root, pkg, rel) {
  return join(root, "packages", pkg, "lib", ...rel.split("/"));
}
function src(root, pkg, rel) {
  return join(root, "packages", pkg, "src", ...rel.split("/"));
}

function withRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), "lib2src-"));
  try {
    return fn(fakeRepo(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("canRedirectLibToSrc: index 与非 index 子模块均重定向（任一层级相对路径）", () => {
  withRepo(({ root, pkg }) => {
    for (const rel of ["index.js", "routes.js", "sub/module.js", "a/b/c/deep.js"]) {
      const hit = canRedirectLibToSrc(lib(root, pkg, rel), { root });
      assert.ok(hit, `${rel} 应命中重定向`);
      assert.equal(toPosix(hit.filePath), toPosix(src(root, pkg, rel.slice(0, -3) + ".ts")), `${rel} 目标应为同包 src/*.ts`);
    }
  });
});

test("canRedirectLibToSrc: packages 边界保留——shared/node_modules/非 lib 一律不动", () => {
  withRepo(({ root, pkg }) => {
    // 共享层 / node_modules / 包内 src / 非 .js 产物：直接传给 canRedirectLibToSrc
    const shared = join(root, "shared", "loopback.js");
    const nodeMod = join(root, "packages", pkg, "node_modules", "dep", "lib", "x.js");
    const srcIn = join(root, "packages", pkg, "src", "routes.ts");
    const data = join(root, "packages", pkg, "lib", "data.json"); // 非 .js/.ts
    assert.equal(canRedirectLibToSrc(shared, { root }), null, "shared/loopback.js 不应命中");
    assert.equal(canRedirectLibToSrc(nodeMod, { root }), null, "包内 node_modules 不应命中");
    assert.equal(canRedirectLibToSrc(srcIn, { root }), null, "已是 src 不应命中");
    assert.equal(canRedirectLibToSrc(data, { root }), null, "lib/data.json 不应命中");
    // lib/*.ts 偶发形态：仍映射到同包 src/*.ts
    const tsHit = canRedirectLibToSrc(join(root, "packages", pkg, "lib", "index.ts"), { root });
    assert.equal(toPosix(tsHit?.filePath), toPosix(src(root, pkg, "index.ts")), "lib/index.ts 应映射到 src/index.ts");
    // 跨包：canRedirectLibToSrc 拒绝（options.pkg 限定目标包语义）
    const cross = join(root, "packages", "dsh-other", "lib", "index.js");
    assert.equal(canRedirectLibToSrc(cross, { root, pkg }), null, "跨包 lib 不应映射到本包 src");
  });
});

test("canRedirectLibToSrc: .. 路径穿越被折叠后即越界，不重定向", () => {
  withRepo(({ root, pkg }) => {
    // 路径穿越：lib 之外（含跨包、不存在的 lib 子段）
    const cases = [
      // 子段向上三层越过 lib → 解析为 packages/dsh-x/sneaky.js（src 子树外）
      join(root, "packages", pkg, "lib", "sub", "..", "..", "..", "sneaky.js"),
      // lib/index.js + 向内 ../：宿主侧合法相对文件路径（lib 内），行为由正向对照覆盖
      // 跨包 via .. 折叠：root 不可用 root 直接被拒
      join(root, "packages", pkg, "..", "..", "scripts", "x.mjs"),
    ];
    for (const p of cases) {
      const hit = canRedirectLibToSrc(p, { root });
      assert.equal(hit, null, `${p} 应因逃出 lib 不命中`);
    }
    // 正向对照：lib 内 .. 折叠后仍留在 lib 内 → 正常重定向
    const inner = join(root, "packages", pkg, "lib", "sub", "..", "index.js");
    const hit = canRedirectLibToSrc(inner, { root });
    assert.ok(hit, "lib 内 .. 折叠后仍在 lib 内应命中");
    assert.equal(toPosix(hit.filePath), toPosix(src(root, pkg, "index.ts")));
  });
});

test("canRedirectLibToSrc: client 产物不映射为宿主 src（避免宿主 src 加载 client）", () => {
  withRepo(({ root, pkg }) => {
    for (const rel of [
      "client.js",
      "client-mermaid.js",
      "client/sub/module.js", // 名义上的「client 目录内 .js」
    ]) {
      assert.equal(canRedirectLibToSrc(lib(root, pkg, rel), { root }), null, `${rel} 不应命中`);
    }
    // 宿主模块 client-logic.ts 的产物放行（不是客户端 bundle）
    const host = canRedirectLibToSrc(lib(root, pkg, "client-logic.js"), { root });
    assert.equal(toPosix(host?.filePath), toPosix(src(root, pkg, "client-logic.ts")));
  });
});

test("canRedirectLibToSrc: Windows 分隔符统一后同样命中", () => {
  withRepo(({ root, pkg }) => {
    const win = lib(root, pkg, "sub/routes.js").replaceAll("/", "\\");
    const hit = canRedirectLibToSrc(win, { root });
    assert.ok(hit, "Windows 反斜杠路径经统一后应命中");
    assert.equal(toPosix(hit.filePath), toPosix(src(root, pkg, "sub/routes.ts")));
  });
});

test("canRedirectLibToSrc: 相对/不可用 root 守卫 fail-closed", () => {
  withRepo(({ root, pkg }) => {
    const p = lib(root, pkg, "index.js");
    assert.equal(canRedirectLibToSrc(p, { root: "relative/root" }), null, "相对 root 不处理");
    assert.equal(canRedirectLibToSrc(p), null, "假仓库根不参与（真实 ROOT 不匹配）");
    // root 为 null / 空串
    assert.equal(canRedirectLibToSrc(p, { root: null }), null);
    assert.equal(canRedirectLibToSrc(p, { root: "" }), null);
  });
});

test("canRedirectLibToSrc: URL 百分号编码经 fileURLToPath 解码后往返一致", () => {
  withRepo(({ root, pkg }) => {
    const url = pathToFileURL(lib(root, pkg, "index.js")).href;
    const urlEnc = url.replace("index.js", "%69ndex.js"); // i → %69（合法编码）
    // loader 真实数据流：file: URL → fileURLToPath 解码 → 绝对路径 → 判定
    const decoded = fileURLToPath(urlEnc);
    const hit = canRedirectLibToSrc(decoded, { root });
    assert.ok(hit, "解码后的绝对路径应命中");
    assert.equal(toPosix(hit.filePath), toPosix(src(root, pkg, "index.ts")));
  });
});

// ------------------------------------------------------------------ resolve hook 端到端

test("resolve: 静态/动态 import lib 被真实重定向到 src（端到端证明 redirect 发生）", () => {
  const root = mkdtempSync(join(tmpdir(), "lib2src-e2e-"));
  const pkg = "dsh-x";
  try {
    fakeRepo(root, pkg);
    writeFileSync(join(root, "packages", pkg, "src", "index.ts"), "export const REDIRECT_PROOF = 'index-ts';\n");
    writeFileSync(join(root, "packages", pkg, "src", "routes.ts"), "export const REDIRECT_PROOF = 'routes-ts';\n");
    mkdirSync(join(root, "packages", pkg, "src", "sub"), { recursive: true });
    writeFileSync(join(root, "packages", pkg, "src", "sub", "x.ts"), "export const REDIRECT_PROOF = 'sub-x-ts';\n");

    const hookUrl = pathToFileURL(join(import.meta.dirname, "mutation-lib-to-src-hook.mjs")).href;
    const testFile = join(root, "packages", pkg, "test", "entry.mjs");
    writeFileSync(testFile, `
      const mod = await import("../lib/index.js");
      if (mod.REDIRECT_PROOF !== "index-ts") {
        throw new Error("index: 未重定向到 src（REDIRECT_PROOF=" + mod.REDIRECT_PROOF + "）");
      }
      const routes = await import("../lib/routes.js");
      if (routes.REDIRECT_PROOF !== "routes-ts") {
        throw new Error("routes: 未重定向到 src（REDIRECT_PROOF=" + routes.REDIRECT_PROOF + "）");
      }
      const sub = await import("../lib/sub/x.js");
      if (sub.REDIRECT_PROOF !== "sub-x-ts") {
        throw new Error("sub/x: 未重定向到 src（REDIRECT_PROOF=" + sub.REDIRECT_PROOF + "）");
      }
      const dyn = await import("../lib/routes.js");
      if (dyn.REDIRECT_PROOF !== "routes-ts") {
        throw new Error("动态 import 未重定向");
      }
      console.log("E2E_OK");
    `);

    const env = { ...process.env, DSH_MUTATION_LIB2SRC_ROOT: root };
    const r = spawnSync(process.execPath, ["--import", hookUrl, testFile], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    assert.equal(r.status, 0, `子进程应退出 0：\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /E2E_OK/, `端到端应输出 E2E_OK，实际：${r.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolve: nextResolve 兜底也修正 lib 产物（file: URL 相对派生）", async () => {
  // 进程内直接调模块 resolve：需先设 env 指向 fake 仓库（currentRoot 惰性读取）
  const root = mkdtempSync(join(tmpdir(), "lib2src-alt-"));
  const pkg = "dsh-x";
  const prevRoot = process.env.DSH_MUTATION_LIB2SRC_ROOT;
  process.env.DSH_MUTATION_LIB2SRC_ROOT = root;
  try {
    fakeRepo(root, pkg);
    const entryUrl = pathToFileURL(join(root, "packages", pkg, "test", "entry.mjs"));
    const spec = pathToFileURL(join(root, "packages", pkg, "lib", "index.js"));
    const ctx = { parentURL: entryUrl.href };
    const out = await resolve(spec.href, ctx, async () => ({ url: spec.href }));
    assert.equal(out.url, pathToFileURL(join(root, "packages", pkg, "src", "index.ts")).href);
    assert.equal(out.shortCircuit, true);
  } finally {
    if (prevRoot === undefined) delete process.env.DSH_MUTATION_LIB2SRC_ROOT;
    else process.env.DSH_MUTATION_LIB2SRC_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolve: 非 lib（bare / node: / 普通相对）原样透传", async () => {
  const root = mkdtempSync(join(tmpdir(), "lib2src-pass-"));
  const pkg = "dsh-x";
  const prevRoot = process.env.DSH_MUTATION_LIB2SRC_ROOT;
  process.env.DSH_MUTATION_LIB2SRC_ROOT = root;
  try {
    fakeRepo(root, pkg);
    const parent = pathToFileURL(join(root, "packages", pkg, "test", "entry.mjs")).href;
    // bare / node: 交给 nextResolve
    for (const spec of ["node:fs", "some-bare-pkg"]) {
      const out = await resolve(spec, { parentURL: parent }, async () => ({ url: `file:///resolved/${spec}` }));
      assert.equal(out.url, `file:///resolved/${spec}`, `${spec} 应原样透传`);
      assert.notEqual(out.shortCircuit, true);
    }
    // 相对普通文件：nextResolve 结果非 lib 形态 → 透传
    const plain = await resolve("../helpers.js", { parentURL: parent }, async () => ({ url: pathToFileURL(join(root, "packages", pkg, "test", "helpers.js")).href }));
    assert.equal(plain.url, pathToFileURL(join(root, "packages", pkg, "test", "helpers.js")).href);
  } finally {
    if (prevRoot === undefined) delete process.env.DSH_MUTATION_LIB2SRC_ROOT;
    else process.env.DSH_MUTATION_LIB2SRC_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolve: 跨包 lib 引用不重定向（parent 为另一包时原样透传）", async () => {
  const root = mkdtempSync(join(tmpdir(), "lib2src-cross-"));
  const prevRoot = process.env.DSH_MUTATION_LIB2SRC_ROOT;
  process.env.DSH_MUTATION_LIB2SRC_ROOT = root;
  try {
    fakeRepo(root, "dsh-x");
    fakeRepo(root, "dsh-other");
    const parent = pathToFileURL(join(root, "packages", "dsh-x", "test", "entry.mjs")).href;
    // dsh-x 测试引用 dsh-other 的 lib 产物 → 不应重定向（保留 packages 边界）
    const spec = pathToFileURL(join(root, "packages", "dsh-other", "lib", "index.js")).href;
    const out = await resolve(spec, { parentURL: parent }, async () => ({ url: spec }));
    assert.equal(out.url, spec, "跨包 lib 引用应原样透传（不得映射到 dsh-other/src）");
  } finally {
    if (prevRoot === undefined) delete process.env.DSH_MUTATION_LIB2SRC_ROOT;
    else process.env.DSH_MUTATION_LIB2SRC_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pkgRootFromParent: 仅识别 packages/<pkg>/ 下的父文件（candidateFrom 形式）", () => {
  const root = mkdtempSync(join(tmpdir(), "lib2src-pkg-"));
  const pkg = "dsh-x";
  try {
    fakeRepo(root, pkg);
    const inPkg = candidateFrom("../lib/index.js", pathToFileURL(join(root, "packages", pkg, "test", "entry.mjs")).href);
    assert.equal(toPosix(canRedirectLibToSrc(inPkg, { root, pkg })?.filePath), toPosix(src(root, pkg, "index.ts")));
    // 包外父目录：candidateFrom 仍可解析（普通路径解析），但 canRedirectLibToSrc 应拒绝
    const outside = candidateFrom("../lib/index.js", pathToFileURL(join(root, "scripts", "x.mjs")).href);
    assert.equal(canRedirectLibToSrc(outside, { root }), null);
    // 跨包（dsh-other）候选仍可解析，但 canRedirectLibToSrc 应拒绝
    const cross = candidateFrom("../lib/index.js", pathToFileURL(join(root, "packages", "dsh-other", "test", "entry.mjs")).href);
    assert.equal(canRedirectLibToSrc(cross, { root, pkg }), null);
    // 非 file: URL 父目录：candidateFrom 返回 null
    assert.equal(candidateFrom("../lib/index.js", "not-a-url"), null);
    // 非 ./ ../ 形态：candidateFrom 返回 null（交给 nextResolve）
    assert.equal(candidateFrom("bare-pkg", "file:///whatever"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveForwardedLibTarget: src 目标不存在时解析到组合根真实实现（阶段四 #670）", () => {
  withRepo(({ root, pkg }) => {
    // 场景：组合根移入子目录——sandbox 里 src/index.ts 不存在、src/apply/index.ts
    // 存在；lib/index.js 可能为 prepare-lib-entry 薄转发（bundle-host 前）或
    // 已内联的完整 bundle（bundle-host 后，无转发语义）——两种形态都要落到
    // src/apply/index.ts。
    mkdirSync(src(root, pkg, "apply"), { recursive: true });
    writeFileSync(src(root, pkg, "apply/index.ts"), "export const apply = () => {};\n", "utf8");

    // 形态一：薄转发（export * from "./apply/index.js"）→ 沿链解析
    writeFileSync(lib(root, pkg, "index.js"), 'export * from "./apply/index.js";\n', "utf8");
    const hit = canRedirectLibToSrc(lib(root, pkg, "index.js"), { root });
    assert.equal(toPosix(hit.filePath), toPosix(src(root, pkg, "index.ts")));
    const forwarded = resolveForwardedLibTarget(hit.filePath, { root });
    assert.equal(toPosix(forwarded), toPosix(src(root, pkg, "apply/index.ts")), "薄转发形态应解析到 src/apply/index.ts");

    // 形态二：bundle-host 内联后的完整 bundle（无相对 from）→ 组合根入口探测
    writeFileSync(lib(root, pkg, "index.js"), "// @ts-nocheck\nvar __create = Object.create;\n", "utf8");
    const bundleHit = canRedirectLibToSrc(lib(root, pkg, "index.js"), { root });
    const bundleFwd = resolveForwardedLibTarget(bundleHit.filePath, { root });
    assert.equal(toPosix(bundleFwd), toPosix(src(root, pkg, "apply/index.ts")), "内联 bundle 形态应经组合根探测落到 src/apply/index.ts");

    // 目标存在时不做转发（普通子模块路径不受影响）
    writeFileSync(src(root, pkg, "routes.ts"), "export const x = 1;\n", "utf8");
    writeFileSync(lib(root, pkg, "routes.js"), "export const x = 1;\n", "utf8");
    const plainHit = canRedirectLibToSrc(lib(root, pkg, "routes.js"), { root });
    assert.equal(resolveForwardedLibTarget(plainHit.filePath, { root }), null, "src 目标存在时应返回 null");

    // 非 index 且转发悬空 → null（fail 可见，不静默吞）
    writeFileSync(lib(root, pkg, "ghost.js"), 'export * from "./missing/index.js";\n', "utf8");
    const ghostHit = canRedirectLibToSrc(lib(root, pkg, "ghost.js"), { root });
    assert.equal(resolveForwardedLibTarget(ghostHit.filePath, { root }), null, "悬空转发应返回 null");
  });
});

test("resolve: lib/index.js 转发入口在变异宿主内解析到 src/apply/index.ts（端到端）", async () => {
  const root = mkdtempSync(join(tmpdir(), "lib2src-fwd-"));
  const prevRoot = process.env.DSH_MUTATION_LIB2SRC_ROOT;
  process.env.DSH_MUTATION_LIB2SRC_ROOT = root;
  try {
    const pkg = "dsh-x";
    fakeRepo(root, pkg);
    mkdirSync(src(root, pkg, "apply"), { recursive: true });
    writeFileSync(lib(root, pkg, "index.js"), 'export * from "./apply/index.js";\n', "utf8");
    writeFileSync(src(root, pkg, "apply/index.ts"), "export const apply = () => {};\n", "utf8");
    const parent = pathToFileURL(join(root, "packages", pkg, "test", "entry.mjs")).href;
    const spec = pathToFileURL(lib(root, pkg, "index.js")).href;
    const out = await resolve(spec, { parentURL: parent }, async () => ({ url: spec }));
    assert.equal(
      toPosix(fileURLToPath(out.url)),
      toPosix(src(root, pkg, "apply/index.ts")),
      "resolve 应把转发入口重定向到 src/apply/index.ts",
    );
  } finally {
    if (prevRoot === undefined) delete process.env.DSH_MUTATION_LIB2SRC_ROOT;
    else process.env.DSH_MUTATION_LIB2SRC_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  }
});