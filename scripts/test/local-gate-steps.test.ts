#!/usr/bin/env node
/**
 * local-gate 分层步骤自测（#733 计划项 3.3 E2 前置）。
 *
 * 为什么单独钉：本地三档的**步骤表**是「哪条判据在本地可见」的唯一事实源，而它此前没有任何
 * 断言——`threshold-monotonic` 就是这样从本地口径里漏掉的（只写在 ci.yml 的 `if: pull_request`
 * 下，本地判绿、CI 判红）。本文件只跑 `--dry-run`（不执行任何步骤），断言两档的步骤表：
 *   pr   全仓对象面 + 产物闸 + 廉价全仓一致性闸（含阈值单调性）
 *   full 同 pr + 豁免到期台账收集（台账只在全量档打印，见 collect-exemptions 的注释）
 * 只测 pr / full：changed 档的包面取决于工作区 diff，断言会随环境漂移。
 *
 * 逐闸的接线（某闸在不在档位计划里、args 指不指向该闸）**不在这里**：标签文本与 args 是两套
 * 口径，只钉标签会让「标签没改、args 换成别的闸」这类漂移全绿。那部分归
 * scripts/test/gate-wiring.test.ts（直接 import 步骤表并做端点比对，两侧一起看）。
 * 本文件只留档位**结构**事实。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "gate", "local-gate.mjs");

/** 取某一档的计划步骤标签（--dry-run，不执行）。 */
function plannedSteps(tier: string) {
  const r = spawnSync(process.execPath, [SCRIPT, "--tier", tier, "--dry-run"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `--tier ${tier} --dry-run 应 exit 0：${r.stderr}`);
  return r.stdout;
}

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

// 逐闸的接线不在这里：某闸在不在计划里、args 指不指向它，都归
// scripts/test/gate-wiring.test.ts（直接 import 步骤表做端点比对，两侧一起看）。
// 本文件只留上面那些「档位**结构**」事实——产物闸是全仓口径还是切片、台账在不在、
// full 与 pr 的包含关系。

test("fail-closed：未知 --tier → exit 2 且统一故障注解", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--tier", "bogus-tier-xyz"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 2, String(r.stderr));
  assert.match(String(r.stderr), /^::error::门禁故障（非判据结论）：\[local-gate\] 未知 --tier/m);
  assert.equal(String(r.stdout), "");
});
