#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * export-faces-lib — 包导出面「分类登记」准入判据（#733 宪法第 3 条 / M2-3.5）。
 *
 * 目的：导出面快照门禁只能证明「符号集与基线一致」，回答不了「这个新符号凭什么是
 * 公共契约」。本判据把「新增导出必须落进三类面之一并显式登记」变成机器可判的准入
 * 条件：**包导出面 ⊆ 安装面 ∪ 配置面 ∪ 契约面**。
 *
 * 同源（§9 禁止双轨）：符号集来自 export-surface-snapshot.mjs 的同一次
 * `emitDeclarations()` 产物，不另起第二套抽取；执法点就在同一个脚本的同一个执行点上——
 * 该执行点审计 P0-1 后从 contract-check 的 spawnSync 迁成 ci.yml 的 `Export surface
 * snapshot` 直接步骤与本地档位计划的 cheapGlobal（可见性由 gate-wiring 断言守护）。
 *
 * 存量口径：`legacy` 是**按包冻结**的存量符号白名单——每个包接入本判据时把自己当时的主入口
 * 导出一次性登记进去（dsh-notifier 在 M2a 冻结时是 100 个，此后随符号退役收缩；M2a 之后新建的
 * dsh-worktree-sidebar 为 0；#826 的 dsh-lan-proxy 为 50），没有全局条数上限，也不存在「时点」
 * 意义上的唯一清单。存量分类（保留 / 移除清单）是后续收窄 PR 的一等交付物，本阶段不预判、不抢跑。
 * 新增符号**没有** legacy 通道：只能进
 * `faces` 并显式选择三类面之一，否则判红。把新符号塞进 `legacy` 同样能绕过本判据，
 * 但那是一次显眼且可评审的登记文件改动——本判据的价值是让「静默增长」不可能，而不是
 * 防止人为改写登记文件（任何登记制都做不到后者，如实写明胜过过度声称）。
 *
 * **论域（#733 M2c 后续 N0(B) 钉死）= 主入口（`.`）的导出面**：调用方只传主入口的符号集，
 * 非主入口（如 `./client`）只进导出面快照的基线比对、不喂本判据。理由是宪法第 3 条指 SDK
 * 面；客户端入口首次出现独有导出（UI 组件/类型）时无法归入三类面，只能塞 `legacy`，与
 * M2b「legacy 归零」冲突。同一分工写在 docs/ARCHITECTURE-METHOD.md §6 三层裁定、
 * docs/DEVELOPMENT.md 的准入段与 export-surface-snapshot.mjs 的门禁自述里。
 */

import { existsSync, readFileSync } from "node:fs";

/** 三类面（#733 宪法第 3 条：包导出面 ⊆ 安装面 ∪ 配置面 ∪ 契约面）。 */
export const EXPORT_FACES = ["安装面", "配置面", "契约面"];

/**
 * 读取分类登记文件（缺失即抛——登记文件是判据的输入，不能静默降级为「无约束」）。
 * @param {string} path 登记文件路径
 * @returns {{ package?: string, faces: Record<string, string>, legacy: string[] }}
 */
export function loadExportFaces(path) {
  if (!existsSync(path)) throw new Error(`导出面分类登记文件不存在：${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    package: parsed.package,
    faces: parsed.faces && typeof parsed.faces === "object" ? parsed.faces : {},
    legacy: Array.isArray(parsed.legacy) ? parsed.legacy : [],
  };
}

/**
 * 准入判据：每个导出符号必须已分类登记（faces）或属存量白名单（legacy）。
 * @param {{ exports: string[], faces: Record<string, string>, legacy: string[], registryPath?: string }} input
 * @returns {string[]} 违规描述列表（空 = 合规）
 */
export function checkExportFaces(input) {
  const {
    exports: exportNames,
    faces,
    legacy,
    registryPath = "scripts/data/<pkg>-export-faces.json",
  } = input;
  const exportSet = new Set(exportNames);
  const legacySet = new Set(legacy);

  return [
    ...checkRegistryShape(faces, legacy, legacySet),
    ...collectLegacyProblems(legacy, exportSet),
    ...collectFaceProblems(faces, exportSet, legacySet),
    ...collectUnregisteredProblems(exportNames, faces, legacySet, registryPath),
  ];
}

/** 登记文件自身的一致性：legacy 去重，以及「既无 faces 也无 legacy」的退化形态。 */
function checkRegistryShape(faces, legacy, legacySet) {
  const problems = [];
  if (legacySet.size !== legacy.length) problems.push("legacy 含重复项");
  if (legacy.length === 0 && Object.keys(faces).length === 0) {
    problems.push("登记文件既无 faces 也无 legacy——判据退化为「无约束」，拒绝放行");
  }
  return problems;
}

/** legacy 是存量白名单：符号退役后不移除，白名单会一直替已消失的符号背书。 */
function collectLegacyProblems(legacy, exportSet) {
  const problems = [];
  for (const name of legacy) {
    if (!exportSet.has(name))
      problems.push(`legacy 含已不存在的导出符号：${name}（符号退役后须一并从 legacy 移除）`);
  }
  return problems;
}

/** faces 每条登记的三重约束：分类合法、与 legacy 互斥、符号确实存在。 */
function collectFaceProblems(faces, exportSet, legacySet) {
  const problems = [];
  for (const [name, face] of Object.entries(faces)) {
    if (!EXPORT_FACES.includes(face)) {
      problems.push(
        `faces["${name}"] 的分类「${face}」不在三类面内（合法值：${EXPORT_FACES.join(" / ")}）`,
      );
    }
    if (legacySet.has(name)) problems.push(`符号 ${name} 同时登记在 faces 与 legacy（二者互斥）`);
    if (!exportSet.has(name)) problems.push(`faces 含已不存在的导出符号：${name}`);
  }
  return problems;
}

/** 未被 faces / legacy 覆盖的导出即新增符号：没有 legacy 通道，必须显式选一类面。 */
function collectUnregisteredProblems(exportNames, faces, legacySet, registryPath) {
  const problems = [];
  for (const name of exportNames) {
    if (faces[name] === undefined && !legacySet.has(name)) {
      problems.push(
        `新增导出未分类登记：${name}（必须落进 ${EXPORT_FACES.join(" / ")} 之一，写进 ${registryPath} 的 faces）`,
      );
    }
  }
  return problems;
}
