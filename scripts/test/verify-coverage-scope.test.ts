#!/usr/bin/env node
/**
 * verify-coverage-scope 自测（#733 计划项 3.4）：单一事实源、条目结构、kind 形态一致性、面完整性、条目腐烂、产物交叉断言。
 *
 * 每条判据都有正反例：这些口径（哪些 kind 合法、哪些字段只允许 pending-project、什么算「逃逸」）
 * 是本次新增的约定，约定只有写成断言才不会被下一个人无意改掉。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "gate", "verify-coverage-scope.mjs");

/** vitest.config.ts 的最小形态：引用数据文件（正例口径）。 */
const VITEST_OK = [
  "import coverage from './scripts/data/coverage.config.json' with { type: 'json' }",
  "export default { test: {",
  "  projects: [{ test: { name: 'unit', include: ['packages/*/test/unit/**/*.test.ts'] } }],",
  "  coverage: {",
  "    provider: 'istanbul',",
  "    include: coverage.include,",
  "    exclude: coverage.exclude.map((e) => e.pattern),",
  "    thresholds: coverage.thresholds,",
  "  },",
  "} }",
  "",
].join("\n");

const BASE_CONFIG = {
  version: 1,
  note: "fixture",
  include: ["packages/*/src/**/*.{ts,tsx}", "shared/**/*.js"],
  exclude: [{ pattern: "**/*.d.ts", kind: "type-only", reason: "声明文件无运行时代码" }],
  thresholds: { lines: 80, functions: 80, statements: 78, branches: 70 },
};

/**
 * 构造最小 fixture 仓库：源文件 + 数据配置 + vitest.config.ts。
 * sourceFiles 默认给一个已分类的宿主端源码（落在 include 面内）。
 * config 取 unknown：缺 reason、kind 越界等非法形态是故意的反例输入，合法性由门禁判定，fixture 只落盘。
 */
function fixture(
  config: unknown = BASE_CONFIG,
  {
    sourceFiles,
    vitest = VITEST_OK,
  }: { sourceFiles?: Array<{ rel: string; content: string }>; vitest?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cov-scope-"));
  const files = sourceFiles ?? [
    { rel: "packages/dsh-fake/src/a.ts", content: "export const a = 1\n" },
    // 声明文件：让默认的 `**/*.d.ts` 条目在覆盖率根内真的命中一个文件（否则条目腐烂判红）
    { rel: "packages/dsh-fake/src/types.d.ts", content: "export type T = 1\n" },
    { rel: "shared/x.js", content: "export const x = 1\n" },
  ];
  for (const { rel, content } of files) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  mkdirSync(join(root, "scripts/data"), { recursive: true });
  writeFileSync(join(root, "scripts/data/coverage.config.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(root, "vitest.config.ts"), vitest);
  return root;
}

function run(root: string) {
  try {
    return spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("正例：universe 全部被 include/exclude 分类 → exit 0", () => {
  const r = run(fixture());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verify-coverage-scope: OK/);
  assert.match(r.stdout, /universe 3 文件/);
});

test("面完整性：src 下新形态文件既不在 include 也不在 exclude → 红（静默逃逸）", () => {
  const r = run(
    fixture(BASE_CONFIG, {
      sourceFiles: [
        { rel: "packages/dsh-fake/src/a.ts", content: "export const a = 1\n" },
        { rel: "packages/dsh-fake/src/types.d.ts", content: "export type T = 1\n" },
        { rel: "shared/x.js", content: "export const x = 1\n" },
        { rel: "packages/dsh-fake/src/notify.ps1", content: "Write-Host hi\n" },
      ],
    }),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /notify\.ps1 既不在 include 也不在任何 exclude 条目里/);
});

test("非源码资源登记为 not-source 后放行（同一文件，加条目即绿）", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [
      ...BASE_CONFIG.exclude,
      { pattern: "**/*.ps1", kind: "not-source", reason: "脚本资源，非 JS 源码" },
    ],
  };
  const r = run(
    fixture(config, {
      sourceFiles: [
        { rel: "packages/dsh-fake/src/a.ts", content: "export const a = 1\n" },
        { rel: "packages/dsh-fake/src/types.d.ts", content: "export type T = 1\n" },
        { rel: "shared/x.js", content: "export const x = 1\n" },
        { rel: "packages/dsh-fake/src/notify.ps1", content: "Write-Host hi\n" },
      ],
    }),
  );
  assert.equal(r.status, 0, r.stderr);
});

test("kind 形态一致性：真实源码被声明成 not-source → 红（关掉把源码移出分母的通道）", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [
      ...BASE_CONFIG.exclude,
      {
        pattern: "packages/dsh-fake/src/cert.ts",
        kind: "not-source",
        reason: "试验：把源码移出分母",
      },
    ],
  };
  const r = run(
    fixture(config, {
      sourceFiles: [
        { rel: "packages/dsh-fake/src/a.ts", content: "export const a = 1\n" },
        { rel: "packages/dsh-fake/src/types.d.ts", content: "export type T = 1\n" },
        { rel: "packages/dsh-fake/src/cert.ts", content: "export const cert = 1\n" },
        { rel: "shared/x.js", content: "export const x = 1\n" },
      ],
    }),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(
    r.stderr,
    /exclude 条目 packages\/dsh-fake\/src\/cert\.ts（kind=not-source）命中 1 个在 include 面内的文件：packages\/dsh-fake\/src\/cert\.ts（命中 include 模式 packages\/\*\/src\/\*\*\/\*\.\{ts,tsx\}）/,
  );
  assert.match(r.stderr, /把源码移出分母必须改用 kind=pending-project/);
});

test("kind 形态一致性：声明文件被声明成 not-source → 红（应改用 type-only）", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [{ pattern: "**/*.d.ts", kind: "not-source", reason: "试验：把声明文件当非源码资源" }],
  };
  const r = run(fixture(config));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /命中 1 个在 include 面内的文件：packages\/dsh-fake\/src\/types\.d\.ts/);
  assert.match(r.stderr, /声明文件应改用 kind=type-only/);
});

test("kind 形态一致性：include 面外的 .js（packages/*/src 下）声明成 not-source → 放行", () => {
  // include 面里 .js 只出现在 shared/**；packages/*/src/**/*.js 本就不进分母，
  // 按「整个 include 面的后缀并集」判会把它误判成源码（latent 误红）。
  const config = {
    ...BASE_CONFIG,
    exclude: [
      ...BASE_CONFIG.exclude,
      {
        pattern: "packages/dsh-fake/src/vendor.js",
        kind: "not-source",
        reason: "构建期拷贝的第三方产物，不是本仓源码",
      },
    ],
  };
  const r = run(
    fixture(config, {
      sourceFiles: [
        { rel: "packages/dsh-fake/src/a.ts", content: "export const a = 1\n" },
        { rel: "packages/dsh-fake/src/types.d.ts", content: "export type T = 1\n" },
        { rel: "packages/dsh-fake/src/vendor.js", content: "module.exports = {}\n" },
        { rel: "shared/x.js", content: "export const x = 1\n" },
      ],
    }),
  );
  assert.equal(r.status, 0, r.stderr);
});

test("kind 形态一致性：include 面内的 .js（shared/**）声明成 not-source → 红且点名命中的 include 模式", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [
      ...BASE_CONFIG.exclude,
      { pattern: "shared/**/*.js", kind: "not-source", reason: "试验：把 shared 的源码移出分母" },
    ],
  };
  const r = run(fixture(config));
  assert.equal(r.status, 1, r.stderr);
  assert.match(
    r.stderr,
    /exclude 条目 shared\/\*\*\/\*\.js（kind=not-source）命中 1 个在 include 面内的文件：shared\/x\.js（命中 include 模式 shared\/\*\*\/\*\.js）/,
  );
  assert.match(r.stderr, /把源码移出分母必须改用 kind=pending-project/);
});

test("kind 形态一致性：include 面外的声明文件（shared 下）声明成 not-source → 红（仍归 type-only）", () => {
  // shared 那条 include 只收 .js，shared 下的 .d.ts 面外；但「声明文件不是资源」不随面放宽。
  const config = {
    ...BASE_CONFIG,
    exclude: [
      { pattern: "shared/**/*.d.ts", kind: "not-source", reason: "试验：把面外的声明当非源码资源" },
    ],
  };
  const r = run(
    fixture(config, {
      sourceFiles: [
        { rel: "packages/dsh-fake/src/a.ts", content: "export const a = 1\n" },
        { rel: "shared/x.js", content: "export const x = 1\n" },
        { rel: "shared/y.d.ts", content: "export type Y = 1\n" },
      ],
    }),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /命中 1 个声明文件：shared\/y\.d\.ts/);
  assert.match(r.stderr, /声明文件应改用 kind=type-only/);
});

test("kind 形态一致性：.d.ts / .d.mts 声明为 type-only → 放行", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [
      { pattern: "**/*.d.ts", kind: "type-only", reason: "声明文件无运行时代码" },
      { pattern: "**/*.d.mts", kind: "type-only", reason: "声明文件无运行时代码（mts）" },
    ],
  };
  const r = run(
    fixture(config, {
      sourceFiles: [
        { rel: "packages/dsh-fake/src/a.ts", content: "export const a = 1\n" },
        { rel: "packages/dsh-fake/src/types.d.ts", content: "export type T = 1\n" },
        { rel: "packages/dsh-fake/src/types.d.mts", content: "export type M = 1\n" },
        { rel: "shared/x.js", content: "export const x = 1\n" },
      ],
    }),
  );
  assert.equal(r.status, 0, r.stderr);
});

test("kind 形态一致性：.ts 声明成 type-only → 红（type-only 只收声明文件）", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [
      { pattern: "**/*.d.ts", kind: "type-only", reason: "声明文件无运行时代码" },
      { pattern: "**/*.ts", kind: "type-only", reason: "试验：把源码当声明排除" },
    ],
  };
  const r = run(fixture(config));
  assert.equal(r.status, 1, r.stderr);
  assert.match(
    r.stderr,
    /exclude 条目 \*\*\/\*\.ts（kind=type-only）命中 1 个非声明文件：packages\/dsh-fake\/src\/a\.ts/,
  );
});

test("条目结构：pending-project 缺 reviewBy/exitCriteria → 红（临时豁免须有到期日与解除条件）", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [
      ...BASE_CONFIG.exclude,
      {
        pattern: "packages/dsh-fake/src/client/**",
        kind: "pending-project",
        reason: "等某个 project 落地再计分母",
      },
    ],
  };
  const r = run(
    fixture(config, {
      sourceFiles: [
        { rel: "packages/dsh-fake/src/a.ts", content: "export const a = 1\n" },
        { rel: "packages/dsh-fake/src/types.d.ts", content: "export type T = 1\n" },
        { rel: "packages/dsh-fake/src/client/ui.ts", content: "export const ui = 1\n" },
        { rel: "shared/x.js", content: "export const x = 1\n" },
      ],
    }),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /pending-project 必须带 reviewBy/);
  assert.match(r.stderr, /pending-project 必须带 exitCriteria/);
});

test("kind 形态一致性：pending-project 命中 .ts 源码不判形态（字段齐全即放行）", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [
      { pattern: "**/*.d.ts", kind: "type-only", reason: "声明文件无运行时代码" },
      {
        pattern: "packages/dsh-fake/src/client/**",
        kind: "pending-project",
        reason: "客户端面等 DOM project 落地后再计分母",
        reviewBy: "2027-03-31",
        exitCriteria: "DOM 判据落地后删除本条并重新基线化",
      },
    ],
  };
  const r = run(
    fixture(config, {
      sourceFiles: [
        { rel: "packages/dsh-fake/src/a.ts", content: "export const a = 1\n" },
        { rel: "packages/dsh-fake/src/types.d.ts", content: "export type T = 1\n" },
        { rel: "packages/dsh-fake/src/client/ui.ts", content: "export const ui = 1\n" },
        { rel: "shared/x.js", content: "export const x = 1\n" },
      ],
    }),
  );
  assert.equal(r.status, 0, r.stderr);
});

test("条目结构：exclude 缺 reason → 红（排除即缩小判据面，必须写明理由）", () => {
  const config = { ...BASE_CONFIG, exclude: [{ pattern: "**/*.d.ts", kind: "type-only" }] };
  const r = run(fixture(config));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /exclude 条目缺 reason/);
});

test("条目结构：kind 越界 → 红（值域三值，无第三条路）", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [{ pattern: "**/*.d.ts", kind: "whatever", reason: "理由够长了" }],
  };
  const r = run(fixture(config));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /kind 须为 type-only \/ not-source \/ pending-project 之一/);
});

test("条目结构：非 pending-project 携带 reviewBy → 红（给永久事实编到期日即假条目）", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [
      { pattern: "**/*.d.ts", kind: "type-only", reason: "理由够长了", reviewBy: "2027-03-31" },
    ],
  };
  const r = run(fixture(config));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /字段 reviewBy 只允许 pending-project 携带/);
});

test("条目结构：pending-project 的 reviewBy 形态错 → 红", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [
      {
        pattern: "**/client/**",
        kind: "pending-project",
        reason: "理由够长了",
        reviewBy: "2027/03/31",
      },
    ],
  };
  const r = run(fixture(config));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /reviewBy 须形如 2027-03-31/);
});

test("条目结构：重复 pattern → 红（两处声明同一排除）", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [
      { pattern: "**/*.d.ts", kind: "type-only", reason: "理由够长了" },
      { pattern: "**/*.d.ts", kind: "not-source", reason: "理由够长了" },
    ],
  };
  const r = run(fixture(config));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /重复 pattern/);
});

test("条目腐烂：模式在覆盖率根内命中 0 个文件 → 红", () => {
  const config = {
    ...BASE_CONFIG,
    exclude: [{ pattern: "**/*.gone", kind: "not-source", reason: "指向已不存在的形态" }],
  };
  const r = run(fixture(config));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /exclude 模式在覆盖率根内命中 0 个文件（条目腐烂）/);
});

test("单一事实源：coverage 块内联 thresholds 对象字面量 → 红", () => {
  const vitest = VITEST_OK.replace(
    "thresholds: coverage.thresholds,",
    "thresholds: { lines: 80, functions: 80, statements: 78, branches: 70 },",
  );
  const r = run(fixture(BASE_CONFIG, { vitest }));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /coverage 块内联了 thresholds 对象字面量/);
});

test("单一事实源：coverage 块内联 include 数组字面量 → 红", () => {
  const vitest = VITEST_OK.replace(
    "include: coverage.include,",
    "include: ['packages/*/src/**/*.{ts,tsx}'],",
  );
  const r = run(fixture(BASE_CONFIG, { vitest }));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /coverage 块内联了 include 数组字面量/);
});

test("回归：projects[].test.include 是测试面，不得被判成第二个事实源", () => {
  const r = run(fixture());
  assert.equal(r.status, 0, r.stderr);
});

test("单一事实源：缺 coverage 块 → 红", () => {
  const vitest = "export default { test: { projects: [] } }\n";
  const r = run(fixture(BASE_CONFIG, { vitest }));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /缺 coverage 块/);
});

test("fail-closed：include 为空数组 → exit 2（分母为空是配置错误）", () => {
  const r = run(fixture({ ...BASE_CONFIG, include: [] }));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /缺非空 include/);
});

/** 固定时间戳，不依赖文件系统写入速度或 wall clock 的精度。 */
function artifactFixture(keys: string[], { fresh = true }: { fresh?: boolean } = {}) {
  const root = fixture();
  mkdirSync(join(root, "coverage"));
  const artifact = Object.fromEntries(keys.map((key) => [join(root, key), {}]));
  writeFileSync(join(root, "coverage/coverage-final.json"), JSON.stringify(artifact));
  utimesSync(join(root, "scripts/data/coverage.config.json"), 1000, 1000);
  utimesSync(join(root, "coverage/coverage-final.json"), fresh ? 2000 : 500, fresh ? 2000 : 500);
  return root;
}

for (const [name, source, expected] of [
  ["纯类型", "export interface Port { run(): void }; export type T = string;", 0],
  ["类型导入", "import type { T } from './x.ts'; export type Port = T;", 0],
  ["重导出门面", "export { x } from '../../../shared/x.js';", 0],
  ["同名门面包含常量", "export const x = 1;", 1],
  ["函数", "export function run() { return 1; }", 1],
  ["类", "export class Thing { run() { return 1; } }", 1],
  ["枚举", "export enum Flag { On, Off }", 1],
  ["副作用", "console.log('side effect');", 1],
  ["动态导入", "import('./other.js');", 1],
  ["无效源码", "export const = ;", 1],
] as Array<[string, string, number]>) {
  test("产物缺失按语句判定而非文件名：" + name, () => {
    const root = artifactFixture(["packages/dsh-fake/src/a.ts", "shared/x.js"]);
    writeFileSync(join(root, "packages/dsh-fake/src/interface.ts"), source);
    const r = run(root);
    assert.equal(r.status, expected, r.stderr + r.stdout);
    if (expected === 1) assert.match(r.stderr, /interface.ts 在当前计分面内但未出现在覆盖率产物里/);
  });
}

test("产物交叉断言：少一个计分对象不能零违规绿", () => {
  const r = run(artifactFixture(["packages/dsh-fake/src/a.ts"]));
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.ok(r.stderr.includes("shared/x.js 在当前计分面内但未出现在覆盖率产物里"), r.stderr);
});

test("产物交叉断言：空对象报告必须列出全部缺失计分对象", () => {
  const r = run(artifactFixture([]));
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.ok(
    r.stderr.includes("packages/dsh-fake/src/a.ts 在当前计分面内但未出现在覆盖率产物里"),
    r.stderr,
  );
  assert.ok(r.stderr.includes("shared/x.js 在当前计分面内但未出现在覆盖率产物里"), r.stderr);
});

test("产物交叉断言：总数相等也不能用 exclude 对象替换计分对象", () => {
  const r = run(
    artifactFixture(["packages/dsh-fake/src/a.ts", "packages/dsh-fake/src/types.d.ts"]),
  );
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.ok(r.stderr.includes("types.d.ts 出现在覆盖率产物里但不在当前 include 面内"), r.stderr);
  assert.ok(r.stderr.includes("shared/x.js 在当前计分面内但未出现在覆盖率产物里"), r.stderr);
});

test("产物交叉断言：完整计分集合通过且不要求被 exclude 的声明文件", () => {
  const r = run(artifactFixture(["packages/dsh-fake/src/a.ts", "shared/x.js"]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /产物交叉断言：2 个 keys/);
});

test("静态预检：没有产物仍正常检查配置", () => {
  const r = run(fixture());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /跳过交叉断言/);
});

test("静态预检：旧产物缺对象不用于判定当前计分面", () => {
  const r = run(artifactFixture([], { fresh: false }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /跳过交叉断言/);
});

test("产物交叉断言：产物比配置新且含面外 key → 红", () => {
  const root = fixture();
  mkdirSync(join(root, "coverage"), { recursive: true });
  writeFileSync(
    join(root, "coverage/coverage-final.json"),
    JSON.stringify({
      [`${root}/packages/dsh-fake/src/a.ts`]: {},
      [`${root}/packages/dsh-fake/src/stray.ts`]: {},
    }),
  );
  // 产物必须比配置新，交叉断言才会执行（旧产物反映的是旧的面）
  const future = Date.now() / 1000 + 60;
  utimesSync(join(root, "coverage/coverage-final.json"), future, future);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /stray\.ts 出现在覆盖率产物里但不在当前 include 面内/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("本仓真实快照：面完整、无逃逸 → exit 0 且打印面计数", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /universe \d+ 文件 = include \d+ − exclude \d+ → 计分 \d+/);
  assert.match(r.stdout, /阈值键 lines\/functions\/statements\/branches/);
});

test("fail-closed：覆盖率配置不可读 → exit 2 且统一故障注解", () => {
  const root = fixture();
  writeFileSync(join(root, "scripts/data/coverage.config.json"), "{ invalid json");
  const r = run(root);
  assert.equal(r.status, 2, r.stderr);
  assert.match(
    r.stderr,
    /^::error::门禁故障（非判据结论）：verify-coverage-scope: 覆盖率配置不可读/m,
  );
  assert.equal(r.stdout, "");
});

test("fail-closed：缺 vitest.config.ts → exit 2 且统一故障注解", () => {
  const root = fixture();
  rmSync(join(root, "vitest.config.ts"));
  const r = run(root);
  assert.equal(r.status, 2, r.stderr);
  assert.match(
    r.stderr,
    /^::error::门禁故障（非判据结论）：verify-coverage-scope: 缺 vitest\.config\.ts/m,
  );
  assert.equal(r.stdout, "");
});

test("fail-closed：universe 为空 → exit 2 且统一故障注解", () => {
  const root = fixture();
  rmSync(join(root, "packages"), { recursive: true, force: true });
  rmSync(join(root, "shared"), { recursive: true, force: true });
  const r = run(root);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^::error::门禁故障（非判据结论）：verify-coverage-scope: universe 为空/m);
  assert.equal(r.stdout, "");
});

test("fail-closed：include 为空数组 → exit 2 且统一故障注解", () => {
  const r = run(fixture({ ...BASE_CONFIG, include: [] }));
  assert.equal(r.status, 2, r.stderr);
  assert.match(
    r.stderr,
    /^::error::门禁故障（非判据结论）：verify-coverage-scope: .*缺非空 include/m,
  );
  assert.equal(r.stdout, "");
});

test("CLI 三态：判红仍 exit 1 且无故障注解", () => {
  const r1 = run(
    fixture(BASE_CONFIG, {
      sourceFiles: [
        { rel: "packages/dsh-fake/src/a.ts", content: "export const a = 1\n" },
        { rel: "packages/dsh-fake/src/types.d.ts", content: "export type T = 1\n" },
        { rel: "shared/x.js", content: "export const x = 1\n" },
        { rel: "packages/dsh-fake/src/notify.ps1", content: "Write-Host hi\n" },
      ],
    }),
  );
  assert.equal(r1.status, 1, r1.stderr);
  assert.doesNotMatch(r1.stderr, /::error::门禁故障/);
  assert.match(r1.stderr, /既不在 include 也不在任何 exclude 条目里/);
});
