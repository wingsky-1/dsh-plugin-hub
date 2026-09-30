#!/usr/bin/env node
"use strict";

/**
 * verify-dir-imports #767 B0 切片 3a 判据回归：I2① 域间值边 / I2④ 值引组合根 / §5.3 client 侧
 * import 面。
 *
 * 为什么存在：这三条判据此前**没有执法点**（方案 §0.1 第 5 条：leafValueEdges 是可合法上升的
 * 结构型计数、--graph 只打印矩阵）。新造的执法点必须双向可证——只靠真实仓跑出 PASS 无法证明
 * 判红有效，何况三类新证据在真实仓里「有存量」与「全零」都存在（mcp 33 条 / notifier 0 条），
 * 光看 PASS 分不清「判据生效」与「断言空转」。故每条判据一组正反 fixture：
 *   - 干净形态判绿，且**入库的存量集合为空**；
 *   - 人为造一条越界边判红，并逐条点名校验证据项与判词；
 *   - 存量登记后**再**新增同类边仍判红（防「写基线洗白」）。
 * client 判据（§5.3）额外钉「独立一遍扫描」：往 client 子树里塞值引**不得**改动任何一个既有
 * 结构型计数（modules / scannedSrcFiles / leafValueEdges / fileValueEdges / crossModuleRefs），
 * 否则各包既有基线会整体位移——这正是实现约束里的第一句。
 *
 * fixture 经 VERIFY_DIR_IMPORTS_ROOT 指向 mkdtemp 隔离目录（基线路径随根推导），不在仓库内造
 * 包目录（产物零污染纪律）。
 *
 * #767 B1.0 判据加固补一组「裸包名自引用」用例：I8① 原先只认相对说明符，而 \`import "<本包名>"\`
 * 经各包 \`exports["."]\` 同样解析到产物面 \`lib/index.js\`——换个写法就能够到禁止面却零证据。
 * 加固的核心属性是**证据 id 归一**：同一处违规的裸写法与相对写法必须落成同一条证据串，
 * 否则改写法即可绕开单调基线（或凭空多出一条「新增证据」）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "gate", "verify-dir-imports.mjs");
const PKG = "fixture-pkg";
const SRC = "packages/" + PKG + "/src";
const PKG_NAME = "@wingsky-1/fixture-pkg";
const MANIFEST_REL = "packages/" + PKG + "/package.json";
const TOPOLOGY_REL = "scripts/data/mutation-topology.json";

/** `$testLayers` 的 fixture 形态（与 scripts/data/mutation-topology.json 同形）。
 *
 * 为什么要它：批次二项 2 起，本闸的**两处层目录**（I8① 单元层、client 族层）都从这份声明
 * 派生，缺 `$testLayers` 即 fail-closed 判红。fixture 必须带着它，否则被验证的行为会被
 * 「派生失败」盖住——这正是 fail-closed 的代价，如实承担。
 */
const FIXTURE_TEST_LAYERS = {
  layerMeta: {
    unit: {
      assertionTarget: "src",
      environment: "node",
      mandatory: true,
      responsibility: "单模块判据",
    },
    integration: {
      assertionTarget: "src",
      environment: "node",
      mandatory: false,
      responsibility: "真实组合根判据",
    },
    "client-unit": {
      assertionTarget: "src",
      environment: "node",
      mandatory: false,
      responsibility: "客户端纯逻辑判据",
    },
    bundle: {
      assertionTarget: "artifact",
      environment: "node",
      mandatory: false,
      responsibility: "产物形态断言",
    },
    e2e: {
      assertionTarget: "live",
      environment: "node",
      mandatory: false,
      responsibility: "大 smoke",
    },
  },
  layers: {
    unit: "test/unit/**/*.test.ts",
    integration: "test/integration/**/*.test.ts",
    "client-unit": "test/client-unit/**/*.test.ts",
    bundle: "test/bundle/**/*.test.ts",
    e2e: "test/e2e/**/*.test.ts",
  },
};
/** fixture 默认拓扑：本包 src 全量入 mutate（client 排除），使覆盖断言不引入额外噪声。 */
function defaultTopology() {
  return JSON.stringify({
    sharedDefaults: {},
    $testLayers: FIXTURE_TEST_LAYERS,
    packages: {
      [PKG]: {
        segments: {
          s1: { mutate: [SRC + "/**/*.ts"], excludes: ["!" + SRC + "/client/**"] },
        },
      },
    },
  });
}

/**
 * 在隔离根下造 fixture（含变异拓扑事实源与本包 package.json），返回根路径（调用方负责清理）。
 * package.json 是 I8① 裸自引用面的唯一包名来源（#767 B1.0）——真实包是 pnpm workspace 成员、
 * 必然带着它，fixture 也必须带着，否则被验证的行为会被「包名读不到」盖住。
 */
function makeFixtureRoot(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "verify-dir-imports-criteria-"));
  const manifest = JSON.stringify({
    name: PKG_NAME,
    version: "0.0.0",
    type: "module",
    exports: { ".": { types: "./lib/index.d.ts", default: "./lib/index.js" } },
  });
  for (const [rel, content] of Object.entries({
    [TOPOLOGY_REL]: defaultTopology(),
    [MANIFEST_REL]: manifest,
    ...files,
  })) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** 对 fixture 根跑脚本，返回 { status, out }。 */
function runOn(root: string, args: string[] = []) {
  const env: Record<string, string | undefined> = { ...process.env, VERIFY_DIR_IMPORTS_ROOT: root };
  // 外部若设了基线路径，会与 fixture 自己的基线串味（残留风险），显式清掉。
  delete env.VERIFY_DIR_IMPORTS_BASELINE;
  const r = spawnSync(process.execPath, [SCRIPT, "--package", PKG, ...args], {
    env,
    encoding: "utf8",
  });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** 读 fixture 根下入库的基线。 */
function fixtureBaseline(root: string) {
  return JSON.parse(readFileSync(join(root, "scripts/data/dir-imports-baseline.json"), "utf8"));
}

/** 本包入库后的质量证据段。 */
function qualityOf(root: string) {
  return fixtureBaseline(root).packages[PKG].quality;
}

/** 生成一份 fixture 台账（§5.3 的存量处置形态：gate=verify-dir-imports，path=<包名>:<证据项>）。 */
function writeLedger(dir: string, paths: string[]) {
  const p = join(dir, "exemptions-fixture.json");
  writeFileSync(
    p,
    JSON.stringify({
      exemptions: paths.map((path) => ({
        gate: "verify-dir-imports",
        path,
        reason: "用例：登记存量证据",
        trackingIssue: "#999",
      })),
    }),
  );
  return p;
}

/** 从「写基线中止」输出里取出待登记的台账键（形态 \`<包名>:<证据项>（<指标>）\`）。 */
function pendingLedgerKeys(out: string) {
  return [...out.matchAll(/^\s+(\S+?)（/gm)].map((m) => m[1]);
}

/** I2① 正例体：全部跨模块值边都指向共享层（包内 \`shared/\` 与 \`server/shared/\`）。 */
function i2CleanFixture() {
  return {
    [SRC + "/shared/interface.ts"]: 'export { S } from "./impl.ts";\n',
    [SRC + "/shared/impl.ts"]: "export const S = 1;\n",
    [SRC + "/server/shared/interface.ts"]: 'export { T } from "./impl.ts";\n',
    [SRC + "/server/shared/impl.ts"]: "export const T = 2;\n",
    [SRC + "/a/interface.ts"]: 'export { A } from "./impl.ts";\n',
    [SRC + "/a/impl.ts"]: 'import { S } from "../shared/interface.ts";\nexport const A = S;\n',
    [SRC + "/b/interface.ts"]: 'export { B } from "./impl.ts";\n',
    [SRC + "/b/impl.ts"]:
      'import { T } from "../server/shared/interface.ts";\nexport const B = T;\n',
  };
}

/** I2④ 底座：src 根 index.ts 存在，域 a 默认**不引**它。 */
function rootIndexFixture(implBody: string) {
  return {
    [SRC + "/index.ts"]: 'export const ROOT = "组合根";\n',
    [SRC + "/a/interface.ts"]: 'export { A } from "./impl.ts";\n',
    [SRC + "/a/impl.ts"]: implBody,
  };
}

/** §5.3 底座：client 只引 \`src/shared\` 与 \`src/client\`（合法面），server 侧另有一个文件。 */
function clientFixture(extra = {}) {
  return {
    [SRC + "/shared/interface.ts"]: 'export { S } from "./impl.ts";\n',
    [SRC + "/shared/impl.ts"]: "export const S = 1;\n",
    [SRC + "/server/channels/x.ts"]: "export const X = 1;\n",
    [SRC + "/a/interface.ts"]: 'export { A } from "./impl.ts";\n',
    [SRC + "/a/impl.ts"]: 'import { S } from "../shared/interface.ts";\nexport const A = S;\n',
    [SRC + "/client/index.ts"]: 'export { render } from "./render.ts";\n',
    [SRC + "/client/render.ts"]:
      'import { S } from "../shared/interface.ts";\nimport { helper } from "./helper.ts";\nexport const render = S + helper;\n',
    [SRC + "/client/helper.ts"]: "export const helper = 1;\n",
    ...extra,
  };
}

test("I2①：目标全为共享层的值边判绿（存量集合为空）；一条域间值边即刻 fail-closed 判红", () => {
  const clean = makeFixtureRoot(i2CleanFixture());
  const dirty = makeFixtureRoot({
    ...i2CleanFixture(),
    [SRC + "/b/impl.ts"]: 'import { A } from "../a/interface.ts";\nexport const B = A;\n',
  });
  try {
    // 正例：存量集合为空即判绿——判据读的是「目标非共享层」这个集合，不是值边总数
    // （该 fixture 有 2 条值边、全部指向共享层，正是 notifier 终态的形态）。
    // D15 起无基线自身判红，故先登记空集合再判定。
    assert.equal(runOn(clean, ["--write-baseline"]).status, 0, "空集合登记应成功");
    const green = runOn(clean);
    assert.equal(
      green.status,
      0,
      "共享层值边应判绿（exit 0），实际 " + green.status + "：\n" + green.out,
    );
    assert.match(green.out, /叶子模块 4 个、值边 2 条/, "应报 4 模块 / 2 值边：\n" + green.out);
    assert.match(
      green.out,
      /域间值边（I2①，目标非共享层）0 条/,
      "共享层值边不得计入 I2①：\n" + green.out,
    );
    // 写基线后入库的存量集合为空（不是「登记了就不管」），且仍判绿。
    assert.equal(runOn(clean, ["--write-baseline"]).status, 0);
    assert.deepEqual(qualityOf(clean).crossDomainValueEdges, [], "干净形态的存量集合必须为空");
    assert.equal(runOn(clean).status, 0, "登记空集合后仍应判绿");

    // 反例：b → a 一条域间值边。无基线时由 fail-closed 面判红。
    const red = runOn(dirty);
    assert.equal(red.status, 1, "域间值边应判红（exit 1），实际 " + red.status + "：\n" + red.out);
    assert.match(
      red.out,
      /无基线 fail-closed：域间值边（目标非共享层） 1 个/,
      "应点名 I2① 的 fail-closed：\n" + red.out,
    );
    // --graph 明细须给出这条边（判据不是只活在一句计数里）。
    const graphed = runOn(dirty, ["--graph"]);
    assert.match(
      graphed.out,
      /域间值边（I2①，目标非共享层的叶子模块值边，只许缩小）：1 条/,
      "graph 应报 1 条：\n" + graphed.out,
    );
    assert.match(graphed.out, /^ {4}b\|a$/m, "graph 应列出 b|a 这条边：\n" + graphed.out);
  } finally {
    rmSync(clean, { recursive: true, force: true });
    rmSync(dirty, { recursive: true, force: true });
  }
});

test("I2①：存量登记后新增一条域间值边仍判红，且 --write-baseline 不得洗白", () => {
  const root = makeFixtureRoot(i2CleanFixture());
  try {
    assert.equal(runOn(root, ["--write-baseline"]).status, 0);
    assert.equal(runOn(root).status, 0, "存量登记后应判绿");
    writeFileSync(
      join(root, SRC + "/b/impl.ts"),
      'import { A } from "../a/interface.ts";\nexport const B = A;\n',
    );
    const after = runOn(root);
    assert.equal(after.status, 1, "新增域间值边应判红，实际 " + after.status + "：\n" + after.out);
    assert.match(
      after.out,
      /\[质量型\] crossDomainValueEdges: 新增未登记证据 b\|a/,
      "应点名新增证据与类：\n" + after.out,
    );
    const refused = runOn(root, ["--write-baseline"]);
    assert.equal(
      refused.status,
      1,
      "未登记的新增证据不得写入，实际 " + refused.status + "：\n" + refused.out,
    );
    assert.match(
      refused.out,
      /写基线中止：存在未登记的新增质量证据/,
      "应报中止原因：\n" + refused.out,
    );
    assert.ok(
      pendingLedgerKeys(refused.out).includes(PKG + ":b|a"),
      "待登记台账键应为 <包名>:<证据项>：\n" + refused.out,
    );
    assert.deepEqual(qualityOf(root).crossDomainValueEdges, [], "中止即不落盘：存量集合保持为空");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I2④：无基线时值引 src 根 index.ts 判红（此前只在成环时才可见）；import type 不误伤", () => {
  const clean = makeFixtureRoot(rootIndexFixture("export const A = 1;\n"));
  const value = makeFixtureRoot(
    rootIndexFixture('import { ROOT } from "../index.ts";\nexport const A = ROOT;\n'),
  );
  const typed = makeFixtureRoot(
    rootIndexFixture('import type { ROOT } from "../index.ts";\nexport const A = 1;\n'),
  );
  try {
    assert.equal(runOn(clean, ["--write-baseline"]).status, 0, "空集合登记应成功");
    const ok = runOn(clean);
    assert.equal(ok.status, 0, "不引组合根应判绿，实际 " + ok.status + "：\n" + ok.out);
    assert.match(ok.out, /值引 src 根 index.ts（I2④）0 条/, "应报 0 条：\n" + ok.out);

    // 反例：域内文件值引组合根。根文件不回引，故不会构成文件级值环——这正是「今天没有执法点」的
    // 形态：旧口径下这条引用既不违规也看不见。
    const red = runOn(value);
    assert.equal(red.status, 1, "值引组合根应判红，实际 " + red.status + "：\n" + red.out);
    assert.match(
      red.out,
      /无基线 fail-closed：值引 src 根 index\.ts 1 个/,
      "应点名 I2④ 的 fail-closed：\n" + red.out,
    );
    // 红因隔离：目标在 src 根，规则 1/2 本就不适用，故不得出现跨模块直引判词。
    assert.doesNotMatch(red.out, /跨模块引用必须走/, "I2④ 的红因不得被规则 2 代偿：\n" + red.out);
    const graphed = runOn(value, ["--graph"]);
    assert.match(
      graphed.out,
      /值引 src 根 index\.ts（I2④，域取组合根常量即文件级值环）：1 条/,
      "graph 应报 1 条：\n" + graphed.out,
    );
    assert.match(
      graphed.out,
      /^ {4}a\/impl\.ts\|index\.ts$/m,
      "graph 应列出来源文件：\n" + graphed.out,
    );

    // 精度：\`import type\` 编译期擦除，不入 fileValueEdges 面，故不得误伤。
    assert.equal(runOn(typed, ["--write-baseline"]).status, 0, "空集合登记应成功");
    const typeOnly = runOn(typed);
    assert.equal(
      typeOnly.status,
      0,
      "import type 不得判红，实际 " + typeOnly.status + "：\n" + typeOnly.out,
    );
    assert.match(
      typeOnly.out,
      /值引 src 根 index\.ts（I2④）0 条/,
      "类型引用不得计入：\n" + typeOnly.out,
    );
  } finally {
    rmSync(clean, { recursive: true, force: true });
    rmSync(value, { recursive: true, force: true });
    rmSync(typed, { recursive: true, force: true });
  }
});

test("I2④：存量登记后新增值引仍判红", () => {
  const root = makeFixtureRoot(rootIndexFixture("export const A = 1;\n"));
  try {
    assert.equal(runOn(root, ["--write-baseline"]).status, 0);
    assert.deepEqual(qualityOf(root).rootIndexImports, [], "干净形态的存量集合必须为空");
    writeFileSync(
      join(root, SRC + "/a/impl.ts"),
      'import { ROOT } from "../index.ts";\nexport const A = ROOT;\n',
    );
    const after = runOn(root);
    assert.equal(after.status, 1, "新增值引应判红，实际 " + after.status + "：\n" + after.out);
    assert.match(
      after.out,
      /\[质量型\] rootIndexImports: 新增未登记证据 a\/impl\.ts\|index\.ts/,
      "应点名新增证据与类：\n" + after.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("§5.3：client 子树独立扫描——加进 client 的值引不得改动任何既有结构型计数", () => {
  const withClient = makeFixtureRoot(clientFixture());
  const withoutClient = makeFixtureRoot(
    Object.fromEntries(
      Object.entries(clientFixture()).filter(([k]) => !k.includes("/client/")),
    ) as Record<string, string>,
  );
  try {
    assert.equal(runOn(withoutClient, ["--write-baseline"]).status, 0);
    assert.equal(runOn(withClient, ["--write-baseline"]).status, 0);
    const before = fixtureBaseline(withoutClient).packages[PKG];
    const after = fixtureBaseline(withClient).packages[PKG];
    for (const key of [
      "modules",
      "scannedSrcFiles",
      "interfaceFacades",
      "leafValueEdges",
      "fileValueEdges",
      "crossModuleRefs",
    ]) {
      assert.equal(
        after[key],
        before[key],
        key + " 因 client 子树位移了（" + before[key] + " → " + after[key] + "）——独立扫描被破坏",
      );
    }
    assert.equal(
      after.allSrcTsFiles - before.allSrcTsFiles,
      3,
      "client 下 3 个文件应仍计入 allSrcTsFiles（只是不入判据面）",
    );
    assert.deepEqual(after.quality.clientServerImports, [], "合法 client 引面不得产生证据");
    assert.deepEqual(after.quality.crossDomainValueEdges, [], "client 引面不得混入 I2①");

    const green = runOn(withClient);
    assert.equal(
      green.status,
      0,
      "client 只引 src/shared 与 src/client 应判绿，实际 " + green.status + "：\n" + green.out,
    );
    assert.match(
      green.out,
      /client → src\/server import（§5\.3）0 条/,
      "应报 0 条：\n" + green.out,
    );
  } finally {
    rmSync(withClient, { recursive: true, force: true });
    rmSync(withoutClient, { recursive: true, force: true });
  }
});

test("§5.3：client → src/server 判红（普通 import 与 import type 都判），登记台账后放行", () => {
  const root = makeFixtureRoot(clientFixture());
  try {
    assert.equal(runOn(root, ["--write-baseline"]).status, 0);
    assert.deepEqual(qualityOf(root).clientServerImports, []);
    assert.equal(runOn(root).status, 0, "合法引面应判绿");

    // 反例 1：普通 import（对应 notifier 的 client/capabilities.ts 存量形态）。
    writeFileSync(
      join(root, SRC + "/client/capabilities.ts"),
      'import { X } from "../server/channels/x.ts";\nexport const C = X;\n',
    );
    const red = runOn(root);
    assert.equal(
      red.status,
      1,
      "client → src/server 应判红，实际 " + red.status + "：\n" + red.out,
    );
    const edge = "src/client/capabilities.ts|src/server/channels/x.ts";
    assert.match(
      red.out,
      /\[质量型\] clientServerImports: 新增未登记证据 src\/client\/capabilities\.ts\|src\/server\/channels\/x\.ts/,
      "应点名新增证据与类：\n" + red.out,
    );
    const refused = runOn(root, ["--write-baseline"]);
    assert.equal(
      refused.status,
      1,
      "未登记不得写入，实际 " + refused.status + "：\n" + refused.out,
    );
    assert.ok(
      pendingLedgerKeys(refused.out).includes(PKG + ":" + edge),
      "台账键应为 <包名>:src/client/…|src/server/…：\n" + refused.out,
    );

    // 反例 2：import type 同样判红——判据是 client 的 **import 面**，不分值与类型（参照包的
    // 两条存量里恰好一条就是 import type）。
    writeFileSync(
      join(root, SRC + "/client/capabilities.ts"),
      'import type { X } from "../server/channels/x.ts";\nexport const C = 1;\n',
    );
    const typeRed = runOn(root);
    assert.equal(
      typeRed.status,
      1,
      "import type 同样应判红，实际 " + typeRed.status + "：\n" + typeRed.out,
    );
    assert.match(
      typeRed.out,
      /\[质量型\] clientServerImports: 新增未登记证据 src\/client\/capabilities\.ts\|src\/server\/channels\/x\.ts/,
      "类型边也应点名为同一条证据：\n" + typeRed.out,
    );

    // 台账通道（§5.3 的存量处置）：登记后写入成功、证据入库、判绿。
    const ledger = writeLedger(root, [PKG + ":" + edge]);
    const accepted = runOn(root, ["--write-baseline", "--exemptions", ledger]);
    assert.equal(accepted.status, 0, "按台账登记后应写入成功：\n" + accepted.out);
    assert.deepEqual(qualityOf(root).clientServerImports, [edge], "证据应入库：\n" + accepted.out);
    assert.equal(runOn(root, ["--exemptions", ledger]).status, 0, "登记后应判绿");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * I8① 底座（#767 B0 切片 3b）：src 有域 a、共享层、客户端与组合根；test/unit/a/impl.test.ts
 * 默认只直连本域 impl（合规）。另两层目录刻意一并造出来——判据必须只认 test/unit/**，
 * test/e2e/** 与 test/integration/** 引组合根是合法形态（I8 判据的 ②③ 本轮不上线）。
 */
function unitFaceFixture(extra = {}) {
  const pkg = "packages/" + PKG;
  return {
    [SRC + "/index.ts"]: 'export const ROOT = "组合根";\n',
    [SRC + "/shared/interface.ts"]: 'export { S } from "./impl.ts";\n',
    [SRC + "/shared/impl.ts"]: "export const S = 1;\n",
    [SRC + "/a/interface.ts"]: 'export { A } from "./impl.ts";\n',
    [SRC + "/a/impl.ts"]: "export const A = 1;\n",
    [SRC + "/client/index.ts"]: "export const render = 1;\n",
    [pkg + "/test/unit/a/impl.test.ts"]:
      'import { A } from "../../../src/a/impl.ts";\nexport const t = A;\n',
    ...extra,
  };
}

/** I8① 的三类越界面：[证据目标, 相对单元测试文件的导入说明符]。 */
const UNIT_FACE_BREACHES = [
  ["src/index.ts", "../../../src/index.ts"],
  ["lib/index.js", "../../../lib/index.js"],
  ["src/client/index.ts", "../../../src/client/index.ts"],
];

const UNIT_TEST_FILE = "packages/" + PKG + "/test/unit/a/impl.test.ts";

/** 断言一行在输出里逐字出现（路径类断言不用正则，免得转义盖过判据本身）。 */
function assertLine(out: string, line: string) {
  assert.ok(out.split("\n").includes(line), "输出缺少行 " + JSON.stringify(line) + "：\n" + out);
}

test("I8①：test/unit 只直连本域 impl 判绿；test/helpers、test/e2e、test/integration 显式放行", () => {
  const pkg = "packages/" + PKG;
  // 三处引组合根的**面外**文件：基础设施（test/helpers.ts）与另两层（e2e / integration）。
  // 它们若被判红，说明判据越过了「只对 test/unit/** 生效」这条口径。
  const root = makeFixtureRoot(
    unitFaceFixture({
      [pkg + "/test/helpers.ts"]:
        'import { ROOT } from "../../src/index.ts";\nexport const h = ROOT;\n',
      [pkg + "/test/e2e/smoke.test.ts"]:
        'import { ROOT } from "../../../src/index.ts";\nexport const e = ROOT;\n',
      [pkg + "/test/integration/flow.test.ts"]:
        'import { ROOT } from "../../../src/index.ts";\nexport const i = ROOT;\n',
    }),
  );
  try {
    // D15 起无基线自身判红：先登记空集合（本 fixture 合规无存量）再判定。
    assert.equal(runOn(root, ["--write-baseline"]).status, 0, "空集合登记应成功");
    const green = runOn(root);
    assert.equal(green.status, 0, "合规单元测试应判绿，实际 " + green.status + "：\n" + green.out);
    assert.match(
      green.out,
      /单元层导入面越界（I8①，test\/unit → src\/index\.ts \/ lib \/ src\/client）0 条/,
      "面外的三层引用不得计入：\n" + green.out,
    );
    // 写基线入库的存量集合为空（不是「登记了就不管」），且仍判绿。
    assert.deepEqual(qualityOf(root).unitImportFaceViolations, [], "干净形态的存量集合必须为空");
    assert.equal(runOn(root).status, 0, "登记空集合后仍应判绿");
    const graphed = runOn(root, ["--graph"]);
    assert.match(
      graphed.out,
      /单元层导入面（I8①，[^\n]*）：0 条/,
      "graph 也应报 0 条：\n" + graphed.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I8①：test/unit 引组合根 / lib / 客户端三面各自判红（无基线 fail-closed + graph 明细）", () => {
  for (const [face, spec] of UNIT_FACE_BREACHES) {
    const root = makeFixtureRoot(
      unitFaceFixture({ [UNIT_TEST_FILE]: 'import "' + spec + '";\nexport const t = 1;\n' }),
    );
    try {
      // 判据不认包名（fixture-pkg 不在任何范围登记里），随 --package 的调用面走。
      const red = runOn(root);
      assert.equal(
        red.status,
        1,
        "test/unit → " + face + " 应判红，实际 " + red.status + "：\n" + red.out,
      );
      assert.match(
        red.out,
        /无基线 fail-closed：单元层导入面越界（test\/unit → src\/index\.ts \/ lib \/ src\/client） 1 个/,
        "应点名 I8① 的 fail-closed：\n" + red.out,
      );
      // 判据不是只活在一句计数里：--graph 必须给出这条证据（含被引目标原样）。
      const graphed = runOn(root, ["--graph"]);
      assert.match(
        graphed.out,
        /单元层导入面（I8①，[^\n]*）：1 条/,
        "graph 应报 1 条：\n" + graphed.out,
      );
      assertLine(graphed.out, "    test/unit/a/impl.test.ts|" + face);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/** 从 --graph 输出里取出 I8① 那一节的证据项（形态 `test/unit/…|目标`）；无该节返回 null。 */
function unitFaceEvidence(out: string) {
  const lines = out.split("\n");
  const head = lines.findIndex((l) => l.includes("单元层导入面（I8①，test/unit 引组合根"));
  if (head === -1) return null;
  const items = [];
  for (const line of lines.slice(head + 1)) {
    const m = line.match(/^ {4}(test\/unit\/\S+)$/);
    if (m === null) break;
    items.push(m[1]);
  }
  return items;
}

test("I8①：存量登记后新增同类越界仍判红，写基线中止；登记台账后才放行", () => {
  const root = makeFixtureRoot(unitFaceFixture());
  const evidence = "test/unit/a/impl.test.ts|src/index.ts";
  try {
    assert.equal(runOn(root, ["--write-baseline"]).status, 0);
    assert.deepEqual(qualityOf(root).unitImportFaceViolations, []);
    assert.equal(runOn(root).status, 0, "存量登记后应判绿");
    writeFileSync(
      join(root, UNIT_TEST_FILE),
      'import { ROOT } from "../../../src/index.ts";\nexport const t = ROOT;\n',
    );
    const after = runOn(root);
    assert.equal(after.status, 1, "新增越界应判红，实际 " + after.status + "：\n" + after.out);
    assert.match(
      after.out,
      /\[质量型\] unitImportFaceViolations: 新增未登记证据 test\/unit\/a\/impl\.test\.ts\|src\/index\.ts/,
      "应点名新增证据与类：\n" + after.out,
    );
    const refused = runOn(root, ["--write-baseline"]);
    assert.equal(
      refused.status,
      1,
      "未登记不得写入，实际 " + refused.status + "：\n" + refused.out,
    );
    assert.ok(
      pendingLedgerKeys(refused.out).includes(PKG + ":" + evidence),
      "台账键应为 <包名>:<证据项>：\n" + refused.out,
    );
    assert.deepEqual(
      qualityOf(root).unitImportFaceViolations,
      [],
      "中止即不落盘：存量集合保持为空",
    );
    // 台账通道（I8 的跨包存量处置同形）：登记后写入成功、证据入库、判绿。
    const ledger = writeLedger(root, [PKG + ":" + evidence]);
    const accepted = runOn(root, ["--write-baseline", "--exemptions", ledger]);
    assert.equal(accepted.status, 0, "按台账登记后应写入成功：\n" + accepted.out);
    assert.deepEqual(
      qualityOf(root).unitImportFaceViolations,
      [evidence],
      "证据应入库：\n" + accepted.out,
    );
    assert.equal(runOn(root, ["--exemptions", ledger]).status, 0, "登记后应判绿");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * #767 B1.0 判据加固：关掉 I8① 的「裸自引用」绕过路径。
 *
 * 为什么把「两种写法落成同一条证据」单独钉成断言：I8① 的判红只比对证据 id 集合（单调基线），
 * 证据 id 一旦随写法漂移，同一处违规就能按写法在基线里长出第二条、或干脆零证据——前者会让
 * 收紧判据的改动凭空产生「新增证据」，后者正是本条要堵的绕过路径。故四种状态（裸/相对 ×
 * lib 存在/不存在）逐一断言同一个 id，并把等号本身写成断言。
 */
test("I8①（B1.0）：裸包名自引用与相对写法落成同一条证据（lib 存在 / 不存在两态），且判红", () => {
  const bare = 'import { ROOT } from "' + PKG_NAME + '";\nexport const t = ROOT;\n';
  const relative = 'import { ROOT } from "../../../lib/index.js";\nexport const t = ROOT;\n';
  const libEntry = "packages/" + PKG + "/lib/index.js";
  const roots = {
    "裸包名 / lib 未构建": makeFixtureRoot(unitFaceFixture({ [UNIT_TEST_FILE]: bare })),
    "裸包名 / lib 已构建": makeFixtureRoot(
      unitFaceFixture({ [UNIT_TEST_FILE]: bare, [libEntry]: "export const ROOT = 1;\n" }),
    ),
    "相对写法 / lib 未构建": makeFixtureRoot(unitFaceFixture({ [UNIT_TEST_FILE]: relative })),
    "相对写法 / lib 已构建": makeFixtureRoot(
      unitFaceFixture({ [UNIT_TEST_FILE]: relative, [libEntry]: "export const ROOT = 1;\n" }),
    ),
  };
  const expected = "test/unit/a/impl.test.ts|lib/index.js";
  try {
    for (const [label, root] of Object.entries(roots)) {
      const graphed = runOn(root, ["--graph"]);
      assert.deepEqual(
        unitFaceEvidence(graphed.out),
        [expected],
        label + " 应落成 " + expected + "：\n" + graphed.out,
      );
      const red = runOn(root);
      assert.equal(
        red.status,
        1,
        label + " 应判红（exit 1），实际 " + red.status + "：\n" + red.out,
      );
      assert.match(
        red.out,
        /无基线 fail-closed：单元层导入面越界（test\/unit → src\/index\.ts \/ lib \/ src\/client） 1 个/,
        label + " 应点名 I8① 的 fail-closed：\n" + red.out,
      );
    }
    // 核心属性：同一处违规的两种写法，证据串逐字相等（不是各自一条）。
    assert.deepEqual(
      unitFaceEvidence(runOn(roots["裸包名 / lib 已构建"], ["--graph"]).out),
      unitFaceEvidence(runOn(roots["相对写法 / lib 已构建"], ["--graph"]).out),
      "裸包名自引用与相对写法必须是同一条证据 id",
    );
  } finally {
    for (const root of Object.values(roots)) rmSync(root, { recursive: true, force: true });
  }
});

test("I8①（B1.0）：<本包名>/<rest> 按同名映射落成 lib/<rest>，子路径写法不能绕过产物面", () => {
  for (const [spec, face] of [
    [PKG_NAME + "/client", "lib/client"],
    [PKG_NAME + "/a/internal.js", "lib/a/internal.js"],
  ]) {
    const root = makeFixtureRoot(
      unitFaceFixture({ [UNIT_TEST_FILE]: 'import "' + spec + '";\nexport const t = 1;\n' }),
    );
    try {
      const red = runOn(root);
      assert.equal(red.status, 1, spec + " 应判红，实际 " + red.status + "：\n" + red.out);
      const graphed = runOn(root, ["--graph"]);
      assert.deepEqual(
        unitFaceEvidence(graphed.out),
        ["test/unit/a/impl.test.ts|" + face],
        spec + " 应映射到 " + face + "：\n" + graphed.out,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("I8①（B1.0）：非本包的裸包名（别的 dsh 包 / 宿主包 / 前缀碰撞）不得产出证据", () => {
  const specs = [
    "@wingsky-1/dsh-notifier",
    "@wingsky-1/dsh-mcp-manager/client",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-agent",
    "@wingsky-1/fixture-pkg-extra",
    "@wingsky-1/fixture-pkg-extra/deep",
    "some-other-pkg",
  ];
  for (const spec of specs) {
    const root = makeFixtureRoot(
      unitFaceFixture({
        [UNIT_TEST_FILE]: 'import type { X } from "' + spec + '";\nexport const t = 1;\n',
      }),
    );
    try {
      // D15 起无基线自身判红：先登记空集合（面外包名无证据）再判定。
      assert.equal(runOn(root, ["--write-baseline"]).status, 0, spec + " 空集合登记应成功");
      const green = runOn(root);
      assert.equal(green.status, 0, spec + " 不得判红，实际 " + green.status + "：\n" + green.out);
      assert.match(
        green.out,
        /单元层导入面越界（I8①，test\/unit → src\/index\.ts \/ lib \/ src\/client）0 条/,
        spec + " 不得计入 I8①：\n" + green.out,
      );
      assert.deepEqual(
        unitFaceEvidence(runOn(root, ["--graph"]).out),
        [],
        spec + " 不得产出证据：\n" + green.out,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("I8①（B1.0）：裸包名写法进的是同一条基线面与台账键（存量后新增仍判红、写基线中止）", () => {
  const root = makeFixtureRoot(unitFaceFixture());
  const evidence = "test/unit/a/impl.test.ts|lib/index.js";
  try {
    assert.equal(runOn(root, ["--write-baseline"]).status, 0);
    assert.deepEqual(qualityOf(root).unitImportFaceViolations, []);
    assert.equal(runOn(root).status, 0, "存量登记后应判绿");
    writeFileSync(
      join(root, UNIT_TEST_FILE),
      'import { ROOT } from "' + PKG_NAME + '";\nexport const t = ROOT;\n',
    );
    const after = runOn(root);
    assert.equal(
      after.status,
      1,
      "新增裸写法越界应判红，实际 " + after.status + "：\n" + after.out,
    );
    assert.match(
      after.out,
      /\[质量型\] unitImportFaceViolations: 新增未登记证据 test\/unit\/a\/impl\.test\.ts\|lib\/index\.js/,
      "应点名新增证据与类（与相对写法同一条）：\n" + after.out,
    );
    const refused = runOn(root, ["--write-baseline"]);
    assert.equal(
      refused.status,
      1,
      "未登记不得写入，实际 " + refused.status + "：\n" + refused.out,
    );
    assert.ok(
      pendingLedgerKeys(refused.out).includes(PKG + ":" + evidence),
      "台账键应为 <包名>:<证据项>：\n" + refused.out,
    );
    const ledger = writeLedger(root, [PKG + ":" + evidence]);
    const accepted = runOn(root, ["--write-baseline", "--exemptions", ledger]);
    assert.equal(accepted.status, 0, "按台账登记后应写入成功：\n" + accepted.out);
    assert.deepEqual(
      qualityOf(root).unitImportFaceViolations,
      [evidence],
      "证据应入库：\n" + accepted.out,
    );
    assert.equal(runOn(root, ["--exemptions", ledger]).status, 0, "登记后应判绿");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * #875 4b+4d 提案 1：client 子树的「已覆盖」由**派生量**（有段认领了 client 系测试）给出，
 * 不再靠把 !src/client/** 抄进每个 server 段的 excludes。
 *
 * 为什么这组用例必须是正反一对：派生口径最危险的失效形态是「恒真」——只要
 * segmentsClaimClientTests 返回 true 就全绿，而它若因写错（把 testFiles 的形态认成对象、
 * 或路径正则写松）恒返回 true，本仓 39 条死条目一删 unnoticed，全绿依旧。
 * 正例钉「认领了 → client 子树零未覆盖」；反例钉「磁盘上有 client 测试但无段认领 →
 * client 子树进未覆盖清单」，反例同时证明这条判据确实在看段 testFiles。
 */
function clientCoverageFixture(segments: unknown, extraSrc: Record<string, string> = {}) {
  return {
    [TOPOLOGY_REL]: JSON.stringify({
      sharedDefaults: {},
      $testLayers: FIXTURE_TEST_LAYERS,
      packages: { [PKG]: { segments } },
    }),
    // client 文件在两种用例里都存在：差别只在段有没有认领 client 判据。
    [SRC + "/client/ui.ts"]: "export const UI = 1;\n",
    [SRC + "/server/a/impl.ts"]: "export const A = 1;\n",
    [SRC + "/index.ts"]: "export const ROOT = 1;\n",
    ...extraSrc,
  };
}

test("#875 提案 1 正例：有段认领 client 系测试 → client 子树零未覆盖（无需任何 !src/client/** 登记）", () => {
  const root = makeFixtureRoot(
    clientCoverageFixture({
      server: {
        // 正向面覆盖 server 与组合根，**独不覆盖 client** —— client 的覆盖只能来自派生量。
        mutate: [SRC + "/server/**/*.ts", SRC + "/index.ts"],
        excludes: [],
        testFiles: ["packages/" + PKG + "/test/client-unit/probe.test.ts"],
      },
    }),
  );
  try {
    const res = runOn(root, ["--write-baseline"]);
    assert.equal(res.status, 0, "认领了 client 判据就不该报未覆盖：\n" + res.out);
    assert.deepEqual(
      qualityOf(root).uncoveredSrcFiles,
      [],
      "认领了 client 系测试时 client 子树不得进未覆盖清单（提案 1 的核心行为）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#875 提案 1 反证：无段认领 client 系测试 → client 子树判红（这条判据确实在看段 testFiles）", () => {
  const root = makeFixtureRoot(
    clientCoverageFixture({
      server: {
        mutate: [SRC + "/server/**/*.ts", SRC + "/index.ts"],
        excludes: [],
        // 段认领的是 server 侧判据：client 系测试在磁盘上，却没有任何段认领它。
        testFiles: ["packages/" + PKG + "/test/unit/probe.test.ts"],
      },
    }),
  );
  try {
    const unitDir = join(root, "packages/" + PKG + "/test/unit");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "probe.test.ts"), "export {};\n");
    const res = runOn(root, ["--write-baseline"]);
    assert.equal(res.status, 1, "无段认领 client 判据时必须判红：\n" + res.out);
    assert.match(
      res.out,
      /未登记的新增质量证据/,
      "判红原因应是未覆盖清单进了新增证据：\n" + res.out,
    );
    assert.ok(
      pendingLedgerKeys(res.out).some((k) => k.startsWith(PKG + ":") && k.includes("client/")),
      "待登记键应点名 client 子树里的文件：\n" + res.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#875 提案 1 边界：派生凭据只对 client/ 生效，server 侧漏覆盖仍照旧判红", () => {
  // 防「派生量越界」：把 clientCovered 实现成「整棵 src 都算已覆盖」，上面两条仍会绿
  // （它们只碰 client），但 server 侧的漏覆盖会被静默吞掉。
  const root = makeFixtureRoot(
    clientCoverageFixture(
      {
        server: {
          mutate: [SRC + "/server/a/**/*.ts"],
          excludes: [],
          testFiles: ["packages/" + PKG + "/test/client-unit/probe.test.ts"],
        },
      },
      // server/b 与组合根都不在正向面里：它们必须照旧进未覆盖清单。
      { [SRC + "/server/b/impl.ts"]: "export const B = 1;\n" },
    ),
  );
  try {
    const res = runOn(root, ["--write-baseline"]);
    assert.equal(res.status, 1, "server 侧漏覆盖必须判红：\n" + res.out);
    const keys = pendingLedgerKeys(res.out);
    assert.ok(
      keys.some((k) => k.includes("server/b/impl.ts")),
      "待登记键应点名 server/b（派生凭据不得越界到 server）：\n" + res.out,
    );
    assert.ok(
      keys.some((k) => k.endsWith("/src/index.ts")),
      "待登记键应点名组合根 index.ts：\n" + res.out,
    );
    assert.ok(
      !keys.some((k) => k.includes("client/")),
      "client 子树已被派生量覆盖，不该出现在待登记键里：\n" + res.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ── 批次二项 2：两处层目录改由 $testLayers 派生（收口后的四组回归）── */

test("批次二 2a：$testLayers.layerMeta 整节缺失 → fail-closed 判红（层名判据不得静默退化为空表）", () => {
  const layers = structuredClone(FIXTURE_TEST_LAYERS);
  delete (layers as { layerMeta?: unknown }).layerMeta;
  const root = makeFixtureRoot({
    [TOPOLOGY_REL]: JSON.stringify({
      sharedDefaults: {},
      $testLayers: layers,
      packages: {
        [PKG]: {
          segments: {
            server: {
              mutate: [SRC + "/**/*.ts"],
              excludes: [],
              testFiles: ["packages/" + PKG + "/test/client-unit/probe.test.ts"],
            },
          },
        },
      },
    }),
  });
  try {
    const res = runOn(root);
    assert.equal(res.status, 1, "删掉 layerMeta 必须判红：\n" + res.out);
    assert.match(
      res.out,
      /测试分层派生失败：\$testLayers\.layerMeta 缺失或形状非法/,
      "判词须点名 layerMeta 缺失：\n" + res.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批次二 2b：unit 的 assertionTarget 改成 artifact → I8① 的必答层集合为空 → fail-closed 判红", () => {
  // 这条钉的是「单元层由 layerMeta 的语义谓词派生」而不是「test/unit 字面量」：把 unit 的
  // assertionTarget 改掉，派生出的必答直连源码层即为空 → 判红。若实现仍写死 test/unit，
  // 同一份 fixture 会安静地继续扫 test/unit，门禁全绿——那正是本项要消灭的静默通道。
  const layers = structuredClone(FIXTURE_TEST_LAYERS);
  (layers.layerMeta.unit as { assertionTarget: string }).assertionTarget = "artifact";
  const root = makeFixtureRoot({
    [TOPOLOGY_REL]: JSON.stringify({
      sharedDefaults: {},
      $testLayers: layers,
      packages: {
        [PKG]: {
          segments: {
            server: {
              mutate: [SRC + "/**/*.ts"],
              excludes: [],
              testFiles: ["packages/" + PKG + "/test/client-unit/probe.test.ts"],
            },
          },
        },
      },
    }),
  });
  try {
    const res = runOn(root);
    assert.equal(res.status, 1, "unit 退出直连源码层后必须判红：\n" + res.out);
    assert.match(
      res.out,
      /测试分层派生失败：由 layerMeta 派生的必答直连源码层为空/,
      "判词须点名派生出的必答层为空：\n" + res.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批次二 2c：client 族层由 $testLayers.layers 派生 —— 新增 client-probe 层后段认领即生效", () => {
  // 钉的是「派生」而不是「枚举」：把一个**不在**旧三项枚举里的 client 族层加进事实源，
  // 段认领它之后 client 子树应零未覆盖。写死枚举的实现在这里会判红（它不认 client-probe），
  // 门禁因此不会因为「新增了一个 client 族层」而静默漏判。
  const layers = structuredClone(FIXTURE_TEST_LAYERS) as {
    layers: Record<string, string>;
    layerMeta: Record<string, unknown>;
  };
  layers.layers["client-probe"] = "test/client-probe/**/*.test.ts";
  layers.layerMeta["client-probe"] = {
    assertionTarget: "src",
    environment: "dom",
    mandatory: false,
    responsibility: "探针用的 client 族层",
  };
  const root = makeFixtureRoot({
    ...clientCoverageFixture({}),
    [TOPOLOGY_REL]: JSON.stringify({
      sharedDefaults: {},
      $testLayers: layers,
      packages: {
        [PKG]: {
          segments: {
            server: {
              mutate: [SRC + "/server/**/*.ts", SRC + "/index.ts"],
              excludes: [],
              testFiles: ["packages/" + PKG + "/test/client-probe/probe.test.ts"],
            },
          },
        },
      },
    }),
  });
  try {
    const res = runOn(root, ["--write-baseline"]);
    assert.equal(res.status, 0, "段认领新登记的 client 族层后 client 子树应零未覆盖：\n" + res.out);
    assert.deepEqual(qualityOf(root).uncoveredSrcFiles, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批次二 2d：client 族层只在一张事实源里登记 → 判红（两张表失配不放过）", () => {
  const layers = structuredClone(FIXTURE_TEST_LAYERS) as { layers: Record<string, string> };
  // 只加 layers 键、不加 layerMeta：派生出的 client 族层在另一张表里没有元数据。
  layers.layers["client-orphan"] = "test/client-orphan/**/*.test.ts";
  const root = makeFixtureRoot({
    [TOPOLOGY_REL]: JSON.stringify({
      sharedDefaults: {},
      $testLayers: layers,
      packages: {
        [PKG]: {
          segments: {
            server: { mutate: [SRC + "/**/*.ts"], excludes: [], testFiles: [] },
          },
        },
      },
    }),
  });
  try {
    const res = runOn(root);
    assert.equal(res.status, 1, "两张事实源失配必须判红：\n" + res.out);
    assert.match(
      res.out,
      /client-orphan.*在 layerMeta 里没有元数据/s,
      "判词须点名失配的层名：\n" + res.out,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
