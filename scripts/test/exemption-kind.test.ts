#!/usr/bin/env node
/**
 * exemption-kind 自测：分桶认面按**形状**（pattern + reason）、分档按**kind**，临时字段只作无 kind 面的兜底。
 *
 * 每条判据都配反例：本库是「删掉 reviewBy 就能把待办洗成设计事实」这条通道的封口，判据本身若被
 * 一行改动削弱（改成按键名发现、或让未识别 kind 落 by-design），台账会静默少算而门禁不响。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BUCKET,
  BY_DESIGN_EXCLUDE_KINDS,
  classifyLedgerNode,
  hasDeferralFields,
  isExclusionShape,
  isLedgerNode,
} from "../lib/exemption-kind.ts";

const PENDING = {
  pattern: "packages/dsh-mcp-manager/src/client/core/api.ts",
  kind: "pending-project",
  reason: "尚无直连判据，计入分母只稀释阈值",
  reviewBy: "2027-03-31",
  exitCriteria: "本文件有了直连判据后删除本条",
};

test("暂缺类 kind：带不带 reviewBy/exitCriteria 都落 deferral（洗白通道封口）", () => {
  const full = classifyLedgerNode(PENDING);
  assert.equal(full.bucket, BUCKET.deferral);
  assert.equal(full.basis, "kind");
  // 反例：把两个字段删掉——旧口径下这条就此从台账消失（计数减 1、exit 0、无判词）
  const stripped: Record<string, unknown> = { ...PENDING };
  delete stripped.reviewBy;
  delete stripped.exitCriteria;
  const bare = classifyLedgerNode(stripped);
  assert.equal(bare.bucket, BUCKET.deferral, "删字段不得把待办降级成设计事实");
  assert.equal(bare.basis, "kind");
});

test("结构性 kind：一律 by-design，即使形状完整也不计入待办", () => {
  for (const kind of ["type-only", "not-source", "facade", "not-mutated"]) {
    const got = classifyLedgerNode({ pattern: "**/*.d.ts", kind, reason: "按设计不进度量面" });
    assert.equal(got.bucket, BUCKET.byDesign, `${kind} 应为结构性`);
    assert.equal(got.basis, "kind");
  }
});

test("未识别 kind 落 deferral（多算不少算，漂移方向被钉死）", () => {
  // 反例方向：若这里改成 byDesign，将来新增的暂缺类 kind 会静默逃逸出台账（漏计不可见）
  const got = classifyLedgerNode({ pattern: "**/x", kind: "brand-new", reason: "新 kind" });
  assert.equal(got.bucket, BUCKET.deferral);
  assert.equal(got.basis, "unknown-kind", "basis 必须说清它不是已登记的 kind");
});

test("无 kind 的两个面：带待办字段即 deferral（保留既有语义作兜底）", () => {
  const gate = classifyLedgerNode({
    gate: "forbid-module-state-src",
    path: "packages/dsh-mcp-manager/src/client/float/panel.ts",
    reason: "客户端刷新单飞句柄",
    reviewBy: "2027-03-31",
  });
  assert.equal(gate.bucket, BUCKET.deferral);
  assert.equal(gate.basis, "deferral-field");
  const design = classifyLedgerNode({ gate: "g", path: "p/a.ts", reason: "长期条目，是设计事实" });
  assert.equal(design.bucket, BUCKET.byDesign);
  assert.equal(design.basis, "no-signal");
});

test("认面谓词按形状：非排除面的 kind 节点（无 pattern）不进台账面", () => {
  // ci-face-registry 的 {kind: "indirect"} 与 threshold-registry 的 {kind: "value"} 都是 kind 节点，
  // 按键名发现会误收 38 条；形状谓词要求 pattern + reason，故它们不在面内。
  const ciFace = { kind: "indirect", face: "gate" };
  assert.equal(isExclusionShape(ciFace), false);
  assert.equal(isLedgerNode(ciFace), false);
  const guard = { kind: "value", paths: ["a.b"], why: "阈值守卫" };
  assert.equal(isLedgerNode(guard), false);
  assert.equal(isLedgerNode(PENDING), true);
});

test("缺 reason 的节点不进排除面（台账漏收的唯一入口由门禁判据②判红兜住）", () => {
  const noReason = { pattern: "**/x", kind: "pending-project" };
  assert.equal(isExclusionShape(noReason), false);
  assert.equal(isLedgerNode(noReason), false);
  assert.equal(hasDeferralFields(noReason), false);
});

test("BY_DESIGN_EXCLUDE_KINDS 是闭集且不含 pending-project（收口目标即把它移出）", () => {
  assert.equal(BY_DESIGN_EXCLUDE_KINDS.has("pending-project"), false);
  assert.equal(BY_DESIGN_EXCLUDE_KINDS.size, 4);
});

test("非对象与 null 不被当作条目（不抛、不静默认领）", () => {
  for (const node of [null, "x", 3, undefined]) {
    assert.equal(isLedgerNode(node), false);
    assert.equal(classifyLedgerNode(node).bucket, BUCKET.byDesign);
  }
});
