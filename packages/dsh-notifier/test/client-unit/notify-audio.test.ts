/**
 * dsh-notifier — 音频出口的判据（#769 阶段 2）。
 *
 * 解锁/自播/节流原先直接操作真实的 AudioContext 与 Date.now，因此「未解锁」「被浏览器挂起」
 * 「resume 被拒绝」「不支持 Web Audio」四条分支一条都测不到——而它们正是能力自检面要对用户
 * 交代的那几种情况。这里用假构造器与可控时钟把四条都跑出来。
 */
import { describe, expect, it } from "vitest";

import {
  createAudioEngine,
  PLAY_THROTTLE_MS,
  type AudioContextLike,
} from "../../src/client/notify/audio.ts";
import { FOLLOW_SYSTEM_TONE, TONES } from "../../src/shared/interface.ts";

function harness(options?: {
  state?: string;
  resume?: () => Promise<void> | void;
  supported?: boolean;
}) {
  const oscillators: Array<{ type: string; frequency: { value: number } }> = [];
  const sampleRates: number[] = [];
  const context = {
    state: options?.state ?? "running",
    currentTime: 5,
    destination: {},
    createBuffer: (_channels: number, _length: number, sampleRate: number): unknown => {
      sampleRates.push(sampleRate);
      return {};
    },
    createBufferSource: () => ({ buffer: null, connect: () => undefined, start: () => undefined }),
    createOscillator: () => {
      const osc = {
        type: "",
        frequency: { value: 0 },
        connect: () => undefined,
        start: () => undefined,
        stop: () => undefined,
      };
      oscillators.push(osc);
      return osc;
    },
    createGain: () => ({
      gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
      connect: () => undefined,
    }),
    resume: options?.resume ?? (() => Promise.resolve()),
  };
  let constructions = 0;
  // 必须是普通函数：箭头函数没有 [[Construct]]，new 一个箭头函数会抛 TypeError，而 unlock()
  // 的 try/catch 会把它吞成「静默无上下文」——测试于是看起来像「产品不工作」。
  const ctor =
    options?.supported === false
      ? undefined
      : (function fakeAudioContext() {
          constructions += 1;
          return context;
        } as unknown as new () => AudioContextLike);
  // 用真实量级的时钟：节流门的初始水位是 0，接近 0 的时钟会让首次放行判 false
  let clock = 1_000_000;
  const engine = createAudioEngine({
    ctor: () => ctor,
    now: () => clock,
  });
  return {
    engine,
    context,
    oscillators,
    sampleRates,
    constructions: () => constructions,
    setClock: (value: number) => {
      clock = value;
    },
    clock: () => clock,
  };
}

describe("音频出口：不支持 Web Audio", () => {
  it("facts 报不支持，解锁与自播都是 no-op（不抛）", () => {
    const h = harness({ supported: false });
    h.engine.unlock();
    h.engine.playTone("ding");
    h.engine.playPreview("ding");
    expect(h.engine.facts()).toEqual({
      supported: false,
      state: null,
      hasEverRun: false,
      resumeRejected: false,
    });
    expect(h.oscillators).toHaveLength(0);
  });
});

describe("音频出口：解锁", () => {
  it("只在首次调用时构造上下文，并播一个空 buffer（手势内仪式）", async () => {
    const h = harness({ state: "suspended" });
    h.engine.unlock();
    h.engine.unlock();
    h.engine.unlock();
    expect(h.constructions()).toBe(1);
    expect(h.sampleRates).toEqual([22050, 22050, 22050]);
    // suspended 起步时「曾跑起来过」只能由 resume() 的回调记下——它在微任务里落定，
    // 同步读会是 false（既有语义，不是缺陷：能力自检面在下次渲染时看到的就是 true）
    expect(h.engine.facts().hasEverRun).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.engine.facts().hasEverRun).toBe(true);
  });

  it("state 已是 running：当场记下「曾跑起来过」", () => {
    const h = harness({ state: "running" });
    h.engine.unlock();
    expect(h.engine.facts()).toMatchObject({ supported: true, state: "running", hasEverRun: true });
  });

  it("resume 被拒绝：记成 resumeRejected（与「还没轮到」区分开，两者下一步动作不同）", async () => {
    const h = harness({ state: "suspended", resume: () => Promise.reject(new Error("denied")) });
    h.engine.unlock();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.engine.facts()).toMatchObject({
      state: "suspended",
      hasEverRun: false,
      resumeRejected: true,
    });
  });

  it("尚未构造时 state 为 null（不是「不支持」——只是还没人在这个页面上点过）", () => {
    const h = harness({ state: "suspended" });
    expect(h.engine.facts()).toMatchObject({ supported: true, state: null, hasEverRun: false });
  });
});

describe("音频出口：自播", () => {
  it("未解锁（上下文未构造）时不发声", () => {
    const h = harness({ state: "running" });
    h.engine.playTone("ding");
    expect(h.oscillators).toHaveLength(0);
  });

  it("按音色表逐音起振：ding 两音、bell 一音、pop 用三角波", () => {
    const h = harness({ state: "running" });
    h.engine.unlock();
    h.engine.playTone("ding");
    expect(h.oscillators.map((o) => o.frequency.value)).toEqual(
      TONES.ding!.notes.map((n) => n.freq),
    );

    const bell = harness({ state: "running" });
    bell.engine.unlock();
    bell.engine.playTone("bell");
    expect(bell.oscillators).toHaveLength(TONES.bell!.notes.length);

    const pop = harness({ state: "running" });
    pop.engine.unlock();
    pop.engine.playTone("pop");
    expect(pop.oscillators[0]!.type).toBe("triangle");
  });

  it("未知音色与「跟随系统」都落到 default 音色（不是静默）", () => {
    for (const tone of [undefined, "nope"] as Array<string | undefined>) {
      const h = harness({ state: "running" });
      h.engine.unlock();
      h.engine.playTone(tone);
      expect(h.oscillators.map((o) => o.frequency.value)).toEqual(
        TONES[FOLLOW_SYSTEM_TONE]!.notes.map((n) => n.freq),
      );
    }
  });

  it("上下文不在 running 时不发声（被挂起/已关闭）", () => {
    for (const state of ["suspended", "closed"]) {
      const h = harness({ state });
      h.engine.unlock();
      h.engine.playTone("ding");
      expect(h.oscillators, state).toHaveLength(0);
    }
  });
});

describe("音频出口：节流", () => {
  it("PLAY_THROTTLE_MS 是字面量锚（防静默漂移，不是行为判据）", () => {
    // 行为用例都把常量当输入喂进去，改这个数字不会红；这条锚让「改数字」必须在测试里显式改一次。
    expect(PLAY_THROTTLE_MS).toBe(1500);
  });

  it("节流窗口边界：1499ms 仍被拦、1500ms 放行、1501ms 又被拦（判定是严格小于）", () => {
    const h = harness({ state: "running" });
    const base = h.clock();
    expect(h.engine.gate()).toBe(true);
    h.setClock(base + 1499);
    expect(h.engine.gate()).toBe(false);
    h.setClock(base + 1500);
    expect(h.engine.gate()).toBe(true);
    h.setClock(base + 1501);
    expect(h.engine.gate()).toBe(false);
  });

  it("试听绕过统一节流（用户手势内直接试听不受限制）", () => {
    const h = harness({ state: "running" });
    h.engine.unlock();
    expect(h.engine.gate()).toBe(true);
    h.engine.playPreview("ding");
    expect(h.oscillators).toHaveLength(TONES.ding!.notes.length);
  });
});
