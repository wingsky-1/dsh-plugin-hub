#!/usr/bin/env node
"use strict";

/**
 * collect-licenses 自测（node:test，issue #13）。
 *
 * 覆盖：
 *   - extractInlinedPackages：pnpm 布局注释 / 直接 node_modules 注释 /
 *     @deepseek-ai 宿主注入排除 / 去重排序 / 无匹配空集
 *   - collectForPackage：有内联 → 写 lib/THIRD-PARTY-LICENSES 且覆盖包名与
 *     license 文本；无内联 → 返回 [] 且不落文件；缺 lib/ → fail-loud
 * 运行：node --test scripts/collect-licenses.test.ts（或 pnpm test:scripts）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectForPackage, extractInlinedPackages } from "../build/collect-licenses.ts";

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "lic-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 造一个「已构建」的假插件包：lib/index.js 含 esbuild 内联注释 + 包级依赖。 */
function fixturePackage(
  root: string,
  { name, indexSource, depLicense }: { name: string; indexSource: string; depLicense?: string },
) {
  const pkg = join(root, "packages", name);
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "lib", "index.js"), indexSource);
  if (depLicense) {
    // pnpm 布局：包级 node_modules/<dep> 为 symlink（此处直接用真实目录简化）
    const depDir = join(pkg, "node_modules", "fake-lib");
    mkdirSync(depDir, { recursive: true });
    writeFileSync(join(depDir, "LICENSE"), depLicense);
    writeFileSync(
      join(depDir, "package.json"),
      JSON.stringify({ name: "fake-lib", version: "1.2.3", license: "MIT" }),
    );
    // win32：目录符号链接需特权，junction 无需且目录解析语义一致
    symlinkSync(
      depDir,
      join(pkg, "node_modules", "linked-lib"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  return pkg;
}

test("extractInlinedPackages：pnpm 布局与直接 node_modules 注释均可提取", () => {
  const src = [
    "// ../../node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/websocket.js",
    "export const x = 1",
    "// ../../node_modules/highlight.js/lib/core.js",
  ].join("\n");
  assert.deepEqual(extractInlinedPackages(src), ["highlight.js", "ws"]);
});

test("extractInlinedPackages：@deepseek-ai 宿主注入排除、去重、排序、空集", () => {
  const src = [
    "// node_modules/.pnpm/@deepseek-ai+dsh-client-runtime@1.0.0/node_modules/@deepseek-ai/dsh-client-runtime/index.js",
    "// ../..../node_modules/marked/lib/marked.esm.js",
    "// node_modules/.pnpm/schemastery@3.18.0/node_modules/schemastery/lib/index.js",
    "// node_modules/.pnpm/marked@18.0.9/node_modules/marked/lib/marked.cjs",
  ].join("\n");
  assert.deepEqual(extractInlinedPackages(src), ["marked", "schemastery"]);
  assert.deepEqual(extractInlinedPackages("const a = 1"), []);
});

test("extractInlinedModuleRefs：scoped 包的 .pnpm 安装段无重复前缀", async () => {
  const { extractInlinedModuleRefs } = await import("../build/collect-licenses.ts");
  const src =
    "// ../../node_modules/.pnpm/@profoundlogic+hogan@3.0.4/node_modules/@profoundlogic/hogan/lib/compiler.js";
  const refs = extractInlinedModuleRefs(src);
  assert.deepEqual(refs, [
    {
      name: "@profoundlogic/hogan",
      pnpmSeg: ".pnpm/@profoundlogic+hogan@3.0.4/node_modules/@profoundlogic/hogan",
    },
  ]);
});

test("collectForPackage：有内联 → 归集文件存在且覆盖包名与 license 文本", () => {
  const { dir, cleanup } = tempRepo();
  try {
    fixturePackage(dir, {
      name: "dsh-fixture",
      indexSource:
        "// ../../node_modules/.pnpm/fake-lib@1.2.3/node_modules/fake-lib/index.js\nexport {}",
      depLicense: "The MIT License (MIT)\n\nCopyright (c) someone",
    });
    const names = collectForPackage("packages/dsh-fixture", dir);
    assert.deepEqual(names, ["fake-lib"]);
    const out = readFileSync(join(dir, "packages/dsh-fixture/lib/THIRD-PARTY-LICENSES"), "utf8");
    assert.match(out, /THIRD-PARTY LICENSES/);
    assert.match(out, /fake-lib@1\.2\.3 — MIT/);
    assert.match(out, /The MIT License \(MIT\)/);
  } finally {
    cleanup();
  }
});

test("collectForPackage：无第三方内联 → 返回空且不写文件；缺 lib → fail-loud", () => {
  const { dir, cleanup } = tempRepo();
  try {
    fixturePackage(dir, { name: "dsh-clean", indexSource: "export const apply = () => {}" });
    assert.deepEqual(collectForPackage("packages/dsh-clean", dir), []);
    assert.ok(!existsSync(join(dir, "packages/dsh-clean/lib/THIRD-PARTY-LICENSES")));
    assert.throws(() => collectForPackage("packages/dsh-absent", dir), /缺 lib/);
  } finally {
    cleanup();
  }
});

/** 造 vendored 登记表（批 2b）：治理数据在 fixture 根的 scripts/data 下。 */
function vendoredRegistry(root: string, entries: unknown) {
  mkdirSync(join(root, "scripts", "data"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "data", "vendored-binaries.json"),
    JSON.stringify({ version: 1, entries }),
  );
}

test("collectForPackage：vendored 裸二进制（无内联）→ 许可文本并入归集并返回其路径", () => {
  const { dir, cleanup } = tempRepo();
  try {
    fixturePackage(dir, { name: "dsh-vendored", indexSource: "export const apply = () => {}" });
    const pkg = join(dir, "packages", "dsh-vendored");
    writeFileSync(join(pkg, "lib", "tool.exe"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]));
    writeFileSync(
      join(pkg, "lib", "tool.exe.LICENSE"),
      "Vendored MIT License\n\nCopyright (c) upstream",
    );
    vendoredRegistry(dir, [
      {
        path: "packages/dsh-vendored/lib/tool.exe",
        sha256: "a".repeat(64),
        license: "MIT",
        source: "https://example.invalid/upstream@1.0.0",
        licenseFile: "packages/dsh-vendored/lib/tool.exe.LICENSE",
      },
    ]);

    const names = collectForPackage("packages/dsh-vendored", dir);
    assert.deepEqual(names, ["packages/dsh-vendored/lib/tool.exe"]);
    const out = readFileSync(join(pkg, "lib", "THIRD-PARTY-LICENSES"), "utf8");
    // 头部必须写出 path：pack-check 对 tarball 的覆盖断言以它为证据（两边同源）
    assert.match(out, /vendored 二进制：packages\/dsh-vendored\/lib\/tool\.exe/);
    assert.match(out, /来源：https:\/\/example\.invalid\/upstream@1\.0\.0/);
    assert.match(out, /Vendored MIT License/);
  } finally {
    cleanup();
  }
});

test("collectForPackage：登记项的 license 文本缺失 → fail-loud（不许静默少收一段）", () => {
  const { dir, cleanup } = tempRepo();
  try {
    fixturePackage(dir, { name: "dsh-broken", indexSource: "export const apply = () => {}" });
    writeFileSync(
      join(dir, "packages", "dsh-broken", "lib", "tool.exe"),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]),
    );
    vendoredRegistry(dir, [
      {
        path: "packages/dsh-broken/lib/tool.exe",
        sha256: "a".repeat(64),
        license: "MIT",
        source: "https://example.invalid/upstream@1.0.0",
        licenseFile: "packages/dsh-broken/lib/gone.LICENSE",
      },
    ]);
    assert.throws(
      () => collectForPackage("packages/dsh-broken", dir),
      /license 文本不存在：packages\/dsh-broken\/lib\/gone\.LICENSE/,
    );
  } finally {
    cleanup();
  }
});

test("collectForPackage：first-party 登记项不进第三方许可段（自有资产没有许可文本可归集）", () => {
  const { dir, cleanup } = tempRepo();
  try {
    fixturePackage(dir, { name: "dsh-firstparty", indexSource: "export const apply = () => {}" });
    const pkg = join(dir, "packages", "dsh-firstparty");
    writeFileSync(join(pkg, "lib", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
    vendoredRegistry(dir, [
      { path: "packages/dsh-firstparty/lib/logo.png", sha256: "b".repeat(64), kind: "first-party" },
    ]);

    assert.deepEqual(collectForPackage("packages/dsh-firstparty", dir), []);
    assert.ok(
      !existsSync(join(pkg, "lib", "THIRD-PARTY-LICENSES")),
      "第一方资产不该出现在第三方许可段（那等于给它编一个来源与许可证）",
    );
  } finally {
    cleanup();
  }
});

test("collectForPackage：vendored 登记项缺字段 → fail-loud（不走 join(undefined) 的奇怪分支）", () => {
  const { dir, cleanup } = tempRepo();
  try {
    fixturePackage(dir, { name: "dsh-shape", indexSource: "export const apply = () => {}" });
    writeFileSync(
      join(dir, "packages", "dsh-shape", "lib", "tool.exe"),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]),
    );
    vendoredRegistry(dir, [
      {
        path: "packages/dsh-shape/lib/tool.exe",
        sha256: "a".repeat(64),
        license: "MIT",
        source: "https://example.invalid/upstream@1.0.0",
        // 缺 licenseFile
      },
    ]);
    assert.throws(
      () => collectForPackage("packages/dsh-shape", dir),
      /字段缺失或非字符串：licenseFile/,
    );
  } finally {
    cleanup();
  }
});

test("collectForPackage：登记表缺失按空集处理（不然 fixture 仓库与未用该机制的包都构建不了）", () => {
  const { dir, cleanup } = tempRepo();
  try {
    fixturePackage(dir, { name: "dsh-noreg", indexSource: "export const apply = () => {}" });
    assert.deepEqual(collectForPackage("packages/dsh-noreg", dir), []);
    assert.ok(!existsSync(join(dir, "packages", "dsh-noreg", "lib", "THIRD-PARTY-LICENSES")));
  } finally {
    cleanup();
  }
});
