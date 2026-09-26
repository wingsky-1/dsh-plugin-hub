#!/usr/bin/env node
"use strict";

/**
 * shared/ 形态冻结守卫（#1028 后续重构）。
 *
 * 为什么需要：shared 已整体 TS 化（源码即 .ts，声明由 tsc 产出、原地 emit）。但「TS 化」
 * 本身没有防回退机制——下一个人完全可以再加一对手写的 `foo.js` + `foo.d.ts`：tsc 不管
 * `.js`（它不在任何 program 里），`skipLibCheck` 又吞掉 `.d.ts` 内的解析失败，于是那份
 * 手写声明重新变成「看起来在生效、实际随时可漂移」的假护栏。#1028 与 #1037 两轮事故
 * 的病根都是这一类。
 *
 * 与 mjs-freeze-guard 同源思路（冻结集合 + 双向差集即红），但 shared 的不变量更强：
 * 不是「哪些文件允许仍是 .mjs」，而是**任何 .js / .d.ts 都不允许存在于版本库的 shared/ 下**。
 * 故本守卫冻的是**形态**而非白名单条目。
 *
 * 覆盖三个方向：
 *   1. git 已提交集合里没有 .js / .d.ts（冻结侧：手写对不得回流）；
 *   2. .ts 模块集合与 ALLOWLIST 相等（增删模块必须显式登记，不许静默漂移）；
 *   3. 本地产物（.js / .d.ts）确实被 gitignore（构建产物不会被误提交），
 *      且每个消费 shared/ 的包 tsconfig 都带 references（TS6305 防陈旧的机制不能被摘掉）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * 「将要被提交」的 shared/ 文件集合 = index（`git ls-files`，含已暂存的改名/删除）
 * ∪ 未跟踪且未被 ignore（`--others --exclude-standard`，覆盖本地新增未 git add）。
 *
 * 刻意**不用** `git ls-tree HEAD`：本守卫要判的是当前这次重构的形态，而 HEAD 在
 * 提交前仍是转换前的树（.js + 手写 .d.ts），用它会把「转换尚未提交」误报成「形态回退」。
 * 构建产物被 .gitignore 排除，故不会混进这个集合。
 */
function committedSharedFiles() {
  const tracked = execFileSync("git", ["ls-files", "--", "shared"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const others = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", "shared"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  return [...tracked.split("\n"), ...others.split("\n")].filter(Boolean);
}

/**
 * 允许存在于 shared/ 的 .ts 模块（key 为 shared/ 下 posix 路径）。
 * 新增/退役模块必须同步本清单——「不许静默增删」正是本守卫的目的之一。
 */
const ALLOWLIST = {
  "shared/client/ensure-style.ts": "样式注入按 id 幂等（#477），客户端消费",
  "shared/client/i18n.ts": "t 活绑定 + bindLocale 装配（#348→#378），5 包客户端消费",
  "shared/dsh-home.ts": "DSH_HOME 解析单一事实源（#517），宿主端消费",
  "shared/host-utils.ts":
    "路由应答与守卫工具（writeJson/readBody/guardLoopbackMethod 等），宿主端消费",
  "shared/loopback.ts": "loopback 判定围栏，路由 403 前置，多包消费",
  "shared/paths.ts": "包主目录拼装单一事实源，5 包消费",
  "shared/settings-namespace.ts": "settings 命名空间安装，lan/mcp 共同接缝",
  "shared/sse-hub.ts": "SSE 长连接枢纽（#515），notifier/mcp 消费",
  "shared/upgrade-tick.ts": "升级链空步单一事实源，消费方只登记版本号",
};

test("shared/ 版本库里没有 .js / .d.ts —— 手写声明对不得回流", () => {
  const offenders = committedSharedFiles().filter(
    (f) =>
      f.startsWith("shared/") && (f.endsWith(".js") || f.endsWith(".d.ts") || f.endsWith(".map")),
  );
  assert.deepEqual(offenders, [], `shared/ 下出现非 .ts 源码：${offenders.join(", ")}`);
});

test("shared/ 的 .ts 模块集合与 ALLOWLIST 相等（增删须显式登记）", () => {
  const mods = committedSharedFiles()
    .filter((f) => f.startsWith("shared/") && f.endsWith(".ts"))
    .filter((f) => !f.startsWith("shared/test/"))
    .sort();
  assert.deepEqual(mods, Object.keys(ALLOWLIST).sort());
  for (const [p, why] of Object.entries(ALLOWLIST)) {
    assert.ok(existsSync(join(ROOT, p)), `ALLOWLIST 登记的 ${p} 不存在（条目腐烂）`);
    assert.ok(why.length > 0, `${p} 缺存在理由`);
  }
});

test("shared/ 的构建产物被 gitignore（不会被误提交）", () => {
  // 刻意枚举**预期产物路径**而不是「磁盘上现有的产物」：未 build 时后者是空集，
  // 断言会恒真——那是装饰性判据。git check-ignore 对不存在的路径同样给出结论。
  const expected = [];
  for (const src of Object.keys(ALLOWLIST)) {
    expected.push(src.replace(/\.ts$/, ".js"), src.replace(/\.ts$/, ".d.ts"));
  }
  assert.equal(expected.length, Object.keys(ALLOWLIST).length * 2);
  const notIgnored = expected.filter((f) => {
    const r = spawnSync("git", ["check-ignore", "-q", f], { cwd: ROOT });
    return r.status !== 0;
  });
  assert.deepEqual(notIgnored, [], `产物未被 gitignore：${notIgnored.join(", ")}`);
});

test("消费 shared/ 的包都带 references —— TS6305 防陈旧的机制不能被摘掉", () => {
  const missing = [];
  for (const p of readdirSync(join(ROOT, "packages"))) {
    const ts = join(ROOT, "packages", p, "tsconfig.json");
    if (!existsSync(ts)) continue;
    const pkgJson = join(ROOT, "packages", p, "package.json");
    if (!existsSync(pkgJson)) continue;
    const build = JSON.parse(readFileSync(pkgJson, "utf8")).scripts?.build ?? "";
    if (!build.includes("tsc -b ../../shared")) continue; // 不消费 shared 的包
    if (!readFileSync(ts, "utf8").includes('"references"')) missing.push(p);
  }
  assert.deepEqual(missing, [], `消费 shared/ 但 tsconfig 缺 references：${missing.join(", ")}`);
});
