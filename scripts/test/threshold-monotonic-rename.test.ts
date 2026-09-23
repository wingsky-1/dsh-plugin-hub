#!/usr/bin/env node
/**
 * 包改名识别 v3 的 TDD 用例（直调纯函数，注入 readBase/readWorkspace，无 git/网络/时间）。
 *
 * 风格与 scripts/test/threshold-monotonic.test.ts 同源（最小声明表＋内存文件映射），
 * 但不用 gitFixture：改名识别是纯函数（compareRegistry＋applyRenameRecognition），
 * 基准/工作区两侧文本由 memRead 注入，目录结构由 packages/basePackages 数组注入，
 * 面并集证据由 faceCheck 注入（() => ({ ok }))。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compareRegistry } from "../lib/threshold-registry.mjs";
import { applyRenameRecognition } from "../gate/threshold-monotonic.mjs";

const GAUNTLET = "scripts/data/gauntlet.config.json";
const TOPOLOGY = "scripts/data/mutation-topology.json";

const guard = <T extends { id: string } & Record<string, unknown>>(fields: T) => ({
  why: "fixture 判据说明",
  hint: "fixture 修法提示",
  ...fields,
});

const THRESHOLD_GUARD = guard({
  id: "mutation.packageThreshold",
  kind: "value",
  sources: [GAUNTLET],
  paths: ["mutation.packages.*.threshold"],
  weaken: "decrease",
  onRemoval: "fail",
  minAllowed: 60,
});
const TIMEOUT_GUARD = guard({
  id: "mutation.timeoutMS",
  kind: "value",
  sources: [TOPOLOGY],
  paths: ["sharedDefaults.timeoutMS", "packages.*.timeoutMS"],
  weaken: "increase",
  onRemoval: "fail",
  maxAllowed: 60000,
  nonMonotonic: true,
});
const ANCHOR_GUARD = guard({
  id: "mutation.packageAnchor",
  kind: "baseline",
  sources: [GAUNTLET],
  paths: ["mutation.packages"],
  anchorFields: ["fixedCovered", "baselineCovered"],
  onRemoval: "fail",
});
const EXISTENCE_GUARD = guard({
  id: "mutation.packageSet",
  kind: "existence",
  sources: [GAUNTLET],
  paths: ["mutation.packages"],
  universe: { dir: "packages", prefix: "dsh-", requireDir: "src" },
  exemptFrom: { source: TOPOLOGY, path: "$noMutationPackages" },
  requireFields: ["fixedCovered", "baselineCovered"],
  exemptionGate: "threshold-registry",
});
const COVERAGE_GUARD = guard({
  id: "coverage.thresholds",
  kind: "value",
  sources: ["scripts/data/coverage.config.json"],
  paths: ["thresholds"],
  keys: ["lines", "functions", "statements", "branches"],
  weaken: "decrease",
  onRemoval: "fail",
  missingIsError: true,
});
const COVERAGE_CONFIG = "scripts/data/coverage.config.json";

const GUARDS = [THRESHOLD_GUARD, TIMEOUT_GUARD, ANCHOR_GUARD, EXISTENCE_GUARD];

const memRead =
  (files: Record<string, string>) =>
  (rel: string): string | null =>
    Object.hasOwn(files, rel) ? files[rel] : null;

const topologyDoc = (packages: Record<string, unknown>, shared: number = 60000) =>
  JSON.stringify({ sharedDefaults: { timeoutMS: shared }, packages });

const OLD = "dsh-old";
const NEW = "dsh-new";
const oldEntry = (overrides: Record<string, unknown> = {}) => ({
  threshold: 60,
  fixedCovered: 70,
  ...overrides,
});
const newEntry = (overrides: Record<string, unknown> = {}) => ({
  threshold: 60,
  fixedCovered: 70,
  ...overrides,
});
const oldTopoEntry = (overrides: Record<string, unknown> = {}) => ({
  timeoutMS: 60000,
  ...overrides,
});
const newTopoEntry = (overrides: Record<string, unknown> = {}) => ({
  timeoutMS: 60000,
  ...overrides,
});

/**
 * 跑一次「全量扫描＋改名识别」；exitCode 口径与 runThresholdMonotonic 的尾部分流一致
 *（envErrors→2，failures→1，否则 0），warning 断言看 adjusted.warnings。
 */
function runRenameCase({
  baseGauntlet,
  wsGauntlet,
  baseTopology,
  wsTopology,
  packages,
  basePackages,
  guards = GUARDS,
  exemptions = new Map(),
  faceOk = true,
  extraBaseFiles = {},
  extraWsFiles = {},
}: {
  baseGauntlet: unknown;
  wsGauntlet: unknown;
  baseTopology: unknown;
  wsTopology: unknown;
  packages: Array<{ name: string; dirs: string[] }>;
  basePackages: Array<{ name: string; dirs: string[] }>;
  guards?: Array<{ id: string } & Record<string, unknown>>;
  exemptions?: Map<string, unknown>;
  faceOk?: boolean;
  extraBaseFiles?: Record<string, string>;
  extraWsFiles?: Record<string, string>;
}) {
  // 用例可传对象或已 stringify 的文本（topologyDoc 返回文本），一律归一化为文本。
  const asText = (value: unknown): string =>
    typeof value === "string" ? value : JSON.stringify(value);
  const baseFiles = {
    [GAUNTLET]: asText(baseGauntlet),
    [TOPOLOGY]: asText(baseTopology),
    ...extraBaseFiles,
  };
  const wsFiles = {
    [GAUNTLET]: asText(wsGauntlet),
    [TOPOLOGY]: asText(wsTopology),
    ...extraWsFiles,
  };
  const registry = { guards };
  const readBase = memRead(baseFiles);
  const readWorkspace = memRead(wsFiles);
  const result = compareRegistry({
    registry,
    readBase,
    readWorkspace,
    textReaders: {},
    packages,
    exemptions,
  });
  const adjusted = applyRenameRecognition({
    registry,
    readBase,
    readWorkspace,
    textReaders: {},
    packages,
    basePackages,
    result,
    exemptions,
    faceCheck: () => ({ ok: faceOk }),
  });
  const exitCode = adjusted.envErrors.length > 0 ? 2 : adjusted.failures.length > 0 ? 1 : 0;
  return { result, adjusted, exitCode };
}

const baseGauntletOld = (overrides: Record<string, unknown> = {}) => ({
  mutation: { strict: true, packages: { [OLD]: oldEntry(overrides) } },
});
const wsGauntletNew = (overrides: Record<string, unknown> = {}) => ({
  mutation: { strict: true, packages: { [NEW]: newEntry(overrides) } },
});
const baseTopologyOld = (overrides: Record<string, unknown> = {}) =>
  topologyDoc({ [OLD]: oldTopoEntry(overrides) });
const wsTopologyNew = (overrides: Record<string, unknown> = {}) =>
  topologyDoc({ [NEW]: newTopoEntry(overrides) });
const pkgsNew = () => [{ name: NEW, dirs: ["src"] }];
const pkgsOld = () => [{ name: OLD, dirs: ["src"] }];

test("改名 v3 P1：同值搬迁绿＋恰好 1 具名警告（rename-pair＋新旧全路径＋值）", () => {
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: wsGauntletNew(),
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
  });
  assert.equal(r.exitCode, 0, "全量扫描只剩被配对的删叶，识别后应放行");
  assert.equal(r.adjusted.renamed, true);
  assert.equal(r.adjusted.warnings.length, 1, "改名警告恰好一条");
  const warn = r.adjusted.warnings[0];
  assert.match(warn, /rename-pair/, "警告具名");
  assert.ok(
    warn.includes("mutation.packages." + OLD + ".threshold") &&
      warn.includes("mutation.packages." + NEW + ".threshold"),
    "警告带 threshold 新旧全路径",
  );
  assert.ok(
    warn.includes("packages." + OLD + ".timeoutMS") &&
      warn.includes("packages." + NEW + ".timeoutMS"),
    "警告带 timeoutMS 新旧全路径",
  );
  assert.ok(warn.includes("60") && warn.includes("60000"), "警告带值");
});

test("改名 v3 P2：搬迁降值红（新阈值 60→50，放宽不可被改名洗白）", () => {
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: wsGauntletNew({ threshold: 50 }),
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
  });
  assert.equal(r.exitCode, 1, "降值是放宽，改名形状不得豁免");
  assert.equal(r.adjusted.renamed, false);
  assert.equal(r.adjusted.warnings.length, 0, "不认改名即无警告");
});

test("改名 v3 M1：多删多增红（两删一增，配对含糊即红）", () => {
  const base = {
    mutation: {
      strict: true,
      packages: { [OLD]: oldEntry(), "dsh-keep": oldEntry() },
    },
  };
  const ws = wsGauntletNew();
  const r = runRenameCase({
    baseGauntlet: base,
    wsGauntlet: ws,
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: [...pkgsOld(), { name: "dsh-keep", dirs: ["src"] }],
  });
  assert.equal(r.exitCode, 1, "同 guard 下两处删叶，只能抑制其中一处是含糊的");
  assert.equal(r.adjusted.renamed, false);
});

test("改名 v3 M1b：一删多增红（新增两个键同样含糊）", () => {
  const ws = {
    mutation: {
      strict: true,
      packages: { [NEW]: newEntry(), "dsh-extra": newEntry() },
    },
  };
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: ws,
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: [...pkgsNew(), { name: "dsh-extra", dirs: ["src"] }],
    basePackages: pkgsOld(),
  });
  assert.equal(r.exitCode, 1);
  assert.equal(r.adjusted.renamed, false);
});

test("改名 v3 M2：跨 guard 互串红（A  guard 删＋B guard 增不得配对）", () => {
  // threshold 守卫一删零增，timeoutMS 守卫零删一增（值相等也不许跨守卫配对）。
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: { mutation: { strict: true, packages: {} } },
    baseTopology: topologyDoc({ [OLD]: { timeoutMS: 60 } }),
    wsTopology: topologyDoc({ [OLD]: { timeoutMS: 60 }, [NEW]: { timeoutMS: 60 } }),
    packages: [{ name: OLD, dirs: ["README.md"] }],
    basePackages: [{ name: OLD, dirs: ["README.md"] }],
  });
  assert.equal(r.exitCode, 1, "删增落在不同守卫，不是改名");
  assert.equal(r.adjusted.renamed, false);
});

test("改名 v3 M3a：配对形但新阈值 59≠60 红（后置严格相等）", () => {
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: wsGauntletNew({ threshold: 59 }),
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
  });
  assert.equal(r.exitCode, 1, "阈值 60→59 即使只差 1 也是放宽（且低于下限）");
  assert.equal(r.adjusted.renamed, false);
});

test("改名 v3 M3b：配对形但新 timeoutMS 60001 超上限红", () => {
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: wsGauntletNew(),
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew({ timeoutMS: 60001 })),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
  });
  assert.equal(r.exitCode, 1, "新叶重过 maxAllowed 全量，不因配对短路");
  assert.equal(r.adjusted.renamed, false);
});

test('改名 v3 M3c：新阈值是字符串 "60" 红（非数字不进 numericLeaves）', () => {
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: wsGauntletNew({ threshold: "60" }),
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
  });
  assert.equal(r.exitCode, 1, '字符串 "60" 与数字 60 不 strict===');
  assert.equal(r.adjusted.renamed, false);
});

test("改名 v3 M4a：仅大小写差异的搬迁红（dsh-old→DSH-OLD 不是改名）", () => {
  const upper = "DSH-OLD";
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: {
      mutation: { strict: true, packages: { [upper]: newEntry() } },
    },
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: topologyDoc({ [upper]: newTopoEntry() }),
    packages: [{ name: upper, dirs: ["src"] }],
    basePackages: pkgsOld(),
  });
  assert.equal(r.exitCode, 1, "大小写-only 差异不认作改名（大小写敏感）");
  assert.equal(r.adjusted.renamed, false);
});

test("改名 v3 M4b：双模板串模板红（删 sharedDefaults、增 packages.* 不得配对）", () => {
  // threshold 守卫两侧各补 dsh-x 同值条目以保持干净，只让 timeoutMS 守卫跨模板。
  const r = runRenameCase({
    baseGauntlet: {
      mutation: {
        strict: true,
        packages: { [OLD]: oldEntry(), "dsh-x": oldEntry() },
      },
    },
    wsGauntlet: {
      mutation: {
        strict: true,
        packages: { [NEW]: newEntry(), "dsh-x": newEntry() },
      },
    },
    baseTopology: topologyDoc({ "dsh-x": oldTopoEntry() }, 60000),
    wsTopology: JSON.stringify({
      sharedDefaults: {},
      packages: { "dsh-x": newTopoEntry(), [NEW]: newTopoEntry() },
    }),
    packages: [...pkgsNew(), { name: "dsh-x", dirs: ["src"] }],
    basePackages: [...pkgsOld(), { name: "dsh-x", dirs: ["src"] }],
  });
  assert.equal(r.exitCode, 1, "删的是 sharedDefaults 模板，增的是 packages.* 模板");
  assert.equal(r.adjusted.renamed, false);
});

test("改名 v3 M5a：#removal 豁免零交互（登记了也不改变改名结局）", () => {
  const exemptions = new Map([
    ["mutation.packages." + OLD + ".threshold#removal", { reason: "fixture" }],
  ]);
  const withEx = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: wsGauntletNew(),
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
    exemptions,
  });
  const withoutEx = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: wsGauntletNew(),
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
  });
  for (const r of [withEx, withoutEx]) {
    assert.equal(r.exitCode, 0);
    assert.equal(r.adjusted.renamed, true);
    assert.equal(r.adjusted.warnings.length, 1);
  }
  assert.equal(
    withEx.adjusted.warnings[0],
    withoutEx.adjusted.warnings[0],
    "豁免不改变警告内容：警告不消费 #removal",
  );
});

test("改名 v3 M5b：旧目录残留腐烂红（表已搬迁、旧目录仍在）", () => {
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: wsGauntletNew(),
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: [...pkgsNew(), ...pkgsOld()],
    basePackages: pkgsOld(),
  });
  assert.equal(r.exitCode, 1, "旧目录未消失：existence 判红，不得被改名抑制");
  assert.equal(r.adjusted.renamed, false);
});

test("改名 v3 M5c：旧键残留腐烂红（新旧键同时留在表里）", () => {
  const ws = {
    mutation: {
      strict: true,
      packages: { [OLD]: oldEntry(), [NEW]: newEntry() },
    },
  };
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: ws,
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
  });
  assert.equal(r.exitCode, 1, "旧键未删：反向悬空检查判红");
  assert.equal(r.adjusted.renamed, false);
});

test("改名 v3：跨键降锚红（阈值同值、fixedCovered 70→50）", () => {
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: wsGauntletNew({ fixedCovered: 50 }),
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
  });
  assert.equal(r.exitCode, 1, "改名包生效锚降低即红（锚同治）");
  assert.equal(r.adjusted.renamed, false);
});

test("改名 v3：面并集不绿则改红（faceCheck false 即使搬迁干净也红）", () => {
  const baseFiles = {
    [GAUNTLET]: JSON.stringify(baseGauntletOld()),
    [TOPOLOGY]: baseTopologyOld(),
  };
  const wsFiles = {
    [GAUNTLET]: JSON.stringify(wsGauntletNew()),
    [TOPOLOGY]: wsTopologyNew(),
  };
  const registry = { guards: GUARDS };
  const readBase = memRead(baseFiles);
  const readWorkspace = memRead(wsFiles);
  const result = compareRegistry({
    registry,
    readBase,
    readWorkspace,
    textReaders: {},
    packages: pkgsNew(),
    exemptions: new Map(),
  });
  const adjusted = applyRenameRecognition({
    registry,
    readBase,
    readWorkspace,
    textReaders: {},
    packages: pkgsNew(),
    basePackages: pkgsOld(),
    result,
    faceCheck: () => ({ ok: false, detail: "fixture：面并集收缩" }),
  });
  assert.equal(adjusted.renamed, false, "existence 与面并集须双绿");
  assert.equal(adjusted.warnings.length, 0);
  const exitCode = adjusted.envErrors.length > 0 ? 2 : adjusted.failures.length > 0 ? 1 : 0;
  assert.equal(exitCode, 1, "原删叶失败照旧判红");
});

test("改名 v3：missingIsError 不被短路（他 guard 的 envError 照样 exit 2）", () => {
  const guards = [...GUARDS, COVERAGE_GUARD];
  const r = runRenameCase({
    baseGauntlet: baseGauntletOld(),
    wsGauntlet: wsGauntletNew(),
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
    guards,
    extraBaseFiles: {
      [COVERAGE_CONFIG]: JSON.stringify({
        thresholds: { lines: 80, functions: 80, statements: 78, branches: 70 },
      }),
    },
    extraWsFiles: {
      [COVERAGE_CONFIG]: JSON.stringify({ thresholds: {} }),
    },
  });
  assert.equal(r.exitCode, 2, "覆盖率阈值整块消失是 fail-closed，不因改名放行");
  assert.equal(r.adjusted.renamed, false);
});

test("改名 v3 R1a：无锚新包＋#anchor 豁免仍绿（显式断言走同一豁免通道）", () => {
  // 基准旧包同样无锚（锚同治无从比较即跳过），新包锚缺口由台账 #anchor 豁免。
  const noAnchor = { threshold: 60 };
  const exemptions = new Map([
    ["mutation.packages." + NEW + "#anchor", { reason: "fixture：锚点待夜间班回填" }],
  ]);
  const r = runRenameCase({
    baseGauntlet: { mutation: { strict: true, packages: { [OLD]: { ...noAnchor } } } },
    wsGauntlet: { mutation: { strict: true, packages: { [NEW]: { ...noAnchor } } } },
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
    exemptions,
  });
  assert.equal(r.exitCode, 0, "豁免覆盖的锚缺口不得被显式断言误杀");
  assert.equal(r.adjusted.renamed, true);
  assert.equal(r.adjusted.warnings.length, 1);
});

test("改名 v3 R1b：无锚新包、无豁免仍红（显式断言与隐含覆盖同结论）", () => {
  const noAnchor = { threshold: 60 };
  const r = runRenameCase({
    baseGauntlet: { mutation: { strict: true, packages: { [OLD]: { ...noAnchor } } } },
    wsGauntlet: { mutation: { strict: true, packages: { [NEW]: { ...noAnchor } } } },
    baseTopology: JSON.parse(baseTopologyOld()),
    wsTopology: JSON.parse(wsTopologyNew()),
    packages: pkgsNew(),
    basePackages: pkgsOld(),
  });
  assert.equal(r.exitCode, 1, "新包无锚且无豁免：existence 判红，改名不认");
  assert.equal(r.adjusted.renamed, false);
});
