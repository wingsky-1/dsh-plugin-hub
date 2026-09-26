import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const root = join(import.meta.dirname, "../..");
const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const steps: { name: string; run?: string; if?: string }[] = workflow.jobs["repo-gate"].steps;
const first = steps.findIndex((s) => s.name === "Restore package outputs into package trees");
const last = steps.findIndex((s) => s.name.startsWith("Build script-test prerequisites"));
assert.ok(first >= 0 && last > first);

type ExerciseOptions = {
  full?: boolean;
  hit?: string[];
  all?: string[];
  artifact?: boolean;
  buildFails?: boolean;
  buildMissing?: boolean;
};

/** 在临时目录里铺 pnpm 桩与（可选的）产物目录；临时目录挂在 t.after 上回收。 */
function makeSandbox(t: test.TestContext, options: ExerciseOptions) {
  const dir = mkdtempSync(join(tmpdir(), "ci-artifact-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = join(bin, "pnpm");
  writeFileSync(
    stub,
    [
      "#!/bin/bash",
      "set -e",
      "touch build-called",
      'if [ "$BUILD_FAILS" = 1 ]; then exit 9; fi',
      'if [ "$BUILD_MISSING" != 1 ]; then mkdir -p packages/B/lib; touch packages/B/lib/index.js; fi',
    ].join(String.fromCharCode(10)),
  );
  chmodSync(stub, 0o755);
  if (options.artifact !== false) {
    mkdirSync(join(dir, "artifacts-tmp/pkg-A/lib"), { recursive: true });
    writeFileSync(join(dir, "artifacts-tmp/pkg-A/lib/index.js"), "artifact");
  }
  return { dir, bin };
}

/** 依序跑 restore→build 区间的步骤，失败即停；返回末步的退出码与合并输出。 */
function runSteps(dir: string, bin: string, full: boolean, options: ExerciseOptions) {
  let status = 0;
  let output = "";
  for (const step of steps.slice(first, last)) {
    if (step.if) {
      assert.equal(step.if, "needs.changes.outputs.fullGate == 'true'");
      if (!full) continue;
    }
    assert.ok(typeof step.run === "string");
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run],
      {
        cwd: dir,
        env: {
          ...process.env,
          PATH: bin + ":" + process.env.PATH,
          RUNNER_TEMP: dir,
          FULL_GATE: String(full),
          HIT_PACKAGES: JSON.stringify(options.hit ?? ["A"]),
          ALL_PACKAGES: JSON.stringify(options.all ?? ["A", "B"]),
          BUILD_FAILS: options.buildFails ? "1" : "0",
          BUILD_MISSING: options.buildMissing ? "1" : "0",
        },
        encoding: "utf8",
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    output += result.stdout + result.stderr;
    status = result.status!;
    if (status !== 0) break;
  }
  return { status, output, built: existsSync(join(dir, "build-called")) };
}

function exercise(t: test.TestContext, options: ExerciseOptions = {}) {
  const { dir, bin } = makeSandbox(t, options);
  return runSteps(dir, bin, options.full ?? true, options);
}

test("missing hit artifact fails before full build can mask it", (t) => {
  const result = exercise(t, { artifact: false });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.built, false);
});
test("full build failure propagates", (t) => {
  const result = exercise(t, { buildFails: true });
  assert.equal(result.status, 9, result.output);
});
test("full build success without all outputs still fails", (t) => {
  const result = exercise(t, { buildMissing: true });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.built, true);
  assert.ok(result.output.includes("B/lib/index.js"));
});
test("full gate rejects an empty all-package list", (t) => {
  const result = exercise(t, { all: [] });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.built, false);
});
test("empty incremental scope is legal without full build", (t) => {
  const result = exercise(t, { full: false, hit: [], artifact: false });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.built, false);
});
test("incremental hit still requires its artifact", (t) => {
  const result = exercise(t, { full: false, artifact: false });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.built, false);
});
test("incremental hit passes without building all packages", (t) => {
  const result = exercise(t, { full: false });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.built, false);
});

test("full gate restores hit artifacts before building and checking all packages", (t) => {
  const result = exercise(t);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.built, true);
});
