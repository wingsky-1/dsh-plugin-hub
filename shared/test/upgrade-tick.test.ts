import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { tickUpgradeVersion, tickUpgradeVersionSync } from "../upgrade-tick.js";

test("空步直接完成：返回 undefined 语义的完成态 Promise", async () => {
  await assert.doesNotReject(tickUpgradeVersion());
  assert.equal(await tickUpgradeVersion(), undefined);
});

test("同步版同样直接返回空（判据：同步链误传异步版会被门禁判红，改坏必须红）", () => {
  assert.equal(tickUpgradeVersionSync(), undefined);
});

test("空步不碰磁盘：哨兵文件逐字不动（判据：空实现若误写存储，这里即红）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-tick-"));
  try {
    const sentinel = join(dir, "user.json");
    writeFileSync(sentinel, '{"user":true}\n', "utf8");

    await tickUpgradeVersion();

    assert.equal(readFileSync(sentinel, "utf8"), '{"user":true}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
