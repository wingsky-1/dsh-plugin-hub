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
 *      的并集，且**每个调用文件各自**覆盖该全集。范围从调用点来却抄在数据文件里，两边漂移过
 *      一次就再也没人对得上；并集只拦整体收窄，单点收窄要靠逐文件那条。
 *      调用点扫描面 = `scripts/gate/*.{mjs,ts}` ∪ `.github/workflows/*.yml`，两种写法都算：
 *      JS 数组形态（gate-steps.mjs）与 CLI 空格形态（ci.yml / observe.yml / release.yml 的 run 行）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { loadScopeRegistry, packageScopeDrift } from "../lib/gate-scope-registry.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const REGISTRY = join(ROOT, "scripts", "data", "gate-scope-registry.json");
const DIR_IMPORTS_BASELINE = join(ROOT, "scripts", "data", "dir-imports-baseline.json");
const GATE_DIR = join(ROOT, "scripts", "gate");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

/**
 * 提取「某门禁脚本被以 `--package <包名>` 调用」的调用点记录（`{file, gate, pkg}`）。
 *
 * 两种写法都必须在扫描面内——只认数组形态的旧版本让 ci.yml 之外的执行点整体消失：
 * observe.yml / release.yml 用的是 CLI 空格形态，于是那两处被收窄时没有任何断言能判红。
 *   - JS 数组形态（scripts/gate/gate-steps.mjs）：`[".../x.mjs", "--package", "pkg"]`；
 *   - CLI 空格形态（ci.yml / observe.yml / release.yml 的 run 行）：`.../x.mjs --package pkg`。
 * `--package` 是**单数**：复数 `--packages` 是产物闸的成本切片（默认全量，不改变语义范围），
 * 两者混为一谈会让登记值失真；`--package=pkg` 不是调用点——该闸不认等号形态，会 exit 2。
 */
const PACKAGE_CALL_PATTERNS = [
  /--package(?!s)"?\s*,\s*"([a-z0-9-]+)"/g,
  /--package(?!s)\s+"?([a-z0-9-]+)"?/g,
];

function extractPackageCallSites(text, file) {
  const records = [];
  for (const ref of text.matchAll(/scripts\/gate\/([a-z0-9-]+)\.(?:mjs|ts)/g)) {
    // 只看脚本引用之后的一小段：调用点写成 spawnSync([...脚本, "--package", "pkg"])，
    // 同一段里可能有多次 --package（同一闸的多个包切片）。
    const window = text.slice(ref.index, ref.index + 600);
    for (const pattern of PACKAGE_CALL_PATTERNS) {
      for (const m of window.matchAll(pattern)) {
        records.push({ file, gate: ref[1], pkg: m[1] });
      }
    }
  }
  return records;
}

/** 扫描面（scripts/gate ∪ .github/workflows）内的全部 `--package` 调用点记录。 */
function packageCallSiteRecords() {
  const files = [
    ...readdirSync(GATE_DIR)
      .filter((f) => /\.(mjs|ts)$/.test(f))
      .map((f) => join(GATE_DIR, f)),
    ...readdirSync(WORKFLOWS_DIR)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => join(WORKFLOWS_DIR, f)),
  ];
  const records = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    records.push(...extractPackageCallSites(text, relative(ROOT, file)));
  }
  return records;
}

/** gate → 全部调用点的 `--package` 并集（registry 里 `scopeFrom=cli` 的声明值）。 */
function packageCallSites() {
  const sites = new Map();
  for (const { gate, pkg } of packageCallSiteRecords()) {
    if (!sites.has(gate)) sites.set(gate, new Set());
    sites.get(gate).add(pkg);
  }
  return sites;
}

/** gate → 调用文件 → 该文件内的 `--package` 并集（每个调用文件都要覆盖登记范围全集）。 */
function packageCallSitesByFile() {
  const byGate = new Map();
  for (const { file, gate, pkg } of packageCallSiteRecords()) {
    if (!byGate.has(gate)) byGate.set(gate, new Map());
    const byFile = byGate.get(gate);
    if (!byFile.has(file)) byFile.set(file, new Set());
    byFile.get(file).add(pkg);
  }
  return byGate;
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

test("执行点全覆盖：scopeFrom=cli 的每个调用文件都必须覆盖登记范围全集（#843 D15）", () => {
  // 并集核对拦不住**单点收窄**：其余执行点仍带着该包，并集不变，删掉 observe.yml 或
  // release.yml 里的一处 --package 照样全绿。而「收窄范围 = 显式 diff 且自测先红」这条承诺
  // 是对每个执行点分别成立的，故按调用文件逐个要求覆盖全集。
  const byGate = packageCallSitesByFile();
  for (const entry of [...registry.gates.values()].filter((e) => e.scopeFrom === "cli")) {
    const byFile = byGate.get(entry.gate);
    assert.ok(
      byFile !== undefined && byFile.size > 0,
      `${entry.gate} 登记为 cli 范围，但没有任何 --package 调用点——范围声明的出处不存在`,
    );
    const declared = [...entry.packages].sort();
    for (const [file, pkgs] of byFile) {
      const observed = [...pkgs].sort();
      assert.deepEqual(
        observed,
        declared,
        `${entry.gate} 在 ${file} 的调用只覆盖 [${observed.join(", ")}]，少于登记范围全集 ` +
          `[${declared.join(", ")}]——执行点范围收窄（收窄必须是显式登记改动，各执行点同步）`,
      );
    }
  }
});

test("调用点提取：数组形态与 CLI 空格形态都在扫描面内，复数 --packages 不得混入", () => {
  // 真实数据当前两种形态恰好同集，故判据本体必须用一个确定的输入打红：只认数组形态时
  // 下面第一条 CLI 形态的调用会整体消失。
  const text = [
    "run: node scripts/gate/verify-dir-imports.mjs --package dsh-alpha --package dsh-beta",
    'args: ["scripts/gate/verify-dir-imports.mjs", "--package", "dsh-gamma"],',
    "run: node scripts/gate/contract-check.ts --packages dsh-delta",
  ].join("\n");
  const seen = [
    ...new Set(extractPackageCallSites(text, "fixture").map((r) => `${r.gate}:${r.pkg}`)),
  ].sort();
  assert.deepEqual(seen, [
    "verify-dir-imports:dsh-alpha",
    "verify-dir-imports:dsh-beta",
    "verify-dir-imports:dsh-gamma",
  ]);
});

test("接线一致：verify-dir-imports 的基线键集 == cli 调用点并集（#843 D15）", () => {
  // 为什么是「基线 ↔ 调用点并集」而不是「基线 ↔ registry 字段」：registry 的 cli 值本身
  // 由调用点并集派生（上面那条用例钉住），故两侧各自对齐同一个真值即可；而**死条目**
  // （有基线、无调用点）恰恰是闸自身发现不了的——没有调用点就永远不会被 --package 点到，
  // 它只会在数据面里冒充「该包仍受保护」。基线键集是同一件事的另一份声明，两处必须逐字对齐。
  const observed = [...(packageCallSites().get("verify-dir-imports") ?? [])].sort();
  assert.ok(observed.length > 0, "verify-dir-imports 应至少有一个 --package 调用点");
  const baselineKeys = Object.keys(
    JSON.parse(readFileSync(DIR_IMPORTS_BASELINE, "utf8")).packages ?? {},
  );
  const drift = packageScopeDrift(baselineKeys, observed);
  assert.deepEqual(
    drift,
    { baselineOnly: [], registryOnly: [] },
    `基线键集与调用点并集漂移——基线独有（死条目，应删）[${drift.baselineOnly.join(", ")}] / ` +
      `调用点独有（缺条目，应跑 --write-baseline 登记）[${drift.registryOnly.join(", ")}]`,
  );
});

test("反例：基线键集与调用点并集任一方向漂移都必须被点名（#843 D15）", () => {
  // 真实数据当前一致，故判据本体必须用一个确定的漂移输入打红：把 packageScopeDrift 改成
  // 恒返回空差集，上面那条用例照样全绿，而这里会立刻失配。
  assert.deepEqual(packageScopeDrift(["a", "b"], ["b", "c"]), {
    baselineOnly: ["a"],
    registryOnly: ["c"],
  });
  assert.deepEqual(packageScopeDrift(["b"], ["b"]), { baselineOnly: [], registryOnly: [] });
  assert.deepEqual(packageScopeDrift([], ["x", "y"]), {
    baselineOnly: [],
    registryOnly: ["x", "y"],
  });
  assert.deepEqual(packageScopeDrift(["x", "y"], []), {
    baselineOnly: ["x", "y"],
    registryOnly: [],
  });
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
