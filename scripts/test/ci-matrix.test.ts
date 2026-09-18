import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { computeCiMatrix, parseTestChangedPackages } from "../ci/ci-matrix.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
/** plugins-manifest.json 的消费面（结构完整性由别的门禁守，这里只声明本文件读到的字段）。 */
interface PluginsManifest {
  active: string[];
  standalone?: string[];
  retired: Array<{ name: string }>;
}

const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/data/plugins-manifest.json"), "utf8"),
) as PluginsManifest;
const EXPECTED_ALL = Array.from(
  new Set([...MANIFEST.active, ...(MANIFEST.standalone ?? []), "dsh-plugins-all"]),
).sort();

test("ci-matrix: 场景 a - 正常命中单一 active 包 (via FILTER_OUTPUTS)", () => {
  const res = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "success",
      BASE_SET: "origin/main",
      FILTER_OUTPUTS: JSON.stringify({ "dsh-notifier": true }),
    },
    rootDir: ROOT,
  });

  assert.deepEqual(res.allPackages, EXPECTED_ALL);
  assert.deepEqual(res.hitPackages, ["dsh-notifier"]);
  assert.deepEqual(res.buildPackages, ["dsh-notifier"], "#722：矩阵 = 命中包（有命中时）");
  assert.deepEqual(res.mutationPackages, ["dsh-notifier"]);
  assert.equal(res.hasMutations, "true");
  // T2-7：dsh-notifier 变异 4 段 → 按域重划 8 段（S3-30/N-24）；#720 再把 config 段按
  // mutant 密度拆为 config-normalize / config-validate / config-rest → 10 段；
  // #733 按域重写后按新布局重划为 9 段（combos 字母序展开）；#769 客户端门禁再加 client 段 → 10 段
  assert.equal(res.mutationCombos.length, 10);
  assert.deepEqual(
    res.mutationCombos.map((c) => c.seg),
    [
      "api",
      "channels",
      "client",
      "config",
      "events",
      "pipeline",
      "sdk",
      "shared",
      "stores",
      "upgrade",
    ],
  );
});

test("ci-matrix: 空切片 → buildPackages 用哨兵占位（防零实例动态矩阵回报 failure，#722）", () => {
  const res = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "success",
      BASE_SET: "origin/main",
      // 纯文档 PR：docs/**、AGENTS.md 刻意不在 global 面（#220），故全 false
      FILTER_OUTPUTS: "{}",
    },
    rootDir: ROOT,
  });

  assert.deepEqual(res.hitPackages, [], "空切片");
  assert.deepEqual(
    res.buildPackages,
    ["__no-hit-package__"],
    "GHA 对零实例动态矩阵回报 failure（实证 run 32802575298），必须用哨兵项占位",
  );
  assert.equal(res.hasMutations, "false");
});

test("ci-matrix: 场景 a - 正常命中单一 active 包 (via BASE_SET 空格分隔)", () => {
  const res = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "success",
      BASE_SET: "dsh-lan-proxy",
      FILTER_OUTPUTS: "{}",
    },
    rootDir: ROOT,
  });

  assert.deepEqual(res.hitPackages, ["dsh-lan-proxy"]);
  assert.deepEqual(res.mutationPackages, ["dsh-lan-proxy"]);
  assert.equal(res.hasMutations, "true");
  assert.deepEqual(
    res.mutationCombos.map((c) => c.seg),
    ["client", "config", "entry", "host-trust", "migrate", "proxy", "shared", "tls"],
  );
});

test("ci-matrix: 场景 b - 退役的 standalone 包不再进入全量清单", () => {
  // dsh-codegraph / dsh-mem0 退役后 standalone 一度清空（#691）。原断言写的是「standalone 应为空」，
  // 那是当时的数据状态而不是不变量——本仓现有刻意不进聚合包的活跃 standalone 包
  // （dsh-worktree-sidebar），该断言会把它误判成回归。真正要守的是「已退役包不复现」：
  // 既不得回到 standalone，也不得进入 CI 全量清单，且必须在 manifest.retired 留痕。
  for (const pkg of ["dsh-codegraph", "dsh-mem0"]) {
    assert.ok(!(MANIFEST.standalone ?? []).includes(pkg), `${pkg} 已退役，不得回到 standalone`);
    assert.ok(!EXPECTED_ALL.includes(pkg), `${pkg} 已退役，不得再进入 CI 全量清单`);
    assert.ok(
      MANIFEST.retired.some((r) => r.name === pkg),
      `${pkg} 必须在 manifest.retired 登记`,
    );
  }
});

test("ci-matrix: 场景 b - 命中无变异配置的 active 包 (dsh-verify-isolated)", () => {
  const res = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "success",
      BASE_SET: "origin/main",
      FILTER_OUTPUTS: JSON.stringify({
        "dsh-verify-isolated": true,
      }),
    },
    rootDir: ROOT,
  });

  assert.deepEqual(res.hitPackages, ["dsh-verify-isolated"]);
  assert.deepEqual(res.mutationPackages, []);
  assert.equal(res.hasMutations, "false");
  assert.deepEqual(res.mutationCombos, []);
});

test("ci-matrix: 场景 c - 全局命中 (GLOBAL_HIT=true) 触发全量切片", () => {
  const res = computeCiMatrix({
    env: {
      GLOBAL_HIT: "true",
      FILTER_OUTCOME: "success",
      BASE_SET: "origin/main",
      FILTER_OUTPUTS: JSON.stringify({ "dsh-notifier": true }),
    },
    rootDir: ROOT,
  });

  assert.deepEqual(res.hitPackages, EXPECTED_ALL);
  assert.equal(res.hasMutations, "true");
  // 必须包含 active + standalone + dsh-plugins-all
  for (const p of [...MANIFEST.active, ...(MANIFEST.standalone ?? []), "dsh-plugins-all"]) {
    assert.ok(res.hitPackages.includes(p), `hitPackages 必须包含 ${p}`);
  }
});

test("ci-matrix: 场景 c - 回退机制 (FILTER_OUTCOME!=success 或 BASE_SET 为空)", () => {
  // 1. FILTER_OUTCOME failure
  const resFailure = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "failure",
      BASE_SET: "origin/main",
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resFailure.hitPackages, EXPECTED_ALL);

  // 2. FILTER_OUTCOME cancelled
  const resCancelled = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "cancelled",
      BASE_SET: "origin/main",
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resCancelled.hitPackages, EXPECTED_ALL);

  // 3. BASE_SET 为空字符串
  const resEmptyBase = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "success",
      BASE_SET: "",
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resEmptyBase.hitPackages, EXPECTED_ALL);

  // 4. BASE_SET 仅含空格
  const resWhitespaceBase = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "success",
      BASE_SET: "   ",
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resWhitespaceBase.hitPackages, EXPECTED_ALL);
});

test("ci-matrix: 场景 d - 变异段展开正确性 (多段配置 + 多包排序)", () => {
  // #840 起仓库已无单配置（seg="0"）包——最后一个单配置包 dsh-web-file-preview 已退役，
  // 本用例随之退为纯多段形态；#742 起 combo 另带逐段超时与失基线标志，
  // 本用例只锁段展开，故按段投影比较（超时/失基线的专项断言见文件尾部的 #742 用例）
  const resMulti = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "success",
      BASE_SET: "dsh-lan-proxy dsh-notifier",
      FILTER_OUTPUTS: "{}",
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resMulti.mutationPackages, ["dsh-lan-proxy", "dsh-notifier"]);
  assert.deepEqual(
    resMulti.mutationCombos.map((c) => ({ package: c.package, seg: c.seg })),
    [
      { package: "dsh-lan-proxy", seg: "client" },
      { package: "dsh-lan-proxy", seg: "config" },
      { package: "dsh-lan-proxy", seg: "entry" },
      { package: "dsh-lan-proxy", seg: "host-trust" },
      { package: "dsh-lan-proxy", seg: "migrate" },
      { package: "dsh-lan-proxy", seg: "proxy" },
      { package: "dsh-lan-proxy", seg: "shared" },
      { package: "dsh-lan-proxy", seg: "tls" },
      { package: "dsh-notifier", seg: "api" },
      { package: "dsh-notifier", seg: "channels" },
      { package: "dsh-notifier", seg: "client" },
      { package: "dsh-notifier", seg: "config" },
      { package: "dsh-notifier", seg: "events" },
      { package: "dsh-notifier", seg: "pipeline" },
      { package: "dsh-notifier", seg: "sdk" },
      { package: "dsh-notifier", seg: "shared" },
      { package: "dsh-notifier", seg: "stores" },
      { package: "dsh-notifier", seg: "upgrade" },
    ],
  );
});

test("#742 阶段 1: combo 携带逐段超时（口径与夜间 mutation-plan 同源）且随段不同", () => {
  const res = computeCiMatrix({
    env: {
      GLOBAL_HIT: "true",
      FILTER_OUTCOME: "success",
      BASE_SET: "origin/main",
      FILTER_OUTPUTS: "{}",
      TEST_CHANGED_PACKAGES: "[]",
    },
    rootDir: ROOT,
  });
  // 期望值取自夜间班 CLI 的**真实产物**（临时 GITHUB_OUTPUT 文件），不是它的 stdout：
  // 该脚本在有 GITHUB_OUTPUT 时只往文件写、stdout 换成一行提示，而 CI 的每个 run 步骤
  // 都带这个变量——按 stdout 解析会在本地绿、在 CI 必红（评审实测：GITHUB_OUTPUT 存在时
  // `.find(l => l.startsWith("shards="))` 得 undefined 并抛 TypeError）。这里直接走 CI 的
  // 同一条路径：给一个临时 GITHUB_OUTPUT，再从文件里读。
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-matrix-shards-"));
  const outFile = path.join(outDir, "github-output.txt");
  try {
    execFileSync(process.execPath, ["scripts/gate/mutation-plan.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outFile },
    });
    const line = fs
      .readFileSync(outFile, "utf8")
      .split("\n")
      .find((l) => l.startsWith("shards="));
    assert.ok(line, "mutation-plan 必须把 shards 写入 GITHUB_OUTPUT（CI 的真实消费路径）");
    const plan = JSON.parse(line.slice("shards=".length)) as Array<{
      seg: string;
      timeoutMinutes: number;
    }>;
    const expected = new Map(plan.map((s) => [s.seg, s.timeoutMinutes]));
    assert.ok(expected.size > 20, `夜间矩阵段数异常（${expected.size}）`);
    for (const c of res.mutationCombos) {
      // ci-matrix 的 seg="0" 指包级 conf（<pkg>.json），台账里的段名就是包名
      const key = c.seg === "0" ? c.package : `${c.package}-${c.seg}`;
      assert.equal(
        c.timeoutMinutes,
        expected.get(key),
        `${key} 的超时必须与夜间 mutation-plan 派生值一致（两处各写一份公式必然漂移）`,
      );
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  // 单段内建阈值不足的老形态：固定 30 分钟曾把 1819s 的实例砍掉，这里锁住「不是全局常数」
  assert.ok(
    new Set(res.mutationCombos.map((c) => c.timeoutMinutes)).size > 1,
    "逐段超时必须随段变化——全相等说明退回了全局固定值",
  );
});

test("#742 阶段 1.7: invalidateBaseline 由 test 变更清单决定，清单缺失一律失基线（fail-closed）", () => {
  // over 允许 undefined：本文件有「TEST_CHANGED_PACKAGES 整键缺失」的用例（= 清单不可得）
  const envOf = (over: Record<string, string | undefined>) => ({
    GLOBAL_HIT: "false",
    FILTER_OUTCOME: "success",
    BASE_SET: "dsh-notifier dsh-lan-proxy",
    FILTER_OUTPUTS: "{}",
    ...over,
  });
  const pick = (res: ReturnType<typeof computeCiMatrix>) =>
    Object.fromEntries(
      res.mutationCombos.map((c) => [`${c.package}-${c.seg}`, c.invalidateBaseline]),
    );

  // 清单为空 → 全部保留基线（这正是绝大多数 PR 的形态）
  const none = pick(
    computeCiMatrix({ env: envOf({ TEST_CHANGED_PACKAGES: "[]" }), rootDir: ROOT }),
  );
  assert.ok(
    Object.values(none).length > 0 && Object.values(none).every((v) => v === false),
    "无 test 变更时不得失基线（否则每个 PR 都退化成全量变异）",
  );

  // 只有 dsh-notifier 的 test 变更 → 只失效该包的段
  const one = pick(
    computeCiMatrix({ env: envOf({ TEST_CHANGED_PACKAGES: '["dsh-notifier"]' }), rootDir: ROOT }),
  );
  for (const [key, v] of Object.entries(one)) {
    assert.equal(v, key.startsWith("dsh-notifier-"), `${key} 的失基线判定必须只跟着本包 test 变更`);
  }
  assert.ok(
    Object.values(one).some((v) => v === true) && Object.values(one).some((v) => v === false),
  );

  // 清单缺失/不可解析 → 一律失基线（宁可多跑一次全量，不要「测试改了却复用旧结果」的假绿）
  for (const bad of [undefined, "", "not-json", '{"a":1}']) {
    const res = computeCiMatrix({ env: envOf({ TEST_CHANGED_PACKAGES: bad }), rootDir: ROOT });
    assert.ok(
      res.mutationCombos.every((c) => c.invalidateBaseline === true),
      `清单为 ${JSON.stringify(bad)} 时必须全部失基线（fail-closed）`,
    );
  }
});

test("#742 阶段 1.7: parseTestChangedPackages 的非法形态一律 unknown（调用方 fail-closed）", () => {
  for (const bad of [undefined, null, "", "  ", "not-json", '{"a":1}', "1"]) {
    const r = parseTestChangedPackages(bad);
    assert.equal(r.unknown, true, `${JSON.stringify(bad)} 必须判为 unknown`);
    assert.equal(r.packages.size, 0);
  }
  const ok = parseTestChangedPackages('["dsh-notifier","dsh-lan-proxy"]');
  assert.equal(ok.unknown, false);
  assert.deepEqual([...ok.packages].sort(), ["dsh-lan-proxy", "dsh-notifier"]);
  // 数组里混入非字符串：过滤掉而不是整体判未知（清单本身可信，只是形状脏）
  const mixed = parseTestChangedPackages('["dsh-notifier",1,null]');
  assert.equal(mixed.unknown, false);
  assert.deepEqual([...mixed.packages], ["dsh-notifier"]);
});

test("ci-matrix: 场景 e - 畸形输入与防御性回退", () => {
  // 畸形 JSON 字符串
  const resBadJson = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "success",
      BASE_SET: "origin/main",
      FILTER_OUTPUTS: "{broken-json",
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resBadJson.hitPackages, []);
  assert.equal(resBadJson.hasMutations, "false");

  // BASE_SET 含有无关 token 与有效包名
  const resTokens = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "success",
      BASE_SET:
        "origin/main 0000000000000000000000000000000000000000 dsh-lan-proxy non-existent-pkg",
      FILTER_OUTPUTS: "{}",
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resTokens.hitPackages, ["dsh-lan-proxy"]);

  // 聚合包 dsh-plugins-all 不进入 mutationPackages
  const resAll = computeCiMatrix({
    env: {
      GLOBAL_HIT: "false",
      FILTER_OUTCOME: "success",
      BASE_SET: "origin/main",
      FILTER_OUTPUTS: JSON.stringify({ "dsh-plugins-all": true }),
    },
    rootDir: ROOT,
  });
  assert.deepEqual(resAll.hitPackages, ["dsh-plugins-all"]);
  assert.deepEqual(resAll.mutationPackages, []);
  assert.equal(resAll.hasMutations, "false");
});

test("ci-matrix: 场景 e - fail-closed 异常防护 (manifest 损坏或空清单)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-matrix-mock-"));
  try {
    const scriptsDataDir = path.join(tmpDir, "scripts/data");
    fs.mkdirSync(scriptsDataDir, { recursive: true });
    // 写入空 manifest
    fs.writeFileSync(
      path.join(scriptsDataDir, "plugins-manifest.json"),
      JSON.stringify({ active: [], standalone: [] }),
    );

    // 只有 dsh-plugins-all 时依然会成功，但如果为空或者读取失败
    fs.writeFileSync(path.join(scriptsDataDir, "plugins-manifest.json"), "invalid json");
    assert.throws(() => computeCiMatrix({ rootDir: tmpDir }), /读取 plugins-manifest\.json 失败/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ci-matrix: 场景 f - CLI 命令行与 --json 参数验证", () => {
  const scriptPath = path.join(ROOT, "scripts/ci/ci-matrix.mjs");
  const ret = spawnSync(process.execPath, [scriptPath, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    // 隔离 GITHUB_OUTPUT（#218 产物零污染）：CI 的每个 run 步骤都带这个变量，子进程会把它
    // 当成自己的输出文件往里追加 6 行（本地不设该变量所以看不到）。本用例只断言 stdout 的
    // --json 形态，关掉写入面即可。
    env: { ...process.env, GITHUB_OUTPUT: "" },
  });
  assert.equal(ret.status, 0, `CLI 执行失败: ${ret.stderr}`);
  const parsed = JSON.parse(ret.stdout);
  assert.ok(Array.isArray(parsed.allPackages));
  assert.ok(Array.isArray(parsed.hitPackages));
  assert.ok(Array.isArray(parsed.mutationPackages));
  assert.ok(typeof parsed.hasMutations === "string");
  assert.ok(Array.isArray(parsed.mutationCombos));
});

test("ci-matrix: 场景 f - GITHUB_OUTPUT 写入契约", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-matrix-gha-"));
  const outputFile = path.join(tmpDir, "github_output.txt");
  fs.writeFileSync(outputFile, "");

  try {
    const scriptPath = path.join(ROOT, "scripts/ci/ci-matrix.mjs");
    const ret = spawnSync(process.execPath, [scriptPath], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        GLOBAL_HIT: "false",
        FILTER_OUTCOME: "success",
        BASE_SET: "origin/main",
        FILTER_OUTPUTS: JSON.stringify({ "dsh-notifier": true }),
      },
    });
    assert.equal(ret.status, 0, `CLI 执行失败: ${ret.stderr}`);

    const content = fs.readFileSync(outputFile, "utf8");
    const lines = content.trim().split("\n");
    const record = Object.fromEntries(
      lines.map((l) => {
        const idx = l.indexOf("=");
        return [l.slice(0, idx), l.slice(idx + 1)];
      }),
    );

    assert.equal(record.hitPackages, JSON.stringify(["dsh-notifier"]));
    assert.equal(record.mutationPackages, JSON.stringify(["dsh-notifier"]));
    assert.equal(record.hasMutations, "true");
    assert.deepEqual(JSON.parse(record.allPackages), EXPECTED_ALL);
    const combos = JSON.parse(record.mutationCombos);
    assert.equal(combos.length, 10);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
