#!/usr/bin/env node
"use strict";

/**
 * build-shared — 仓库根共享层的**唯一**构建入口（#1028 后续重构）。
 *
 * 为什么必须是独立一步、而不是让每个包各建一次：
 * `tsc -b` 对同一个 composite 工程**不可并发**——多个进程同时写同一份
 * `tsconfig.tsbuildinfo` 与同一批输出，后来的会读到半写的产物并判定「已是最新」
 * 而跳过 emit，于是消费包解析 `../../shared/xxx.js` 时找不到 `.d.ts`，回落到
 * `.ts` 源码；而源码在各包 `rootDir` 之外 → `TS2306 is not a module` + 隐式 any 级联。
 * 实测症状：CI 根 build（`pnpm -r` 并行）下随机切片判红、本地常绿、每次红的切片都不同。
 *
 * 所以分工是：根 build 先跑本步骤把 shared 建好，随后各包的 `tsc -b ../../shared`
 * 只是幂等的 no-op（专为「单包构建」路径准备：gate 的 changed 档与 CI 的单包 job
 * 都只跑那一个包的 build 脚本，那时 shared 未必已构建）。
 *
 * 失败一律响亮退出：shared 建不出来就不该继续编包（产物缺失会在下游变成更难读的错误）。
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const r = spawnSync(
  process.execPath,
  [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-b", join(ROOT, "shared")],
  { cwd: ROOT, stdio: "inherit" },
);

if (r.error !== undefined) {
  console.error(`[build-shared] tsc 启动失败：${String(r.error)}`);
  process.exitCode = 1;
} else if (r.status !== 0) {
  console.error(`[build-shared] shared 编译失败（exit ${r.status}）——不继续构建各包`);
  process.exitCode = r.status ?? 1;
} else {
  console.log("[build-shared] shared 已构建（composite，原地 emit）");
}
