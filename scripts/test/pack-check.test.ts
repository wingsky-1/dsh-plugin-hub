#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * pack-check W1.2 落盘面回归：--log-file 把 stdout 判据行镜像到文件（发布证据链用）。
 * 空切片运行（--packages ""）不打包、秒级，断言「落盘 == 所见」即可。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/gate/pack-check.ts");

test("pack-check --log-file：空切片 exit 0 且落盘与 stdout 同形", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-check-"));
  try {
    const log = join(dir, "ev", "pack-check.log");
    const result = spawnSync(process.execPath, [SCRIPT, "--packages", "", "--log-file", log], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const logged = readFileSync(log, "utf8");
    assert.match(logged, /pack-check：全部通过/);
    assert.equal(logged, result.stdout, "落盘必须是 stdout 的逐字节镜像");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
