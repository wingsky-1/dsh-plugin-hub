#!/usr/bin/env node
"use strict";

/**
 * sync-catalog-peers — 从 pnpm-workspace.yaml catalog 生成官方 peerDependencies 精确版本。
 *
 * catalog 是唯一可编辑事实源；本命令只更新其生成投影。执行前后都不改包版本、
 * devDependencies、minimumReleaseAgeExclude 或其它清单字段。任一官方 peer 找不到
 * catalog 条目时整批零写入并判红，避免半升级状态。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncCatalogPeers } from "../lib/catalog-peers-lib.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

try {
  const result = syncCatalogPeers(root);
  for (const problem of result.problems) console.error(`catalog:sync-peers | ${problem}`);
  if (result.problems.length > 0) {
    console.error("catalog:sync-peers | 零写入：请先补齐 pnpm-workspace.yaml catalog");
    process.exitCode = 1;
  } else if (result.changed.length === 0) {
    console.log("catalog:sync-peers | 已是最新");
  } else {
    console.log(`catalog:sync-peers | 已更新 ${result.changed.length} 个包`);
    for (const path of result.changed) console.log(`  ${path}`);
  }
} catch (error) {
  console.error(`catalog:sync-peers | ${String(error)}`);
  process.exitCode = 1;
}
