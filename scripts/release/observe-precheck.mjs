#!/usr/bin/env node
/**
 * 发版前置校验：最近是否有**成功收口**的 observe 夜班（#843 R-2 / D4）。
 *
 * ── 判定口径：为什么是「窗口内至少一次 success」──────────────────────────────────
 * observe.yml 是**每日夜间全量班**（cron `0 20 * * *`；实测 run 创建落在 21:53~23:00 UTC），
 * 变异基线 `baseline/mutation` 由它在收口 job 里并集入档。故「基线是否新鲜」最强的一条可机检
 * 证据就是「最近一期夜班是否成功收口」。本脚本据此取**时间窗**口径：
 *
 *   在 `now - maxAgeHours`（默认 24 h）之后**收口**（`updated_at`）的 run 里，至少有一条
 *   `conclusion == "success"`。
 *
 * 三个候选口径的取舍（另两个被否决，理由本身是判据的一部分）：
 *   - 「最近一次 run 是否 success」：否决。observe 是 90 分钟级的重班，且调度延迟实测可达数
 *     小时，单个 run 被 cancelled / 排队超时被杀是常态；只看最近一次会把「上一夜刚成功、
 *     本夜正在跑」这种健康形态误伤。
 *   - 「与目标 commit 同一次」：否决。schedule 触发的 run 的 head_sha 是**触发时刻的 main
 *     HEAD**，而发版 tag 指向版本提交，两者天然几乎不可能相同 ⇒ 判据恒红、只能靠 override，
 *     等于没有判据；且基线写入走的是孤立分支的 tip，与发布 commit 本无对应关系。
 *   - 「最近 N 次内有 success」（计数口径）：否决。计数在**班次停摆**时假绿——日程被禁用后，
 *     最近 N 次全是历史 success，窗口外照样放行；时间窗把「停摆」直接判红。这与本仓
 *     `baseline-staleness.mjs` 的教训同源（代理指标必须在停摆形态下也判红）。
 *   - 「时间窗」：采用。它把「最近一期夜班是否成功收口」写成可判定的量，停摆与连续失败都会
 *     让龄越过窗口。代价是一条**已知且刻意保留**的保守边界：实测相邻成功收口的最大间隔
 *     24 h 37 min（run 78 收口 2026-09-13T22:44:53Z → run 79 收口 2026-09-14T23:22:06Z），
 *     故每天存在最长约 40 分钟的窄带（上一夜成功已满 24 h、当晚班次尚未收口）会判红。那一刻
 *     确实**没有**「最近一期夜班成功」的证据，fail-closed 是正确取向；处置是等班次收口，或走
 *     override。`--max-age-hours` 可调，但调宽等于接受「漏一夜也算新鲜」，改时请连同实测数据
 *     一起改。
 *
 * 边界语义沿用 `baseline-staleness.mjs` 的约定：龄**恰好等于**窗口即判陈旧——阈值是允许的
 * 最大龄，到达上界就该拦。
 *
 * 判定面 = 最近 `--per-page`（默认 30）次 run：夜班实测约 1 次/日 + 偶发 dispatch，30 条足以
 * 覆盖 24 h 窗口；不做服务端 `created` 过滤，是为了让「取回来的原始响应」与判定输入同形，
 * 便于用 `--runs-file` 复跑取证。手动 dispatch 的 run 同样计入：它跑的是**同一条全量管线**、
 * 同样并集入档基线分支，是等价的「基线已刷新」证据，故不按 event 过滤。
 *
 * ── 失败语义：fail-closed ──────────────────────────────────────────────────────
 * 「没有基线新鲜度的证据」与「证据显示不新鲜」都不放行，且**一切取数 / 解析失败一律判红**：
 *   - gh api 失败（401/403/404、网络、gh 未登录、本机无 gh）；
 *   - 响应不是合法 JSON、缺 `workflow_runs` 数组、或 run 列表为空；
 *   - run 条目损坏（非对象、时间戳不可解析、success 缺收口时刻）。
 * 退出码：0 = 放行；1 = 不放行（陈旧 / 无成功 / 无 run / 取数失败，一律 fail-closed）；
 *         2 = **参数非法**（未知 flag、`--max-age-hours` 非正数、`--per-page` 越界）。2 与 1
 *             分开是为了在 Actions 上一眼区分「判据拦下发布」与「workflow 把参数写错了」。
 *
 * ── override 逃生口（风险说明）─────────────────────────────────────────────────
 * `--override` 直接放行且**不取任何数据**（API 自身故障时也要能用），只打印 `::warning::`。
 * 有两个入口，语义完全相同：
 *   - CLI `--override`（本地取证 / 手动跑）；
 *   - 环境变量 `SKIP_OBSERVE_CHECK=true`——release.yml 的判据步骤把
 *     `workflow_dispatch.inputs.skip_observe_check` 接到它上面。为什么走环境变量而不是在
 *     workflow 里写 shell 分支：那一步必须保持「一条直接命令」的闭合形态（gate-wiring 的
 *     形态断言如此要求，理由是该形态不给「静默关掉判据」留余地），分支逻辑因此落在脚本里。
 *     只认字面量 `"true"`：值写歪（`yes` / `1`）不生效，方向偏保守。
 * 它对应 release.yml 的 `workflow_dispatch.inputs.skip_observe_check`：紧急修复时在 GitHub UI
 * 手动 dispatch 本 workflow、ref 选**要发布的那个 v* tag** 才能绕过。风险与义务：绕过即在
 * 「变异基线可能陈旧」的前提下发布，发布者必须在该版本的 PR / release notes / 发布记录里写明
 * 理由（为什么急、为什么不新鲜、何时补跑 observe），并在当天补跑一次 observe.yml。把 override
 * 当常规通道，会让本判据退化成装饰——它的价值全在「默认路径真的会拦」。
 *
 * 用法：node scripts/release/observe-precheck.mjs [--workflow observe.yml] [--max-age-hours 24]
 *       [--per-page 30] [--repo owner/name] [--runs-file <json>] [--now <iso>] [--override]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { failClosed } from "../lib/gate-exit.mjs";

export const DEFAULT_WORKFLOW = "observe.yml";
export const DEFAULT_MAX_AGE_HOURS = 24;
export const DEFAULT_PER_PAGE = 30;

/** override 的环境变量入口（release.yml 的判据步骤用它接 workflow_dispatch 输入）。 */
export const OVERRIDE_ENV = "SKIP_OBSERVE_CHECK";

/** gh api 的仓库占位符：在仓库目录内运行时由 gh 自己解析出 owner/repo。 */
const REPO_PLACEHOLDER = "{owner}/{repo}";
const MS_PER_HOUR = 3_600_000;
const MAX_PER_PAGE = 100;

const USAGE =
  "用法：node scripts/release/observe-precheck.mjs [--workflow observe.yml] [--max-age-hours 24] " +
  "[--per-page 30] [--repo owner/name] [--runs-file <json>] [--now <iso>] [--override]\n" +
  `override 也可用环境变量 ${OVERRIDE_ENV}=true（release.yml 的判据步骤走的就是它）。`;

/** 取 `--flag value` / `--flag=value`；未给出返回 fallback。重复给出时后者胜（单测靠它注入）。 */
function argValue(argv, flag, fallback) {
  const eq = argv.findLast((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const idx = argv.lastIndexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
}

/** 取值型 flag（`--flag value` 或 `--flag=value`）；其余（`--override`）是开关。 */
const VALUE_FLAGS = new Set([
  "--workflow",
  "--max-age-hours",
  "--per-page",
  "--repo",
  "--runs-file",
  "--now",
]);

/**
 * 未登记的 flag 与位置参数一律算参数非法。
 *
 * 为什么不能沿用 argValue 的「找不到就回落 fallback」：`--max-age-hour`（少个 s）会被静默丢掉、
 * 按默认 24 h 判定——调用者以为改了窗口，判据实际一字未变。参数写错必须比「判据拦下发布」更容易
 * 分辨，故与审批类脚本的「未知参数即 exit 2」对齐（方向 fail-closed）。
 */
function unknownArgs(argv) {
  const bad = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (VALUE_FLAGS.has(flag)) {
      // `--flag value` 的取值也是位置参数，跳过它；`--flag=value` 的取值在同一个 token 里。
      if (eq === -1) i += 1;
      continue;
    }
    if (flag === "--override") continue;
    bad.push(arg);
  }
  return bad;
}

function toDate(value, label) {
  const at = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(at.getTime())) throw new TypeError(`${label} 不可解析：${String(value)}`);
  return at;
}

/**
 * 时间戳字段的读取：缺字段返回 null（在途 run 的 updated_at 允许为空），但**给了值就必须可解析**
 * ——不可解析的时间戳会让龄算成 NaN，静默按「不发版」处理不如直接判输入损坏。
 */
function readTime(raw, index, field) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new TypeError(`第 ${index} 条 run 的 ${field} 不是字符串或 null：${typeof raw}`);
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new TypeError(`第 ${index} 条 run 的 ${field} 不可解析：${raw}`);
  }
  return at;
}

/** API run 对象 → 判定所需的窄形态；结构损坏一律抛错（由调用方转成 fail-closed）。 */
function normalizeRun(run, index) {
  if (run === null || typeof run !== "object" || Array.isArray(run)) {
    throw new TypeError(`第 ${index} 条 run 不是对象——输入损坏，按 fail-closed 处理`);
  }
  const conclusion = run.conclusion ?? null;
  if (conclusion !== null && typeof conclusion !== "string") {
    throw new TypeError(`第 ${index} 条 run 的 conclusion 既不是字符串也不是 null`);
  }
  const at = readTime(run.updated_at, index, "updated_at");
  if (conclusion === "success" && at === null) {
    throw new TypeError(
      `第 ${index} 条 run 是 success 但缺可解析的 updated_at（收口时刻）——` +
        "无法给「基线已刷新」的证据定时间",
    );
  }
  return {
    conclusion,
    at,
    createdAt: readTime(run.created_at, index, "created_at"),
    number: Number.isInteger(run.run_number) ? run.run_number : null,
    event: typeof run.event === "string" ? run.event : "",
    sha: typeof run.head_sha === "string" ? run.head_sha : "",
    url: typeof run.html_url === "string" ? run.html_url : "",
  };
}

/** 展示用的 run 摘要（判词里只出现事实，措辞留给 renderVerdictLine）。 */
function summarize(run) {
  if (run === null || run === undefined) return null;
  return {
    number: run.number,
    conclusion: run.conclusion,
    event: run.event,
    sha: run.sha,
    url: run.url,
    at: run.at === null ? null : run.at.toISOString(),
    createdAt: run.createdAt === null ? null : run.createdAt.toISOString(),
  };
}

/** 排序用时钟：优先收口时刻，退到创建时刻（在途 run 没有收口时刻）。 */
function runClock(run) {
  const t = run.at ?? run.createdAt;
  return t === null ? Number.NEGATIVE_INFINITY : t.getTime();
}

function ageInHours(now, then) {
  return (now.getTime() - then.getTime()) / MS_PER_HOUR;
}

/**
 * 判定本体（纯函数：可注入 now / 窗口 / override，故离线可测，也不碰 IO）。
 *
 * runs 接受 gh api `workflow_runs` 的原始数组；结构损坏（非数组、条目非对象、时间戳不可解析、
 * success 缺收口时刻）一律抛 TypeError，由 CLI 转成 fail-closed 判红——不把「看不懂的输入」
 * 当成「没有坏消息」。
 */
export function evaluateObserveRecency({
  runs,
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  workflow = DEFAULT_WORKFLOW,
  override = false,
}) {
  if (!(Number.isFinite(maxAgeHours) && maxAgeHours > 0)) {
    throw new TypeError(`maxAgeHours 必须是正数：${String(maxAgeHours)}`);
  }
  if (override === true) {
    return {
      ok: true,
      status: "overridden",
      overridden: true,
      workflow,
      maxAgeHours,
      now: null,
      ageHours: null,
      run: null,
      total: null,
      successCount: null,
    };
  }
  const at = toDate(now, "now");
  if (!Array.isArray(runs)) {
    throw new TypeError(`run 列表不是数组：${runs === null ? "null" : typeof runs}`);
  }
  const normalized = runs.map(normalizeRun);
  const base = {
    overridden: false,
    workflow,
    maxAgeHours,
    now: at.toISOString(),
    total: normalized.length,
  };
  if (normalized.length === 0) {
    return { ...base, ok: false, status: "no-runs", ageHours: null, run: null, successCount: 0 };
  }
  const successes = normalized.filter((run) => run.conclusion === "success");
  const newest = [...normalized].sort((a, b) => runClock(b) - runClock(a))[0];
  const fresh = successes
    .filter((run) => ageInHours(at, run.at) < maxAgeHours)
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (fresh !== undefined) {
    return {
      ...base,
      ok: true,
      status: "fresh",
      ageHours: ageInHours(at, fresh.at),
      run: summarize(fresh),
      successCount: successes.length,
    };
  }
  if (successes.length > 0) {
    const latest = successes.sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    return {
      ...base,
      ok: false,
      status: "stale",
      ageHours: ageInHours(at, latest.at),
      run: summarize(latest),
      successCount: successes.length,
    };
  }
  return {
    ...base,
    ok: false,
    status: "no-success",
    ageHours: null,
    run: summarize(newest),
    successCount: 0,
  };
}

function shortSha(sha) {
  const s = String(sha ?? "");
  return s.length > 7 ? s.slice(0, 7) : s;
}

function describeRun(run) {
  if (run === null || run === undefined) return "（响应里没有 run 元数据）";
  const parts = [`#${run.number ?? "?"}`];
  if (run.event !== "") parts.push(`event=${run.event}`);
  if (run.sha !== "") parts.push(`SHA ${shortSha(run.sha)}`);
  return parts.join("，");
}

/** 判定 → 一行判词。所有状态（含取数失败的 error）都从这里出，判词与本文件的口径说明同源。 */
export function renderVerdictLine(verdict) {
  const where = `observe 发版前置（${verdict.workflow}，窗口 ${verdict.maxAgeHours} h）`;
  switch (verdict.status) {
    case "fresh":
      return `${where}：放行 —— 窗口内有成功班次 ${describeRun(verdict.run)}，收口于 ${verdict.run.at}（龄 ${verdict.ageHours.toFixed(1)} h）`;
    case "stale":
      return (
        `${where}：阻断 —— 窗口内没有成功班次；最近一次成功 ${describeRun(verdict.run)} 收口于 ` +
        `${verdict.run.at}，龄 ${verdict.ageHours.toFixed(1)} h ≥ 窗口 ${verdict.maxAgeHours} h（基线可能陈旧）`
      );
    case "no-success":
      return `${where}：阻断 —— 最近 ${verdict.total} 次班次里没有任何 success；最近一次 ${describeRun(verdict.run)} 结论 ${verdict.run?.conclusion ?? "未收口"}`;
    case "no-runs":
      return `${where}：阻断 —— 查不到任何 run（fail-closed：没有「基线新鲜」的证据就不发版）`;
    case "overridden":
      return `${where}：放行（override）—— 已显式跳过前置校验`;
    case "error":
      return `${where}：阻断（fail-closed）—— ${verdict.reason}`;
    default:
      throw new TypeError(`未知的判定状态：${String(verdict.status)}`);
  }
}

const OVERRIDE_OBLIGATION =
  "override 义务：绕过即在「变异基线可能陈旧」的前提下发布——必须在本版本的 PR / release notes / " +
  "发布记录里写明理由（为什么急、为什么不新鲜、何时补跑 observe），并在当天补跑一次 observe.yml。";

function lastLine(text) {
  const line = String(text ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .at(-1);
  return line === undefined ? null : line;
}

/** 取数据：gh api（REST）。任何失败都不吞，交给调用方判红。 */
function fetchRuns({ repo, workflow, perPage }) {
  const endpoint = `repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${perPage}`;
  let raw;
  try {
    raw = execFileSync("gh", ["api", endpoint], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`gh api ${endpoint} 失败：${lastLine(err.stderr) ?? err.message}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(`gh api 响应不是合法 JSON：${err.message}`);
  }
  if (!Array.isArray(payload?.workflow_runs)) {
    throw new Error("gh api 响应缺 workflow_runs 数组");
  }
  return payload.workflow_runs;
}

/** 离线取证入口：吃 gh api 的原样响应，也吃裸数组（便于手工构造最小复现）。 */
function readRunsFile(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`--runs-file 读取失败（${file}）：${err.message}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--runs-file 不是合法 JSON（${file}）：${err.message}`);
  }
  const runs = Array.isArray(payload) ? payload : payload?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error(`--runs-file 缺 workflow_runs 数组（${file}）`);
  return runs;
}

/** override 的两个入口：CLI 开关，或 workflow 接过来的环境变量（只认字面量 "true"）。 */
function overrideRequested(argv, env) {
  if (argv.includes("--override")) return true;
  return String(env[OVERRIDE_ENV] ?? "") === "true";
}

function main(argv, env = process.env) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const unknown = unknownArgs(argv);
  if (unknown.length > 0) {
    failClosed(`observe-precheck: 未知参数 ${unknown.join(" ")}（用 --help 查看可用参数）`);
  }
  const rawMaxAge = argValue(argv, "--max-age-hours", String(DEFAULT_MAX_AGE_HOURS));
  const maxAgeHours = Number(rawMaxAge);
  if (!(Number.isFinite(maxAgeHours) && maxAgeHours > 0)) {
    failClosed(`observe-precheck: --max-age-hours 需要正数（实际 ${rawMaxAge}）`);
  }
  const rawPerPage = argValue(argv, "--per-page", String(DEFAULT_PER_PAGE));
  const perPage = Number(rawPerPage);
  if (!(Number.isInteger(perPage) && perPage >= 1 && perPage <= MAX_PER_PAGE)) {
    failClosed(`observe-precheck: --per-page 需要 1..${MAX_PER_PAGE} 的整数（实际 ${rawPerPage}）`);
  }
  const workflow = argValue(argv, "--workflow", DEFAULT_WORKFLOW);
  const repo = argValue(argv, "--repo", REPO_PLACEHOLDER);
  const runsFile = argValue(argv, "--runs-file", null);
  const nowArg = argValue(argv, "--now", null);

  // override 在校验参数之后、取数据之前：API 故障时它必须仍然可用。
  if (overrideRequested(argv, env)) {
    console.log(`::warning::${renderVerdictLine({ status: "overridden", workflow, maxAgeHours })}`);
    console.log(OVERRIDE_OBLIGATION);
    return 0;
  }

  let verdict;
  try {
    const runs =
      runsFile === null ? fetchRuns({ repo, workflow, perPage }) : readRunsFile(runsFile);
    verdict = evaluateObserveRecency({ runs, now: nowArg ?? new Date(), maxAgeHours, workflow });
  } catch (err) {
    verdict = { status: "error", workflow, maxAgeHours, reason: err.message };
  }
  const line = renderVerdictLine(verdict);
  console.log(verdict.ok === true ? line : `::error::${line}`);
  return verdict.ok === true ? 0 : 1;
}

/** 仅直接执行时跑 main（被 import 时只取纯函数）。 */
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) process.exitCode = main(process.argv.slice(2));
