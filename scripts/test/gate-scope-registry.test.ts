#!/usr/bin/env node
// @ts-nocheck
/**
 * 范围注册表自测（#733 计划项 3.2.1）。
 *
 * 三件事，缺一不可：
 *   1. 结构——条目字段齐备、gate 唯一、script 真实存在（登记指向不存在的脚本 = 台账腐烂）；
 *   2. **未登记即红**——枚举本仓全部路径受限门禁，逐个要求已登记。枚举面刻意是「机械可派生」
 *      的两类，而不是人工维护的第二份清单：`scripts/gate/forbid-*.mjs`（命名即契约）
 *      ∪ 调用点带 `--package`（单数）的门禁脚本。新增一个 forbid 闸或给某个闸加一个包切片，
 *      忘了登记这里就先红；
 *   3. 调用点一致——`scopeFrom: "cli"` 的门禁，其登记范围必须**等于**调用点 `--package`
 *      的并集。范围从调用点来却抄在数据文件里，两边漂移过一次就再也没人对得上。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadScopeRegistry } from "../lib/gate-scope-registry.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const REGISTRY = join(ROOT, "scripts", "data", "gate-scope-registry.json");
const GATE_DIR = join(ROOT, "scripts", "gate");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

/**
 * 提取「某门禁脚本被以 `--package <包名>` 调用」的调用点。
 * `--package` 是**单数**：复数 `--packages` 是产物闸的成本切片（默认全量，不改变语义范围），
 * 两者混为一谈会让登记值失真。
 */
function packageCallSites() {
  const files = [
    ...readdirSync(GATE_DIR)
      .filter((f) => /\.(mjs|ts)$/.test(f))
      .map((f) => join(GATE_DIR, f)),
    ...readdirSync(WORKFLOWS_DIR)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => join(WORKFLOWS_DIR, f)),
  ];
  const sites = new Map();
  for (const file of files) {
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const ref of text.matchAll(/scripts\/gate\/([a-z0-9-]+)\.(?:mjs|ts)/g)) {
      // 只看脚本引用之后的一小段：调用点写成 spawnSync([...脚本, "--package", "pkg"])，
      // 同一段里可能有多次 --package（同一闸的多个包切片）。
      const window = text.slice(ref.index, ref.index + 600);
      for (const m of window.matchAll(/--package(?!s)"?\s*,\s*"([a-z0-9-]+)"/g)) {
        const gate = ref[1];
        if (!sites.has(gate)) sites.set(gate, new Set());
        sites.get(gate).add(m[1]);
      }
    }
  }
  return sites;
}

/** 命名即契约的 forbid 闸：`scripts/gate/forbid-*.mjs`。 */
function forbidGateNames() {
  return readdirSync(GATE_DIR)
    .filter((f) => /^forbid-[a-z0-9-]+\.mjs$/.test(f))
    .map((f) => f.replace(/\.mjs$/, ""))
    .sort();
}

const registry = loadScopeRegistry(REGISTRY);

test("结构：条目字段齐备、gate 唯一、script 存在", () => {
  assert.ok(registry.gates.size >= 4, `登记条目应有 4 条以上，实际 ${registry.gates.size}`);
  for (const [gate, entry] of registry.gates) {
    assert.equal(entry.gate, gate);
    assert.ok(["registry", "cli", "tree"].includes(entry.scopeFrom), `${gate}: scopeFrom 取值越界`);
    assert.ok(
      existsSync(join(ROOT, entry.script)),
      `${gate}: 登记的 script 不存在（${entry.script}）——登记指向不存在的脚本即腐烂`,
    );
    assert.ok(entry.why.length > 10, `${gate}: why 过短，范围是治理决策，必须写明理由`);
  }
});

test("未登记即红：scripts/gate/forbid-*.mjs 必须全部登记", () => {
  const names = forbidGateNames();
  assert.ok(names.length >= 3, `forbid-* 闸应有 3 个以上，实际 ${names.length}`);
  for (const name of names) {
    assert.ok(
      registry.gates.has(name),
      `${name} 未登记进 scripts/data/gate-scope-registry.json——未登记即红：新增路径受限门禁必须登记范围`,
    );
  }
});

test("未登记即红：调用点带 --package 的门禁必须登记", () => {
  const sites = packageCallSites();
  assert.ok(sites.size >= 2, `应至少派生 2 个受 --package 限制的门禁，实际 ${sites.size}`);
  for (const [gate, pkgs] of sites) {
    assert.ok(
      registry.gates.has(gate),
      `${gate} 被调用点以 --package 限制（${[...pkgs].join(", ")}）但未登记范围——未登记即红`,
    );
  }
});

test("调用点一致：scopeFrom=cli 的登记范围 == 调用点 --package 并集", () => {
  const sites = packageCallSites();
  const cliGates = [...registry.gates.values()].filter((e) => e.scopeFrom === "cli");
  assert.ok(cliGates.length >= 1, "至少应有一个 scopeFrom=cli 的门禁登记");
  for (const entry of cliGates) {
    const observed = sites.get(entry.gate);
    assert.ok(
      observed !== undefined,
      `${entry.gate} 登记为 cli 范围，但没有任何 --package 调用点——范围声明的出处不存在`,
    );
    assert.deepEqual(
      [...entry.packages].sort(),
      [...observed].sort(),
      `${entry.gate} 的登记范围与调用点 --package 并集不一致（两边漂移）`,
    );
  }
});

test("scopeFrom=registry / tree 的登记范围形态合法（通配或非空数组）", () => {
  for (const entry of registry.gates.values()) {
    if (entry.scopeFrom === "cli") continue;
    const ok =
      (typeof entry.packages === "string" && entry.packages.endsWith("*")) ||
      (Array.isArray(entry.packages) && entry.packages.length > 0);
    assert.ok(ok, `${entry.gate}: packages 形态不合法（${JSON.stringify(entry.packages)}）`);
  }
});
