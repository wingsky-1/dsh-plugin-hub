#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * catalog-peers-lib — catalog ↔ peer/devDeps 一致性校验（纯逻辑库，可单测）。
 *
 * 动机（#695）：官方类型层版本曾在 pnpm-workspace.yaml 的 catalog 与各包
 * peerDependencies 双写，一次 rc 升级要手改 20 处字面量，改漏无任何信号；
 * dsh-verify-isolated 的 peer 还一度游离于 catalog 之外。peer 统一走 catalog:
 * 后事实源收敛为 catalog 一处（pnpm pack 时替换回具体版本，发布物字节语义不变），
 * 本库把「收敛后不再漂移」变成机器约束。
 *
 * 零新增依赖：yaml 只解析本文件自用的两个顶层段（受限子集，非通用 YAML 解析器）。
 * 受限子集里唯一必须与形态解耦的是标量引号：pnpm-workspace.yaml 在 Prettier 格式化面内，
 * 引号写法（单引号/双引号/不加）归格式化器决定，解析器只认结构、不认引号形态。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OFFICIAL_SCOPE = "@deepseek-ai/";
const DEP_FIELDS = ["peerDependencies", "devDependencies", "dependencies"];

/** 剥掉 YAML 标量两侧的成对引号（单/双均可）；未加引号时原样返回。 */
function unquote(scalar) {
  const quote = scalar[0];
  if ((quote === "'" || quote === '"') && scalar.length >= 2 && scalar.endsWith(quote)) {
    return scalar.slice(1, -1);
  }
  return scalar;
}

/** 解析顶层 `catalog:` 段的 name → version。 */
export function parseCatalog(yamlText) {
  const catalog = new Map();
  let inSection = false;
  for (const line of yamlText.split("\n")) {
    if (/^catalog:\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    // 顶层键（非缩进行）终止当前段
    if (/^[A-Za-z]/.test(line)) inSection = false;
    if (!inSection) continue;
    const m = /^ {2}(\S+):\s*(\S+)\s*$/.exec(line);
    if (m) catalog.set(unquote(m[1]), unquote(m[2]));
  }
  return catalog;
}

/** 解析顶层 `minimumReleaseAgeExclude:` 段的包名集（剥离 @version 后缀）。 */
export function parseReleaseExclude(yamlText) {
  const names = new Set();
  let inSection = false;
  for (const line of yamlText.split("\n")) {
    if (/^minimumReleaseAgeExclude:\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (/^[A-Za-z]/.test(line)) inSection = false;
    if (!inSection) continue;
    const m = /^ {2}- (\S+)\s*$/.exec(line);
    if (!m) continue;
    const name = unquote(m[1]);
    const at = name.lastIndexOf("@");
    names.add(at > 0 ? name.slice(0, at) : name);
  }
  return names;
}

/**
 * 全仓校验：官方包依赖声明必须走 catalog:，且 catalog: 引用必须有条目、
 * catalog 每个键都要在供应链豁免清单里登记。
 */
export function checkCatalogPeers(root) {
  const yamlText = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const catalog = parseCatalog(yamlText);
  const excluded = parseReleaseExclude(yamlText);

  const { problems, officialPeerCount } = collectPackageProblems(root, catalog);
  problems.push(...collectCatalogExemptionProblems(catalog, excluded));

  const lines = [
    `catalog ${catalog.size} 键 | 官方 peer ${officialPeerCount} 处 | 豁免清单 ${excluded.size} 条`,
  ];
  return { lines, problems, catalogSize: catalog.size, officialPeerCount };
}

/** 扫描面只看 packages 下真实存在的包目录；隐藏目录与 node_modules 不是待校验对象。 */
function packageDirs(root) {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)
    .sort();
}

/** 读不出或解析不了 package.json 一律跳过：那是包本身的问题，不是本门禁的判据面。 */
function readPackageManifest(root, dir) {
  try {
    return JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** 单个包的一个依赖字段：官方包一律写 catalog:，写了 catalog: 就必须有对应条目。 */
function collectDepProblems(dir, field, deps, catalog) {
  const problems = [];
  let officialPeerCount = 0;
  for (const [name, spec] of Object.entries(deps)) {
    if (!name.startsWith(OFFICIAL_SCOPE)) continue;
    if (field === "peerDependencies") officialPeerCount++;
    if (spec !== "catalog:") {
      problems.push(`${dir}: ${field}["${name}"] = "${spec}" —— 官方包一律写 catalog:`);
    } else if (!catalog.has(name)) {
      problems.push(
        `${dir}: ${field}["${name}"] 用了 catalog: 但 pnpm-workspace.yaml 无此 catalog 条目`,
      );
    }
  }
  return { problems, officialPeerCount };
}

/** 逐包逐字段累计问题，并把官方 peer 声明出现次数单独带出（真实仓库的回归底线看它）。 */
function collectPackageProblems(root, catalog) {
  const problems = [];
  let officialPeerCount = 0;
  for (const dir of packageDirs(root)) {
    const pkg = readPackageManifest(root, dir);
    if (pkg === null) continue;
    for (const field of DEP_FIELDS) {
      const deps = pkg[field];
      if (deps === undefined || deps === null || typeof deps !== "object") continue;
      const found = collectDepProblems(dir, field, deps, catalog);
      problems.push(...found.problems);
      officialPeerCount += found.officialPeerCount;
    }
  }
  return { problems, officialPeerCount };
}

/**
 * catalog 键未登记进供应链豁免清单即判红。
 *
 * 两处是同一份事实源的两面登记：catalog 有了键而豁免清单没跟上，说明升级时只改了半边。
 */
function collectCatalogExemptionProblems(catalog, excluded) {
  const problems = [];
  for (const name of catalog.keys()) {
    if (!excluded.has(name)) {
      problems.push(
        `catalog["${name}"] 未登记进 minimumReleaseAgeExclude（供应链豁免清单与事实源漂移）`,
      );
    }
  }
  return problems;
}
