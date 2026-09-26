#!/usr/bin/env node
"use strict";

/**
 * scripts .mjs 冻结守卫（#776 checkJs 落点）。
 *
 * 为什么存在：全量 checkJs 已裁决不做（38 个.mjs 系运行时垫片，649 条多为缺 JSDoc
 * 非真实缺陷，大爆炸修复违反增量纪律），替代落点是「冻结+触达即转，不单独立项追踪
 * 转.ts 计数」。本守卫即冻结侧：scripts/ 下的 .mjs 清单被冻结为 ALLOWLIST 常量，
 * 新增 .mjs 不登记即红；存量 .mjs 的转写（触达即转）发生时同步更新本清单（删旧条目）。
 *
 * 基线说明：任务书快照为 38 个，现 HEAD（6de1fd2c 起）实测为 53 个（git ls-tree
 * 枚举，见下），15 个增量同样冻结——38 是裁决时数，不是本文件的断言数。
 *
 * 为什么枚举 git ls-tree 又兼顾磁盘：git ls-tree 是「已提交清单」的权威答案（PR
 * 上新增已提交 .mjs 必在此出现）；磁盘枚举（walkFiles）另覆盖「新增未 git add」
 * 的本地形态，否则故意漏登记一新文件的改坏试验在本地恒绿。两者都与 ALLOWLIST
 * 比对，任一方向差集即红。
 *
 * 为什么薄垫片含量不做自动化断言：.mjs 有大有小（门禁判据实现数百行、lib 小到
 * 29 行），行数/内容形态与「是否该转.ts」无关，转写时机由 PR 人工评审 gate
 * 判定（改到哪个 .mjs 就转写为 .ts），本守卫只冻「集合」，不判「含量」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, sep } from "node:path";
import { walkFiles } from "../lib/walk-files.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPTS = join(ROOT, "scripts");

const isMjs = (name: string): boolean => name.endsWith(".mjs");
const toPosix = (p: string): string => p.split(sep).join("/");

/**
 * 冻结清单：key 为仓库根相对 posix 路径（scripts\/…\.mjs），value 为存在理由（一句）。
 * 新增 .mjs 必须在此登记理由；转写为 .ts 时删除对应条目。理由只说明「为什么它现在
 * 还是 .mjs」（loader 直跑/被直引），不承诺转写顺序。
 */
const ALLOWLIST: Record<string, string> = {
  "scripts/ci/changed-test-packages.mjs":
    "Stryker static-mutant 盲区处置：test 变更主动失效基线，以 .mjs 由变异链路 loader 直跑",
  "scripts/ci/ci-matrix.mjs":
    "CI 矩阵派生（包切片+逐段超时），以 .mjs 被 ci.yml 与本地门禁 loader 直引",
  "scripts/derive/host-contract.mjs": "宿主契约离线派生诊断工具（不进门禁），以 .mjs 零依赖直跑",
  "scripts/gate/baseline-archive.mjs":
    "变异基线归档纯函数面（分页取全+对账），以 .mjs 供 overlay 复用的 loader 库",
  "scripts/gate/baseline-push.mjs":
    "归档分支写路径共用管线（孤立 commit+租约推送），以 .mjs 被两写入方直引",
  "scripts/gate/collect-exemptions.mjs":
    "豁免到期台账收集器（reviewBy/exitCriteria 扫描），以 .mjs 在全量档 loader 直跑",
  "scripts/gate/crap-check.mjs":
    "单函数 CRAP 检查（src 口径），以 .mjs 在夜间与 gate:full loader 直跑",
  "scripts/gate/export-surface-snapshot.mjs":
    "包导出面快照门禁（tsc declaration 基线比对），以 .mjs 为判据 loader 入口",
  "scripts/gate/forbid-homedir-src.mjs":
    "B5 homedir 门禁（AST 禁 src 直连 HOME），以 .mjs 为判据 loader 入口",
  "scripts/gate/forbid-module-state-src.mjs":
    "模块级可变状态门禁（AST 扫顶层 let/var），以 .mjs 为判据 loader 入口",
  "scripts/gate/forbid-raw-exit2.mjs":
    "门禁故障码唯一出口判据（禁裸 exit 2），以 .mjs 为判据 loader 入口",
  "scripts/gate/forbid-src-tests.mjs":
    "遗留 .src.test.ts 禁止门禁（防双份回潮），以 .mjs 被 CI 与本地复用的 loader",
  "scripts/gate/gate-steps.mjs":
    "本地门禁档位→步骤表纯函数单一来源，以 .mjs 供接线断言直引的无副作用模块",
  "scripts/gate/gen-stryker-conf.mjs":
    "Stryker 配置派生与 stryker:check 门禁入口，以 .mjs 为变异链路 loader",
  "scripts/gate/local-gate.mjs":
    "本地门禁分层执行器（changed/pr/full），以 .mjs 为 pnpm gate:* loader 入口",
  "scripts/gate/local-scope.mjs":
    "改动→本地包切片纯函数（只读 ci.yml filters），以 .mjs 被门禁 loader 直引",
  "scripts/gate/mutation-gate.mjs":
    "PR 增量变异率判分（与夜间共用统计库），以 .mjs 为判据 loader 入口",
  "scripts/gate/mutation-ledger.mjs": "变异段实测台账生成与校验，以 .mjs 为台账链路 loader 入口",
  "scripts/gate/mutation-plan.mjs": "夜间变异矩阵段清单与超时派生，以 .mjs 供 observe 动态矩阵直引",
  "scripts/gate/mutation-topology.mjs":
    "变异拓扑登记形状判据共享模块，以 .mjs 被派生与门禁直引的库",
  "scripts/gate/observe-check.mjs": "夜间观察报告阈值校验与回落检测，以 .mjs 为判据 loader 入口",
  "scripts/gate/orphan-baseline.mjs":
    "变异基线孤立分支管理（读/并集写/清理），以 .mjs 为基线链路 loader",
  "scripts/gate/overlay-baseline.mjs":
    "PR 合入后增量基线秒级覆盖同步，以 .mjs 为 overlay 链路 loader",
  "scripts/gate/red-line-approval.mjs":
    "红线路径人工批准判据（approved 留痕），以 .mjs 为 CI 判据 loader 入口",
  "scripts/gate/repo-gate-assert.mjs":
    "repo-gate 聚合闸 fail-closed 判定，以 .mjs 为聚合判据 loader",
  "scripts/gate/test-surface.mjs":
    "测试面层→文件清单→--min 纯函数（派生库），以 .mjs 被 gen 链路直引",
  "scripts/gate/threshold-monotonic.mjs":
    "阈值单调性校验（声明表驱动），以 .mjs 为判据 loader 入口",
  "scripts/gate/verify-coverage-scope.mjs":
    "覆盖率面 include/exclude 完整性判据，以 .mjs 为判据 loader 入口",
  "scripts/gate/verify-dir-imports.mjs":
    "目录 interface.ts 门面与依赖图判据，以 .mjs 为判据 loader 入口",
  "scripts/gate/verify-host-seams.mjs": "宿主接缝结构门禁（R1-R4），以 .mjs 为判据 loader 入口",
  "scripts/gate/verify-prose-counts.mjs":
    "散文段数一致性判据（拓扑 vs gauntlet），以 .mjs 为判据 loader 入口",
  "scripts/gate/verify-provider-usage-shape.mjs":
    "provider-usage 源码形态锁，以 .mjs 为判据 loader 入口",
  "scripts/gate/verify-scripts-index.mjs":
    "README 索引存在性与引用即登记判据，以 .mjs 为判据 loader 入口",
  "scripts/gate/verify-shared-fanin.mjs": "shared 跨包扇入判据，以 .mjs 为判据 loader 入口",
  "scripts/gate/verify-vendored-binaries.mjs":
    "发布物 vendored 二进制登记判据，以 .mjs 为判据 loader 入口",
  "scripts/lib/ci-ism-denylist.mjs": "CI-ism 未跟踪文件判据库，以 .mjs 被门禁 loader 直引",
  "scripts/lib/gate-endpoints.mjs":
    "判据接线解析层（别名→脚本身份归一），以 .mjs 被接线断言直引的库",
  "scripts/lib/gate-exit.mjs": "门禁自身故障唯一退出口 failClosed，以 .mjs 被全部门禁直引的库",
  "scripts/lib/glob-files.mjs": "仓库根锚定 glob 展开库，以 .mjs 被派生链路直引",
  "scripts/lib/mutation-ledger-lib.mjs": "变异台账日志解析与对账库，以 .mjs 被台账链路直引",
  "scripts/lib/mutation-report-lib.mjs": "Stryker 报告统计单一事实源库，以 .mjs 被判分两侧直引",
  "scripts/lib/threshold-registry.mjs": "阈值声明表读取与自洽校验库，以 .mjs 被单调性判据直引",
  "scripts/lib/vendored-binaries-lib.mjs":
    "vendored 分发面判定与内容嗅探库，以 .mjs 被三处判据共用的库",
  "scripts/maintenance/repair-mcp-catalog-sessions.mjs":
    "一次性修复：dsh 升级后 mcp-catalog 会话修复，以 .mjs 手工直跑的维护脚本",
  "scripts/maintenance/migrate-plugin-rows.mjs":
    "一次性 profile row identity 迁移（dry-run/apply/备份），以 .mjs 手工直跑的维护脚本",
  "scripts/maintenance/scan-actions-concurrency.mjs":
    "Actions 并发峰值扫描诊断工具，以 .mjs 手工直跑的维护脚本",
  "scripts/maintenance/upstream-contract-warn.mjs":
    "上游消解 warn-job（只 warn 不阻塞），以 .mjs 为独立 job loader",
  "scripts/release/baseline-staleness.mjs":
    "变异基线新鲜度观测判据（48h 阈值），以 .mjs 为周报链路 loader",
  "scripts/release/collect-tgz-evidence.mjs":
    "发布证据链（pack+SHA256SUMS），以 .mjs 为发布链路 loader",
  "scripts/release/health-report-body.mjs": "健康报告机器信号段生成库，以 .mjs 被周报链路直引",
  "scripts/release/observe-precheck.mjs":
    "发版前置 observe 成功收口校验，以 .mjs 为发布门禁 loader",
  "scripts/test/mutation-probe.mjs": "变异度量可信度探针（覆盖分辨率边界），以 .mjs 直接探针直跑",
  "scripts/test/run-vitest.mjs":
    "vitest 包装（恢复 --min 文件数判据防假绿），以 .mjs 为包级 test loader",
  "scripts/test/script-test-prereqs.mjs":
    "test:scripts 编译产物前置包清单（CI 与本地同源），以 .mjs 被门禁直引的库",
};

test("scripts .mjs 冻结：git ls-tree 与磁盘枚举都必须等于 ALLOWLIST（#776 落点）", () => {
  const allowKeys: string[] = Object.keys(ALLOWLIST).sort();
  assert.ok(allowKeys.length > 0, "ALLOWLIST 为空：冻结清单退化为恒真（假绿）");
  const emptyReason: string[] = allowKeys.filter((k: string) => ALLOWLIST[k].trim().length === 0);
  assert.deepEqual(
    emptyReason,
    [],
    "下列 ALLOWLIST 条目缺存在理由（一句）：\n" + emptyReason.join("\n"),
  );
  const badSuffix: string[] = allowKeys.filter(
    (k: string) => !k.endsWith(".mjs") || !k.startsWith("scripts/"),
  );
  assert.deepEqual(
    badSuffix,
    [],
    "下列 ALLOWLIST 键形态非法（必须 scripts\/…\.mjs）：\n" + badSuffix.join("\n"),
  );

  // 磁盘枚举：覆盖未 git add 的新增文件（否则本地改坏试验恒绿）。
  const onDisk: string[] = walkFiles(SCRIPTS, isMjs)
    .map((rel: string) => "scripts/" + rel)
    .sort();
  assert.ok(onDisk.length > 0, "磁盘枚举为空（walkFiles 失效）：冻结判据退化为恒真（假绿）");
  const unregisteredDisk: string[] = onDisk.filter((p: string) => !(p in ALLOWLIST));
  assert.deepEqual(
    unregisteredDisk,
    [],
    "下列磁盘 .mjs 未在 ALLOWLIST 登记（新增 .mjs 请登记理由；触达即转时删旧条目）：\n" +
      unregisteredDisk.join("\n"),
  );
  const stale: string[] = allowKeys.filter((p: string) => !onDisk.includes(p));
  assert.deepEqual(
    stale,
    [],
    "下列 ALLOWLIST 条目在磁盘已不存在（转写为 .ts 或删除后请同步删条目）：\n" + stale.join("\n"),
  );

  // git 枚举：已提交清单的权威答案（PR 上新增已提交 .mjs 必在此出现）。
  const gitResult = spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", "scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.strictEqual(
    gitResult.status,
    0,
    "git ls-tree 执行失败（exit=" +
      String(gitResult.status) +
      "）——冻结枚举不可信：\n" +
      String(gitResult.stderr),
  );
  const gitMjs: string[] = String(gitResult.stdout)
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.endsWith(".mjs"))
    .map((line: string) => toPosix(line))
    .map((p: string) => (p.startsWith("./") ? p.slice(2) : p))
    .filter((line: string) => line.startsWith("scripts/"))
    .sort();
  const normalizedGitMjs: string[] = gitMjs;
  assert.ok(
    normalizedGitMjs.length > 0,
    "git 枚举为空（ls-tree 失效）：冻结判据退化为恒真（假绿）",
  );
  const unregisteredGit: string[] = normalizedGitMjs.filter((p: string) => !(p in ALLOWLIST));
  assert.deepEqual(
    unregisteredGit,
    [],
    "下列 git 已提交 .mjs 未在 ALLOWLIST 登记（新增 .mjs 请登记理由）：\n" +
      unregisteredGit.join("\n"),
  );
});
