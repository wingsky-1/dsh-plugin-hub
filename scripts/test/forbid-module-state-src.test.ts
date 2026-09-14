#!/usr/bin/env node
// @ts-nocheck
/** forbid-module-state-src.mjs 自测（#733 M2c 后续 N2a）：正反例 + 登记豁免 + 台账腐烂 + fail-closed。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts", "gate", "forbid-module-state-src.mjs");
const PKG = "dsh-notifier";

/** 构造最小 fixture 仓库（--root 注入）。pkgFiles: [{ rel, content }] */
function fixture(pkgFiles) {
  const dir = mkdtempSync(join(tmpdir(), "forbid-module-state-"));
  mkdirSync(join(dir, "packages", PKG, "src"), { recursive: true });
  for (const { rel, content } of pkgFiles) {
    const p = join(dir, "packages", PKG, "src", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function runWith(dir, extraArgs = []) {
  try {
    return spawnSync(process.execPath, [SCRIPT, "--root", dir, ...extraArgs], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir) {
  return runWith(dir);
}

/**
 * 构造豁免台账临时文件，返回其路径。
 * 刻意不放进 fixture 目录：台账是治理数据面，`--root` 只换扫描面，两者不该混在一起。
 */
function exemptionsFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), "gate-exemptions-"));
  const p = join(dir, "gate-exemptions.json");
  writeFileSync(p, JSON.stringify({ version: 1, exemptions: entries }));
  return p;
}

test("正例：干净 src（无模块级可变状态）→ exit 0", () => {
  const r = run(fixture([{ rel: "a.ts", content: "const a = 1\nexport const b = a\n" }]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /无模块级可变状态/);
});

test("反例：模块级 let → exit 1 且点名符号（本判据要防的核心方向）", () => {
  const r = run(
    fixture([
      { rel: "a.ts", content: "let lastOutcome = true\nexport const peek = () => lastOutcome\n" },
    ]),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /模块级 let（lastOutcome）/);
  assert.match(r.stderr, /FAIL（扫描 1 文件，违规 1 /);
});

test("反例：模块级 var → exit 1", () => {
  const r = run(
    fixture([
      { rel: "a.ts", content: "var cache: unknown = null\nexport const peek = () => cache\n" },
    ]),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /模块级 var（cache）/);
});

test("反例：export let 顶格形态 → exit 1（不只裸声明）", () => {
  const r = run(fixture([{ rel: "a.ts", content: "export let counter = 0\n" }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /模块级 let（counter）/);
});

test("放行：函数体内 let/var 是正常局部状态 → exit 0", () => {
  const r = run(
    fixture([
      {
        rel: "a.ts",
        content: "export function f(): number {\n  let x = 1\n  x += 1\n  return x\n}\n",
      },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
});

test("放行：declare let 是环境声明（无运行时状态）→ exit 0", () => {
  const r = run(
    fixture([
      { rel: "a.ts", content: "declare let ambient: number\nexport const peek = () => ambient\n" },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
});

test("#733 3.1.2：缩进的模块级声明同样判红——形态（缩进）不再参与判据", () => {
  // 旧实现按「顶格」过滤，缩进一格即可逃出判据；那是一个静默绕过口，
  // 客户端 22 处历史 var 正是靠它留在判据外。现改为登记豁免，见下方用例。
  const r = run(
    fixture([{ rel: "a.ts", content: "  let hidden = 1\nexport const peek = () => hidden\n" }]),
  );
  assert.equal(r.status, 1, "缩进不得成为绕过判据的通道");
  assert.match(r.stderr, /模块级 let（hidden）/);
});

test("豁免：登记条目使该文件命中合法 → exit 0 且回显 issue 与 reviewBy", () => {
  const dir = fixture([{ rel: "a.ts", content: "let x = 1\nexport const peek = () => x\n" }]);
  const ledger = exemptionsFile([
    {
      gate: "forbid-module-state-src",
      path: `packages/${PKG}/src/a.ts`,
      reason: "测试用登记",
      trackingIssue: "#999",
      reviewBy: "2027-03-31",
    },
  ]);
  const r = runWith(dir, ["--exemptions", ledger]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /登记豁免 1 处/);
  assert.match(r.stdout, /登记豁免 #999（reviewBy 2027-03-31）/);
});

test("豁免：只有调用点注释、未登记 → 仍判红（注释不能替代登记）", () => {
  const r = run(
    fixture([
      {
        rel: "a.ts",
        content:
          "// dsh-gate:allow-module-state #999 测试理由\nlet x = 1\nexport const peek = () => x\n",
      },
    ]),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未在 scripts\/data\/gate-exemptions\.json 登记/);
});

test("豁免：注释缺 issue 号 → 既不算登记也不算合法注释，按违规报", () => {
  const r = run(
    fixture([
      {
        rel: "a.ts",
        content:
          "// dsh-gate:allow-module-state 随手一豁\nlet x = 1\nexport const peek = () => x\n",
      },
    ]),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /违规 1 /);
});

test("台账腐烂：登记条目指向的文件存在但本次零命中 → 判红并要求删除条目", () => {
  const dir = fixture([{ rel: "a.ts", content: "const a = 1\nexport const b = a\n" }]);
  const ledger = exemptionsFile([
    {
      gate: "forbid-module-state-src",
      path: `packages/${PKG}/src/a.ts`,
      reason: "已失效的登记",
      trackingIssue: "#999",
      reviewBy: "2027-03-31",
    },
  ]);
  const r = runWith(dir, ["--exemptions", ledger]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /已腐烂，应删除条目 #999/);
});

test("台账校验：reviewBy 格式不合法 → fail-closed（机制失效不得当作无豁免）", () => {
  const dir = fixture([{ rel: "a.ts", content: "let x = 1\nexport const peek = () => x\n" }]);
  const ledger = exemptionsFile([
    {
      gate: "forbid-module-state-src",
      path: `packages/${PKG}/src/a.ts`,
      reason: "缺日期",
      trackingIssue: "#999",
      reviewBy: "soon",
    },
  ]);
  const r = runWith(dir, ["--exemptions", ledger]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /reviewBy 须形如 2027-03-31/);
});

test("台账校验：条目缺 trackingIssue → fail-closed", () => {
  const dir = fixture([{ rel: "a.ts", content: "let x = 1\nexport const peek = () => x\n" }]);
  const ledger = exemptionsFile([
    {
      gate: "forbid-module-state-src",
      path: `packages/${PKG}/src/a.ts`,
      reason: "缺 issue",
      reviewBy: "2027-03-31",
    },
  ]);
  const r = runWith(dir, ["--exemptions", ledger]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /trackingIssue 须形如 #123/);
});

test("F1：字符串字面量里的伪豁免注释不生效（真实注释词法识别）→ 判违规", () => {
  const r = run(
    fixture([
      {
        rel: "a.ts",
        content:
          'const msg = "// dsh-gate:allow-module-state #999 字符串伪造"\nlet x = 1\nexport const peek = () => [x, msg]\n',
      },
    ]),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /违规 1 /);
  assert.ok(!r.stderr.includes("字符串伪造"), "字符串内容不得被当作豁免理由");
});

test("fail-closed：语法损坏文件（TS 不可解析）→ exit 1 且指明解析失败", () => {
  const r = run(fixture([{ rel: "broken.ts", content: "export const a = (((\n" }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /解析失败（fail-closed，一律判红）/);
});

test("fail-closed：扫描面为空（无任何 src 文件）→ exit 1，不退化为「零违规」", () => {
  const r = run(fixture([]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未发现任何扫描目标/);
});

test("扫描面：.tsx 也在扫描面内（客户端入口形态）", () => {
  const r = run(
    fixture([{ rel: "view.tsx", content: "let shared = 0\nexport const View = () => shared\n" }]),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /模块级 let（shared）/);
});

test("本仓真实快照：client/index.tsx 的 7 处模块级 var 全部走登记豁免 → exit 0", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // 包面含 dsh-lan-proxy（#765 扩面，实测零命中后才扩）：范围变了此断言先红，提示复核扩面依据。
  assert.match(r.stdout, /OK（扫描 \d+ 文件，包 dsh-lan-proxy, dsh-notifier，登记豁免 7 处）/);
  // 7 处与豁免台账是同一个数字的两面：客户端 var 数量变了、或台账条目被删，
  // 此断言先红并提示同步台账（scripts/data/gate-exemptions.json）与 #762。
  // #765 批次已把同文件的 14 处常量 var 改 const，故从 21 降到 7（余下皆为真·可变绑定）。
  // 锚点的行号随客户端源码增删而移动（豁免台账本身是文件级、不跟行号），改到 `t` 所在行即可。
  assert.match(
    r.stdout,
    /packages\/dsh-notifier\/src\/client\/index\.tsx:241 \[模块级 var（t）\] 登记豁免 #762（reviewBy 2027-03-31）/,
  );
});

/** 写一份范围注册表临时文件，返回其路径（--registry 注入）。 */
function registryFile(gates) {
  const dir = mkdtempSync(join(tmpdir(), "gate-scope-registry-"));
  const p = join(dir, "gate-scope-registry.json");
  writeFileSync(p, JSON.stringify({ version: 1, gates }));
  return p;
}

test("#733 3.2.1：范围注册表未登记本闸 → 判红（未登记即红，运行时也拦）", () => {
  const dir = fixture([{ rel: "a.ts", content: "let x = 1\nexport const peek = () => x\n" }]);
  const registry = registryFile([
    { gate: "some-other-gate", script: "x.mjs", scopeFrom: "tree", packages: "dsh-*", why: "占位" },
  ]);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--registry", registry], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /未在范围注册表登记/);
    assert.match(r.stderr, /未登记即红/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#733 3.2.1：范围为空（注册表登记了别的包）→ 判红，不退化为「零违规」", () => {
  const dir = fixture([{ rel: "a.ts", content: "let x = 1\nexport const peek = () => x\n" }]);
  const registry = registryFile([
    {
      gate: "forbid-module-state-src",
      script: "scripts/gate/forbid-module-state-src.mjs",
      scopeFrom: "registry",
      packages: ["dsh-other"],
      why: "范围写错包名",
    },
  ]);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--registry", registry], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /未发现任何扫描目标/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#733 3.2.1：范围注册表结构不合法（packages 非空数组/通配）→ fail-closed", () => {
  const dir = fixture([{ rel: "a.ts", content: "let x = 1\nexport const peek = () => x\n" }]);
  const registry = registryFile([
    {
      gate: "forbid-module-state-src",
      script: "scripts/gate/forbid-module-state-src.mjs",
      scopeFrom: "registry",
      packages: [],
      why: "空范围",
    },
  ]);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--registry", registry], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /packages 须为/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
