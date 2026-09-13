#!/usr/bin/env node
// @ts-nocheck
/**
 * gate-scope-registry — 路径受限门禁的**扫描范围**读取与解析（#733 计划项 3.2.1）。
 *
 * 为什么是数据：范围（这门禁管哪些包）与判据（什么算命中）是两件事，此前都写在门禁脚本里，
 * 「收窄了范围」和「放松了判据」在 diff 里长得一样。范围进数据面后，收窄范围是一次显式的
 * 数据改动，且门禁自测会先红。
 *
 * 为什么必须可注入：`--root` 换扫描面、`--registry` 换范围声明。没有注入点，「门禁确实在读
 * 注册表」就只能靠在源码里 grep 常量名来证明——形态判据（违反原则 ③），且注入点是把
 * 「未登记即红」写成行为断言的前提。
 *
 * 未登记即红的两个执行点：① 门禁运行时 `scopePackages` 抛错（本文件）；② 自测枚举
 * `scripts/gate/forbid-*.mjs` 与调用点 `--package`（scripts/test/gate-scope-registry.test.ts）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listPackageNames } from "./exemption-gate.ts";

/** 包范围通配：`dsh-*` 表示「packages 下所有 dsh- 前缀的包目录」。 */
const WILDCARD_SUFFIX = "*";
/** scopeFrom 的三种取值（无第三条路）：脚本读注册表 / 调用点传参 / 遍历目录树派生。 */
const SCOPE_FROM = ["registry", "cli", "tree"];

/**
 * 读取范围注册表。任何 IO/结构错误都抛给调用方——注册表坏掉等于范围声明失效，
 * 不能退化成「没有范围约束」继续跑（那会让门禁静默变成全仓扫描或空扫描）。
 */
export function loadScopeRegistry(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`范围注册表不可读（${path}）：${e.message}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`范围注册表 JSON 语法错误（${path}）：${e.message}`);
  }
  if (!Array.isArray(json.gates)) throw new Error(`范围注册表缺 gates 数组（${path}）`);
  const gates = new Map();
  for (const item of json.gates) {
    if (item === null || typeof item !== "object") throw new Error("范围注册表 gates 含非对象项");
    if (typeof item.gate !== "string" || item.gate.length === 0)
      throw new Error(`范围注册表条目缺 gate：${JSON.stringify(item).slice(0, 120)}`);
    if (typeof item.script !== "string" || item.script.length === 0)
      throw new Error(`${item.gate}：范围注册表条目缺 script`);
    if (!SCOPE_FROM.includes(item.scopeFrom))
      throw new Error(
        `${item.gate}：scopeFrom 须为 ${SCOPE_FROM.join(" / ")} 之一（当前 ${JSON.stringify(item.scopeFrom)}）`,
      );
    if (!isPackageScope(item.packages))
      throw new Error(
        `${item.gate}：packages 须为 "dsh-*" 形态的通配或非空包名数组（当前 ${JSON.stringify(item.packages)}）`,
      );
    if (typeof item.why !== "string" || item.why.length === 0)
      throw new Error(`${item.gate}：范围注册表条目缺 why（范围是治理决策，必须写明理由）`);
    if (gates.has(item.gate)) throw new Error(`范围注册表存在重复 gate：${item.gate}`);
    gates.set(item.gate, item);
  }
  return { path, version: json.version, gates };
}

/** packages 字段形态：`"<prefix>*"` 通配，或非空包名数组。 */
function isPackageScope(value) {
  if (typeof value === "string") return value.endsWith(WILDCARD_SUFFIX) && value.length > 1;
  if (Array.isArray(value))
    return value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0);
  return false;
}

/**
 * 解析某门禁的**实际包清单**（展开通配）。未登记、或登记的范围解析为空 → 抛错：
 * 「未登记即红」不能只写在自测里，运行时同样要红——否则新门禁忘了登记会静默变成
 * 「扫 0 个包 = 零违规」的假绿。
 */
export function scopePackages(root, registry, gate) {
  const entry = registry.gates.get(gate);
  if (entry === undefined) {
    throw new Error(
      `${gate} 未在范围注册表登记（${registry.path}）——未登记即红：路径受限门禁必须先登记范围`,
    );
  }
  const packages = resolvePackages(root, gate, entry);
  if (packages.length === 0) {
    throw new Error(
      `${gate} 的范围解析为空（${JSON.stringify(entry.packages)} @ ${registry.path}）——范围为空等于判据失效`,
    );
  }
  return packages;
}

/** 展开 packages 字段；通配形态要读目录，读不到时把「读哪里失败」一并抛出。 */
function resolvePackages(root, gate, entry) {
  if (typeof entry.packages !== "string") return [...entry.packages].sort();
  const prefix = entry.packages.slice(0, -WILDCARD_SUFFIX.length);
  try {
    return listPackageNames(root, prefix);
  } catch (e) {
    throw new Error(`${gate} 的范围无法解析：读取 ${join(root, "packages")} 失败（${e.message}）`);
  }
}
