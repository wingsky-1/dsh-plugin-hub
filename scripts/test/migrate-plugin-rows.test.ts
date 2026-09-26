import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "maintenance", "migrate-plugin-rows.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(patchText: string, settingsText?: string): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-row-migration-"));
  roots.push(home);
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  writeFileSync(join(home, "profiles", "web", "cordis.patch.yml"), patchText, "utf8");
  if (settingsText !== undefined) writeFileSync(join(home, "settings.yaml"), settingsText, "utf8");
  return home;
}

function run(
  home: string,
  apply = false,
): { status: number | null; stdout: string; stderr: string } {
  const args = [SCRIPT, "--home", home, "--json"];
  if (apply) args.push("--apply");
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const PATCH = [
  "- insert:",
  "    - id: ui-dsh-lan-proxy",
  '      name: "@wingsky-1/dsh-lan-proxy"',
  "      disabled: true",
  "      config:",
  "        port: 4100",
  "",
].join("\n");

test("默认 dry-run 只报告，不改 profile", () => {
  const home = makeHome(PATCH);
  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { mode: string; totalChanges: number };
  assert.equal(report.mode, "dry-run");
  assert.equal(report.totalChanges, 1);
  assert.match(
    readFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "utf8"),
    /id: ui-dsh-lan-proxy/,
  );
});

test("--apply 改 id、保留字段并生成备份", () => {
  const home = makeHome(PATCH);
  const result = run(home, true);
  assert.equal(result.status, 0, result.stderr);
  const file = join(home, "profiles", "web", "cordis.patch.yml");
  const text = readFileSync(file, "utf8");
  assert.match(text, /id: dsh-lan-proxy/);
  assert.match(text, /disabled: true/);
  assert.match(text, /port: 4100/);
  const report = JSON.parse(result.stdout) as { files: Array<{ backup?: string }> };
  assert.ok(report.files[0]?.backup);
  assert.equal(existsSync(report.files[0]!.backup!), true);
});

test("重复 legacy row 与 legacy settings section 均 fail-closed", () => {
  const duplicate = [
    "- insert:",
    "    - id: ui-dsh-lan-proxy",
    '      name: "@wingsky-1/dsh-lan-proxy"',
    "    - id: ui-dsh-lan-proxy",
    '      name: "@wingsky-1/dsh-lan-proxy"',
    "",
  ].join("\n");
  const duplicateResult = run(makeHome(duplicate));
  assert.equal(duplicateResult.status, 1);

  const settings = ["ui-dsh-mcp-manager:", "  ui: {}", ""].join("\n");
  const settingsResult = run(makeHome(PATCH, settings));
  assert.equal(settingsResult.status, 1);
  assert.match(settingsResult.stdout, /ui-dsh-mcp-manager/);
});
