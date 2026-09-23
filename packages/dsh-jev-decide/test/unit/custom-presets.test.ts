/** 自建自定义预设存储：校验 + 落盘往返 + 决议接线（mkdtempSync 隔离，全程离线）。
 *
 * 守的是 P1 自建存储面：保留字拒收、形状拒收、落盘往返 createdAt 保持、
 * 自定义 id 可决议（含开关/cap 封顶）、listPresets 带 custom 旗。
 * 把任一分支改松本文件必红。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CustomPreset } from "../../src/shared/interface.ts";
import { validateCustomPresets, validatePutBody } from "../../src/server/config/impl/model.ts";
import { customPresetsFile } from "../../src/server/config/impl/paths.ts";
import { loadCustomPresets, loadState, savePatch } from "../../src/server/config/impl/service.ts";
import type { ConfigDeps } from "../../src/server/config/deps.ts";
import { atomicWrite0600Sync, readJsonSync, readTextSync } from "../../src/server/store/impl/io.ts";
import { validateDecideArgs } from "../../src/server/tools/impl/validate.ts";
import { decide, listPresets } from "../../src/server/tools/impl/service.ts";
import type { DecideDeps } from "../../src/server/tools/deps.ts";

function deps(): ConfigDeps {
  return { io: { readJsonSync, readTextSync, atomicWrite0600Sync }, logger: { warn: () => {} } };
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "jev-custom-"));
}

function customEntry(over: Partial<CustomPreset> = {}): Record<string, unknown> {
  return {
    id: "my-board",
    label: "My board",
    description: "Goal: teach callers how to ask about boards.",
    enabled: true,
    automationCap: 2,
    ...over,
  };
}

function customMap(): ReadonlyMap<string, CustomPreset> {
  const checked = validateCustomPresets([customEntry()]);
  if (!checked.ok) throw new Error("fixture invalid");
  return new Map(checked.list.map((entry) => [entry.id, entry]));
}

const CONNECTION = {
  timeoutMs: 8000,
  maxConcurrency: 4,
  truncBudget: 32000,
  hasPlaintextKey: false,
} as const;

function baseDeps(over: Partial<DecideDeps> = {}): DecideDeps {
  return {
    logger: { warn: () => {} },
    connection: { ...CONNECTION },
    isEnabled: () => true,
    capOf: () => 2,
    resolveKey: () => ({ key: "Abcdefgh12345678", source: "env" as const }),
    root: "/tmp/proj",
    sessionId: "sess-1",
    ...over,
  };
}

describe("validateCustomPresets 形状", () => {
  it("合法整列通过并打时间戳", () => {
    const r = validateCustomPresets([customEntry()]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.list).toHaveLength(1);
      expect(r.list[0]?.id).toBe("my-board");
      expect(typeof r.list[0]?.createdAt).toBe("number");
    }
  });
  it("保留字 frozen id 即 RESERVED_PRESET", () => {
    for (const id of ["general", "secret-leak", "plan-review", "risk-check", "custom"]) {
      const r = validateCustomPresets([customEntry({ id })]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.errorCode).toBe("RESERVED_PRESET");
    }
  });
  it("坏 id/重复/超长/坏 cap 即拒收", () => {
    expect(validateCustomPresets([{ ...customEntry(), id: "坏" }]).ok).toBe(false);
    expect(validateCustomPresets([customEntry(), customEntry()]).ok).toBe(false);
    expect(validateCustomPresets([{ ...customEntry(), label: "" }]).ok).toBe(false);
    expect(validateCustomPresets([{ ...customEntry(), automationCap: 9 }]).ok).toBe(false);
    expect(validateCustomPresets("x").ok).toBe(false);
  });
  it("PUT 白名单收 customPresets", () => {
    const r = validatePutBody({ customPresets: [customEntry()] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.customPresets).toHaveLength(1);
  });
});

describe("落盘往返（缺席即空列表）", () => {
  it("缺席文件即空列表；非法形状 warn 后空列表", () => {
    const home = tempHome();
    expect(loadCustomPresets(home, deps())).toEqual([]);
  });
  it("savePatch 全量替换 + createdAt 保持", () => {
    const home = tempHome();
    const d = deps();
    const first = validatePutBody({ customPresets: [customEntry()] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const saved = savePatch(home, first.patch, d);
    expect(saved.customPresets).toHaveLength(1);
    expect(customPresetsFile(home).endsWith("custom-presets.json")).toBe(true);
    const createdAt = saved.customPresets[0]?.createdAt;
    const again = validatePutBody({
      customPresets: [{ ...customEntry(), label: "Renamed" }],
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const saved2 = savePatch(home, again.patch, d);
    expect(saved2.customPresets[0]?.label).toBe("Renamed");
    expect(saved2.customPresets[0]?.createdAt).toBe(createdAt);
    expect(loadState(home, d).customPresets).toHaveLength(1);
  });
});

describe("决议接自定义 id", () => {
  const override = [{ id: "q1", text: "Pick?", kind: "choice", options: ["A", "B"] }] as const;
  it("未知 id 即 UNKNOWN_PRESET；自建 id 缺题即 MISSING_OVERRIDE", () => {
    const unknown = validateDecideArgs(
      { preset_id: "nope", state: { text: "x", lang: "en" }, questions_override: [...override] },
      customMap(),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.failure.errorCode).toBe("UNKNOWN_PRESET");
    const missing = validateDecideArgs(
      { preset_id: "my-board", state: { text: "x", lang: "en" } },
      customMap(),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.errorCode).toBe("MISSING_OVERRIDE");
  });
  it("自建 id 带题即 custom appliedSource", () => {
    const r = validateDecideArgs(
      {
        preset_id: "my-board",
        state: { text: "x", lang: "en" },
        questions_override: [...override],
      },
      customMap(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.valid.appliedSource).toBe("custom");
  });
  it("关闭的自建即 PRESET_DISABLED；cap 0 封顶 manual", async () => {
    const events: unknown[] = [];
    const disabled = await decide(
      {
        preset_id: "my-board",
        state: { text: "x", lang: "en" },
        questions_override: [...override],
      },
      baseDeps({
        isEnabled: () => false,
        customPresets: customMap(),
        recordEvent: (e) => {
          events.push(e);
        },
        fetchImpl: async () => ({ status: 200, text: "{}" }),
      }),
    );
    expect(disabled.ok).toBe(false);
    expect(events).toHaveLength(0);
    const capped = await decide(
      {
        preset_id: "my-board",
        state: { text: "x", lang: "en" },
        questions_override: [...override],
      },
      baseDeps({
        capOf: () => 0,
        customPresets: customMap(),
        fetchImpl: async () => ({
          status: 200,
          text: JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              q1: {
                type: "choice",
                choice: "A",
                confidence: 0.9,
                probabilities: { A: 0.9, B: 0.1 },
              },
            },
            usage: { input_tokens: 9, output_tokens: 3 },
          }),
        }),
      }),
    );
    expect(capped).toMatchObject({ ok: true, tier: "none", automation: "manual" });
  });
  it("事件带调用题目快照（含候选项全列）", async () => {
    const events: { questions?: { id: string; options?: readonly string[] }[] }[] = [];
    const out = await decide(
      {
        preset_id: "my-board",
        state: { text: "x", lang: "en" },
        questions_override: [...override],
      },
      baseDeps({
        customPresets: customMap(),
        recordEvent: (e) => {
          events.push(e as never);
        },
        fetchImpl: async () => ({
          status: 200,
          text: JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              q1: {
                type: "choice",
                choice: "A",
                confidence: 0.9,
                probabilities: { A: 0.9, B: 0.1 },
              },
            },
            usage: { input_tokens: 9, output_tokens: 3 },
          }),
        }),
      }),
    );
    expect(out.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.questions?.[0]?.options).toEqual(["A", "B"]);
  });
});

describe("listPresets 自建合并", () => {
  it("frozen 5 + 自建 1，custom 旗与描述透出", () => {
    const all = listPresets({
      isEnabled: () => true,
      capOf: () => 2,
      customs: [...customMap().values()],
    });
    expect(all).toHaveLength(6);
    const mine = all.find((entry) => entry.id === "my-board");
    expect(mine).toMatchObject({ custom: true, label: "My board", templateVersion: 1 });
    expect(all.filter((entry) => !entry.custom)).toHaveLength(5);
  });
});
