#!/usr/bin/env node
// @ts-nocheck
/** forbid-homedir-src.mjs 自测（#517 B5）：正反例 + 三态 + fail-closed 全组合。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/gate/forbid-homedir-src.mjs");

/** 构造最小 fixture 仓库（--root 注入）。pkgFiles: [{ rel, content }] */
function fixture(pkgFiles) {
  const dir = mkdtempSync(join(tmpdir(), "forbid-homedir-src-test-"));
  mkdirSync(join(dir, "packages/dsh-fake/src"), { recursive: true });
  for (const { rel, content } of pkgFiles) {
    const p = join(dir, "packages/dsh-fake/src", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function run(root) {
  try {
    return spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("正例：干净 src（无任何 HOME 来源 API）→ exit 0", () => {
  const dir = fixture([{ rel: "a.ts", content: "export const a = 1\n" }]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK（扫描 1 文件，无 HOME 来源 API 直连）/);
});

test("正例：shared/dsh-home 式合法接缝不受影响（dshHome 内部实现在 packages 外）", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      // 插件 src 调 dshHome()（从 shared 导入）而非 homedir——门禁不命中
      content: 'import { dshHome } from "../../shared/dsh-home.js"\nexport const p = dshHome()\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("反例：os.homedir 直连（named import）→ exit 1", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content: 'import { homedir } from "node:os"\nexport const p = join(homedir(), ".dsh")\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /homedir\(\)（node:os homedir 别名调用）/);
  assert.match(r.stderr, /FAIL（扫描 1 文件，违规 1 /);
});

test("反例：别名 import { homedir as hd } 逃逸 → exit 1", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content: 'import { homedir as hd } from "os"\nexport const p = hd()\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hd\(\)（node:os homedir 别名调用）/);
});

test('反例：os["homedir"] 中括号混淆形态 → exit 1', () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content: 'import * as os from "node:os"\nexport const p = os["homedir"]()\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /os\.homedir/);
});

test("反例：process.env.HOME 直连（含中括号形态）→ exit 1", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content: 'export const h = process.env["HOME"]\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /process\.env\.HOME/);
});

test("反例：os.userInfo()（homedir 别名通道）→ exit 1", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content: 'import * as os from "node:os"\nexport const u = os.userInfo().homedir\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /os\.userInfo/);
});

test("反例：untildify 直连 → exit 1", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content: 'import untildify from "untildify"\nexport const p = untildify("~/x")\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /untildify\(\)（untildify 别名调用）/);
});

test("反例：.mjs 文件同样受扫（adapters 旁路防护）→ exit 1", () => {
  const dir = fixture([
    {
      rel: "a.mjs",
      content: 'import { homedir } from "node:os"\nexport const p = homedir()\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /homedir\(\)（node:os homedir 别名调用）/);
});

test("豁免三态：有注释但未在台账登记 → FAIL（不合法豁免）", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content:
        'import { homedir } from "node:os"\n// dsh-gate:allow-homedir #999 测试理由\nexport const p = homedir()\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /有 dsh-gate:allow-homedir 注释但未在 scripts\/data\/gate-exemptions\.json 登记/,
  );
});

test("豁免三态：豁免注释缺 issue 号 → 不算合法豁免，按违规报", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content:
        'import { homedir } from "node:os"\n// dsh-gate:allow-homedir 随手一豁\nexport const p = homedir()\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1);
  // 无 #NNN → 豁免标记不成立 → 该命中未在台账登记 → 违规
  assert.match(r.stderr, /违规 1 /);
});

test("F1：字符串字面量里的伪豁免注释不生效（真实注释词法识别）→ 判违规", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content:
        'import { homedir } from "node:os"\nconst msg = "// dsh-gate:allow-homedir #999 字符串伪造"\nexport const p = homedir()\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /违规 1 /);
  assert.ok(!r.stderr.includes("字符串伪造"), "字符串内容不得被当作豁免理由");
});

test("F2：台账条目文件存在但本次零命中 → 报已腐烂（非死代码）", () => {
  // 为什么改用注入台账（--exemptions）而不是锚定真实台账：本用例的判定面是「反向腐烂
  // 校验」这条机制，与真实台账里此刻有几条无关。原先锚定真实条目，结果是台账一收紧
  // （~user 透传那条被 provider-usage 自己去掉后，homedir 面已零豁免）本用例就跟着红，
  // 属于把机制判据绑在了数据现状上。
  const dir = mkdtempSync(join(tmpdir(), "forbid-homedir-rot-"));
  mkdirSync(join(dir, "packages/dsh-provider-usage/src/domain1/registry"), { recursive: true });
  writeFileSync(
    join(dir, "packages/dsh-provider-usage/src/domain1/registry/path-resolve.ts"),
    "export const clean = 1\n",
  ); // 台账含此文件，但零命中（反向腐烂校验的判定面）
  const ledger = exemptionsFile([
    {
      gate: "forbid-homedir-src",
      path: "packages/dsh-provider-usage/src/domain1/registry/path-resolve.ts",
      reason: "测试用登记：文件存在但零命中",
      trackingIssue: "#999",
    },
  ]);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--exemptions", ledger], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /已腐烂，应删除条目/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirname(ledger), { recursive: true, force: true });
  }
});

test('F3：dynamic import 命名空间形态（await import("node:os")）→ 判违规', () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content:
        'export async function g() {\n  const os = await import("node:os")\n  return os.homedir()\n}\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /os\.homedir/);
});

test("F4：参数/局部同名遮蔽不误报（esbuild 自动重命名，锁定行为）", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content:
        'import { homedir } from "node:os"\nimport * as os from "node:os"\n' +
        "export function g(homedir: () => string) { return homedir() }\n" +
        'export const x = () => { const os = { homedir: () => "x" }; return os.homedir() }\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /无 HOME 来源 API 直连/);
});

test("P3：--root=<path> 等号形态可用", () => {
  const dir = fixture([{ rel: "a.ts", content: "export const a = 1\n" }]);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, `--root=${dir}`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK（扫描 1 文件/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail-closed：语法损坏文件（TS 不可解析）→ exit 1 且指明解析失败", () => {
  const dir = fixture([
    {
      rel: "broken.ts",
      content: "export const a = (((\n",
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /解析失败（fail-closed，一律判红）/);
});

test("本仓真实快照：homedir 面零豁免 → exit 0 且无任何已登记条目", () => {
  // 收紧史：#722 起 provider-config.ts 与 apply.ts 改走 shared/dsh-home.js 的 userHome 接缝，
  // 两条台账条目随之腐烂删除；此后仅剩 path-resolve.ts 的 `~user` 透传一处。该处已由
  // provider-usage 自己去掉——`~user` 一律原样返回（untildify v6 会经 os.homedir() +
  // os.userInfo() 展开 `~<当前登录用户>`，既绕过 DSH_HOME 接缝，也违反本模块写明的语义边界）。
  // 于是本面**零豁免**：这条断言从此是「门禁面不许再长出豁免」的守卫，而非台账清单。
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /无 HOME 来源 API 直连/);
  for (const f of [
    "packages/dsh-provider-usage/src/domain1/registry/path-resolve.ts",
    "packages/dsh-provider-usage/src/apply/apply.ts",
    "packages/dsh-provider-usage/src/domain1/registry/provider-config.ts",
  ])
    assert.ok(!r.stdout.includes(f), `${f} 不应再出现在豁免台账中（该面已零豁免）`);
});

/** 构造豁免台账临时文件（--exemptions 注入），返回其路径。 */
function exemptionsFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), "gate-exemptions-"));
  const p = join(dir, "gate-exemptions.json");
  writeFileSync(p, JSON.stringify({ version: 1, exemptions: entries }));
  return p;
}

test("#733 3.2.2：.tsx 纳入扫描面——客户端入口不再是对本判据的盲区", () => {
  // 旧过滤是 /\.(ts|mts|mjs)$/，不含 .tsx；客户端入口基本都是 .tsx（仓内 10 个）。
  const dir = fixture([
    {
      rel: "view.tsx",
      content: 'import { homedir } from "node:os"\nexport const View = () => homedir()\n',
    },
  ]);
  const r = run(dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /homedir\(\)（node:os homedir 别名调用）/);
});

test("#733 3.2.2：双源齐备（登记 + 调用点注释）→ 合法豁免，exit 0", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content:
        'import { homedir } from "node:os"\n// dsh-gate:allow-homedir #999 测试理由\nexport const p = homedir()\n',
    },
  ]);
  const ledger = exemptionsFile([
    {
      gate: "forbid-homedir-src",
      path: "packages/dsh-fake/src/a.ts",
      reason: "测试用登记",
      trackingIssue: "#999",
      reviewBy: "2027-03-31",
    },
  ]);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--exemptions", ledger], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /登记豁免 #999（reviewBy 2027-03-31）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#733 3.2.2：双源缺一（登记了但调用点无注释）→ 判违规——本闸是双源闸", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content: 'import { homedir } from "node:os"\nexport const p = homedir()\n',
    },
  ]);
  const ledger = exemptionsFile([
    {
      gate: "forbid-homedir-src",
      path: "packages/dsh-fake/src/a.ts",
      reason: "测试用登记",
      trackingIssue: "#999",
    },
  ]);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--exemptions", ledger], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(
      r.stderr,
      /已登记在 scripts\/data\/gate-exemptions\.json 但该调用点缺紧邻豁免注释/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#733 3.2.2：台账条目按 gate 作用域隔离——他闸条目不豁免本闸", () => {
  // 两闸共用同一个台账文件，条目串闸（写错 gate）必须表现为「没登记」而不是「已豁免」。
  const dir = fixture([
    {
      rel: "a.ts",
      content:
        'import { homedir } from "node:os"\n// dsh-gate:allow-homedir #999 测试理由\nexport const p = homedir()\n',
    },
  ]);
  const ledger = exemptionsFile([
    {
      gate: "forbid-module-state-src",
      path: "packages/dsh-fake/src/a.ts",
      reason: "写错 gate 的条目",
      trackingIssue: "#999",
    },
  ]);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--exemptions", ledger], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /未在 scripts\/data\/gate-exemptions\.json 登记/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#733 3.2.2：台账结构不合法（reviewBy 形态）→ fail-closed，不当作「无豁免」继续跑", () => {
  const dir = fixture([
    {
      rel: "a.ts",
      content:
        'import { homedir } from "node:os"\n// dsh-gate:allow-homedir #999 测试理由\nexport const p = homedir()\n',
    },
  ]);
  const ledger = exemptionsFile([
    {
      gate: "forbid-homedir-src",
      path: "packages/dsh-fake/src/a.ts",
      reason: "日期形态错误",
      trackingIssue: "#999",
      reviewBy: "2027/03/31",
    },
  ]);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--exemptions", ledger], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /reviewBy 须形如 2027-03-31/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#733 3.2.1：范围注册表未登记本闸 → 判红（未登记即红）", () => {
  const dir = fixture([{ rel: "a.ts", content: "export const a = 1\n" }]);
  const regDir = mkdtempSync(join(tmpdir(), "gate-scope-registry-"));
  const registry = join(regDir, "gate-scope-registry.json");
  writeFileSync(
    registry,
    JSON.stringify({
      version: 1,
      gates: [
        {
          gate: "some-other-gate",
          script: "x.mjs",
          scopeFrom: "tree",
          packages: "dsh-*",
          why: "占位",
        },
      ],
    }),
  );
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--registry", registry], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /未在范围注册表登记/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
