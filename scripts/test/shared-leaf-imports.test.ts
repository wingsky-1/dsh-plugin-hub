#!/usr/bin/env node
// @ts-nocheck
/**
 * 「src/shared 只能做零依赖叶子」判据（此前完全缺失）。
 *
 * 约束来源：src/shared/ 是包内**两端共享面**——宿主端经 tsc emit 后被 esbuild 内联，客户端则由
 * esbuild **直接**解析该目录的 .ts、内联进 lib/client.js。于是同级模块一旦有依赖，症状分三档：
 *   a) bare 第三方 import → **静默**内联进浏览器产物（无报错，最危险的一种）；
 *   b) `node:` 前缀 → 客户端（平台 browser）构建硬失败；
 *   c) 跨目录相对引用 → 把别的代码拖进客户端产物。
 * 这三条在本次 shared 收口（sounds.ts / kinds.ts）之前没有任何机械判据守着，全靠人记得。
 *
 * 判据形态：与 scripts/gate/forbid-module-state-src.mjs 同形——esbuild 的 ts loader 转译后由
 * acorn 取 AST，再用 node:module 的 SourceMap 把行号映射回源码。两处额外口径：
 *   - tsconfigRaw.verbatimModuleSyntax=true：**未使用的值 import 不得被省略**（零 import 的规则
 *     不区分用没用过）；
 *   - 转译前把 `import type …` / `export type { … } from` 归一成值形态再解析：纯类型 import
 *     会被 ts loader 整体擦除，但本判据要守的是「文件里出现 import 语句」这件事本身——它的存在
 *     会让读者以为本目录有依赖，而下一个把 `type` 去掉的人会立刻炸客户端构建。类型别名声明
 *     （`export type X = …`）不在归一化范围内，故不会被误判成 re-export。
 *
 * 扫描面为什么不是「packages 下全部 src/shared 目录」：
 *   判据只对「客户端经 src/shared/interface.ts 消费共享面」的包成立——客户端走门面，门面转出的
 *   每个目标都会被 esbuild 解析，所以整个 src/shared/ 目录都得是叶子。反例是 dsh-provider-usage：
 *   它的客户端**刻意不走**门面（它 src/shared 里的 config.ts / ui-config.ts 带 schemastery 与
 *   node:fs，是宿主专属模块），把那种目录拉进面里只会得到与真实风险无关的红。故扫描面 =
 *   「本包 src/client/** 里有静态 import 指向本包 src/shared/interface.ts」的包的整个 src/shared/。
 *   扫描面为空即判红（fail-closed），不允许退化成「零违规」。
 *
 * 运行：node --test scripts/test/shared-leaf-imports.test.ts（pnpm test:scripts 亦覆盖）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as acorn from "acorn";
import { transform } from "esbuild";

import { walkFiles } from "../lib/walk-files.ts";

const ROOT = join(import.meta.dirname, "../..");

/** 收集 dir 下满足谓词的文件（相对路径，/ 分隔）；目录不存在时给空集而不是抛。 */
function filesUnder(dir, predicate) {
  return existsSync(dir) ? walkFiles(dir, predicate) : [];
}

/** 类型 import / 类型 re-export 归一成值形态（类型别名声明不动，见文件头）。 */
function normalizeTypeImports(text) {
  return text
    .replace(/\bimport\s+type\s/g, "import ")
    .replace(/\bexport\s+type\s*\{/g, "export {")
    .replace(/\bexport\s+type\s*\*/g, "export *");
}

/**
 * 单文件里的模块 specifier（静态 import / export-from / import= require / 动态 import），带源码行号。
 * 转译或解析失败时抛出（调用方按 fail-closed 判红）。
 */
async function specifiersOf(file) {
  const normalized = normalizeTypeImports(readFileSync(file, "utf8"));
  const { code, map } = await transform(normalized, {
    loader: file.endsWith(".tsx") ? "tsx" : "ts",
    sourcefile: file,
    sourcemap: true,
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  });
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const sourceMap = map ? new SourceMap(JSON.parse(map)) : null;
  /** 转译后行号 → 源码行号（转译可能重排换行，故一律过 SourceMap）。 */
  const lineOf = (node) => {
    if (sourceMap) {
      const entry = sourceMap.findEntry(node.loc.start.line - 1, node.loc.start.column);
      if (entry?.originalLine !== undefined) return entry.originalLine + 1;
    }
    return node.loc.start.line;
  };
  const found = [];
  const push = (literal) => {
    if (literal !== undefined && literal !== null && typeof literal.value === "string") {
      found.push({ spec: literal.value, line: lineOf(literal) });
    }
  };
  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source
    ) {
      push(node.source);
    } else if (node.type === "ImportExpression") {
      push(node.source);
    } else if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      push(node.arguments[0]);
    }
    for (const key of Object.keys(node)) {
      if (key !== "loc") walk(node[key]);
    }
  };
  walk(ast);
  return found;
}

/** 一个 specifier 的违规判定；合法（同目录相对）返回 null。 */
function violationOf(spec) {
  if (spec.startsWith("node:")) {
    return {
      kind: "node-builtin",
      reason: "值引 node: 前缀模块——客户端（平台 browser）构建会硬失败",
    };
  }
  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    return { kind: "bare", reason: "bare 第三方 import——会被静默内联进浏览器产物（无报错）" };
  }
  if (!spec.startsWith("./") || spec.split("/").includes("..")) {
    return {
      kind: "cross-dir",
      reason: '跨目录相对引用——会把别的代码拖进客户端产物；只允许同目录 "./x.ts"',
    };
  }
  return null;
}

/** 本包客户端是否经 src/shared/interface.ts 消费共享面（判据的适用前提，见文件头）。 */
async function clientUsesFacade(pkgDir) {
  const facade = join(pkgDir, "src", "shared", "interface.ts");
  const clientDir = join(pkgDir, "src", "client");
  if (!existsSync(facade) || !existsSync(clientDir)) return false;
  const clientFiles = filesUnder(
    clientDir,
    (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
  );
  for (const rel of clientFiles) {
    const file = join(clientDir, rel);
    let specs;
    try {
      specs = await specifiersOf(file);
    } catch {
      // 客户端文件不在判定面内（它有 typecheck / lint / 产物契约各自的门禁）；读不出来就不构成前提，
      // 真到了「一个门面消费者都认不出」的地步，下面的扫描面为空会判红。
      continue;
    }
    for (const { spec } of specs) {
      if (spec.startsWith(".") && resolve(dirname(file), spec) === facade) return true;
    }
  }
  return false;
}

/** 扫描面与违规清单。扫描面为空 → 一条 empty-scan 违规（判据不得恒绿）。 */
async function scanSharedLeafImports(root) {
  const packagesDir = join(root, "packages");
  const packages = existsSync(packagesDir)
    ? readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => existsSync(join(packagesDir, name, "src")))
    : [];
  const scanned = [];
  for (const pkg of packages) {
    const pkgDir = join(packagesDir, pkg);
    if (!(await clientUsesFacade(pkgDir))) continue;
    const sharedDir = join(pkgDir, "src", "shared");
    for (const rel of filesUnder(sharedDir, (name) => name.endsWith(".ts"))) {
      scanned.push({
        pkg,
        rel: "packages/" + pkg + "/src/shared/" + rel,
        abs: join(sharedDir, rel),
      });
    }
  }
  const violations = [];
  if (scanned.length === 0) {
    violations.push({
      file: "<scan>",
      line: 0,
      spec: "",
      kind: "empty-scan",
      reason:
        "扫描面为空：没有任何包的 src/client/** 经 src/shared/interface.ts 引用两端共享面——判据会退化成恒绿（fail-closed）",
    });
  }
  for (const entry of scanned) {
    let specs;
    try {
      specs = await specifiersOf(entry.abs);
    } catch (e) {
      violations.push({
        file: entry.rel,
        line: 0,
        spec: "",
        kind: "parse-failed",
        reason: "源文件解析失败（fail-closed，一律判红）：" + String(e.message).split("\n")[0],
      });
      continue;
    }
    for (const { spec, line } of specs) {
      const bad = violationOf(spec);
      if (bad !== null)
        violations.push({ file: entry.rel, line, spec, kind: bad.kind, reason: bad.reason });
    }
  }
  return { scanned, violations };
}

/** 构造最小 fixture 仓库；files 的键是相对 fixture 根的路径。 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "shared-leaf-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/** 在隔离目录里跑一次判据并保证清理（测试不得在仓库内留产物）。 */
async function run(files) {
  const dir = fixture(files);
  try {
    return await scanSharedLeafImports(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 一个「客户端走门面」的最小包骨架（共享面内容由各用例补）。 */
function pkgWithFacade(sharedFiles, pkg = "fx") {
  const files = {
    ["packages/" + pkg + "/src/client/index.tsx"]:
      'import { A } from "../shared/interface.ts";\nexport const use = A;\n',
  };
  for (const [rel, content] of Object.entries(sharedFiles)) {
    files["packages/" + pkg + "/src/shared/" + rel] = content;
  }
  return files;
}

// ---------------------------------------------------------------- 真实仓库

test("真实仓库：扫描面非空、至少覆盖 dsh-notifier 的 src/shared，且零违规", async () => {
  const { scanned, violations } = await scanSharedLeafImports(ROOT);
  assert.deepEqual(
    violations,
    [],
    "src/shared 出现了叶子约束违规：" +
      violations.map((v) => `${v.file}:${v.line} [${v.kind}] ${v.spec} —— ${v.reason}`).join("；"),
  );
  assert.ok(scanned.length >= 2, `扫描面至少 2 个文件（否则判据形同虚设），实际 ${scanned.length}`);
  const notifier = scanned.filter((entry) => entry.pkg === "dsh-notifier");
  assert.ok(
    notifier.length >= 2,
    "dsh-notifier 的 src/shared 必须在扫描面内——它是本判据要守的那个「客户端走门面」的包",
  );
  for (const known of ["interface.ts", "tones.ts", "sounds.ts", "kinds.ts"]) {
    assert.ok(
      notifier.some((entry) => entry.rel.endsWith("/" + known)),
      `dsh-notifier src/shared 少了 ${known}（扫描面口径变了，先复核这个断言再改）`,
    );
  }
});

test("扫描面口径：客户端不经门面的包不入面（provider-usage 的 src/shared 是宿主专属模块）", async () => {
  const { scanned } = await scanSharedLeafImports(ROOT);
  // 面变了这条先红，提示复核：dsh-provider-usage 的 src/shared 里有 schemastery / node:fs 这类
  // 只可能出现在宿主端的依赖，它的客户端按设计直引实现文件、不走 interface.ts。
  assert.equal(
    scanned.some((entry) => entry.pkg === "dsh-provider-usage"),
    false,
    "dsh-provider-usage 进了扫描面——它的 src/shared 不是两端共享叶子面，请复核适用前提",
  );
});

// ---------------------------------------------------------------- 反例（三类违例各自判红）

test("反例 a：bare 第三方 import → 判红且点名「静默内联」", async () => {
  const { scanned, violations } = await run(
    pkgWithFacade({ "interface.ts": 'import z from "schemastery";\nexport const A = z;\n' }),
  );
  assert.equal(scanned.length, 1);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].kind, "bare");
  assert.equal(violations[0].spec, "schemastery");
  assert.match(violations[0].reason, /静默内联/);
  assert.equal(violations[0].line, 1, "行号指向出问题的 import 语句");
});

test("反例 a 变体：未使用的值 import 同样判红（不得只靠「用了没用」判定）", async () => {
  const { violations } = await run(
    pkgWithFacade({ "interface.ts": 'import z from "schemastery";\nexport const A = 1;\n' }),
  );
  assert.deepEqual(
    violations.map((v) => v.kind),
    ["bare"],
  );
});

test("反例 b：node: 前缀 import → 判红且点名「客户端构建硬失败」", async () => {
  const { violations } = await run(
    pkgWithFacade({
      "interface.ts": 'import { readFile } from "node:fs/promises";\nexport const A = readFile;\n',
    }),
  );
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].kind, "node-builtin");
  assert.match(violations[0].reason, /硬失败/);
});

test("反例 c：跨目录相对引用（../）→ 判红", async () => {
  const { violations } = await run(
    pkgWithFacade({ "interface.ts": 'export { B } from "../sibling.ts";\n' }),
  );
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].kind, "cross-dir");
  assert.equal(violations[0].spec, "../sibling.ts");
});

test("反例 c 变体：多行 import、动态 import、import= require 的越界同样命中", async () => {
  const { violations } = await run(
    pkgWithFacade({
      "interface.ts": [
        'import {\n  B,\n} from "node:fs";',
        'import fs = require("node:path");',
        'export const load = () => import("../lazy.ts");',
        'export * from "./deep/../../outside.ts";',
        "",
      ].join("\n"),
    }),
  );
  assert.deepEqual(
    violations.map((v) => v.kind),
    ["node-builtin", "node-builtin", "cross-dir", "cross-dir"],
  );
});

test("反例 d：纯类型 import / 类型 re-export 也判红（文件里出现 import 语句即违规）", async () => {
  const { violations } = await run(
    pkgWithFacade({
      "interface.ts": [
        'import type { Stats } from "node:fs";',
        'import type Z from "yaml";',
        'export type { N } from "../types.ts";',
        "export const A = 1;",
        "",
      ].join("\n"),
    }),
  );
  assert.deepEqual(
    violations.map((v) => v.kind),
    ["node-builtin", "bare", "cross-dir"],
  );
});

test("回归：类型别名声明（export type X = …）不得被当成 re-export 误判", async () => {
  const { scanned, violations } = await run(
    pkgWithFacade({
      "interface.ts": 'export type X = "a" | "b";\nexport const A: X = "a";\n',
    }),
  );
  assert.equal(scanned.length, 1);
  assert.deepEqual(violations, [], JSON.stringify(violations));
});

test("回归：注释里的伪 import 语句不算命中", async () => {
  const { violations } = await run(
    pkgWithFacade({
      "interface.ts": [
        '// 例如 import type { X } from "yaml"',
        '/* export type { Y } from "node:fs" */',
        '/** 反例：import z from "schemastery" */',
        "export const A = 1;",
        "",
      ].join("\n"),
    }),
  );
  assert.deepEqual(violations, [], JSON.stringify(violations));
});

test("fail-closed：语法损坏的共享面文件 → 判红并指明解析失败", async () => {
  const { violations } = await run(pkgWithFacade({ "interface.ts": "export const A = (((\n" }));
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].kind, "parse-failed");
  assert.match(violations[0].reason, /解析失败/);
});

// ---------------------------------------------------------------- 正例与扫描面隔离

test("正例：零 import 与同目录 ./ 相对 import 放行（面非空）", async () => {
  const { scanned, violations } = await run(
    pkgWithFacade({
      "interface.ts": 'export { A } from "./a.ts";\nexport type { N } from "./types.ts";\n',
      "a.ts": "export const A = 1;\n",
      "types.ts": "export type N = number;\n",
    }),
  );
  assert.deepEqual(violations, []);
  assert.equal(scanned.length, 3);
});

test("fail-closed：有 src/shared 但客户端不走门面 → 扫描面为空即判红", async () => {
  const { scanned, violations } = await run({
    "packages/fx/src/client/index.tsx": "export const x = 1;\n",
    "packages/fx/src/shared/a.ts": "export const A = 1;\n",
  });
  assert.equal(scanned.length, 0);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].kind, "empty-scan");
  assert.match(violations[0].reason, /恒绿/);
});

test("扫描面隔离：门面包的共享面被扫，非门面包的同名目录不被牵连", async () => {
  const files = {
    ...pkgWithFacade({ "interface.ts": "export const A = 1;\n" }, "withfacade"),
    "packages/nofacade/src/client/index.tsx": "export const x = 1;\n",
    "packages/nofacade/src/shared/interface.ts":
      'import { readFileSync } from "node:fs";\nexport const A = readFileSync;\n',
  };
  const { scanned, violations } = await run(files);
  assert.deepEqual(
    scanned.map((entry) => entry.pkg),
    ["withfacade"],
  );
  assert.deepEqual(violations, [], JSON.stringify(violations));
});

test("扫描面不是「只看文件名」：src/shared 之外的文件不参与判定", async () => {
  const files = {
    ...pkgWithFacade({ "interface.ts": "export const A = 1;\n" }),
    "packages/fx/src/server/uses-node.ts":
      'import { readFile } from "node:fs";\nexport const A = readFile;\n',
  };
  const { scanned, violations } = await run(files);
  assert.equal(scanned.length, 1);
  assert.deepEqual(violations, []);
});
