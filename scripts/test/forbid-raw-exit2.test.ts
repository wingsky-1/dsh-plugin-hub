#!/usr/bin/env node
// @ts-nocheck
/**
 * forbid-raw-exit2.mjs 自测（#843 P-2 的否定判据）：正反例 + AST 边界 + fail-closed。
 *
 * 边界用例是这份自测的要点：判据走 AST，注释与字符串里的同形文本**不能**命中（本判据自己的
 * 文件头与 lib/gate-exit.mjs 的说明都逐字含这些形态）；而 `return 2` 与 `{ exitCode: 2 }` 是
 * 显式排除的形态（归 L3 退出码契约归一），它们**必须**判绿——否则本判据会顺手改写二十处函数的
 * 返回语义，那是本批次明确不做的事。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts", "gate", "forbid-raw-exit2.mjs");

/**
 * 构造最小 fixture 仓库（--root 注入）：files = [{ rel, content }]，rel 相对仓库根。
 * 两个扫描面目录**一律先建出来**：判据对「面不可读」是 fail-closed（exit 2），
 * fixture 少建一个目录测到的就是那条分支，而不是用例想测的东西。
 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "forbid-raw-exit2-"));
  mkdirSync(join(dir, "scripts", "gate"), { recursive: true });
  mkdirSync(join(dir, "scripts", "release"), { recursive: true });
  for (const { rel, content } of files) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function run(files) {
  const dir = fixture(files);
  try {
    return spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("正例：扫描面里没有任何 exit 2 形态 → exit 0", () => {
  const r = run([
    { rel: "scripts/gate/a.mjs", content: "export const ok = 1\n" },
    { rel: "scripts/release/b.ts", content: "export const ok: number = 1\n" },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /无裸 exit 2/);
});

test("反例：process.exit(2) → exit 1 且点名文件与行号（本判据要防的核心方向）", () => {
  const r = run([
    { rel: "scripts/gate/a.mjs", content: "export function f() {\n  process.exit(2);\n}\n" },
  ]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /scripts\/gate\/a\.mjs:2 裸 process\.exit\(2\)/);
  assert.match(r.stderr, /FAIL（扫描 1 文件）/);
});

test("反例：process.exitCode = 2 与裸 exitCode = 2 同判", () => {
  const r = run([
    {
      rel: "scripts/gate/a.mjs",
      content: "process.exitCode = 2;\nlet exitCode = 0;\nexitCode = 2;\n",
    },
  ]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /a\.mjs:1 裸 exitCode = 2/);
  assert.match(r.stderr, /a\.mjs:3 裸 exitCode = 2/);
});

test("反例：.ts 文件同样在面内（判据不按扩展名开口子）", () => {
  const r = run([
    {
      rel: "scripts/release/a.ts",
      content: "export const x: number = 1;\nexport function f(): void {\n  process.exit(2);\n}\n",
    },
  ]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /scripts\/release\/a\.ts:3 裸 process\.exit\(2\)/);
});

test("行号锚：命中之前的注释行不得让报出的行号偏小（.ts 经 sourcemap 校正）", () => {
  // esbuild 剥类型时会丢掉注释，不映射行号就会把第 4 行报成第 3 行甚至第 2 行——判词里的行号
  // 是给人照着改的，偏一行就等于把读者指到别处（实测三行探针文件曾报成第 2 行）。
  const js = run([
    { rel: "scripts/gate/a.mjs", content: "// 注释\n// 再来一行\nif (bad) process.exit(2);\n" },
  ]);
  assert.equal(js.status, 1, js.stdout);
  assert.match(js.stderr, /scripts\/gate\/a\.mjs:3 裸 process\.exit\(2\)/);
  const ts = run([
    {
      rel: "scripts/release/a.ts",
      content: "// 注释\nexport function f(): void {\n  process.exit(2);\n}\n",
    },
  ]);
  assert.equal(ts.status, 1, ts.stdout);
  assert.match(ts.stderr, /scripts\/release\/a\.ts:3 裸 process\.exit\(2\)/);
});

test("边界：注释与字符串里的同形文本不命中（检测走 AST，不是文本扫描）", () => {
  const r = run([
    {
      rel: "scripts/gate/a.mjs",
      content:
        "// 这里曾经写过 process.exit(2)，现在改走 failClosed\n" +
        "/* exitCode = 2 也一样 */\n" +
        "export const doc = \"不要写 process.exit(2)\" + 'exitCode = 2'\n",
    },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test("边界：return 2 显式排除（归 L3 退出码契约归一，不由本判据改写既有返回语义）", () => {
  const r = run([
    {
      rel: "scripts/gate/a.mjs",
      content: "export function f() {\n  if (bad) return 2;\n  return 0;\n}\n",
    },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test("边界：对象字面量 { exitCode: 2 } 排除（退出码经返回值交给调用方的形态，同上）", () => {
  const r = run([
    {
      rel: "scripts/gate/a.mjs",
      content: "export function f() {\n  return { exitCode: 2, failures: 0 };\n}\n",
    },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test("边界：scripts/ 其它目录（lib / test / build）不在扫描面内", () => {
  const r = run([
    { rel: "scripts/lib/a.mjs", content: "process.exit(2);\n" },
    { rel: "scripts/gate/b.mjs", content: "process.exit(2);\n" },
  ]);
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stderr, /scripts\/lib\/a\.mjs/, "lib/ 不在面内");
});

test("fail-closed：扫描面为空（提取口径失效）→ exit 2 且判词带「门禁故障（非判据结论）」", () => {
  const r = run([{ rel: "docs/x.md", content: "noop\n" }]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /::error::门禁故障（非判据结论）：/);
  assert.match(r.stderr, /扫描面为空/);
});

test("fail-closed：源码解析失败 → exit 2（不得当成「这个文件没违规」）", () => {
  const r = run([{ rel: "scripts/gate/a.mjs", content: "export const = ;\n" }]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /::error::门禁故障（非判据结论）：/);
  assert.match(r.stderr, /解析失败/);
});
