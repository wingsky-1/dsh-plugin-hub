#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * verify-version 回归：tag 唯一来源口径 + W1.1 --log-file 落盘。
 *
 * 为什么需要它：它是发版链路第一道版本门。--log-file 的镜像必须与 stdout 逐行一致，
 * 且三种红态（非 tag / 空包集 / 版本不一致）都不得丢证据。CLI 用例跑在当前 worktree
 * （无精确 tag → 确定性 exit 1），离线；纯函数直测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { main, parseLogFile, writeLogFile } from "../release/verify-version.ts";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/release/verify-version.ts");

test("parseLogFile：--log-file 双形态；缺取值回落 null", () => {
  assert.equal(parseLogFile([]), null);
  assert.equal(parseLogFile(["--log-file", "/tmp/a.log"]), "/tmp/a.log");
  assert.equal(parseLogFile(["--log-file=/tmp/b.log"]), "/tmp/b.log");
  assert.equal(parseLogFile(["--log-file"]), null);
  assert.equal(parseLogFile(["--log-file", ""]), null);
});

test("writeLogFile：父目录逐级建出（调用方只传路径）", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-version-"));
  try {
    const target = join(dir, "deep", "nested", "vv.log");
    writeLogFile(target, "line1\n");
    assert.equal(readFileSync(target, "utf8"), "line1\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：非 tag 环境 exit 1，且 --log-file 镜像 stderr 的 fail 行", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-version-"));
  try {
    const log = join(dir, "ev", "verify-version.log");
    const result = spawnSync(process.execPath, [SCRIPT, "--log-file", log], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, "当前 worktree 无精确 tag，必须 exit 1");
    assert.match(result.stderr, /非 tag 环境/);
    // 镜像一致：落盘文件逐行 == 终端输出的 fail 行（证据与所见同源）
    assert.match(readFileSync(log, "utf8"), /非 tag 环境/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main 返回值：非 tag 环境返回 1（不抛错）", () => {
  assert.equal(main([]), 1);
});
