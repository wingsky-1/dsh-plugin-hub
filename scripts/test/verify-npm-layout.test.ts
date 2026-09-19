#!/usr/bin/env node
"use strict";

/**
 * verify-npm-layout W1.2 落盘面回归：--log-file 把 stdout 判据行镜像到文件（发布证据链用）。
 * 空切片运行（--packages ""）不打包、秒级，断言「落盘 == 所见」即可。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/gate/verify-npm-layout.ts");

test("verify-npm-layout --log-file：空切片 exit 0 且落盘与 stdout 同形", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-npm-layout-"));
  try {
    const log = join(dir, "ev", "verify-npm-layout.log");
    const result = spawnSync(process.execPath, [SCRIPT, "--packages", "", "--log-file", log], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const logged = readFileSync(log, "utf8");
    assert.match(logged, /verify-npm-layout：全部通过/);
    assert.equal(logged, result.stdout, "落盘必须是 stdout 的逐字节镜像");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify-npm-layout --log-file 落盘失败即 fail-closed（证据缺失 exit 1，与 verify-version 同果）", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-npm-layout-"));
  try {
    // 父路径是文件 → 逐级建目录必然失败（与 observe-precheck 落盘失败用例同形）
    writeFileSync(join(dir, "blocker"), "x");
    const blocked = join(dir, "blocker", "verify-npm-layout.log");
    const result = spawnSync(process.execPath, [SCRIPT, "--packages", "", "--log-file", blocked], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, "证据写不下来不得静默放行（判据绿也置 1）");
    assert.match(result.stderr, /证据缺失/, "判词须注明证据缺失");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
