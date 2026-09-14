#!/usr/bin/env node
// @ts-nocheck
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
const TOPOLOGY_REL = "scripts/data/mutation-topology.json";

/** fixture 默认拓扑：本包 src 全量入 mutate（client 排除），使覆盖断言不引入额外噪声。 */
function defaultTopology() {
  return JSON.stringify({
    sharedDefaults: {},
    packages: {
      [PKG]: {
        segments: {
          s1: { mutate: [SRC + "/**/*.ts"], excludes: ["!" + SRC + "/client/**"] },
        },
      },
    },
  });
}

/** 在隔离根下造 fixture（含变异拓扑事实源），返回根路径（调用方负责清理）。 */
function makeFixtureRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "verify-dir-imports-criteria-"));
  for (const [rel, content] of Object.entries({ [TOPOLOGY_REL]: defaultTopology(), ...files })) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** 对 fixture 根跑脚本，返回 { status, out }。 */
function runOn(root, args = []) {
  const env = { ...process.env, VERIFY_DIR_IMPORTS_ROOT: root };
  // 外部若设了基线路径，会与 fixture 自己的基线串味（残留风险），显式清掉。
  delete env.VERIFY_DIR_IMPORTS_BASELINE;
  const r = spawnSync(process.execPath, [SCRIPT, "--package", PKG, ...args], {
    env,
    encoding: "utf8",
  });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** 读 fixture 根下入库的基线。 */
function fixtureBaseline(root) {
  return JSON.parse(readFileSync(join(root, "scripts/data/dir-imports-baseline.json"), "utf8"));
}

/** 本包入库后的质量证据段。 */
function qualityOf(root) {
  return fixtureBaseline(root).packages[PKG].quality;
}

/** 生成一份 fixture 台账（§5.3 的存量处置形态：gate=verify-dir-imports，path=<包名>:<证据项>）。 */
function writeLedger(dir, paths) {
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
function pendingLedgerKeys(out) {
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
function rootIndexFixture(implBody) {
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
    // 正例：无基线（fail-closed 面）也判绿——判据读的是「目标非共享层」这个集合，不是值边总数
    // （该 fixture 有 2 条值边、全部指向共享层，正是 notifier 终态的形态）。
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
    Object.fromEntries(Object.entries(clientFixture()).filter(([k]) => !k.includes("/client/"))),
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
