/**
 * dsh-provider-usage — unit：S2 契约与共享层（#768 计划表 rev2 S2 行）。
 *
 * 白盒直连 src（不经包入口，不落盘——本文件零落盘，故无 mkdtemp）：
 * 1. server/shared 新叶 errsurf：canonical 实现 + 门面二方同构
 *    （三域写 + 健康读的数据形状；Q5 的机器可判部分；#768 D13 删旧垫片
 *    domain2/common/errsurf.ts，common 目录已消除）；
 * 2. schedule 纯面先行：LAST_RUN_SCHEMA / deriveLastRun / alignLastRun 经
 *    server/schedule/interface.ts 复用（type + pure：确定性、无副作用；D2 起物理定义在调度域）；
 * 3. config 归一化单答案 / LEGACY 锁表先行：经 server/config/interface.ts
 *    复用（D1 起物理定义在 config 域；旧默认模板统一升级为三份新默认 = 单答案）；
 * 4. UpgradeDeps 窄面冻结：server/upgrade/deps.ts 纯类型面（运行时零出口，
 *    窄面三项可装配）；per-root 链不在本域；禁新建 file-io 叶（结构断言）。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  makeLayerErrorSurface,
  makeNoopLayerErrorSurface,
  LAYER_ERROR_KEYS,
  LAYER_ERROR_MAX_RECENT_DEFAULT,
} from "../../../src/server/shared/errsurf.ts";
import * as sharedFacade from "../../../src/server/shared/interface.ts";
// #768 D13：旧垫片 src/domain2/common/errsurf.ts 已删（common 目录消除），本文件不再导入旧路径。
import * as upgradeDepsNs from "../../../src/server/upgrade/deps.ts";
import type { UpgradeDeps } from "../../../src/server/upgrade/deps.ts";
import {
  LAST_RUN_SCHEMA,
  deriveLastRun,
  alignLastRun,
} from "../../../src/server/shared/interface.ts";
import { normalizeReportConfig } from "../../../src/server/config/interface.ts";
import {
  DEFAULT_PROMPTS,
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_WEEKLY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V1,
} from "../../../src/server/shared/interface.ts";

const SERVER_DIR = fileURLToPath(new URL("../../../src/server/", import.meta.url));

describe("1) server/shared 新叶与旧垫片同构", () => {
  it("门面透出的工厂与 canonical 同一引用", () => {
    expect(sharedFacade.makeLayerErrorSurface).toBe(makeLayerErrorSurface);
  });

  it("门面透出的 noop 与 canonical 同一引用", () => {
    expect(sharedFacade.makeNoopLayerErrorSurface).toBe(makeNoopLayerErrorSurface);
  });

  it("门面透出的键表与 canonical 同一引用", () => {
    expect(sharedFacade.LAYER_ERROR_KEYS).toBe(LAYER_ERROR_KEYS);
  });

  it("门面透出的默认保留条数与 canonical 一致", () => {
    expect(sharedFacade.LAYER_ERROR_MAX_RECENT_DEFAULT).toBe(LAYER_ERROR_MAX_RECENT_DEFAULT);
  });

  it("旧垫片已删除（common 目录消除；复活即回退）", () => {
    expect(existsSync(SERVER_DIR + "/../domain2/common/errsurf.ts")).toBe(false);
    expect(existsSync(SERVER_DIR + "/../domain2/common/interface.ts")).toBe(false);
    expect(existsSync(SERVER_DIR + "/../domain2/common")).toBe(false);
  });

  it("三域键齐（Q5 无单一所有者：写入方分属三域，非一域所有物）", () => {
    expect([...LAYER_ERROR_KEYS].sort()).toEqual(["aggregate", "execute", "schedule"]);
  });

  it("三域写 + 健康读形状：record 三层各记一条，snapshot 三键齐", () => {
    const surface = makeLayerErrorSurface();
    surface.record("aggregate", "压实失败");
    surface.record("schedule", "tick 异常", "daily 2026-01-14");
    surface.record("execute", "任务失败");
    const snap = surface.snapshot();
    expect(snap.aggregate.count).toBe(1);
    expect(snap.schedule.count).toBe(1);
    expect(snap.schedule.recent[0]?.context).toBe("daily 2026-01-14");
    expect(snap.execute.count).toBe(1);
  });

  it("进程期常驻对偶：两份 surface 互不干扰（内存态，无落盘共享）", () => {
    const a = makeLayerErrorSurface();
    const b = makeLayerErrorSurface();
    a.record("aggregate", "只记在 A");
    expect(b.snapshot().aggregate.count).toBe(0);
  });
});

describe("2) schedule 纯面经 interface 先行", () => {
  it("LAST_RUN_SCHEMA 为当期版本", () => {
    expect(LAST_RUN_SCHEMA).toBe(2);
  });

  it("deriveLastRun 空事实得空表（无 index 视作无事实）", () => {
    expect(deriveLastRun([])).toEqual({});
  });

  it("derive/align 纯函数：同输入同输出（确定性，无副作用）", () => {
    const records = [
      {
        period: "daily" as const,
        key: "2026-01-13",
        generatedAt: new Date(2026, 0, 14, 9, 0, 0).getTime(),
        endDay: "2026-01-13",
        ok: true,
      },
    ];
    expect(deriveLastRun(records)).toEqual(deriveLastRun(records));
    expect(alignLastRun({}, records)).toEqual(alignLastRun({}, records));
  });

  it("alignLastRun 保留首次启用预置键（index 无对应记录时不动）", () => {
    const preset = { daily: "2026-01-13" };
    expect(alignLastRun(preset, [])).toEqual(preset);
  });
});

describe("3) config 归一化单答案 / LEGACY 映射表先行", () => {
  it("旧单一默认模板统一升级为三份新默认（单答案）", () => {
    const next = normalizeReportConfig({ promptTemplate: LEGACY_PROMPT_TEMPLATE });
    expect(next.prompts).toEqual(DEFAULT_PROMPTS);
  });

  it("LEGACY 三周期旧词非空（迁移判定基准文本）", () => {
    // 锚：prompts.ts 锁表字面量长度，第二事实源（改文本必须红）。
    expect(LEGACY_DAILY_PROMPT_V1.length).toBe(623);
    expect(LEGACY_WEEKLY_PROMPT_V1.length).toBe(705);
    expect(LEGACY_MONTHLY_PROMPT_V1.length).toBe(823);
    // 形状：三词均含 {stats} 注入位 + 主笔头 + 各自时间尺度（今天/这一周/这个月）。
    for (const text of [
      LEGACY_DAILY_PROMPT_V1,
      LEGACY_WEEKLY_PROMPT_V1,
      LEGACY_MONTHLY_PROMPT_V1,
    ]) {
      expect(text.includes("{stats}")).toBe(true);
      expect(text.startsWith("你是「AI 用量年报」主笔。")).toBe(true);
    }
    expect(LEGACY_DAILY_PROMPT_V1.includes("时间尺度以「今天」为准")).toBe(true);
    expect(LEGACY_WEEKLY_PROMPT_V1.includes("时间尺度以「这一周」为准")).toBe(true);
    expect(LEGACY_MONTHLY_PROMPT_V1.includes("时间尺度以「这个月」为准")).toBe(true);
  });

  it("旧三周期模板命中即回退当期默认（平滑升级，不丢形态）", () => {
    const next = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V1,
        weekly: LEGACY_WEEKLY_PROMPT_V1,
        monthly: LEGACY_MONTHLY_PROMPT_V1,
      },
    });
    expect(next.prompts).toEqual(DEFAULT_PROMPTS);
  });
});

describe("4) UpgradeDeps 窄面冻结 + 禁 file-io 叶", () => {
  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(upgradeDepsNs)).toEqual([]);
  });

  it("窄面三项可装配（logger + root 解析能力 + 旧文件显式读面）", async () => {
    const calls: string[] = [];
    const deps: UpgradeDeps = {
      logger: { warn: (message: string) => void calls.push(message) },
      resolveRoot: () => "/tmp/dou-upgrade-root",
      readOldFile: async (file: string) => {
        if (file.endsWith("missing.json")) return { ok: false as const };
        return { ok: true as const, text: "{}" };
      },
    };
    expect(deps.resolveRoot()).toBe("/tmp/dou-upgrade-root");
    const hit = await deps.readOldFile("/x/config.json");
    expect(hit).toEqual({ ok: true, text: "{}" });
    const miss = await deps.readOldFile("/x/missing.json");
    expect(miss).toEqual({ ok: false });
    deps.logger.warn("版本落差");
    expect(calls).toEqual(["版本落差"]);
  });

  it("禁新建 file-io 叶：src/server 下无 file-io.ts", () => {
    expect(existsSync(SERVER_DIR + "/shared/file-io.ts")).toBe(false);
    expect(existsSync(SERVER_DIR + "/upgrade/file-io.ts")).toBe(false);
  });
});
