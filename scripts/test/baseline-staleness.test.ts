#!/usr/bin/env node
"use strict";

/**
 * 基线陈旧判据的回归（#718 验收判据「基线陈旧可被观测」）。
 *
 * 为什么需要它：阈值语义（`>` 还是 `>=`）、三态措辞、以及「只有 stale 才落 issue 文件」这条接线，
 * 任一处走样都会让判据要么永不报、要么常报。这里把三态与边界钉死，并用 `--commit-date` / `--now`
 * 注入跑一次**真实 CLI**（离线，不调 gh、不发任何写请求），守住「纯函数对但接线错」这一层。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  STALENESS_THRESHOLD_HOURS,
  evaluateBaselineStaleness,
  renderIssueBody,
  renderReportLine,
} from "../release/baseline-staleness.mjs";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/release/baseline-staleness.mjs");
const SHA = "a4277ac29417ff4a69c17edfb69592226bd0c329";
/** 纯函数调用归一：实现（scripts/release/baseline-staleness.mjs）仍带 @ts-nocheck，now 默认 new Date()
 * 把推断收窄为 Date——实现本体 new Date(now) 同时接受 ISO 字符串（无效串抛 TypeError 另有专条
 * 用例钉住），测试侧保留字符串入参并整体断言。 */
type StalenessArgs = Parameters<typeof evaluateBaselineStaleness>[0];
const staleness = (args: { lastCommitDate: string; now: string; thresholdHours?: number }) =>
  evaluateBaselineStaleness(args as unknown as StalenessArgs);

/** CLI 注入式运行：不给 --commit-date 才会走 gh，故这里全程离线。 */
function runCli(dir: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--branch",
      "baseline/mutation",
      "--commit-date",
      "2026-09-12T00:00:00Z",
      "--commit-sha",
      SHA,
      "--status-file",
      join(dir, "status.json"),
      "--issue-file",
      join(dir, "issue.md"),
      ...args,
    ],
    { cwd: dir, encoding: "utf8" },
  );
}

test("阈值是 48 h，且默认生效（错过一夜约 30 h 不得告警）", () => {
  assert.equal(STALENESS_THRESHOLD_HOURS, 48);
  const v = staleness({
    lastCommitDate: "2026-09-13T18:17:00Z",
    now: "2026-09-15T00:17:00Z",
  });
  assert.equal(v.thresholdHours, 48);
  assert.equal(v.ageHours, 30);
  assert.equal(v.stale, false, "错过一夜不得误报，连续两夜才报");
});

test("正：龄 < 阈值 → 不告警，正文留痕为 fresh", () => {
  const v = staleness({
    lastCommitDate: "2026-09-14T00:00:00Z",
    now: "2026-09-14T06:00:00Z",
  });
  assert.equal(v.ageHours, 6);
  assert.equal(v.stale, false);
  const line = renderReportLine({ ...v, status: "fresh", branch: "baseline/mutation", sha: SHA });
  assert.match(line, /^- 变异基线（\`baseline\/mutation\`）龄：6\.0 h（阈值 48 h/);
  assert.match(line, /SHA a4277ac/);
  assert.doesNotMatch(line, /超过阈值/);
});

test("反：龄 > 阈值 → 告警，正文与工单正文都点明龄与阈值", () => {
  const v = staleness({
    lastCommitDate: "2026-09-12T00:00:00Z",
    now: "2026-09-14T06:00:00Z",
  });
  assert.equal(v.ageHours, 54);
  assert.equal(v.stale, true);
  const state = { ...v, status: "stale", branch: "baseline/mutation", sha: SHA };
  const line = renderReportLine(state);
  assert.match(line, /龄：54\.0 h —— \*\*超过阈值 48 h\*\*/);
  const body = renderIssueBody(state);
  assert.match(body, /## 变异基线陈旧告警/);
  assert.match(body, /最后提交 2026-09-12T00:00:00\.000Z/);
  assert.match(body, /先看 observe 夜班最近一次结论/);
  assert.match(body, /2026-09-12T00:00:00\.000Z/);
});

test("边界：龄恰好 = 阈值 → 判陈旧（>= 语义，恰好到期不再多沉默一轮）", () => {
  const v = staleness({
    lastCommitDate: "2026-09-12T00:00:00Z",
    now: "2026-09-14T00:00:00Z",
  });
  assert.equal(v.ageHours, 48);
  assert.equal(v.stale, true, "恰好 48 h 视为陈旧：阈值是允许的最大龄，到达上界即报");
});

test("阈值可注入（供单测与实证），但仍必须是正数", () => {
  const base = { lastCommitDate: "2026-09-14T00:00:00Z", now: "2026-09-14T02:00:00Z" };
  assert.equal(staleness({ ...base, thresholdHours: 2 }).stale, true);
  assert.equal(staleness({ ...base, thresholdHours: 3 }).stale, false);
  assert.throws(() => staleness({ ...base, thresholdHours: 0 }), /正数/);
});

test("不可解析的时间一律抛错（不得静默当成新鲜）", () => {
  assert.throws(
    () => staleness({ lastCommitDate: "not-a-date", now: "2026-09-14T00:00:00Z" }),
    TypeError,
  );
  assert.throws(
    () => staleness({ lastCommitDate: "2026-09-14T00:00:00Z", now: "nope" }),
    TypeError,
  );
});

test("CLI 接线：fresh 不落 issue 文件；stale 落且带 ::error::；unknown 落 ::error:: 但不建单", () => {
  const dir = mkdtempSync(join(tmpdir(), "baseline-staleness-"));
  try {
    const fresh = runCli(dir, ["--now", "2026-09-12T06:00:00Z"]);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.doesNotMatch(fresh.stdout, /::error::/);
    assert.equal(existsSync(join(dir, "issue.md")), false, "未超阈值不得产出工单正文");
    assert.equal(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).status, "fresh");

    const stale = runCli(dir, ["--now", "2026-09-15T00:00:00Z"]);
    assert.equal(stale.status, 0, "观测本身不判红：告警通道是 annotation + 工单");
    assert.match(stale.stdout, /::error::变异基线陈旧：龄 72\.0 h ≥ 阈值 48 h/);
    assert.match(readFileSync(join(dir, "issue.md"), "utf8"), /## 变异基线陈旧告警/);
    assert.equal(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).status, "stale");

    rmSync(join(dir, "issue.md"));
    const unknown = runCli(dir, ["--commit-date", "not-a-date", "--now", "2026-09-15T00:00:00Z"]);
    assert.equal(unknown.status, 0, unknown.stderr);
    assert.match(unknown.stdout, /::error::变异基线龄无法观测：/);
    assert.equal(existsSync(join(dir, "issue.md")), false, "观测失败不建陈旧工单（正文已留痕）");
    assert.equal(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).status, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 接线：--threshold-hours 非正数一律 exit 2（fail-closed，不落状态文件）", () => {
  const dir = mkdtempSync(join(tmpdir(), "baseline-staleness-"));
  try {
    for (const bad of ["0", "48h"]) {
      const result = runCli(dir, ["--threshold-hours", bad]);
      assert.equal(result.status, 2, `${bad}：阈值非正数必须 exit 2（参数校验在写任何文件之前）`);
      assert.match(
        result.stderr,
        /^::error::门禁故障（非判据结论）：baseline-staleness: --threshold-hours 需要正数/m,
        `${bad}：必须带统一故障注解`,
      );
      assert.equal(result.stdout, "", `${bad}：不得污染 stdout`);
      assert.equal(existsSync(join(dir, "status.json")), false, `${bad}：参数非法不得落状态文件`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1.4 选A：--warn-only 纯存证 warn（stale/unknown 只打 ::warning::，恒 exit 0，状态照落）", () => {
  const dir = mkdtempSync(join(tmpdir(), "baseline-staleness-"));
  try {
    // stale：默认 ::error::，--warn-only 下 ::warning::，退出码都是 0
    const plain = runCli(dir, ["--now", "2026-09-15T00:00:00Z"]);
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /^::error::变异基线陈旧/m);
    const warned = runCli(dir, ["--now", "2026-09-15T00:00:00Z", "--warn-only"]);
    assert.equal(warned.status, 0, "存证模式永不判红");
    assert.match(warned.stdout, /^::warning::变异基线陈旧/m);
    assert.doesNotMatch(warned.stdout, /^::error::/m, "存证模式不得打 ::error:: 注解");
    assert.equal(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).status, "stale");
    // unknown（--commit-date 缺失且无 gh 时走 injected=null？此处用不可解析日期触发）：状态照落，仍 exit 0
    const unknown = spawnSync(
      process.execPath,
      [SCRIPT, "--warn-only", "--now", "not-a-date", "--status-file", join(dir, "u.json")],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(unknown.status, 0);
    assert.match(unknown.stdout, /^::warning::变异基线龄无法观测/m);
    assert.equal(JSON.parse(readFileSync(join(dir, "u.json"), "utf8")).status, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
