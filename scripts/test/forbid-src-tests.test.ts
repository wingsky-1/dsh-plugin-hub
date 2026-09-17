import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "../..");
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "forbid-src-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts/gate", "scripts/lib"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  // Run the real CLI without adding a production root override for tests.
  for (const file of ["scripts/gate/forbid-src-tests.mjs", "scripts/lib/gate-exit.mjs"]) {
    copyFileSync(join(ROOT, file), join(root, file));
  }
  return root;
}
function run(root: string, preload?: string) {
  const result = spawnSync(
    process.execPath,
    [...(preload ? ["--import", preload] : []), join(root, "scripts/gate/forbid-src-tests.mjs")],
    { cwd: root, encoding: "utf8" },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
for (const shape of ["missing", "file"] as const) {
  test("unreadable packages root: " + shape, (t) => {
    const root = fixture(t);
    if (shape === "file") writeFileSync(join(root, "packages"), "not a directory");
    const result = run(root);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /::error::门禁故障/);
    assert.match(result.stderr, /packages/);
    assert.doesNotMatch(result.stdout, /forbid-src-tests: OK/);
  });
}
test("readable tree without legacy tests passes", (t) => {
  const root = fixture(t);
  const dir = join(root, "packages/example/test/nested");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "normal.test.ts"), "");
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /forbid-src-tests: OK/);
});
test("nested untracked legacy test is a rule violation", (t) => {
  const root = fixture(t);
  const dir = join(root, "packages/example/test/nested");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "legacy.src.test.ts"), "");
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes("legacy.src.test.ts"));
  assert.doesNotMatch(result.stdout, /forbid-src-tests: OK/);
});
test("nested directory read failure aborts the scan", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "packages/example/test"), { recursive: true });
  const preload = join(root, "deny-nested.mjs");
  // Deterministic EACCES injection also works when the test runner is root.
  writeFileSync(
    preload,
    [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "import { basename } from 'node:path';",
      "const original = fs.readdirSync;",
      "fs.readdirSync = function (path, ...args) {",
      "  if (basename(String(path)) === 'test') {",
      "    throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' });",
      "  }",
      "  return original.call(this, path, ...args);",
      "};",
      "syncBuiltinESMExports();",
    ].join(String.fromCharCode(10)),
  );
  const result = run(root, preload);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /::error::门禁故障/);
  assert.match(result.stderr, /EACCES/);
  assert.match(result.stderr, /example/);
  assert.doesNotMatch(result.stdout, /forbid-src-tests: OK/);
});
