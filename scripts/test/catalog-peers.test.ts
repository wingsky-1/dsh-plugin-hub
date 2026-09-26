#!/usr/bin/env node
"use strict";

/**
 * catalog-peers：catalog 唯一事实源与 DSH-facing peer 投影的单测。
 *
 * 正向用真实仓库数据；负向与写入型测试用 mkdtemp 最小副本，测试产物不落仓库。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCatalogPeers,
  checkMaterializedCatalogPeers,
  memberDriftProblem,
  officialDepProblems,
  officialSourceRefs,
  packageNameOf,
  parseCatalog,
  parseReleaseExclude,
  plannedPeerChanges,
  sideMemberProblems,
  sideValueProblems,
  sourceImportProblems,
  syncCatalogPeers,
  isCanonicalExactVersion,
} from "../lib/catalog-peers-lib.ts";
import { loadManifest } from "../lib/plugins-manifest-lib.ts";

const ROOT = join(import.meta.dirname, "..", "..");

test("真实仓库：官方 peer 是 catalog 精确版本（raw link 可被 DSH 校验）", () => {
  const catalog = parseCatalog(readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8"));
  let officialPeerCount = 0;
  const { active, standalone } = loadManifest(ROOT);
  for (const dir of [...active, ...standalone]) {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"),
    ) as {
      peerDependencies?: Record<string, string>;
    };
    for (const [name, spec] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!name.startsWith("@deepseek-ai/")) continue;
      officialPeerCount++;
      assert.equal(spec, catalog.get(name), `${dir}: ${name} 必须与 catalog 精确一致`);
    }
  }
  // 期望值由 manifest 侧现算，而非写死数字：写死会让每加一个 peer 就红一次，
  // 于是这条断言迟早被人改成下界，失去「两侧一致」的判据力。
  const manifestTotal = Object.values(loadManifest(ROOT).dshPeerContracts).reduce(
    (sum, names) => sum + names.length,
    0,
  );
  assert.equal(
    officialPeerCount,
    manifestTotal,
    `package.json 侧官方 peer 数应与 manifest 合同一致，实际 ${officialPeerCount} vs ${manifestTotal}`,
  );
});

test("真实仓库：catalog ↔ peer/devDeps 零违规", () => {
  const { problems, catalogSize, officialPeerCount } = checkCatalogPeers(ROOT);
  assert.deepEqual(problems, []);
  assert.ok(catalogSize >= 15, `catalog 应含补全后的官方包，实际 ${catalogSize}`);
  let declared = 0;
  for (const dir of [...loadManifest(ROOT).active, ...loadManifest(ROOT).standalone]) {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"),
    ) as { peerDependencies?: Record<string, string> };
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (name.startsWith("@deepseek-ai/")) declared++;
    }
  }
  assert.equal(
    officialPeerCount,
    declared,
    `manifest 合同应与各包 package.json 的官方 peer 逐一对齐，实际 ${officialPeerCount} vs ${declared}`,
  );
});

test("parseCatalog：只取 catalog 段，不被后续顶层段污染", () => {
  const yaml = [
    "catalog:",
    "  '@deepseek-ai/cordis': 4.0.2",
    "  '@deepseek-ai/dsh-session': 0.1.2-rc.1",
    "allowBuilds:",
    "  esbuild: true",
    "",
  ].join("\n");
  const catalog = parseCatalog(yaml);
  assert.equal(catalog.size, 2);
  assert.equal(catalog.get("@deepseek-ai/dsh-session"), "0.1.2-rc.1");
});

test("引号形态无关：单引号/双引号/不加引号解析结果一致", () => {
  const forms = [
    ["  '@deepseek-ai/cordis': 4.0.2", "  - '@deepseek-ai/cordis@4.0.2'"],
    ['  "@deepseek-ai/cordis": 4.0.2', '  - "@deepseek-ai/cordis@4.0.2"'],
    ["  @deepseek-ai/cordis: 4.0.2", "  - @deepseek-ai/cordis@4.0.2"],
  ];
  for (const [catalogLine, excludeLine] of forms) {
    const yaml = ["catalog:", catalogLine, "minimumReleaseAgeExclude:", excludeLine, ""].join("\n");
    const catalog = parseCatalog(yaml);
    assert.equal(catalog.size, 1, `catalog 行「${catalogLine}」应恰好解析出 1 键`);
    assert.equal(catalog.get("@deepseek-ai/cordis"), "4.0.2", `catalog 行「${catalogLine}」`);
    assert.ok(parseReleaseExclude(yaml).has("@deepseek-ai/cordis"));
  }
});

test("parseReleaseExclude：剥离 @version 后缀", () => {
  const yaml = [
    "minimumReleaseAgeExclude:",
    "  - '@deepseek-ai/dsh-session@0.1.2-rc.1'",
    "allowBuilds:",
    "",
  ].join("\n");
  assert.ok(parseReleaseExclude(yaml).has("@deepseek-ai/dsh-session"));
});

/** 造最小仓库副本：pnpm-workspace.yaml + 一个带官方 peer 的包。 */
function makeRepo({
  peer = "catalog:",
  devPeer = "catalog:",
  catalogLine = "  '@deepseek-ai/dsh-session': 0.1.2-rc.1",
  excludeLine = "  - '@deepseek-ai/dsh-session@0.1.2-rc.1'",
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "catalog-peers-"));
  writeFileSync(
    join(dir, "pnpm-workspace.yaml"),
    ["catalog:", catalogLine, "minimumReleaseAgeExclude:", excludeLine, ""].join("\n"),
  );
  mkdirSync(join(dir, "packages", "dsh-probe"), { recursive: true });
  writeFileSync(
    join(dir, "packages", "dsh-probe", "package.json"),
    JSON.stringify(
      {
        name: "probe",
        peerDependencies: {
          "@deepseek-ai/dsh-session": peer,
          react: "^18.2.0",
        },
        devDependencies: { "@deepseek-ai/dsh-session": devPeer },
      },
      null,
      2,
    ),
  );
  mkdirSync(join(dir, "scripts", "data"), { recursive: true });
  writeFileSync(
    join(dir, "scripts", "data", "plugins-manifest.json"),
    JSON.stringify(
      {
        active: ["dsh-probe"],
        standalone: [],
        retired: [],
        dshPeerContracts: { "dsh-probe": ["@deepseek-ai/dsh-session"] },
        configSurfaces: [{ package: "dsh-probe", surface: "none", reason: "fixture" }],
      },
      null,
      2,
    ),
  );
  mkdirSync(join(dir, "packages", "dsh-plugins-all"), { recursive: true });
  writeFileSync(
    join(dir, "packages", "dsh-plugins-all", "package.json"),
    JSON.stringify({ name: "@wingsky-1/dsh-plugins-all", peerDependencies: {} }, null, 2),
  );
  return dir;
}

function withRepo(
  options: {
    peer?: string;
    devPeer?: string;
    catalogLine?: string;
    excludeLine?: string;
  },
  fn: (dir: string) => void,
) {
  const dir = makeRepo(options);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("同步：只把官方 peer 投影为 catalog 精确版本，保留 dev peer 与非官方 peer", () => {
  withRepo({}, (dir) => {
    const before = readFileSync(join(dir, "packages", "dsh-probe", "package.json"), "utf8");
    const result = syncCatalogPeers(dir);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.changed, ["packages/dsh-probe/package.json"]);

    const after = JSON.parse(
      readFileSync(join(dir, "packages", "dsh-probe", "package.json"), "utf8"),
    ) as {
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(after.peerDependencies["@deepseek-ai/dsh-session"], "0.1.2-rc.1");
    assert.equal(after.peerDependencies.react, "^18.2.0");
    assert.equal(after.devDependencies["@deepseek-ai/dsh-session"], "catalog:");
    assert.notEqual(
      before,
      readFileSync(join(dir, "packages", "dsh-probe", "package.json"), "utf8"),
    );

    const second = syncCatalogPeers(dir);
    assert.deepEqual(second.problems, []);
    assert.deepEqual(second.changed, []);
  });
});

test("同步：catalog 缺项时整批零写入", () => {
  withRepo(
    {
      catalogLine: "  '@deepseek-ai/other': 1.0.0",
      excludeLine: "  - '@deepseek-ai/other@1.0.0'",
    },
    (dir) => {
      const file = join(dir, "packages", "dsh-probe", "package.json");
      const before = readFileSync(file, "utf8");
      const result = syncCatalogPeers(dir);
      assert.ok(
        result.problems.some((problem) =>
          /无对应 pnpm-workspace\.yaml catalog 条目|缺少 canonical exact catalog 版本/.test(
            problem,
          ),
        ),
      );
      assert.deepEqual(result.changed, []);
      assert.equal(readFileSync(file, "utf8"), before);
    },
  );
});

test("发布物：官方 peer 名单与 catalog 精确版本必须保持一致", () => {
  const catalog = new Map([["@deepseek-ai/dsh-session", "0.1.2-rc.1"]]);
  const source = {
    peerDependencies: { "@deepseek-ai/dsh-session": "0.1.2-rc.1", react: "^18.2.0" },
  };
  assert.deepEqual(
    checkMaterializedCatalogPeers(
      source,
      { peerDependencies: { "@deepseek-ai/dsh-session": "0.1.2-rc.1", react: "^18.2.0" } },
      catalog,
      "fixture",
      ["@deepseek-ai/dsh-session"],
    ),
    [],
  );
  assert.match(
    checkMaterializedCatalogPeers(
      source,
      { peerDependencies: { "@deepseek-ai/dsh-session": "catalog:" } },
      catalog,
      "fixture",
      ["@deepseek-ai/dsh-session"],
    ).join("\n"),
    /不是 catalog exact version/,
  );
  assert.match(
    checkMaterializedCatalogPeers(
      { peerDependencies: { "@deepseek-ai/dsh-session": "catalog:" } },
      { peerDependencies: { "@deepseek-ai/dsh-session": "0.1.2-rc.1" } },
      catalog,
      "fixture",
      ["@deepseek-ai/dsh-session"],
    ).join("\n"),
    /不是 catalog exact version/,
  );
  assert.match(
    checkMaterializedCatalogPeers(
      source,
      { peerDependencies: { react: "^18.2.0" } },
      catalog,
      "fixture",
      ["@deepseek-ai/dsh-session"],
    ).join("\n"),
    /tarball peer 成员不匹配合同（缺少 @deepseek-ai\/dsh-session/,
  );
  assert.match(
    checkMaterializedCatalogPeers(
      source,
      {
        peerDependencies: {
          "@deepseek-ai/dsh-session": "0.1.2-rc.1",
          "@deepseek-ai/dsh-tools": "0.1.2-rc.1",
          react: "^18.2.0",
        },
      },
      catalog,
      "fixture",
      ["@deepseek-ai/dsh-session"],
    ).join("\n"),
    /tarball peer 成员不匹配合同.*多出 @deepseek-ai\/dsh-tools/,
  );
});

test("负向：删除整个 dshPeerContracts 合同 → catalog 门禁判红", () => {
  withRepo({}, (dir) => {
    const manifestFile = join(dir, "scripts", "data", "plugins-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
    delete manifest.dshPeerContracts;
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const { problems } = checkCatalogPeers(dir);
    assert.ok(problems.some((problem) => /dshPeerContracts 缺 dsh-probe/.test(problem)));
  });
});

test("负向：删除 manifest 合同成员 → 生成器零写入并判红", () => {
  withRepo({}, (dir) => {
    const file = join(dir, "packages", "dsh-probe", "package.json");
    const before = readFileSync(file, "utf8");
    const manifest = JSON.parse(before) as { peerDependencies: Record<string, string> };
    delete manifest.peerDependencies["@deepseek-ai/dsh-session"];
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    const result = syncCatalogPeers(dir);
    assert.ok(
      result.problems.some((problem) => /peer 成员合同漂移|缺少 manifest 合同成员/.test(problem)),
    );
    assert.deepEqual(result.changed, []);
  });
});

test("负向：catalog range 不是 canonical exact SemVer → 生成器零写入并判红", () => {
  withRepo(
    {
      catalogLine: "  '@deepseek-ai/dsh-session': ^0.1.2-rc.1",
      excludeLine: "  - '@deepseek-ai/dsh-session@^0.1.2-rc.1'",
    },
    (dir) => {
      const file = join(dir, "packages", "dsh-probe", "package.json");
      const before = readFileSync(file, "utf8");
      const result = syncCatalogPeers(dir);
      assert.ok(result.problems.some((problem) => /canonical exact SemVer/.test(problem)));
      assert.deepEqual(result.changed, []);
      assert.equal(readFileSync(file, "utf8"), before);
      assert.equal(isCanonicalExactVersion("0.1.2-rc.1"), true);
      assert.equal(isCanonicalExactVersion("^0.1.2-rc.1"), false);
      assert.equal(isCanonicalExactVersion("workspace:*"), false);
      assert.equal(isCanonicalExactVersion("0.1.2-rc.1+foo"), false);
    },
  );
});

test("负向：peer 写回漂移版本 → 判红", () => {
  withRepo({ peer: "0.1.2-rc.2" }, (dir) => {
    const { problems } = checkCatalogPeers(dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /必须与 catalog 精确版本/);
  });
});

test("负向：catalog 引用无对应条目 → 判红", () => {
  withRepo(
    { catalogLine: "  '@deepseek-ai/other': 1.0.0", excludeLine: "  - '@deepseek-ai/other@1.0.0'" },
    (dir) => {
      const { problems } = checkCatalogPeers(dir);
      assert.ok(
        problems.some((problem) =>
          /无此 catalog 条目|无对应 pnpm-workspace.yaml catalog 条目/.test(problem),
        ),
      );
    },
  );
});

test("负向：catalog 键未登记供应链豁免清单 → 判红", () => {
  withRepo({ excludeLine: "  - '@deepseek-ai/unrelated@1.0.0'" }, (dir) => {
    const { problems } = checkCatalogPeers(dir);
    assert.ok(problems.some((problem) => /未登记进 minimumReleaseAgeExclude/.test(problem)));
  });
});

test("负向：供应链豁免版本与 catalog 漂移 → 判红", () => {
  withRepo({ excludeLine: "  - '@deepseek-ai/dsh-session@0.1.2-rc.0'" }, (dir) => {
    const { problems } = checkCatalogPeers(dir);
    assert.ok(problems.some((problem) => /minimumReleaseAgeExclude 版本 .* 不一致/.test(problem)));
  });
});

test("锁：活进程持锁时生成器 fail-closed 且不改清单", () => {
  withRepo({}, (dir) => {
    const file = join(dir, "packages", "dsh-probe", "package.json");
    const before = readFileSync(file, "utf8");
    writeFileSync(join(dir, ".catalog-peers.lock"), `${process.pid}\n`);
    const result = syncCatalogPeers(dir);
    assert.ok(result.problems.some((problem) => /锁已存在|不自动回收/.test(problem)));
    assert.deepEqual(result.changed, []);
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

test("锁：疑似陈旧锁也不自动回收，人工确认后清理", () => {
  withRepo({}, (dir) => {
    const lock = join(dir, ".catalog-peers.lock");
    writeFileSync(lock, "2147483647\n");
    const result = syncCatalogPeers(dir);
    assert.ok(result.problems.some((problem) => /不自动回收/.test(problem)));
    assert.deepEqual(result.changed, []);
    assert.equal(existsSync(lock), true);
  });
});

test("生成期间 catalog 改动 → CAS 拒绝且不写 package.json", () => {
  withRepo({}, (dir) => {
    const packageFile = join(dir, "packages", "dsh-probe", "package.json");
    const yamlFile = join(dir, "pnpm-workspace.yaml");
    const beforePackage = readFileSync(packageFile, "utf8");
    const beforeYaml = readFileSync(yamlFile, "utf8");
    assert.throws(
      () =>
        syncCatalogPeers(dir, {
          beforeWrite: () => {
            writeFileSync(yamlFile, beforeYaml.replace("0.1.2-rc.1", "0.1.2-rc.2"));
          },
        }),
      /pnpm-workspace\.yaml 在生成期间被其它进程修改/,
    );
    assert.equal(readFileSync(packageFile, "utf8"), beforePackage);
  });
});

test("生成期间成员合同改动 → CAS 拒绝且不写 package.json", () => {
  withRepo({}, (dir) => {
    const packageFile = join(dir, "packages", "dsh-probe", "package.json");
    const manifestFile = join(dir, "scripts", "data", "plugins-manifest.json");
    const beforePackage = readFileSync(packageFile, "utf8");
    const beforeManifest = readFileSync(manifestFile, "utf8");
    assert.throws(
      () =>
        syncCatalogPeers(dir, {
          beforeWrite: () => {
            writeFileSync(manifestFile, beforeManifest + "\n");
          },
        }),
      /plugins-manifest\.json 在生成期间被其它进程修改/,
    );
    assert.equal(readFileSync(packageFile, "utf8"), beforePackage);
  });
});

test("生成期间 package.json 改动 → CAS 拒绝且不覆盖外部内容", () => {
  withRepo({}, (dir) => {
    const packageFile = join(dir, "packages", "dsh-probe", "package.json");
    const beforePackage = readFileSync(packageFile, "utf8");
    const external = beforePackage + "\n";
    assert.throws(
      () =>
        syncCatalogPeers(dir, {
          beforeWrite: () => writeFileSync(packageFile, external),
        }),
      /package\.json 在生成期间被其它进程修改/,
    );
    assert.equal(readFileSync(packageFile, "utf8"), external);
  });
});

test("双包生成期间第二包被改 → 第一包回滚且不覆盖第二包", () => {
  withRepo({}, (dir) => {
    const secondDir = join(dir, "packages", "dsh-probe-two");
    mkdirSync(secondDir, { recursive: true });
    writeFileSync(
      join(secondDir, "package.json"),
      JSON.stringify(
        {
          name: "probe-two",
          peerDependencies: { "@deepseek-ai/dsh-session": "catalog:" },
          devDependencies: { "@deepseek-ai/dsh-session": "catalog:" },
        },
        null,
        2,
      ) + "\n",
    );
    const manifestFile = join(dir, "scripts", "data", "plugins-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
      active: string[];
      dshPeerContracts: Record<string, string[]>;
      configSurfaces: Array<{ package: string; surface: string; reason: string }>;
    };
    manifest.active.push("dsh-probe-two");
    manifest.dshPeerContracts["dsh-probe-two"] = ["@deepseek-ai/dsh-session"];
    manifest.configSurfaces.push({ package: "dsh-probe-two", surface: "none", reason: "fixture" });
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const firstFile = join(dir, "packages", "dsh-probe", "package.json");
    const secondFile = join(secondDir, "package.json");
    const firstBefore = readFileSync(firstFile, "utf8");
    const secondBefore = readFileSync(secondFile, "utf8");
    const secondExternal = secondBefore + "\n";
    let calls = 0;
    assert.throws(
      () =>
        syncCatalogPeers(dir, {
          beforeWrite: () => {
            calls++;
            if (calls === 2) writeFileSync(secondFile, secondExternal);
          },
        }),
      /package\.json 在生成期间被其它进程修改/,
    );
    assert.equal(readFileSync(firstFile, "utf8"), firstBefore);
    assert.equal(readFileSync(secondFile, "utf8"), secondExternal);
  });
});

test("负向：聚合包声明 DSH 官方 peer → 判红", () => {
  withRepo({}, (dir) => {
    const file = join(dir, "packages", "dsh-plugins-all", "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      peerDependencies: Record<string, string>;
    };
    manifest.peerDependencies["@deepseek-ai/dsh-tools"] = "0.1.2-rc.1";
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    const { problems } = checkCatalogPeers(dir);
    assert.ok(problems.some((problem) => /聚合包不得声明 DSH 官方 peer/.test(problem)));
  });
});

test("负向：聚合包 peerDependencies 非对象/值非字符串 → 判红", () => {
  for (const value of [null, [], "0.1.7-rc.1", 42]) {
    withRepo({}, (dir) => {
      const file = join(dir, "packages", "dsh-plugins-all", "package.json");
      const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      manifest.peerDependencies = value;
      writeFileSync(file, JSON.stringify(manifest, null, 2));
      const { problems } = checkCatalogPeers(dir);
      assert.ok(
        problems.some((problem) =>
          /peerDependencies 存在时必须是对象|peerDependencies\[.*\] 必须是字符串/.test(problem),
        ),
        `value=${JSON.stringify(value)} problems=${problems.join("; ")}`,
      );
    });
  }
});

// ── 拆出后各纯判据的直接单测（#732 E5）：每条锁一个判定，不经 checkCatalogPeers 间接观察 ──

test("officialDepProblems：官方包条目要么字面量 catalog: 且 catalog 有该键，否则判词", () => {
  const catalog = new Map([["@deepseek-ai/dsh", "4.0.0"]]);
  // 非官方包不归本判据管。
  assert.deepEqual(officialDepProblems("p", "dependencies", { react: "^19.0.0" }, catalog), []);
  // 字面量 catalog: 且有该键：无判词。
  assert.deepEqual(
    officialDepProblems("p", "dependencies", { "@deepseek-ai/dsh": "catalog:" }, catalog),
    [],
  );
  // 值不是字面量 catalog:（如 ^4.0.0 或 workspace:*）。
  assert.deepEqual(
    officialDepProblems("p", "dependencies", { "@deepseek-ai/dsh": "^4.0.0" }, catalog),
    ['p: dependencies["@deepseek-ai/dsh"] = "^4.0.0" —— 官方包一律写 catalog:'],
  );
  // 字面量 catalog: 但 catalog 无该键。
  assert.deepEqual(
    officialDepProblems("p", "devDependencies", { "@deepseek-ai/other": "catalog:" }, catalog),
    [
      'p: devDependencies["@deepseek-ai/other"] 用了 catalog: 但 pnpm-workspace.yaml 无此 catalog 条目',
    ],
  );
});

test("memberDriftProblem：成员齐备返回 null，缺或多出各给一条判词", () => {
  const peers = { "@deepseek-ai/dsh": "4.0.0" };
  assert.equal(memberDriftProblem("p", ["@deepseek-ai/dsh"], peers), null);
  assert.equal(memberDriftProblem("p", [], null), null);
  assert.equal(
    memberDriftProblem("p", ["@deepseek-ai/dsh", "@deepseek-ai/x"], peers),
    "p: peer 成员合同漂移（缺少 @deepseek-ai/x；多出 无）",
  );
  assert.equal(
    memberDriftProblem("p", [], { "@deepseek-ai/y": "1.0.0" }),
    "p: peer 成员合同漂移（缺少 无；多出 @deepseek-ai/y）",
  );
});

test("plannedPeerChanges：版本不同才算变更；缺版本记判词且不阻断其余成员", () => {
  const catalog = new Map([
    ["@deepseek-ai/a", "1.0.0"],
    ["@deepseek-ai/b", "2.0.0"],
  ]);
  const peers = { "@deepseek-ai/a": "0.9.0", "@deepseek-ai/b": "2.0.0" };
  const r = plannedPeerChanges("p", ["@deepseek-ai/a", "@deepseek-ai/b"], peers, catalog);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.changes, [{ name: "@deepseek-ai/a", from: "0.9.0", to: "1.0.0" }]);
  // 缺 catalog 版本的成员：只对它自己记判词，另一个成员照常产出变更。
  const partial = plannedPeerChanges(
    "p",
    ["@deepseek-ai/a", "@deepseek-ai/missing"],
    peers,
    catalog,
  );
  assert.deepEqual(partial.problems, [
    'p: peer "@deepseek-ai/missing" 缺少 canonical exact catalog 版本',
  ]);
  assert.deepEqual(partial.changes, [{ name: "@deepseek-ai/a", from: "0.9.0", to: "1.0.0" }]);
  // catalog 里是非 canonical exact（如 ^1.0.0）同样记判词。
  const badRange = new Map([["@deepseek-ai/a", "^1.0.0"]]);
  assert.deepEqual(plannedPeerChanges("p", ["@deepseek-ai/a"], null, badRange).problems, [
    'p: peer "@deepseek-ai/a" 缺少 canonical exact catalog 版本',
  ]);
  // 全部齐平时零变更零判词。
  const same = plannedPeerChanges("p", ["@deepseek-ai/b"], peers, catalog);
  assert.deepEqual(same.problems, []);
  assert.deepEqual(same.changes, []);
});

test("sideMemberProblems / sideValueProblems：发布边界两侧各判一次", () => {
  const expected = new Set(["@deepseek-ai/dsh"]);
  assert.deepEqual(sideMemberProblems("L", "源", { "@deepseek-ai/dsh": "4.0.0" }, expected), []);
  assert.deepEqual(sideMemberProblems("L", "源", {}, expected), [
    "L: 源 peer 成员不匹配合同（缺少 @deepseek-ai/dsh；多出 无）",
  ]);
  assert.deepEqual(sideMemberProblems("L", "tarball", { "@deepseek-ai/z": "1.0.0" }, expected), [
    "L: tarball peer 成员不匹配合同（缺少 @deepseek-ai/dsh；多出 @deepseek-ai/z）",
  ]);
  assert.deepEqual(
    sideValueProblems("L", "源", { "@deepseek-ai/dsh": "4.0.0" }, "@deepseek-ai/dsh", "4.0.0"),
    [],
  );
  assert.deepEqual(sideValueProblems("L", "tarball", null, "@deepseek-ai/dsh", "4.0.0"), [
    'L: tarball peerDependencies["@deepseek-ai/dsh"] 不是 catalog exact version',
  ]);
});

// ---------------------------------------------------------------- X1：源码引用反推 peer

/** 往 fixture 包的 src 写文件（X1 判据的面 = packages/<pkg>/src）。 */
function withSrc(dir: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, "packages", "dsh-probe", "src", rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  return dir;
}

/** fixture 包的 peer 反推判词。 */
function srcProblems(dir: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(dir, "packages", "dsh-probe", "package.json"), "utf8"),
  ) as Record<string, unknown>;
  return sourceImportProblems(dir, "dsh-probe", manifest);
}

test("X1 载体自证：真实仓库里判据取到的是真实引用（防恒零命中的假绿）", () => {
  // 为什么要有这条：本判据跑在「esbuild 擦除 import type / declare module + acorn AST」的
  // 组合上，而本仓对官方包的引用几乎全是类型导入——若采集侧退化成「什么都没取到」，
  // 上面那条「零违规」照样全绿。故正面钉住「取到了东西」这件事。
  let total = 0;
  for (const dir of Object.keys(loadManifest(ROOT).dshPeerContracts)) {
    const found = officialSourceRefs(ROOT, dir);
    assert.deepEqual(found.problems, [], `${dir}: 采集面自身不可判`);
    total += found.referenced.size;
  }
  assert.ok(
    total >= 20,
    `X1 应取到真实官方引用（当前 ${total} 个包级引用），低于 20 说明采集面退化了`,
  );
});

test("X1：import type / declare module / export…from 未登记为 peer 即判红", () => {
  withRepo({}, (dir) => {
    withSrc(dir, {
      "a.ts": [
        'import type { A } from "@deepseek-ai/dsh-llm";',
        'declare module "@deepseek-ai/dsh-tools" { interface X { a: string } }',
        'export type { B } from "@deepseek-ai/dsh-agent";',
      ].join("\n"),
    });
    const problems = srcProblems(dir);
    for (const name of [
      "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-tools",
      "@deepseek-ai/dsh-agent",
    ]) {
      assert.ok(
        problems.some((p) => p.includes(`"${name}"`)),
        `${name} 应被判红，实际：${JSON.stringify(problems)}`,
      );
    }
    assert.ok(problems.every((p) => p.includes("peerDependencies 未登记")));
  });
});

test("X1 零误报：裸字符串字面量 / 注释 / 非官方包都不算引用", () => {
  // 本仓的实证反例：packages/dsh-mcp-manager/src/server/shared/constants.ts 的
  // OFFICIAL_MCP_CLIENT_SPECIFIER 是宿主 loader 的运行时字符串常量。文本扫描会把它当引用，
  // 判据若如此，全仓每加一个 specifier 常量就假红一次。
  withRepo({}, (dir) => {
    withSrc(dir, {
      "a.ts": [
        'const OFFICIAL = "@deepseek-ai/dsh-mcp-client";',
        '// import type { X } from "@deepseek-ai/dsh-llm";',
        '/* declare module "@deepseek-ai/dsh-tools" {} */',
        'const s = `import y from "@deepseek-ai/dsh-agent"`;',
        'import type { L } from "@wingsky-1/dsh-notifier/client";',
        "export const used = [OFFICIAL, s, L];",
      ].join("\n"),
    });
    assert.deepEqual(srcProblems(dir), []);
  });
});

test("X1：子路径说明符按包名匹配（dsh-session/types 由 peer dsh-session 覆盖）", () => {
  withRepo({}, (dir) => {
    withSrc(dir, { "a.ts": 'import type { S } from "@deepseek-ai/dsh-session/types";' });
    assert.deepEqual(srcProblems(dir), [], "子路径应归到包名再比对");
    assert.equal(packageNameOf("@deepseek-ai/dsh-session/types"), "@deepseek-ai/dsh-session");
    assert.equal(packageNameOf("react"), "react");
  });
});

test("X1：.tsx 里的类型导入照样取到（词法分段不得吞掉文件头）", () => {
  withRepo({}, (dir) => {
    withSrc(dir, {
      "a.tsx": [
        'import type { A } from "@deepseek-ai/dsh-llm";',
        "export function View() {",
        "  return (",
        '    <div className="x">',
        "      <span>{1 / 2}</span>",
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    });
    const problems = srcProblems(dir);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.ok(problems[0].includes("@deepseek-ai/dsh-llm"));
  });
});

test("X1：已登记为 peer 的引用零判词（与 checkCatalogPeers 同源）", () => {
  withRepo({}, (dir) => {
    withSrc(dir, { "a.ts": 'import type { S } from "@deepseek-ai/dsh-session";' });
    const manifest = JSON.parse(
      readFileSync(join(dir, "packages", "dsh-probe", "package.json"), "utf8"),
    ) as Record<string, unknown>;
    manifest.peerDependencies = {
      ...(manifest.peerDependencies as Record<string, string>),
      "@deepseek-ai/dsh-session": "0.1.2-rc.1",
    };
    writeFileSync(
      join(dir, "packages", "dsh-probe", "package.json"),
      JSON.stringify(manifest, null, 2),
    );
    assert.deepEqual(sourceImportProblems(dir, "dsh-probe", manifest), []);
    assert.deepEqual(checkCatalogPeers(dir).problems, []);
  });
});
