#!/usr/bin/env node
/**
 * 变异基线（`baseline/mutation`）新鲜度的观测与判定（#718 验收判据「基线陈旧可被观测」）。
 *
 * 判据打在**事实**上，不是代理上：读基线分支最后提交的时间。基线有**两条写入路径**：
 *   a. observe.yml 夜班（UTC 20:00）在收口 job 里并集入档（scripts/gate/orphan-baseline.mjs）；
 *   b. baseline-overlay.yml 在 push main 时把该 PR 的增量基线秒级 overlay 上去
 *      （scripts/gate/overlay-baseline.mjs，与 a 共用 scripts/gate/baseline-push.mjs 的写路径）。
 * 代理指标（「observe 最近一次是不是 success」）在两种形态下都会漏报：班次成功但两条路径都没落盘
 * （如段报告缺失 → 收口 job 的入档步骤整体跳过），以及班次根本没跑（此时「最近一次 run」仍是旧的
 * success）。读分支 tip 的提交时间不受这两种形态影响。
 *
 * 为什么执行点在 health-report.yml 而不在 observe.yml：**监控者与被监控者必须分离**——observe 是
 * 写入方之一，把新鲜度检查放进去，会在它整体没跑时一起沉默（dead-man's switch 的反面）。
 * health-report 是**独立于上述两条写入路径**的第三条班次、周期一周（不会告警疲劳），且已有
 * issues: write，故本项**零权限变更**：本脚本只读分支信息，建单在 workflow 侧用已有权限做。
 *
 * 判据的真实语义是「**两条入档路径都停了**」，不是「observe 单点停了」——故**绿 != observe 健康**：
 * 夜班停摆但仍有触及变异切片的 PR 合入时，基线会被 overlay 在 48 h 内持续刷新而恒为 fresh。
 * 要单点观测 observe，看它自己最近一次 run；本判据不做这个代理。
 *
 * 三个执行点参数化路径（--status-file / --issue-file），纯函数部分不碰 IO 也不发写请求。
 */
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 告警阈值（小时）：48 = 连续两夜未入档。
 * 推导：夜班 UTC 20:00 并集入档、周报周一 UTC 02:17 检查，正常龄约 6 h；错过一夜约 30 h
 * 仍在阈内（不误报），连续两夜未更新约 54 h 才告警。48 h 正好卡在「两夜」这一语义上。
 */
export const STALENESS_THRESHOLD_HOURS = 48;

export const DEFAULT_BRANCH = "baseline/mutation";

/** 工单标题：稳定不变（不带日期 / 龄值），否则「按标题搜到同一张单」的幂等性无从谈起。 */
export const STALENESS_ISSUE_TITLE = "chore(health): 变异基线陈旧告警";

const MS_PER_HOUR = 3_600_000;

/**
 * 龄 → 三态判定（纯函数：可注入 now 与阈值，故离线可测）。
 *
 * 边界取 `age >= threshold`（恰好等于阈值即判陈旧）：阈值是「允许的最大龄」的上界，到达上界
 * 就该报，而不是再等一周；取 `>` 会让「恰好 48 h」这种由整点提交与整点调度自然产出的
 * 形态额外多沉默一轮。方向偏保守（多报一次，代价只是下一周照常再报一次）。
 */
export function evaluateBaselineStaleness({
  lastCommitDate,
  now = new Date(),
  thresholdHours = STALENESS_THRESHOLD_HOURS,
}) {
  const last = new Date(lastCommitDate);
  const at = new Date(now);
  if (Number.isNaN(last.getTime()))
    throw new TypeError(`lastCommitDate 不可解析：${lastCommitDate}`);
  if (Number.isNaN(at.getTime())) throw new TypeError(`now 不可解析：${String(now)}`);
  if (!(Number.isFinite(thresholdHours) && thresholdHours > 0)) {
    throw new TypeError(`thresholdHours 必须是正数：${thresholdHours}`);
  }
  const ageHours = (at.getTime() - last.getTime()) / MS_PER_HOUR;
  return {
    stale: ageHours >= thresholdHours,
    ageHours,
    thresholdHours,
    lastCommitDate: last.toISOString(),
    now: at.toISOString(),
  };
}

/** 龄的展示口径（1 位小数，小时）；单独成函数以便报告与注解同源。 */
export function formatAgeHours(ageHours) {
  return `${ageHours.toFixed(1)} h`;
}

function shortSha(sha) {
  const s = String(sha ?? "");
  return s.length > 7 ? s.slice(0, 7) : s;
}

/**
 * 周报正文里的一行基线留痕（未超阈值也要留痕，否则「检查过」与「没检查」在正文里同形）。
 * 三态各有自己的措辞，不共用一条「正常/异常」的模糊句。
 */
export function renderReportLine(state) {
  const branch = state.branch ?? DEFAULT_BRANCH;
  switch (state.status) {
    case "fresh":
      return `- 变异基线（\`${branch}\`）龄：${formatAgeHours(state.ageHours)}（阈值 ${state.thresholdHours} h，最后提交 ${state.lastCommitDate}，SHA ${shortSha(state.sha)}）`;
    case "stale":
      return `- 变异基线（\`${branch}\`）龄：${formatAgeHours(state.ageHours)} —— **超过阈值 ${state.thresholdHours} h**（最后提交 ${state.lastCommitDate}，SHA ${shortSha(state.sha)}）；已建/追幂等工单 \`${STALENESS_ISSUE_TITLE}\``;
    case "unknown":
      return `- 变异基线（\`${branch}\`）龄：无法确定（${state.reason}）—— 见本班 ::error:: 注解`;
    default:
      throw new TypeError(`未知的基线新鲜度状态：${String(state.status)}`);
  }
}

/** 陈旧工单正文：把「判据 + 事实 + 下一步看哪里」一次给全，避免拿到单的人回头翻 workflow。 */
export function renderIssueBody(state) {
  return [
    "## 变异基线陈旧告警",
    "",
    renderReportLine(state),
    "",
    "### 先看什么",
    "",
    "- **先看 observe 夜班最近一次结论**：夜间班次在收口 job 里按「本班是否产出段报告」建/追标题为 `chore(observe): 夜间质量报告 <日期>` 的工单（#765 G1）。按标题搜它，先区分「夜班没跑」与「夜班跑了但基线没入档」。",
    "- 夜班没跑：看 Observe (nightly) 的调度（cron `0 20 * * *`）是否被禁用、是否连续失败、是否排队超时被杀。",
    "- 夜班跑了但基线没更新：看该班次 `mutation-collect` 里 `Archive baseline to orphan branch` 步骤的日志（并集入档为单点 push，失败即 fail-loud），以及 `baseline-overlay.yml` 在 PR 合入路径上是否报错。",
    "",
    "### 判定口径",
    "",
    `- 阈值 ${state.thresholdHours} h = 连续两夜未更新（夜班 20:00 UTC 入档、周报周一 02:17 UTC 检查，正常龄约 6 h）。`,
    "- 检查的是基线分支最后提交时间这一**事实**，不是「observe 最近是否 success」：后者在「observe 成功但未入档」与「observe 整体没跑」两种形态下都会漏报。",
    "- 本工单由 health-report 周报幂等建/追（标题稳定，超阈期间每周追评一次，不做状态流转）。",
    "",
  ].join("\n");
}

/** 取 `--flag value` / `--flag=value`；未给出返回 fallback。重复给出时后者胜（实证与单测靠它覆盖注入值）。 */
function argValue(argv, flag, fallback) {
  const eq = argv.findLast((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const idx = argv.lastIndexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
}

/**
 * 基线分支的「最后提交」事实：一次 REST 调用同时拿 SHA 与提交时间。
 * 分支名带斜杠，必须 `encodeURIComponent`（路径参数里的 slash 会被当成多一段路由）。
 */
function readBaselineCommit(branch) {
  let raw;
  try {
    raw = execFileSync(
      "gh",
      ["api", `repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (err) {
    const detail =
      String(err.stderr ?? "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .at(-1) ?? err.message;
    throw new Error(`读取分支 ${branch} 失败：${detail}`);
  }
  const json = JSON.parse(raw);
  const sha = json?.commit?.sha;
  const date = json?.commit?.commit?.committer?.date ?? json?.commit?.commit?.author?.date;
  if (typeof sha !== "string" || sha === "" || typeof date !== "string" || date === "") {
    throw new Error(`分支 ${branch} 的响应缺 commit.sha / 提交时间`);
  }
  return { sha, date };
}

/**
 * 观测并落盘。返回退出码——**本脚本自己的判定永远 0（含 stale 与 unknown）**：它只管把状态
 * 落盘，判红是 workflow 的事，且必须发生在所有建单/报告步骤之后。两种语义刻意分开：
 *   - stale（发现）：检查做成了、基线旧了 —— 告警通道是 annotation + 工单，run 保持绿；
 *   - unknown（失败）：检查根本没做成 —— 属「环境失败不得静默降级」，由 health-report.yml
 *     最末的 verdict 步骤读状态文件判红。为什么判红不能落在这里：GHA 语义下本步骤非零会
 *     直接跳过后面的周报建单与陈旧工单，把留痕一起吞掉（#765 G1 的形态）。
 */
function main(argv) {
  const branch = argValue(argv, "--branch", DEFAULT_BRANCH);
  const thresholdHours = Number(
    argValue(argv, "--threshold-hours", String(STALENESS_THRESHOLD_HOURS)),
  );
  if (!(Number.isFinite(thresholdHours) && thresholdHours > 0)) {
    console.error(`baseline-staleness: --threshold-hours 需要正数（实际 ${thresholdHours}）`);
    return 2;
  }
  const statusFile = argValue(argv, "--status-file", null);
  const issueFile = argValue(argv, "--issue-file", null);
  const injectedDate = argValue(argv, "--commit-date", null);
  const nowArg = argValue(argv, "--now", undefined);
  const rawNow = nowArg === undefined ? new Date() : nowArg;

  let state;
  try {
    const commit =
      injectedDate === null
        ? readBaselineCommit(branch)
        : { sha: argValue(argv, "--commit-sha", "injected"), date: injectedDate };
    const verdict = evaluateBaselineStaleness({
      lastCommitDate: commit.date,
      now: rawNow,
      thresholdHours,
    });
    state = {
      status: verdict.stale ? "stale" : "fresh",
      branch,
      sha: commit.sha,
      lastCommitDate: verdict.lastCommitDate,
      ageHours: verdict.ageHours,
      thresholdHours,
      now: verdict.now,
    };
  } catch (err) {
    state = {
      status: "unknown",
      branch,
      reason: err.message,
      thresholdHours,
      now: Number.isNaN(new Date(rawNow).getTime()) ? null : new Date(rawNow).toISOString(),
    };
  }

  // 标题随状态一并落盘：workflow 侧的幂等建/追必须与正文里引用的标题逐字相同，
  // 两处各写一份字面量的漂移后果是「每周新建一张单」而没有任何判据会发现。
  state.issueTitle = STALENESS_ISSUE_TITLE;

  const line = renderReportLine(state);
  if (state.status === "stale") {
    console.log(
      `::error::变异基线陈旧：龄 ${formatAgeHours(state.ageHours)} ≥ 阈值 ${state.thresholdHours} h` +
        `（${branch} 最后提交 ${state.lastCommitDate}，SHA ${shortSha(state.sha)}）`,
    );
  }
  if (state.status === "unknown") {
    console.log(`::error::变异基线龄无法观测：${state.reason}`);
  }
  console.log(line);

  if (statusFile !== null) writeFileSync(statusFile, `${JSON.stringify(state, null, 2)}\n`);
  if (issueFile !== null && state.status === "stale") {
    writeFileSync(issueFile, `${renderIssueBody(state)}\n`);
  }
  return 0;
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
