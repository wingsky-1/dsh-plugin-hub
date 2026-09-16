#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * client-contract-lib 的导出键集判据回归测试（issue #843 §3 R2-M-4）。
 *
 * 为什么存在：仓库约定客户端是干净模块——只 `export function apply` + `export const inject`，
 * 而原断言只查 apply 是函数、inject 是数组。「多导出一个键」在真实产物上无人拦：externals
 * 路径把干净模块编译成 cjs 再内联，源码里每个 export 都装到 module.exports 上，第三个键
 * 照样全绿。本文件用两种输入证明判据会红（多一个键 / 缺 inject），并用干净产物证明它不恒假。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertClientContract } from "../lib/client-contract-lib.ts";
import { buildClient } from "../build/build-client.ts";

const PKG = "@wingsky-1/export-keys-test";
/** 判据键名的字面量副本：不从被测实现 import，键名被改时这里必须跟着改（防同源期望）。 */
const KEYSET_CHECK = "materialize后exports键集恰为apply+inject";

/** 与真实产物同构的最小契约外壳：注册 factory → materialize 后返回给定的 exports 表达式。 */
const product = (exportsExpr) =>
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG)}, factory: function (require) { return ${exportsExpr}; } });`;

test("导出键集：恰好 apply + inject → 通过（防判据恒假）", () => {
  const { ok, checks } = assertClientContract(
    PKG,
    product("{ apply: function () {}, inject: [] }"),
  );
  assert.equal(checks[KEYSET_CHECK], true, `干净产物应通过键集判据：${JSON.stringify(checks)}`);
  assert.equal(ok, true, "干净产物整体应通过");
});

test("导出键集：多导出一个键 → 判红，且只有键集判据红", () => {
  const { ok, checks } = assertClientContract(
    PKG,
    product("{ apply: function () {}, inject: [], helper: 1 }"),
  );
  assert.equal(checks[KEYSET_CHECK], false, `多一个键必须判红：${JSON.stringify(checks)}`);
  assert.equal(ok, false, "键集违例必须让整体判红");
  const failed = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  assert.deepEqual(failed, [KEYSET_CHECK], `判红必须只来自键集判据：${JSON.stringify(checks)}`);
});

test("导出键集：缺 inject → 键集判据独立判红（不靠既有 inject 形态判据顺带红）", () => {
  const { ok, checks } = assertClientContract(PKG, product("{ apply: function () {} }"));
  assert.equal(
    checks["materialize后exports.inject为数组"],
    false,
    "前提：缺 inject 本来就被既有形态判据覆盖",
  );
  assert.equal(checks[KEYSET_CHECK], false, `键集判据必须也判红：${JSON.stringify(checks)}`);
  assert.equal(ok, false, "缺 inject 必须让整体判红");
});

test("导出键集：真实构建产物（externals 路径）多一个 export → 判红", async () => {
  const dir = mkdtempSync(join(tmpdir(), "export-keys-"));
  try {
    const src = join(dir, "client.ts");
    writeFileSync(
      src,
      [
        'import * as React from "react";',
        "export const inject: string[] = [];",
        "export function apply() { return () => (React as any).marker }",
        "export const helper = 1;",
        "",
      ].join("\n"),
    );
    const out = join(dir, "client.js");
    await buildClient({ src, outfile: out, packageName: PKG, externals: ["react"] });
    const { ok, checks } = assertClientContract(PKG, readFileSync(out, "utf8"));
    assert.equal(
      checks[KEYSET_CHECK],
      false,
      `多出的 export 必须进键集判据：${JSON.stringify(checks)}`,
    );
    assert.equal(ok, false, "多出一个 export 的真实产物必须判红");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
