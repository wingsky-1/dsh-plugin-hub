/**
 * dsh-notifier pipeline 域 judge 块 —— 唯一裁决点的判据顺序与边界。
 *
 * 时间纪律：免打扰判定读 `new Date()`，故用 `vi.setSystemTime` 钉住「现在」。三点理由写在这里，
 * 因为这个文件是后续所有时间相关用例的样板：
 *  1. **不调 `vi.useFakeTimers`**：`setSystemTime` 单独用只换掉 `globalThis.Date`，不碰事件循环，
 *     因此与真实 IO 无冲突；开了假时钟就要跟着操心定时器推进。
 *  2. **日期一律本地构造** `new Date(y, m, d, h, mi)`：`getHours()/getMinutes()` 读的是本地时区，
 *     两端同源，于是本文件在任意 `TZ`、任意 pool（forks/threads）下结果一致；写成
 *     `new Date("...Z")` 会在非 UTC 时区下随机红。
 *  3. `afterEach` 必须 `useRealTimers()` 还原被替换的 `Date`，否则同文件后续用例看到伪造的「现在」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type { NotifyConfig } from "../../../src/server/config/impl/model/type.ts";
import { judgeRequest } from "../../../src/server/pipeline/impl/judge/index.ts";
import { BUILTIN_KINDS } from "../../../src/server/pipeline/impl/service/kinds.ts";
import type { NotifyKind } from "../../../src/server/pipeline/impl/service/kinds.ts";
import type { NotifyRequest } from "../../../src/server/pipeline/impl/service/type.ts";

/** 事件开关在设置里的键名。 */
type KindSwitchKey =
  | "notifyAsk"
  | "notifyQuestion"
  | "notifyTaskDone"
  | "notifySubagentDone"
  | "notifyTaskError"
  | "notifyTurnEnd";

/** 内置事件 → 它的开关。独立写一遍而不是从源码导：漏配或改名的种类会在这里红，抄源码就恒真了。 */
const KIND_SWITCHES: ReadonlyArray<readonly [NotifyKind, KindSwitchKey]> = [
  ["ask", "notifyAsk"],
  ["question", "notifyQuestion"],
  ["done", "notifyTaskDone"],
  ["subagent-done", "notifySubagentDone"],
  ["error", "notifyTaskError"],
  ["turn-end", "notifyTurnEnd"],
];

/** 跨午夜窗口，用于免打扰与短路顺序两组用例。 */
const QUIET_CROSS_MIDNIGHT: NotifyConfig["quietHours"] = {
  enabled: true,
  start: "22:00",
  end: "08:00",
};

/** 2026-01-15 的某个本地时刻。 */
function at(hour: number, minute: number): Date {
  return new Date(2026, 0, 15, hour, minute, 0);
}

/** 把「现在」钉死并产出配置；`over` 只覆盖本次关心的键。 */
function configAt(now: Date, over: Partial<NotifyConfig> = {}): NotifyConfig {
  vi.setSystemTime(now);
  return { ...DEFAULT_CONFIG, ...over };
}

function request(kind: NotifyKind, over: Partial<NotifyRequest> = {}): NotifyRequest {
  return { kind, title: "标题", body: "正文", ...over };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("judgeRequest 判据顺序：总开关 → kind 开关 → 动态 kind 确认 → 免打扰", () => {
  it("总开关关：短路在最前，连免打扰都不看", () => {
    const config = configAt(at(23, 0), { quietHours: QUIET_CROSS_MIDNIGHT });
    expect(judgeRequest(config, request("done"), false)).toEqual({ ok: false, reason: "disabled" });
  });

  it("kind 开关：六个内置事件各由自己的开关决定", () => {
    for (const [kind, key] of KIND_SWITCHES) {
      const off = configAt(at(12, 0));
      off[key] = false;
      expect(judgeRequest(off, request(kind), true), `${key} 关`).toEqual({
        ok: false,
        reason: "kind-off",
      });

      const on = configAt(at(12, 0));
      on[key] = true;
      expect(judgeRequest(on, request(kind), true), `${key} 开`).toEqual({ ok: true });
    }
  });

  it("内置种类开关覆盖完整：全部置关后除 test 外无一放行（漏配开关键的 kind 会在这里露出来）", () => {
    const allOff = configAt(at(12, 0));
    for (const [, key] of KIND_SWITCHES) allOff[key] = false;
    for (const kind of BUILTIN_KINDS) {
      if (kind === "test") continue;
      expect(judgeRequest(allOff, request(kind), true), kind).toEqual({
        ok: false,
        reason: "kind-off",
      });
    }
  });

  it("test 没有开关也没有免打扰：用户主动按下它，被静音吃掉等于测试按钮失效", () => {
    const config = configAt(at(23, 0), {
      notifyTaskDone: false,
      quietHours: { ...QUIET_CROSS_MIDNIGHT, allowKinds: [] },
    });
    expect(judgeRequest(config, request("test"), true)).toEqual({ ok: true });
  });

  it("kind 开关先于免打扰：开关关时给 kind-off 而不是 quiet", () => {
    const config = configAt(at(23, 0), { notifyTaskDone: false, quietHours: QUIET_CROSS_MIDNIGHT });
    expect(judgeRequest(config, request("done"), true)).toEqual({ ok: false, reason: "kind-off" });
  });

  it("severity 不参与裁决（只影响出站呈现）", () => {
    const config = configAt(at(12, 0));
    expect(judgeRequest(config, request("done", { severity: "failure" }), true)).toEqual({
      ok: true,
    });
  });
});

describe("judgeRequest 动态 kind：确认名单是唯一凭据", () => {
  it("未确认 → unlisted；确认（进 allowKinds）→ 放行", () => {
    expect(judgeRequest(configAt(at(12, 0)), request("demo:report"), true)).toEqual({
      ok: false,
      reason: "unlisted",
    });
    expect(
      judgeRequest(
        configAt(at(12, 0), { allowKinds: ["demo:report"] }),
        request("demo:report"),
        true,
      ),
    ).toEqual({ ok: true });
  });

  it("命名空间撞内置名的 kind 不是内置种类：allowKinds 里写 ask 不会放行 ask:foo", () => {
    // 与 sdk 域 send 守卫同源：`ask:foo` 查不到任何事件开关，放行它等于放行一条无归属的通知。
    const config = configAt(at(12, 0), { allowKinds: ["ask"] });
    expect(judgeRequest(config, request("ask:foo"), true)).toEqual({
      ok: false,
      reason: "unlisted",
    });
  });

  it("动态 kind 也受免打扰约束：确认与免打扰是两道独立的关", () => {
    const config = configAt(at(23, 0), {
      allowKinds: ["demo:report"],
      quietHours: QUIET_CROSS_MIDNIGHT,
    });
    expect(judgeRequest(config, request("demo:report"), true)).toEqual({
      ok: false,
      reason: "quiet",
    });
  });
});

describe("免打扰：窗口两端都是闭开 [start, end)", () => {
  it.each<[number, number, boolean]>([
    [21, 59, true],
    [22, 0, false],
    [23, 59, false],
    [0, 0, false],
    [7, 59, false],
    [8, 0, true],
  ])("跨午夜窗口 22:00–08:00 在 %i:%i 时放行=%s", (hour, minute, allowed) => {
    const config = configAt(at(hour, minute), { quietHours: QUIET_CROSS_MIDNIGHT });
    const verdict = judgeRequest(config, request("done"), true);
    expect(verdict).toEqual(allowed ? { ok: true } : { ok: false, reason: "quiet" });
  });

  it.each<[number, number, boolean]>([
    [12, 59, true],
    [13, 0, false],
    [13, 59, false],
    [14, 0, true],
  ])("同日窗口 13:00–14:00 在 %i:%i 时放行=%s", (hour, minute, allowed) => {
    const config = configAt(at(hour, minute), {
      quietHours: { enabled: true, start: "13:00", end: "14:00" },
    });
    const verdict = judgeRequest(config, request("done"), true);
    expect(verdict).toEqual(allowed ? { ok: true } : { ok: false, reason: "quiet" });
  });

  it("quietHours.enabled=false 时窗口形同不存在", () => {
    const config = configAt(at(23, 0), {
      quietHours: { enabled: false, start: "22:00", end: "08:00" },
    });
    expect(judgeRequest(config, request("done"), true)).toEqual({ ok: true });
  });

  it("时段内仍放行的 kind（quietHours.allowKinds）逐条生效，未列出的照压", () => {
    const config = configAt(at(23, 0), {
      quietHours: { ...QUIET_CROSS_MIDNIGHT, allowKinds: ["error"] },
    });
    expect(judgeRequest(config, request("error"), true)).toEqual({ ok: true });
    expect(judgeRequest(config, request("done"), true)).toEqual({ ok: false, reason: "quiet" });
  });

  it("脏设置不吞通知：时刻解析失败一律算未命中", () => {
    for (const [start, end] of [
      ["25:00", "08:00"],
      ["22:60", "08:00"],
      ["abc", "08:00"],
      ["", "08:00"],
      ["9:30", "08:00"],
      ["22:00", "nope"],
    ]) {
      const config = configAt(at(23, 0), { quietHours: { enabled: true, start, end } });
      expect(judgeRequest(config, request("done"), true), `start=${start} end=${end}`).toEqual({
        ok: true,
      });
    }
  });

  it("零长窗口（start == end）不算命中：它更可能是没填完，而不是「静音一整天」", () => {
    const config = configAt(at(23, 0), {
      quietHours: { enabled: true, start: "22:00", end: "22:00" },
    });
    expect(judgeRequest(config, request("done"), true)).toEqual({ ok: true });
  });
});
