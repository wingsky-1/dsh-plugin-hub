#!/usr/bin/env node
/**
 * scripts/gate/mutation-ledger.mjs —— 变异段实测台账的生成与校验（#718 S0.2）。
 *
 * 定位：**维护者/本地工具，不进 CI**。生成模式要拉 Actions run 日志（需要 gh 与网络），
 * 而入库台账的校验（--check）是离线的、由 test:scripts 调用。之所以不做成 CI 采集步骤：
 * 那会改动 `.github/workflows/`（红线段），而本项是零红线的测量任务。
 *
 * 台账的唯一可信量是 `wallSeconds`：**段执行时间**取自 run 日志，而不是段配置文件的时间戳
 * （基线文件的 mtime 会被写入方刷新成「刚刚」——已退役的增量班次每次都会重写全部段文件，
 * 如今的沿用段虽保留远端 manifest 条目，但文件时间戳本身仍无法区分「真的重测过」与「只是被
 * 重写」）。日志有两种载体形态，解析器都要认（见 `mutation-ledger-lib.mjs`）：
 *   - group 形态（#718 S1.1 之前的串行班）：`##[group]stryker <seg>` 与配对 `##[endgroup]`；
 *   - 矩阵形态（S1.1 之后，每段一个独立 job）：job 名 `Mutation shard (<seg>)` + 段内输出特征。
 *
 * 生成时**排除结论非 success 的 shard**：被杀实例的日志只到中途，采信它会系统性低估耗时
 * （实测 run 34681565987 的 events / server 即如此），而低估是超时定标里最危险的方向。
 *
 * 用法：
 *   gh run view <run-id> --log > /tmp/observe.log          # 生成模式需 gh 与网络，故不进 CI
 *   node scripts/gate/mutation-ledger.mjs --run <id> --from-log /tmp/observe.log \
 *        [--workflow <name>] --scope <full|incremental> --write
 *   node scripts/gate/mutation-ledger.mjs --check      # 离线校验入库台账（覆盖全部段 + 字段完整）
 *
 * `--run` 与 `--from-log` 都是必填：前者是台账的幂等键（同一 run 重跑是替换而非追加），后者是
 * 数据来源——解析器只认日志，不认工作区文件时间戳（见上）。
 *
 * 退出码：0 = 通过；1 = 校验失败；2 = 环境/用法错误。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkLedgerEntry,
  expectedSegsFromConfFiles,
  parseSegmentLedger,
} from "../lib/mutation-ledger-lib.mjs";
import { failClosed } from "../lib/gate-exit.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONF_DIR = join(ROOT, "stryker.conf.d");
const LEDGER_PATH = join(ROOT, "scripts", "data", "mutation-segment-ledger.json");
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

function currentSegs() {
  return expectedSegsFromConfFiles(readdirSync(CONF_DIR));
}

/** 台账的段索引：测量值 ∪ 显式登记为「尚未测到」的段（两者共同构成「覆盖全部段」）。 */
export function ledgerCoverage(ledger) {
  const measured = new Set();
  for (const m of ledger.measurements ?? []) for (const s of m.segments ?? []) measured.add(s.seg);
  const unmeasured = new Set(Object.keys(ledger.unmeasured ?? {}));
  return { measured, unmeasured, all: new Set([...measured, ...unmeasured]) };
}

/** 覆盖全部段：既无测量值、又未登记进 unmeasured 的段逐个报出。 */
function collectCoverageProblems(expectedSet, all) {
  const problems = [];
  for (const s of expectedSet)
    if (!all.has(s)) problems.push(`台账未覆盖段：${s}（既无测量值，也未登记进 unmeasured）`);
  return problems;
}

/** 游离段（当前 stryker.conf.d 已无）必须显式登记取代关系，否则段集合脱节会静默存在。 */
function collectOrphanProblems(expectedSet, all, superseded) {
  const problems = [];
  for (const s of all) {
    if (expectedSet.has(s)) continue;
    // 段被拆分/更名后，历史测量值仍有对照价值，故不要求删除；但必须显式登记取代关系，
    // 否则「段集合与 stryker.conf.d 脱节」这件事会静默存在（漏段的反面同样危险）。
    const sup = superseded[s];
    if (sup === undefined) {
      problems.push(
        `台账存在游离段：${s}（当前 stryker.conf.d 已无该段；若已被拆分/更名，请在 superseded 登记取代关系）`,
      );
      continue;
    }
    problems.push(...collectSupersededProblems(s, sup, expectedSet));
  }
  return problems;
}

/** superseded 条目的字段完整性：replacedBy 非空、指向现存段、reason 非空。 */
function collectSupersededProblems(s, sup, expectedSet) {
  const problems = [];
  if (!Array.isArray(sup.replacedBy) || sup.replacedBy.length === 0)
    problems.push(`superseded.${s} 缺少 replacedBy`);
  for (const r of sup.replacedBy ?? []) {
    if (!expectedSet.has(r)) problems.push(`superseded.${s}.replacedBy 指向当前不存在的段：${r}`);
  }
  if (typeof sup.reason !== "string" || sup.reason.trim() === "")
    problems.push(`superseded.${s} 缺少 reason`);
  return problems;
}

/** 测量值与 unmeasured 的语义冲突，以及 unmeasured 缺理由。 */
function collectUnmeasuredProblems(ledger, measured, unmeasured) {
  const problems = [];
  for (const s of measured)
    if (unmeasured.has(s)) problems.push(`段 ${s} 同时出现在测量值与 unmeasured 中（语义冲突）`);
  for (const [s, reason] of Object.entries(ledger.unmeasured ?? {})) {
    if (typeof reason !== "string" || reason.trim() === "")
      problems.push(`unmeasured.${s} 缺少理由（必须写明为何尚无测量值）`);
  }
  return problems;
}

/** measurements 每条记录的字段完整性与段内不重复。 */
function collectMeasurementProblems(measurements) {
  const problems = [];
  for (const m of measurements) {
    const runId = m.run?.id;
    if (typeof runId !== "number") problems.push("measurements 条目缺少 run.id");
    if (typeof m.scope !== "string" || m.scope.trim() === "")
      problems.push(`run ${runId}: scope 缺失`);
    const segs = m.segments ?? [];
    if (segs.length === 0) problems.push(`run ${runId}: segments 为空`);
    const seen = new Set();
    for (const s of segs) {
      if (seen.has(s.seg)) problems.push(`run ${runId}: 段 ${s.seg} 重复登记`);
      seen.add(s.seg);
      problems.push(...checkLedgerEntry(s).map((p) => `run ${runId}: ${p}`));
    }
  }
  return problems;
}

/** 离线校验：覆盖全部段（不漏不重）+ 每条记录字段完整 + unmeasured 必有理由 + 游离段必有 superseded 登记。 */
export function checkLedger(ledger, expected) {
  const { measured, unmeasured, all } = ledgerCoverage(ledger);
  const expectedSet = new Set(expected);
  const superseded = ledger.superseded ?? {};
  return [
    ...collectCoverageProblems(expectedSet, all),
    ...collectOrphanProblems(expectedSet, all, superseded),
    ...collectUnmeasuredProblems(ledger, measured, unmeasured),
    ...collectMeasurementProblems(ledger.measurements ?? []),
  ];
}

function ghRunMeta(runId) {
  try {
    return JSON.parse(
      execFileSync(
        "gh",
        [
          "run",
          "view",
          String(runId),
          "--repo",
          "wingsky-1/dsh-plugin-hub",
          "--json",
          "databaseId,name,event,conclusion,createdAt,headSha",
        ],
        { encoding: "utf8" },
      ),
    );
  } catch (e) {
    failClosed(`[ledger] 读取 run ${runId} 元数据失败：${String(e.message).split("\n")[0]}`);
  }
}

/**
 * 该 run 里结论非 success 的 shard 段名集合（其日志只到中途，耗时不可作实测）。
 * 对 group 形态（#718 S1.1 之前的单 job 串行班）job 名不匹配，返回空集——旧路径不受影响。
 */
function incompleteShardSegs(runId) {
  try {
    const d = JSON.parse(
      execFileSync(
        "gh",
        ["api", `repos/wingsky-1/dsh-plugin-hub/actions/runs/${runId}/jobs?per_page=100`],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      ),
    );
    const out = new Set();
    for (const j of d.jobs ?? []) {
      if (j.conclusion === "success") continue;
      const m = /^Mutation shard \((.+)\)$/.exec(j.name ?? "");
      if (m !== null) out.add(m[1]);
    }
    return out;
  } catch (e) {
    failClosed(`[ledger] 读取 run ${runId} 的 job 列表失败：${String(e.message).split("\n")[0]}`);
  }
}

/** --check 模式：校验入库台账并打印覆盖统计。 */
function runCheck() {
  if (!existsSync(LEDGER_PATH)) {
    console.error(`[ledger] 台账不存在：${LEDGER_PATH}`);
    return 2;
  }
  const problems = checkLedger(JSON.parse(readFileSync(LEDGER_PATH, "utf8")), currentSegs());
  for (const p of problems) console.error(`[ledger] ${p}`);
  if (problems.length > 0) {
    console.error(`[ledger] --check 失败：${problems.length} 项（拆段/加包后必须重测并更新台账）`);
    return 1;
  }
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  const { measured, unmeasured } = ledgerCoverage(ledger);
  const cur = new Set(currentSegs());
  const historical = [...measured].filter((s) => !cur.has(s));
  console.log(
    `[ledger] --check 通过：覆盖全部 ${cur.size} 段` +
      `（已测 ${[...measured].filter((s) => cur.has(s)).length} + 待测 ${unmeasured.size}）` +
      (historical.length > 0 ? `；历史段 ${historical.length} 条已在 superseded 登记取代关系` : ""),
  );
  return 0;
}

/** 生成模式的必填参数：缺失或取值非法都是用法错误（退出码 2），不进入采集。 */
function resolveRunArgs() {
  const runId = opt("--run");
  const fromLog = opt("--from-log");
  if (runId === undefined || fromLog === undefined) {
    console.error(
      "用法：--run <id> --from-log <path> [--workflow <name>] --scope <full|incremental> --write",
    );
    return null;
  }
  const scope = opt("--scope");
  if (scope !== "full" && scope !== "incremental") {
    console.error("[ledger] --scope 必须是 full 或 incremental（口径必须显式，否则耗时不可比）");
    return null;
  }
  return { runId, fromLog, scope };
}

/** 组装本次实测条目；结论非 success 的 shard 先排除（理由见下）。 */
function buildLedgerEntry(runId, scope, parsed) {
  const meta = ghRunMeta(runId);
  // 未完成的段不得当实测写入：被 timeout 杀掉的 shard 也会留下日志（跑到 N% 就断），
  // 直接采信会把「未跑完的时间」当成该段的耗时，系统性**低估**——而这正是超时定标里
  // 最危险的方向（实测 run 34681565987 的 events / server 即如此）。故按 job 结论过滤。
  const incomplete = incompleteShardSegs(runId);
  const segments = parsed.filter((s) => !incomplete.has(s.seg));
  for (const s of parsed) {
    if (incomplete.has(s.seg)) {
      console.error(
        `[ledger] 排除未完成段 ${s.seg}（job 非 success：日志只到中途，时间不可作为实测）`,
      );
    }
  }
  return {
    run: {
      id: meta.databaseId,
      workflow: opt("--workflow") ?? meta.name,
      event: meta.event,
      conclusion: meta.conclusion,
      createdAt: meta.createdAt,
      headSha: meta.headSha,
    },
    scope,
    measuredAt: new Date().toISOString(),
    logSource: `gh run view ${runId} --log`,
    segments,
  };
}

/** 同一 run 幂等替换：先删旧条目再按 run.id 排序，已覆盖的段从 unmeasured 移除。 */
function mergeLedgerEntry(ledger, entry) {
  ledger.measurements = (ledger.measurements ?? []).filter((m) => m.run?.id !== entry.run.id);
  ledger.measurements.push(entry);
  const covered = new Set(entry.segments.map((s) => s.seg));
  for (const s of covered) delete ledger.unmeasured[s];
  ledger.measurements.sort((a, b) => (a.run?.id ?? 0) - (b.run?.id ?? 0));
}

/** 落盘（--write）或打印条目，随后复用 --check 的校验口径给出退出码。 */
function emitLedger(ledger, entry, scope) {
  if (argv.includes("--write")) {
    writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n", "utf8");
    console.log(
      `[ledger] 已写入 ${LEDGER_PATH}：run ${entry.run.id} ${entry.segments.length} 段（scope=${scope}）`,
    );
  } else {
    console.log(JSON.stringify(entry, null, 2));
  }
  const problems = checkLedger(ledger, currentSegs());
  for (const p of problems) console.error(`[ledger] ${p}`);
  return problems.length === 0 ? 0 : 1;
}

function runGenerate() {
  const args = resolveRunArgs();
  if (args === null) return 2;
  const logText = readFileSync(args.fromLog, "utf8");
  const parsed = parseSegmentLedger(logText);
  if (parsed.length === 0) {
    console.error(
      `[ledger] 日志中未解析到任何 stryker 段：${args.fromLog}（run 未跑变异，或日志格式已变）`,
    );
    return 2;
  }
  const entry = buildLedgerEntry(args.runId, args.scope, parsed);
  const ledger = existsSync(LEDGER_PATH)
    ? JSON.parse(readFileSync(LEDGER_PATH, "utf8"))
    : { $comment: "", measurements: [], unmeasured: {} };
  mergeLedgerEntry(ledger, entry);
  return emitLedger(ledger, entry, args.scope);
}

function main() {
  if (argv.includes("--check")) return runCheck();
  return runGenerate();
}

// CLI 守卫：被测试 import 时（argv[1] 不是本文件）不得执行 main，避免测试进程被 exit 带走。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
