/**
 * tier/automation 投影契约直测（#732 阶段 2 从 decide 编排里拆出的纯函数）。
 *
 * 守的是三条互不相同的规则叠加后的结果，任一条被改动本文件必红：
 * 1. Noul 置空 tier——choice==="Noul" 表示弃权，弃权不分级（tier 强制 none，
 *    不受 automationCap 影响；这是「不把弃权当成低置信度」的安全语义）。
 * 2. cap 封顶——automationCap 三档（0=none/1=low/2=high）对 tier 与 automation
 *    分别取 min，cap=0 即全封 none。
 * 3. 截断强制 suggest-only（R5）——远端成功但输入被截断时，automation 一律
 *    suggest-only；该规则只作用于远端成功面，本地预检命中路径恒 manual。
 */
import { describe, expect, it } from "vitest";
import { projectLevels } from "../../src/server/tools/impl/service.ts";
import type { RemoteVerdict } from "../../src/server/tools/impl/client.ts";

function verdict(over: Partial<RemoteVerdict> = {}): RemoteVerdict {
  return {
    resultKind: "choice",
    confidence: 0.9,
    tier: 2,
    automation: 2,
    codepoints: 0,
    ...over,
  };
}

describe("projectLevels Noul 置空 tier", () => {
  it("choice + Noul → tier none，即便 cap=2、tier=2", () => {
    expect(projectLevels(verdict({ resultKind: "choice", choice: "Noul" }), 2, false)).toEqual({
      tier: "none",
      automation: "manual",
    });
  });
  it("choice 非 Noul 且 cap=2 → high/auto", () => {
    expect(projectLevels(verdict({ resultKind: "choice", choice: "opt-a" }), 2, false)).toEqual({
      tier: "high",
      automation: "auto",
    });
  });
  it("score 结果的 choice 字段不参与 Noul 判定（须 resultKind 也是 choice）", () => {
    expect(projectLevels(verdict({ resultKind: "score", choice: "Noul" }), 2, false)).toEqual({
      tier: "high",
      automation: "auto",
    });
  });
});

describe("projectLevels cap 封顶", () => {
  it("cap=0 全封 none/manual（tier 与 automation 分别取 min）", () => {
    expect(projectLevels(verdict(), 0, false)).toEqual({ tier: "none", automation: "manual" });
  });
  it("cap=1 把 high 压到 low、auto 压到 assisted", () => {
    expect(projectLevels(verdict(), 1, false)).toEqual({ tier: "low", automation: "assisted" });
  });
  it("cap=2 不改变原档", () => {
    expect(projectLevels(verdict(), 2, false)).toEqual({ tier: "high", automation: "auto" });
  });
  it("tier 与 automation 各自封顶：tier=2/automation=1 在 cap=1 下 → low/assisted", () => {
    expect(projectLevels(verdict({ tier: 2, automation: 1 }), 1, false)).toEqual({
      tier: "low",
      automation: "assisted",
    });
  });
  it("tier none 时 automation 一律 manual，不看原 automation 序号", () => {
    expect(projectLevels(verdict({ tier: 0, automation: 2 }), 2, false)).toEqual({
      tier: "none",
      automation: "manual",
    });
  });
});

describe("projectLevels 截断强制 suggest-only（R5）", () => {
  it("截断时 automation 变 suggest-only，tier 不受影响", () => {
    expect(projectLevels(verdict(), 2, true)).toEqual({ tier: "high", automation: "suggest-only" });
  });
  it("截断优先级高于 cap 封顶后的 automation（cap=0 也仍是 suggest-only）", () => {
    expect(projectLevels(verdict(), 0, true)).toEqual({ tier: "none", automation: "suggest-only" });
  });
  it("Noul + 截断：tier 仍 none，automation 仍 suggest-only（两条规则各自生效）", () => {
    expect(projectLevels(verdict({ resultKind: "choice", choice: "Noul" }), 2, true)).toEqual({
      tier: "none",
      automation: "suggest-only",
    });
  });
});
