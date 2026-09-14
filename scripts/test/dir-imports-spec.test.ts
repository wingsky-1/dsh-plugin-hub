#!/usr/bin/env node
"use strict";

/**
 * classifySpec 单测（#792 PR1 取数层）：三分类与 name 归一化。
 *
 * 为什么需要：PR6 的「共享层禁 node / 禁引插件包」判据全部建立在这个分类上，分类错一格
 * 判据就整条失效——把 `node:fs` 判成 external 等于把禁止面直接放行，而真实包当前跑绿
 * 证明不了这件事。故这里覆盖两个事实源形态（前缀名 / 裸名）与归一化边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { classifySpec } from "../lib/dir-imports-spec.ts";

test("builtin：node: 前缀名与裸内置名归一到同一 name", () => {
  assert.deepEqual(classifySpec("node:fs"), { kind: "builtin", name: "fs" });
  assert.deepEqual(classifySpec("fs"), { kind: "builtin", name: "fs" });
  assert.deepEqual(classifySpec("path"), { kind: "builtin", name: "path" });
  assert.deepEqual(classifySpec("child_process"), { kind: "builtin", name: "child_process" });
});

test("builtin：覆盖 builtinModules 全集，两种写法都必须判 builtin", () => {
  for (const name of builtinModules) {
    const bare = name.startsWith("node:") ? name.slice("node:".length) : name;
    assert.deepEqual(classifySpec(bare), { kind: "builtin", name: bare }, `裸名 ${bare}`);
    assert.deepEqual(
      classifySpec(`node:${bare}`),
      { kind: "builtin", name: bare },
      `前缀名 ${bare}`,
    );
  }
});

test("relative：相对路径与绝对路径都不是包", () => {
  assert.deepEqual(classifySpec("./a.ts"), { kind: "relative", name: "./a.ts" });
  assert.deepEqual(classifySpec("../b/interface.ts"), {
    kind: "relative",
    name: "../b/interface.ts",
  });
  assert.deepEqual(classifySpec("/abs/path.ts"), { kind: "relative", name: "/abs/path.ts" });
});

test("external：包名归一（scoped 取两段、丢弃子路径）", () => {
  assert.deepEqual(classifySpec("@deepseek-ai/dsh-tools"), {
    kind: "external",
    name: "@deepseek-ai/dsh-tools",
  });
  assert.deepEqual(classifySpec("@deepseek-ai/dsh-tools/lib/client.js"), {
    kind: "external",
    name: "@deepseek-ai/dsh-tools",
  });
  assert.deepEqual(classifySpec("lodash/merge"), { kind: "external", name: "lodash" });
  assert.deepEqual(classifySpec("cordis"), { kind: "external", name: "cordis" });
});

test("边界：node: 前缀的未知名归 builtin（归错方向只会更严）", () => {
  assert.deepEqual(classifySpec("node:not-a-real-builtin"), {
    kind: "builtin",
    name: "not-a-real-builtin",
  });
});
