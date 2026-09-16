#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * 本地门禁分层（#722）的包面推导回归。
 *
 * 为什么存在：`pnpm gate:changed` 的价值全押在「本地切片 == CI 切片」上。它靠解析
 * ci.yml 的 paths-filter `filters` 块拿到包面归属，所以三类回归必须钉死：
 *   1. 解析器被块内注释行/引号形态打挂 → 静默回退全量（本地又变慢，无人察觉）；
 *   2. 解析器「宽容」到把注释里的路径当规则 → 本地少跑（本地绿 CI 红）；
 *   3. 全局面（shared/scripts/.github/包管理文件）不再升级 → 静态闸在本地被绕过。
 * 断言全部锚在真实 ci.yml 上（不另写 fixture 副本，避免与事实源漂移）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import {
  CI_WORKFLOW,
  matchFilterBlock,
  parseFilterBlock,
  planChangedScope,
  shouldEscalateChangedTier,
} from "../gate/local-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI_YML = readFileSync(join(ROOT, CI_WORKFLOW), "utf8");

test("parseFilterBlock：真实 ci.yml 的 filters 块可解析，且含全局面与 6 个包面", () => {
  const filters = parseFilterBlock(CI_YML);
  assert.ok(filters !== null, "filters 块必须可解析（不可解析 → 本地静默回退全量）");
  assert.ok(Array.isArray(filters.global) && filters.global.length > 0, "global 面必须存在且非空");
  for (const pkg of [
    "dsh-notifier",
    "dsh-mcp-manager",
    "dsh-provider-usage",
    "dsh-lan-proxy",
    "dsh-verify-isolated",
    "dsh-plugins-all",
  ]) {
    assert.ok(Array.isArray(filters[pkg]), `包面 ${pkg} 必须在 filters 块内`);
  }
  // #220 决策：docs/** 与 AGENTS.md 刻意不在全局面，纯文档 PR 不跑变异/切片
  assert.ok(filters.global.includes("shared/**"), "shared/** 属于全局面");
  assert.ok(filters.global.includes("pnpm-lock.yaml"), "锁文件属于全局面");
  assert.ok(
    filters.global.some((g) => g === ".github/**"),
    ".github/** 属于全局面",
  );
  assert.ok(
    !filters.global.some((g) => g.startsWith("docs/") || g === "AGENTS.md"),
    "docs 面不得混入全局面（#220）",
  );
  // 块内注释行不得被当成规则
  assert.ok(!Object.keys(filters).some((k) => k.startsWith("#")), "注释行不得被解析为 filter 键");
  assert.ok(
    !Object.values(filters)
      .flat()
      .some((g) => g.startsWith("#")),
    "注释行不得被解析为 glob",
  );
});

test("parseFilterBlock：块缺失/畸形一律返回 null（调用方 fail-closed）", () => {
  assert.equal(parseFilterBlock("name: CI\non:\n  pull_request:\n"), null, "无 filters 块 → null");
  assert.equal(
    parseFilterBlock("        filters: |\n          global:\n            - no-quotes-here\n"),
    null,
    "未加引号的条目 → null",
  );
});

test("#742 2.1: filters 只用两套匹配器语义一致的 glob 形态（否定/扩展语法即判红）", () => {
  // 本地靠解析同一份 filters 推导切片，匹配用 node:path 的 matchesGlob；CI 侧 dorny/paths-filter
  // 用 picomatch（dot:true）。两者只在两处分歧：`!` 否定前缀与扩展语法（{a,b} / ? / [abc]），
  // 以及路径中的点号段。分歧方向是「本地少跑」= 本地绿而 CI 红，正是本地快线存在的意义所在，
  // 所以不许出现——收窄白名单（#742 阶段 2.1）后 glob 数量从 9 条涨到 45 条，这个守卫必须显式。
  const filters = parseFilterBlock(CI_YML);
  const exotic = [];
  for (const [face, globs] of Object.entries(filters)) {
    for (const g of globs) {
      if (/^!/.test(g) || /[{}?[\]]/.test(g)) exotic.push(`${face}: ${g}`);
    }
  }
  assert.deepEqual(
    exotic,
    [],
    "filters 出现否定前缀或扩展 glob 语法——两套匹配器语义分歧，本地切片会静默少跑",
  );
  // 点号段（如 packages/x/.y）：picomatch({dot:true}) 命中而 matchesGlob 不命中，同一类分歧
  const dotted = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f.includes("/."));
  assert.deepEqual(
    dotted,
    [],
    "tracked 文件里出现点号开头的中段路径——两套 glob 引擎对它的判定不同，需先显式裁决再提交",
  );
});

test("matchFilterBlock：包内改动命中该包；全局面命中 global；纯文档两者都不命中", () => {
  const filters = parseFilterBlock(CI_YML);
  assert.deepEqual(matchFilterBlock(filters, ["packages/dsh-notifier/src/text/sanitize.ts"]), {
    globalHit: false,
    packages: ["dsh-notifier"],
  });
  assert.deepEqual(matchFilterBlock(filters, ["pnpm-lock.yaml"]), {
    globalHit: true,
    packages: [],
  });
  assert.deepEqual(matchFilterBlock(filters, ["docs/DEVELOPMENT.md", "AGENTS.md"]), {
    globalHit: false,
    packages: [],
  });
  // 段配置是变异单一事实源（#322）：改段配置必须命中该包
  assert.deepEqual(matchFilterBlock(filters, ["stryker.conf.d/dsh-lan-proxy-config.json"]), {
    globalHit: false,
    packages: ["dsh-lan-proxy"],
  });
});

test("planChangedScope：全局面命中回退全量；单包改动只命中该包；解析失败回退全量", () => {
  const allPackages = ["dsh-lan-proxy", "dsh-notifier", "dsh-plugins-all"];

  const scoped = planChangedScope({
    root: ROOT,
    files: ["packages/dsh-lan-proxy/src/server/proxy/impl/proxy.ts"],
    allPackages,
  });
  assert.deepEqual(scoped.hitPackages, ["dsh-lan-proxy"]);
  assert.equal(scoped.globalHit, false);

  const global = planChangedScope({
    root: ROOT,
    files: ["scripts/gate/local-gate.mjs"],
    allPackages,
  });
  assert.deepEqual(
    global.hitPackages,
    allPackages,
    "改 scripts/gate/** 必须回退全量（本地快线覆盖不到门禁脚本本体）",
  );
  assert.equal(global.globalHit, true);

  // #742 阶段 2.1：整树 scripts/** 收窄为白名单后，白名单外的 scripts 条目不再升级为全量
  // （它们的消费方是每个 PR 都常驻的静态闸，见 scripts/data/ci-face-registry.json 的豁免条目）
  const exempt = planChangedScope({
    root: ROOT,
    files: ["scripts/maintenance/scan-actions-concurrency.mjs"],
    allPackages,
  });
  assert.deepEqual(
    exempt.hitPackages,
    [],
    "白名单外的 scripts 条目（如 scripts/maintenance/**）不得再回退全量——收窄的意义就在这里",
  );
  assert.equal(exempt.globalHit, false);

  // 解析失败：临时根里放一份没有 filters 块的 workflow
  const tmpRoot = mkdtempSync(join(tmpdir(), "local-scope-"));
  try {
    mkdirSync(join(tmpRoot, ".github", "workflows"), { recursive: true });
    writeFileSync(join(tmpRoot, CI_WORKFLOW), "name: CI\non:\n  pull_request:\n", "utf8");
    const broken = planChangedScope({
      root: tmpRoot,
      files: ["packages/dsh-lan-proxy/src/server/proxy/impl/proxy.ts"],
      allPackages,
    });
    assert.deepEqual(broken.hitPackages, allPackages, "filters 不可解析 → 全量（fail-closed）");
    assert.equal(broken.escalated, true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("#742 2.1: 本地快线升档判据（全局面 + 空切片的非文档改动升档，纯文档不升）", () => {
  const esc = shouldEscalateChangedTier;
  assert.equal(
    esc({ globalHit: true, hitPackages: [], files: ["docs/a.md"] }),
    true,
    "命中全局面必须升档——本地快线覆盖不到静态闸",
  );
  assert.equal(
    esc({
      globalHit: false,
      hitPackages: ["dsh-notifier"],
      files: ["packages/dsh-notifier/src/a.ts"],
    }),
    false,
    "有命中包面就走快线，不升档",
  );
  assert.equal(
    esc({
      globalHit: false,
      hitPackages: [],
      files: ["scripts/maintenance/scan-actions-concurrency.mjs"],
    }),
    true,
    "白名单外的 scripts 条目必须升档：收窄前它们命中的是全局面，若本地就此 exit 0，" +
      "「本地绿而 CI 红」就回来了（消费方是 CI 上恒跑的 lint/format/test:scripts）",
  );
  assert.equal(
    esc({
      globalHit: false,
      hitPackages: [],
      files: ["scripts/test/foo.test.ts", "tools/lint/bin/lint.mjs"],
    }),
    true,
    "其它豁免条目同理（scripts/test/**、tools/**）",
  );
  assert.equal(
    esc({
      globalHit: false,
      hitPackages: [],
      files: ["docs/a.md", "README.md", ".dsh/skills/x/SKILL.md"],
    }),
    false,
    "纯文档 diff 不升档（收窄前也不命中任何面，不是本次引入的落差）",
  );
  assert.equal(esc({ globalHit: false, hitPackages: [], files: [] }), false, "空 diff 不升档");
  assert.equal(
    esc({ globalHit: false, hitPackages: [], files: null }),
    false,
    "取不到文件清单时不升档（该路径已 fail-closed 回退全量包，快线照样跑全包）",
  );
});
