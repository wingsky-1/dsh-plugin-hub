/** #847：丢掉任一独立执行点必须红；不能用第二个 --package 伪装接线。 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { tierSteps } from "../gate/gate-steps.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = "scripts/gate/export-surface-snapshot.mjs";
const PACKAGE = "dsh-worktree-sidebar";
const COMMAND = "node " + SCRIPT + " --package " + PACKAGE;

function assertIndependent(commands: string[]) {
  assert.equal(
    commands.filter((command) => command.trim() === COMMAND).length,
    1,
    "dsh-worktree-sidebar 必须有且仅有一条独立导出面命令",
  );
}

for (const [file, job] of [
  ["ci", "repo-gate"],
  ["observe", "quality"],
  ["release", "publish"],
]) {
  const workflow = parse(readFileSync(join(ROOT, ".github/workflows/" + file + ".yml"), "utf8"));
  test(file + "：独立执行点及丢入口反例", () => {
    const commands = workflow.jobs[job].steps.flatMap((step: { run?: string }) =>
      step.run ? [step.run] : [],
    );
    assertIndependent(commands);
    assert.throws(
      () => assertIndependent(commands.filter((command: string) => command.trim() !== COMMAND)),
      /必须有且仅有一条独立导出面命令/,
    );
    assert.throws(
      () =>
        assertIndependent(
          commands.map((command: string) =>
            command.trim() === COMMAND
              ? "node " + SCRIPT + " --package dsh-notifier --package " + PACKAGE
              : command,
          ),
        ),
      /必须有且仅有一条独立导出面命令/,
    );
  });
}
for (const tier of ["pr", "full"]) {
  test(tier + "：本地独立执行点及丢入口反例", () => {
    const commands = tierSteps(tier, {
      hitPackages: [],
      withCoverage: false,
      base: "origin/main",
      scopeLabel: "全仓",
    }).map((step: { cmd?: string; args: string[] }) =>
      [step.cmd ?? "pnpm", ...step.args].join(" "),
    );
    assertIndependent(commands);
    assert.throws(
      () => assertIndependent(commands.filter((command: string) => command !== COMMAND)),
      /必须有且仅有一条独立导出面命令/,
    );
  });
}
test("本包资产必须存在且分类零 legacy", () => {
  const surface = JSON.parse(
    readFileSync(join(ROOT, "scripts/data/dsh-worktree-sidebar-export-surface.json"), "utf8"),
  );
  const faces = JSON.parse(
    readFileSync(join(ROOT, "scripts/data/dsh-worktree-sidebar-export-faces.json"), "utf8"),
  );
  assert.equal(surface.package, PACKAGE);
  assert.equal(faces.package, PACKAGE);
  assert.deepEqual(faces.legacy, []);
  assert.deepEqual(Object.keys(faces.faces).sort(), ["ROUTES", "apply", "inject", "name"]);
});
