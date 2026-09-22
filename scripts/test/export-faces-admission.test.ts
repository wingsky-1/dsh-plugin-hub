#!/usr/bin/env node
"use strict";

/**
 * 导出面分类登记准入判据自测（#733 M2a-3.5，§9「门禁自测：违规判红、合规判绿」）。
 *
 * 两层证据，缺一不可：
 *  1. **判据本身**（fixture 正反双向）：在 mkdtemp 隔离目录铺登记文件，直接对
 *     checkExportFaces 断言——覆盖「新增未登记」「分类值非法」「faces/legacy 互斥」
 *     「legacy 过期」「空登记退化」五个方向。真实仓库跑出 PASS 无法证明判红有效。
 *  2. **执法接线**（真实脚本端到端）：spawn scripts/gate/export-surface-snapshot.mjs
 *     本体，证明该判据确实挂在既有 CI 步骤（contract-check 调用的同一条命令）上，
 *     而不是一个没人调用的库函数。
 *
 * 判据与门禁**同一实现**（scripts/lib/export-faces-lib.ts），不在测试里复刻一份逻辑
 * ——否则测试绿而门禁红的双轨漂移无从裁决（§9 禁止双轨）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { EXPORT_FACES, checkExportFaces, loadExportFaces } from "../lib/export-faces-lib.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "gate", "export-surface-snapshot.mjs");
// 逐包参数化：判据与登记形态由同一实现（export-faces-lib）驱动，接入一个新包只是加一条，
// 而不是复制一份测试逻辑——双轨会让「测试绿而门禁红」无从裁决（§9）。dsh-mcp-manager 于
// #767 B0 接入，其 legacy 是重构前那棵树的存量全集。dsh-provider-usage 于
// #768 S1 接入，其 legacy 是 S1 时点的存量全集（主入口经别名读 apply 产物）。
const PACKAGES = ["dsh-notifier", "dsh-mcp-manager", "dsh-provider-usage"];
const registryPath = (pkg: string) => join(ROOT, "scripts", "data", `${pkg}-export-faces.json`);
const baselinePath = (pkg: string) => join(ROOT, "scripts", "data", `${pkg}-export-surface.json`);

/** 在隔离目录写一份登记文件并返回路径（用完即弃，产物零污染）。 */
function writeRegistry(dir: string, payload: unknown) {
  const path = join(dir, "faces.json");
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

function withTmp(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "export-faces-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 1) 判据正反双向（fixture）

test("合规：导出集合全部已登记（faces ∪ legacy 覆盖完整）→ 无违规", () => {
  const problems = checkExportFaces({
    exports: ["apply", "ROUTES", "NotifierService", "legacyConst"],
    faces: { apply: "安装面", ROUTES: "安装面", NotifierService: "契约面" },
    legacy: ["legacyConst"],
  });
  assert.deepEqual(problems, []);
});

test("违规：新增导出未登记 → 判红且点名（本判据要防的核心方向）", () => {
  const problems = checkExportFaces({
    exports: ["apply", "brandNewExport"],
    faces: { apply: "安装面" },
    legacy: [],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /新增导出未分类登记：brandNewExport/);
  // 三类面必须出现在提示里，否则登记者不知道该写什么值
  for (const face of EXPORT_FACES) assert.match(problems[0], new RegExp(face));
});

test("违规：faces 的分类值不在三类面内 → 判红", () => {
  const problems = checkExportFaces({
    exports: ["apply"],
    faces: { apply: "工具面" },
    legacy: [],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /分类「工具面」不在三类面内/);
});

test("违规：同一符号同时登记在 faces 与 legacy → 判红（互斥）", () => {
  const problems = checkExportFaces({
    exports: ["apply"],
    faces: { apply: "安装面" },
    legacy: ["apply"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /同时登记在 faces 与 legacy/);
});

test("违规：legacy 含已不存在的导出符号 → 判红（符号退役须同步收缩）", () => {
  const problems = checkExportFaces({
    exports: ["apply"],
    faces: { apply: "安装面" },
    legacy: ["alreadyRemoved"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /legacy 含已不存在的导出符号：alreadyRemoved/);
});

test("违规：登记文件为空（既无 faces 也无 legacy）→ 拒绝放行，不退化为无约束", () => {
  const problems = checkExportFaces({ exports: ["apply"], faces: {}, legacy: [] });
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /判据退化为「无约束」/);
  assert.match(problems.join("\n"), /新增导出未分类登记：apply/);
});

test("违规：legacy 含重复项 → 判红", () => {
  const problems = checkExportFaces({ exports: ["a"], faces: {}, legacy: ["a", "a"] });
  assert.match(problems.join("\n"), /legacy 含重复项/);
});

test("loadExportFaces：登记文件缺失即抛（不静默降级）", () => {
  withTmp((dir: string) => {
    assert.throws(() => loadExportFaces(join(dir, "missing.json")), /登记文件不存在/);
  });
});

test("loadExportFaces：字段缺失时按空集合读取（由 checkExportFaces 的空集合判据兜底）", () => {
  withTmp((dir: string) => {
    const path = writeRegistry(dir, { package: "x" });
    const loaded = loadExportFaces(path);
    assert.deepEqual(loaded.faces, {});
    assert.deepEqual(loaded.legacy, []);
  });
});

test("已知边界（如实登记）：新符号塞进 legacy 可绕过准入判据——本判据只让「静默增长」不可能", () => {
  // 为什么要有这条「断言放行」的用例：docs/DEVELOPMENT.md 的准入段与
  // scripts/lib/export-faces-lib.ts 的注释都声称「legacy 上没有阻止其增大的机器判据」。
  // 该声称若只写在散文里，就会随判据演化而反向（#733 M2c 复核实测：规范文档一度写成
  // 「legacy 只许随符号退役而缩小」，与实现相反）。把它钉成机器事实后，判据一旦收紧
  // （例如让 legacy 对齐冻结清单），本用例必红并点名要同步的两处文本。
  const problems = checkExportFaces({
    exports: ["A", "B", "brandNew"],
    faces: {},
    legacy: ["A", "B", "brandNew"],
  });
  assert.deepEqual(
    problems,
    [],
    "若变红说明判据已收紧为「legacy 只许缩小」——请同步 docs/DEVELOPMENT.md 的导出准入段与 export-faces-lib.ts 的存量口径注释",
  );
});

// ---------------------------------------------------------------- 2) 真实仓库登记文件自洽

for (const pkg of PACKAGES) {
  test(`真实登记文件（${pkg}）：package 匹配且覆盖基线全部导出符号`, () => {
    const registry = loadExportFaces(registryPath(pkg));
    const baselineExports = JSON.parse(readFileSync(baselinePath(pkg), "utf8")).exports.map(
      (e: { name: string }) => e.name,
    );
    assert.equal(baselineExports.length > 0, true, "基线导出符号集必须非空（先断言集合非空）");
    assert.equal(registry.package, pkg);
    const problems = checkExportFaces({
      exports: baselineExports,
      faces: registry.faces,
      legacy: registry.legacy,
    });
    assert.deepEqual(problems, []);
    assert.equal(
      registry.legacy.length,
      baselineExports.length,
      "存量白名单条数应等于基线条数（两包在各自冻结时点全部为存量）",
    );
  });
}

// ---------------------------------------------------------------- 3) 执法接线（真实脚本）

for (const pkg of PACKAGES) {
  test(`端到端（${pkg}）：合规登记 → 真实门禁脚本 exit 0`, () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--package", pkg], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 180000,
    });
    assert.equal(
      result.status,
      0,
      `期望 exit 0，实际 ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(result.stdout, new RegExp(`PASS ${pkg} 导出面与基线零 diff`));
  });

  test(`端到端（${pkg}）：模拟新增未登记导出（把一个存量符号移出 legacy）→ 真实门禁脚本 exit 1`, () => {
    withTmp((dir: string) => {
      const registry = JSON.parse(readFileSync(registryPath(pkg), "utf8"));
      const dropped = registry.legacy[0];
      registry.legacy = registry.legacy.slice(1);
      const path = writeRegistry(dir, registry);
      const result = spawnSync(process.execPath, [SCRIPT, "--package", pkg, "--faces", path], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 180000,
      });
      assert.equal(
        result.status,
        1,
        `期望 exit 1，实际 ${result.status}\n${result.stdout}\n${result.stderr}`,
      );
      assert.match(result.stdout, new RegExp(`新增导出未分类登记：${dropped}`));
      // 判红必须来自分类登记判据，而不是被基线比对的红掩盖（两条判据各自独立发声）
      assert.match(result.stdout, /\[导出面分类登记\]/);
    });
  });

  test(`端到端（${pkg}）--verbose：声明块分列「当前/基线」，且两侧不等时不得声称「与基线一致」（#733 M2c R4-2）`, () => {
    const baseBlocks = JSON.parse(readFileSync(baselinePath(pkg), "utf8")).declBlocks;
    assert.equal(baseBlocks.length > 0, true, "基线声明块集必须非空（先断言集合非空）");
    const result = spawnSync(process.execPath, [SCRIPT, "--package", pkg, "--verbose"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 180000,
    });
    assert.equal(
      result.status,
      0,
      `期望 exit 0，实际 ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
    const line = result.stdout.split("\n").find((l) => l.includes("声明块 当前"));
    assert.ok(
      line !== undefined,
      `verbose 应分列「当前 / 基线」两个声明块计数，实际输出：\n${result.stdout}`,
    );
    const m = /声明块 当前 (\d+) \/ 基线 (\d+)/.exec(line);
    assert.ok(m !== null, `计数格式不符：${line}`);
    // 「基线」计数必须真取自基线文件——把当前值打印两遍会在此判红。
    assert.equal(
      Number(m[2]),
      baseBlocks.length,
      `「基线」计数应等于基线文件的 declBlocks 条数（${baseBlocks.length}）：${line}`,
    );
    // 旧文案（`${surface.declBlocks.length} 个声明块与基线一致`）的缺陷是**单向**的：它把
    // 「当前值」说成与基线一致，无论两侧计数是否相等。故判据也取单向——**两侧不等时不得
    // 出现该短语**。写成双向等价（`includes(...) === (m1===m2)`）会埋一条假红地雷：实现
    // 永不再打印该短语，一旦基线被合法刷新到与现状相等（M2b 的待决事项），右式为 true 而
    // 左式恒 false → 门禁正确却判红，最可能的"修法"是把断言改弱（#733 M2c 复核实测）。
    if (Number(m[1]) !== Number(m[2])) {
      assert.equal(
        line.includes("与基线一致"),
        false,
        `两侧计数不等时不得声称「与基线一致」：${line}`,
      );
    }
    assert.equal(
      line.includes("不等于判据实际比对的块集合"),
      true,
      `必须写明该计数与比对块集合的关系：${line}`,
    );
  });
}
