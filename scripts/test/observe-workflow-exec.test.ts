import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const root = join(import.meta.dirname, "../..");
const workflow = parse(readFileSync(join(root, ".github/workflows/observe.yml"), "utf8"));
const collectSteps = workflow.jobs["mutation-collect"].steps;
function step(name: string) {
  const matches = collectSteps.filter((s: { name?: string }) => s.name?.startsWith(name));
  assert.equal(matches.length, 1, name);
  const found = matches[0];
  return found as { run?: string; if?: string };
}
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "observe-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "scripts/gate"), { recursive: true });
  const stub = join(bin, "gh");
  writeFileSync(
    stub,
    [
      "#!/bin/bash",
      "set -eu",
      'printf "%s\n" "$*" >> gh.log',
      'if [ "$2" = list ]; then printf "%s" "$EXISTING"; else cp "${@: -1}" delivered.md; fi',
    ].join(String.fromCharCode(10)),
    { mode: 0o755 },
  );
  return dir;
}
function run(dir: string, name: string, env: Record<string, string> = {}) {
  const found = step(name);
  assert.ok(typeof found.run === "string");
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", found.run], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: join(dir, "bin") + ":" + process.env.PATH,
      GITHUB_OUTPUT: join(dir, "output"),
      EXISTING: "",
      ...env,
    },
  });
}
// Only the conditions used by these real steps are supported; unknown syntax fails the test.
function enabled(name: string, count: string, success: boolean) {
  const condition = step(name).if;
  if (!condition) return success;
  return (
    condition.split(" && ").every((term) => {
      if (term === "always()") return true;
      const match = /^steps\.reports\.outputs\.count != '(.*)'$/.exec(term);
      assert.ok(match, "Unsupported condition: " + term);
      return count !== match[1];
    }) &&
    (condition.includes("always()") || success)
  );
}
test("zero reports reliably writes count=0 under pipefail", (t) => {
  const root = fixture(t);
  const result = run(
    root,
    "Restore report layout（多 artifact 下载各建子目录，平铺回 coverage/mutation/）",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, "output"), "utf8"), "count=0\n");
});

test("missing count cannot archive; issue runs even after earlier failure", () => {
  assert.equal(
    step("Create/update observe issue（幂等：同日重跑不重复建；回落即追评）").if,
    "always()",
  );
  assert.match(
    step("Archive baseline to orphan branch（#718 S1.2：并集入档 + 对账）").if ?? "",
    /count != ''/,
  );
});

for (const count of ["0", ""]) {
  for (const existing of ["", "42"]) {
    test("no reports diagnostic count=" + JSON.stringify(count) + " existing=" + existing, (t) => {
      const root = fixture(t);
      const result = run(
        root,
        "Create/update observe issue（幂等：同日重跑不重复建；回落即追评）",
        {
          REPORT_COUNT: count,
          EXISTING: existing,
        },
      );
      assert.equal(result.status, 1, "诊断成功送达后仍须判红：" + result.stderr);
      const log = readFileSync(join(root, "gh.log"), "utf8");
      assert.match(log, existing ? /issue comment 42/ : /issue create/);
      const body = readFileSync(join(root, "delivered.md"), "utf8");
      assert.match(body, /报告数量/);
      assert.match(body, /无法给出/);
    });
  }
}

test("zero or missing count skips archive execution even after failure", (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, "scripts/gate/orphan-baseline.mjs"),
    'throw new Error("archive must not execute");',
  );
  for (const count of ["", "0"]) {
    assert.equal(enabled("Archive baseline", count, false), false);
    assert.equal(enabled("Create/update observe issue", count, false), true);
  }
});

for (const exitCode of [0, 1, 2]) {
  test("partial reports preserve score result and issue trace, score exit=" + exitCode, (t) => {
    const root = fixture(t);
    const dir = join(root, "coverage/mutation/mutation-shard-dsh-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dsh-a.json"), "{}");
    writeFileSync(join(dir, "incremental-a.json"), "{}");
    const restored = run(root, "Restore report layout");
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readFileSync(join(root, "output"), "utf8"), "count=1\n");
    // The scorer is a boundary stub: execute the YAML invocation and preserve its exit status.
    const body = "partial score result " + exitCode;
    writeFileSync(
      join(root, "scripts/gate/observe-check.mjs"),
      'import {writeFileSync} from "node:fs";\n' +
        (exitCode === 2
          ? ""
          : 'writeFileSync("observe-body.md", ' + JSON.stringify(body) + ");\n") +
        'writeFileSync("observe-status.json", ' +
        JSON.stringify(JSON.stringify({ exitCode })) +
        ");\n" +
        "process.exit(" +
        exitCode +
        ");\n",
    );
    assert.equal(
      enabled("Threshold check & report body（阈值校验 + 回落检测 + 报告产出）", "1", true),
      true,
    );
    assert.equal(
      run(root, "Threshold check & report body（阈值校验 + 回落检测 + 报告产出）", {}).status,
      exitCode,
    );
    assert.equal(enabled("Archive baseline", "1", exitCode === 0), true);
    assert.equal(enabled("Create/update observe issue", "1", exitCode === 0), true);
    const issued = run(root, "Create/update observe issue（幂等：同日重跑不重复建；回落即追评）", {
      REPORT_COUNT: "1",
      EXISTING: "42",
      REPORT_OUTCOME: exitCode ? "failure" : "success",
      QUALITY_RESULT: "success",
      SHARDS_RESULT: "success",
    });
    assert.equal(issued.status, exitCode === 2 ? 1 : 0, issued.stderr);
    assert.match(readFileSync(join(root, "gh.log"), "utf8"), /issue comment 42/);
    const delivered = readFileSync(join(root, "delivered.md"), "utf8");
    if (exitCode === 2) {
      assert.match(delivered, /无法给出/);
      assert.match(delivered, /"exitCode":2/);
    } else assert.equal(delivered, body);
  });
}

for (const upstream of ["QUALITY_RESULT", "SHARDS_RESULT"]) {
  for (const state of ["success", "failure", "cancelled", "skipped", "", "unknown"]) {
    for (const existing of ["", "42"]) {
      test(
        "complete reports with " + upstream + "=" + JSON.stringify(state) + " existing=" + existing,
        (t) => {
          const root = fixture(t);
          const body = "complete score result\ncoverage and mutation passed\n";
          writeFileSync(
            join(root, "scripts/gate/observe-check.mjs"),
            'import {writeFileSync} from "node:fs"; writeFileSync("observe-body.md", ' +
              JSON.stringify(body) +
              ");",
          );
          const scored = run(root, "Threshold check & report body");
          assert.equal(scored.status, 0, scored.stderr);
          const env = {
            QUALITY_RESULT: "success",
            SHARDS_RESULT: "success",
            [upstream]: state,
            REPORT_COUNT: "35",
            REPORT_OUTCOME: "success",
            EXISTING: existing,
            RUN_URL: "https://example.test/run/875",
          };
          const issued = run(root, "Create/update observe issue", env);
          assert.equal(issued.status, state === "success" ? 0 : 1, issued.stdout + issued.stderr);
          const delivered = readFileSync(join(root, "delivered.md"), "utf8");
          assert.ok(delivered.startsWith(body), "判分正文必须完整保留");
          assert.match(
            readFileSync(join(root, "gh.log"), "utf8"),
            existing ? /issue comment 42/ : /issue create/,
          );
          if (state === "success") assert.equal(delivered, body);
          else {
            assert.match(delivered, /上游任务未成功/);
            assert.ok(delivered.includes("quality：" + (env.QUALITY_RESULT || "未知")));
            assert.ok(delivered.includes("shards：" + (env.SHARDS_RESULT || "未知")));
            assert.ok(delivered.includes(env.RUN_URL));
          }
        },
      );
    }
  }
}
