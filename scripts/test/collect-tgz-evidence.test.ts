#!/usr/bin/env node
"use strict";

/**
 * collect-tgz-evidence 回归（3.7 W1.3）：参数校验（exit 2 经 failClosed）、sha256 行形态、
 * --help。全量收集需真实 pnpm pack + registry 清单，不在单测跑（见 gate:pr 后的手工 dry-run 记录）；
 * 这里钉死「非法输入的形状」与「证据行的形状」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  LOG_FILENAME,
  SHA_FILENAME,
  argValue,
  parseArgs,
  renderShaLines,
  sha256File,
  usage,
} from "../release/collect-tgz-evidence.mjs";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/release/collect-tgz-evidence.mjs");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
}

test("常量：证据文件名（workflow 上传面与脚本同源，改名即两处同步红）", () => {
  assert.equal(SHA_FILENAME, "SHA256SUMS");
  assert.equal(LOG_FILENAME, "collect-tgz-evidence.log");
});

test("parseArgs：--out-dir 必填且绝对路径；未知参数抛错（调用方转 exit 2）", () => {
  assert.throws(function () {
    parseArgs([]);
  }, /缺少 --out-dir/);
  assert.throws(function () {
    parseArgs(["--out-dir", "relative/dir"]);
  }, /必须是绝对路径/);
  assert.throws(function () {
    parseArgs(["--out-dir", "/tmp/x", "--bogus"]);
  }, /未知参数/);
  assert.throws(function () {
    parseArgs(["--out-dir", "/tmp/x", "stray"]);
  }, /未知参数/);
  assert.deepEqual(parseArgs(["--out-dir", "/tmp/x"]), {
    help: false,
    outDir: "/tmp/x",
    keepTgz: false,
  });
  assert.deepEqual(parseArgs(["--out-dir=/tmp/x", "--keep-tgz"]), {
    help: false,
    outDir: "/tmp/x",
    keepTgz: true,
  });
  assert.deepEqual(parseArgs(["--help"]), { help: true });
});

test("sha256 行形态：`sha256sum` 默认文本形态（hex + 两空格 + 文件名）", () => {
  const dir = mkdtempSync(join(tmpdir(), "collect-tgz-"));
  try {
    const a = join(dir, "a.tgz");
    writeFileSync(a, "fake-tgz-bytes");
    const lines = renderShaLines([{ name: "a.tgz", path: a }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^[0-9a-f]{64}  a\.tgz$/);
    assert.equal(lines[0].split(" ")[0], sha256File(a));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 参数非法 exit 2 + 统一故障注解；--help exit 0", () => {
  for (const args of [[], ["--out-dir", "relative/dir"], ["--out-dir", "/tmp/x", "--bogus"]]) {
    const result = runCli(args);
    assert.equal(result.status, 2, args.join(" ") || "(空参数)");
    assert.match(result.stderr, /^::error::门禁故障（非判据结论）：collect-tgz-evidence: /m);
  }
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.equal(help.stdout.trim(), usage().trim());
});

test("argValue：--flag 双形态（与仓内其余判据同形）", () => {
  assert.equal(argValue(["--out-dir", "/tmp/x"], "--out-dir", null), "/tmp/x");
  assert.equal(argValue(["--out-dir=/tmp/x"], "--out-dir", null), "/tmp/x");
  assert.equal(argValue([], "--out-dir", null), null);
});
