#!/usr/bin/env node
"use strict";

/**
 * ensure-shared-built — 跑包级 tsc 之前的**统一前置**（#1028 后续重构）。
 *
 * 为什么需要：shared 的声明由 tsc 产出（composite + 原地 emit），不入库。包级 tsconfig
 * 带 references，于是任何**裸 `tsc -p <包>`**（不经 `tsc -b`）都要求 shared 的产物已存在
 * 且是最新的，否则报 TS6305。仓内至少两处这样的入口：各包的 `typecheck` 脚本，以及
 * export-surface-snapshot 门禁内部的 `tsc -p --declaration --emitDeclarationOnly`。
 *
 * 为什么收敛成共享入口而不是各写各的：这条先决条件一旦散落，就是下一处「忘了先建
 * shared」的地方——而它的失败信号（满屏 TS6305）离病因很远，正是 #1028 那轮反复误判的
 * 成因。收敛到一处后，新增工具只需 import 它，遗漏面从「N 个入口」降到「0 个已知入口 +
 * 评审」。
 *
 * 已构建时是秒级 no-op（`tsc -b` 读 tsbuildinfo 判定最新即退出），不承担构建成本。
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** 确保仓库根 shared 的声明产物就绪；失败即抛，绝不静默继续。 */
export function ensureSharedBuilt(root) {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const res = spawnSync(process.execPath, [tsc, "-b", join(root, "shared")], {
    cwd: root,
    encoding: "utf8",
  });
  if (res.error !== undefined) {
    throw new Error(`shared 构建前置启动失败：${String(res.error)}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `shared 构建前置失败（exit ${res.status}）——包级 tsc 会连带报 TS6305，` +
        `先修 shared：${res.stdout || ""}${res.stderr || ""}`,
    );
  }
}
