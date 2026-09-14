#!/usr/bin/env node
// @ts-nocheck
/**
 * local-gate 分层步骤自测（#733 计划项 3.3 E2 前置）。
 *
 * 为什么单独钉：本地三档的**步骤表**是「哪条判据在本地可见」的唯一事实源，而它此前没有任何
 * 断言——`threshold-monotonic` 就是这样从本地口径里漏掉的（只写在 ci.yml 的 `if: pull_request`
 * 下，本地判绿、CI 判红）。本文件只跑 `--dry-run`（不执行任何步骤），断言两档的步骤表：
 *   pr   全仓对象面 + 产物闸 + 廉价全仓一致性闸（含阈值单调性）
 *   full 同 pr + 豁免到期台账收集（台账只在全量档打印，见 collect-exemptions 的注释）
 * 只测 pr / full：changed 档的包面取决于工作区 diff，断言会随环境漂移。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "gate", "local-gate.mjs");

/** 取某一档的计划步骤标签（--dry-run，不执行）。 */
function plannedSteps(tier) {
  const r = spawnSync(process.execPath, [SCRIPT, "--tier", tier, "--dry-run"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `--tier ${tier} --dry-run 应 exit 0：${r.stderr}`);
  return r.stdout;
}

test("pr 档：含阈值单调性（本地必须能拦住悄悄降线）", () => {
  const out = plannedSteps("pr");
  assert.match(
    out,
    /threshold-monotonic（阈值只许升不许降，基准 origin\/main）/,
    "pr 档必须含 threshold-monotonic —— 否则本地判绿而 CI 判红",
  );
});

test("pr 档：产物闸标注为全仓口径（pr/full 对象面是全仓，不是切片）", () => {
  const out = plannedSteps("pr");
  for (const gate of ["contract", "pack:check", "verify:npmlayout"]) {
    assert.ok(
      out.includes(`${gate}（全仓口径）`),
      `${gate} 在 pr 档应标注「全仓口径」（实测步骤表里写的是切片口径就等于文档说谎）`,
    );
  }
});

test("pr 档：不跑豁免到期台账（反复打印同一份存量台账只是噪音）", () => {
  const out = plannedSteps("pr");
  assert.ok(!out.includes("豁免到期台账"), "pr 档不应含台账收集步骤");
});

test("full 档：pr 档的全部 + 豁免到期台账收集", () => {
  const out = plannedSteps("full");
  assert.match(out, /豁免到期台账（收集 reviewBy，仅报告）/, "full 档必须收集到期台账");
  assert.match(out, /threshold-monotonic（阈值只许升不许降，基准 origin\/main）/, "full 档同 pr");
  assert.match(out, /contract（全仓口径）/, "full 档同 pr");
});

test("pr 档：含 scripts 索引判据（#733 E2 的引用即登记，恒跑规则面）", () => {
  const out = plannedSteps("pr");
  // 用 includes 而非正则：标签里的 ` + ` 在正则里是量词，会把断言写成永远不匹配
  assert.ok(
    out.includes("verify:scripts-index（scripts 索引：存在性 + 引用即登记）"),
    "pr 档必须含 verify:scripts-index —— 它属恒跑的规则面",
  );
});

test("pr 档：含覆盖率面判据（#733 3.4：单一事实源 + 面完整性）", () => {
  const out = plannedSteps("pr");
  assert.ok(
    out.includes("verify:coverage-scope（覆盖率面：单一事实源 + 面完整性）"),
    "pr 档必须含 verify:coverage-scope",
  );
});
