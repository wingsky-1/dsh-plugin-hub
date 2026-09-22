#!/usr/bin/env node
"use strict";

/**
 * shared/paths.js 行为契约单测（P2a 包主目录收敛）。
 *
 * 锁定 `pluginHome(base, ...segments)` 等同 `join(base, ...segments)`：6 处调用点
 * （lan-proxy / mcp-manager / notifier 二段、worktree-sidebar 三段、jev-decide
 * config 显式 base 二段、jev-decide history 显式 base 三段）收敛前后默认形态
 * 路径逐字节不变，且随 `DSH_HOME` 隔离切换落盘根。
 *
 * 断言纪律：期望一律手写字面量（`base + sep + 分段` 拼出），禁止以同源
 * 期望——即不准用 `pluginHome` 本身或同一拼装原语计算期望值
 * （如 `join(base, ...)`，那是用被测语义验证被测语义）。
 *
 * 运行：node --test scripts/test/shared-paths.test.ts（或 pnpm test:scripts）
 * 零落盘：base 取 `mkdtempSync` 隔离目录，本模块不写文件，用完 `rmSync` 清理。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { dshHome } from "../../shared/dsh-home.js";
import { pluginHome } from "../../shared/paths.js";

function tempBase() {
  const dir = mkdtempSync(join(tmpdir(), "paths-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("二段默认形态逐字节不变（lan-proxy / mcp-manager / notifier / jev-config 形）", () => {
  const { dir, cleanup } = tempBase();
  try {
    assert.equal(
      pluginHome(dir, "@wingsky-1/dsh-lan-proxy"),
      dir + sep + "@wingsky-1/dsh-lan-proxy",
    );
    assert.equal(
      pluginHome(dir, "@wingsky-1/dsh-mcp-manager"),
      dir + sep + "@wingsky-1/dsh-mcp-manager",
    );
    assert.equal(pluginHome(dir, "@wingsky-1/dsh-notifier"), dir + sep + "@wingsky-1/dsh-notifier");
    assert.equal(
      pluginHome(dir, "@wingsky-1/dsh-jev-decide"),
      dir + sep + "@wingsky-1/dsh-jev-decide",
    );
  } finally {
    cleanup();
  }
});

test("三段默认形态逐字节不变（worktree-sidebar 绑定表 / jev-history 形）", () => {
  const { dir, cleanup } = tempBase();
  try {
    assert.equal(
      pluginHome(dir, "@wingsky-1/dsh-worktree-sidebar", "bindings.json"),
      dir + sep + "@wingsky-1/dsh-worktree-sidebar" + sep + "bindings.json",
    );
    assert.equal(
      pluginHome(dir, "@wingsky-1/dsh-jev-decide", "history"),
      dir + sep + "@wingsky-1/dsh-jev-decide" + sep + "history",
    );
  } finally {
    cleanup();
  }
});

test("显式 base 透传（jev 两域 `home ?? dshHome()` 形：非 env 基原样拼装）", () => {
  const { dir, cleanup } = tempBase();
  try {
    const home = dir + sep + "fake-home";
    assert.equal(
      pluginHome(home, "@wingsky-1/dsh-jev-decide"),
      home + sep + "@wingsky-1/dsh-jev-decide",
    );
    assert.equal(
      pluginHome(home, "@wingsky-1/dsh-jev-decide", "history"),
      home + sep + "@wingsky-1/dsh-jev-decide" + sep + "history",
    );
  } finally {
    cleanup();
  }
});

test("DSH_HOME 隔离：`pluginHome(dshHome(), ...)` 随 env 切换落盘根", () => {
  const prev = process.env.DSH_HOME;
  const { dir, cleanup } = tempBase();
  try {
    process.env.DSH_HOME = dir;
    assert.equal(
      pluginHome(dshHome(), "@wingsky-1/dsh-notifier"),
      dir + sep + "@wingsky-1/dsh-notifier",
    );
    assert.equal(
      pluginHome(dshHome(), "@wingsky-1/dsh-worktree-sidebar", "bindings.json"),
      dir + sep + "@wingsky-1/dsh-worktree-sidebar" + sep + "bindings.json",
    );
  } finally {
    if (prev !== undefined) process.env.DSH_HOME = prev;
    else delete process.env.DSH_HOME;
    cleanup();
  }
});
