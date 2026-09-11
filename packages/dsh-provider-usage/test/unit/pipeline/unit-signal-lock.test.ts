// @ts-nocheck
/**
 * dsh-provider-usage — unit：#120 signal 接线 + per-provider 互斥配套断言。
 *
 * 硬性断言三项（issue #120 配套要求）：
 * 1. 超时后底层 fetch 收到 abort——合并信号下发至 fetchData 入参并透传给 fetchImpl，
 *    超时触发后该 signal.aborted === true（真实场景下 undici fetch 收到同一信号即中断请求）；
 * 2. 0 参 fetchData 兼容不受影响——形参 0 个的适配器照常走 fresh 通道；
 * 3. 超时失败不当 fresh 落历史——失败帧 ok=false/status='stale'/无 rawData，
 *    上层 append 门控（ok && fresh && rawData!==undefined）三条件全破，绝不落盘。
 *
 * 另覆盖：外部信号合流（手动级联监听，engines node>=20 兼容，不用 AbortSignal.any）、
 * 已 abort 外部信号的同步短路、成功路径监听器摘除、管道组装 fail-fast 断言。
 */
console.error("EVAL-ORDER-TAG: SIGNAL-LOCK");
import { afterAll, describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import {
  runV2Pipeline,
  safeFetchData,
} from "../../../src/apply/index.ts";

/** 构造满足 v2 契约的最小适配器（format 函数恒返回占位）。 */
function mkAdapter(name, provider, fetchData) {
  return {
    version: 2,
    name,
    providers: [provider],
    fetchData,
    formatCapsule: () => "<span>s</span>",
    formatPanel: () => "<p>s</p>",
  };
}

describe("硬性1：超时后底层 fetch 收到 abort", () => {
  // safeFetchData 层：fn 收到合并信号；超时后该信号 aborted=true
  const probeSafeFetchDataTimeout = async () => {
    let seen;
    const r = await safeFetchData(async (signal) => {
      seen = signal;
      await new Promise(() => {}); // 模拟慢远端永挂
      return {};
    }, 25);
    return { r, seen };
  };

  it("超时错误文案稳定", async () => {
    const { r } = await probeSafeFetchDataTimeout();
    expect(r.error).toBe("fetchData 超时");
  });

  it("fn 入参收到 AbortSignal（合并信号已下发）", async () => {
    const { seen } = await probeSafeFetchDataTimeout();
    expect(seen instanceof AbortSignal).toBeTruthy();
  });

  it("超时后合并信号已 abort（透传给 fetch 即中断真实请求）", async () => {
    const { seen } = await probeSafeFetchDataTimeout();
    expect(seen.aborted).toBe(true);
  });

  // runV2Pipeline 层端到端：fetchData 把 ctx.signal 透传给注入的 fetch（deepseek-official
  // 直传形态），超时后底层 fetch 手里的正是同一个已 abort 的信号（接线证据链闭合）
  const probePipelineSignalPassthrough = async () => {
    const seen = { fromAdapter: undefined, fromFetch: undefined };
    const adapter = mkAdapter("sig-adp", "p-sig", async (ctx) => {
      seen.fromAdapter = ctx.signal;
      // 模拟真实适配器：signal 原样进 RequestInit.signal，fetch 内部挂到网络上
      return await ctx.fetch("https://gw.test/usage", { signal: ctx.signal });
    });
    const r = await runV2Pipeline({
      adapter,
      provider: "p-sig",
      config: {},
      staticPath: "",
      timeoutMs: 25,
      fetchImpl: (_url, init) => new Promise((_res, rej) => {
        seen.fromFetch = init.signal;
        init.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
      }),
    });
    return { r, seen };
  };

  it("超时取数失败帧 ok=false", async () => {
    const { r } = await probePipelineSignalPassthrough();
    expect(r.ok).toBe(false);
  });

  it("超时失败帧 status=stale", async () => {
    const { r } = await probePipelineSignalPassthrough();
    expect(r.status).toBe("stale");
  });

  it("超时文案经管线原样上浮", async () => {
    const { r } = await probePipelineSignalPassthrough();
    expect(r.error).toBe("fetchData 超时");
  });

  it("fetchData 入参收到合并 AbortSignal", async () => {
    const { seen } = await probePipelineSignalPassthrough();
    expect(seen.fromAdapter instanceof AbortSignal).toBeTruthy();
  });

  it("超时后 fetchData 手里的信号已 abort", async () => {
    const { seen } = await probePipelineSignalPassthrough();
    expect(seen.fromAdapter.aborted).toBe(true);
  });

  it("底层 fetch 收到的正是下发的合并信号（同对象）", async () => {
    const { seen } = await probePipelineSignalPassthrough();
    expect(seen.fromFetch).toBe(seen.fromAdapter);
  });

  it("底层 fetch 观察到 abort（socket 可中断）", async () => {
    const { seen } = await probePipelineSignalPassthrough();
    expect(seen.fromFetch.aborted).toBe(true);
  });

  // opencode-go 监听形态：fetchData 监听 ctx.signal 做补偿取消，超时后同样被触发
  const probeListenModeTimeout = async () => {
    let notified = false;
    const adapter = mkAdapter("sig-listen", "p-sig-l", (ctx) => new Promise((_res, rej) => {
      ctx.signal.addEventListener("abort", () => {
        notified = true;
        rej(new Error("aborted"));
      }, { once: true });
    }));
    const r = await runV2Pipeline({ adapter, provider: "p-sig-l", config: {}, staticPath: "", timeoutMs: 25 });
    return { r, notified };
  };

  it("race 超时分支先于 fn rejection 定格错误文案", async () => {
    const { r } = await probeListenModeTimeout();
    expect(r.error).toBe("fetchData 超时");
  });

  it("监听型适配器在超时后收到取消通知", async () => {
    const { notified } = await probeListenModeTimeout();
    expect(notified).toBe(true);
  });
});

describe("硬性2：0 参 fetchData 兼容不受影响", () => {
  // 形参 0 个的 fetchData（旧版常见声明）：不读入参、不依赖 signal，走正常 fresh 通道
  const zeroArg = function zero() { return Promise.resolve({ visits: 9 }); };

  const probeZeroArg = async () => {
    const adapter = mkAdapter("zero-adp", "p-zero", zeroArg);
    const r = await runV2Pipeline({ adapter, provider: "p-zero", config: {}, staticPath: "", timeoutMs: 1000 });
    return r;
  };

  it("前置确认：被测 fetchData 为 0 形参声明", () => {
    expect(zeroArg.length).toBe(0);
  });

  it("0 参 fetchData 正常成功", async () => {
    expect((await probeZeroArg()).ok).toBe(true);
  });

  it("0 参 fetchData 走 fresh 通道", async () => {
    expect((await probeZeroArg()).status).toBe("fresh");
  });

  it("数据保真（多传一个 signal 实参无影响）", async () => {
    expect((await probeZeroArg()).rawData).toEqual({ visits: 9 });
  });

  it("胶囊照常渲染", async () => {
    expect(typeof (await probeZeroArg()).capsuleHtml).toBe("string");
  });
});

describe("硬性3：超时失败不当 fresh 落历史", () => {
  // 失败帧三条件全破：ok=false / status='stale' / rawData===undefined
  // ——上层 append 门控（result.ok && status==='fresh' && rawData!==undefined）绝不放行
  const probeSlowFailFrame = async () => {
    const adapter = mkAdapter("slow-adp", "p-hist", () => new Promise(() => {}));
    return await runV2Pipeline({ adapter, provider: "p-hist", config: {}, staticPath: "", timeoutMs: 25 });
  };

  it("超时帧 ok=false（门控条件1破）", async () => {
    expect((await probeSlowFailFrame()).ok).toBe(false);
  });

  it("超时帧 status=stale（门控条件2破）", async () => {
    expect((await probeSlowFailFrame()).status).toBe("stale");
  });

  it("超时帧无 rawData（门控条件3破）→ 绝不以 fresh 身份落历史", async () => {
    expect((await probeSlowFailFrame()).rawData).toBe(undefined);
  });

  it("失败原因标记 fetch-failed", async () => {
    expect((await probeSlowFailFrame()).reason).toBe("fetch-failed");
  });

  it("error 字段携带失败信息", async () => {
    expect((await probeSlowFailFrame()).error).not.toBe(null);
  });

  // 对照组：fresh 成功帧携带 rawData——证明「无 rawData」是超时路径特有而非通用形状
  const probeFastFreshFrame = async () => {
    const adapter = mkAdapter("fast-adp", "p-hist-ok", async () => ({ v: 1 }));
    return await runV2Pipeline({ adapter, provider: "p-hist-ok", config: {}, staticPath: "", timeoutMs: 1000 });
  };

  it("对照组 fresh", async () => {
    expect((await probeFastFreshFrame()).status).toBe("fresh");
  });

  it("fresh 帧携带 rawData 供历史落盘", async () => {
    expect((await probeFastFreshFrame()).rawData).toEqual({ v: 1 });
  });
});

describe("外部信号合流（手动级联，node>=20 兼容）", () => {
  // 外部信号中途 abort → 取数立即取消，不等超时窗口
  const probeExternalAbort = async () => {
    const external = new AbortController();
    const t0 = Date.now();
    const pending = safeFetchData(() => new Promise(() => {}), 10_000, external.signal);
    setTimeout(() => external.abort(), 5); // 触发用定时器：驱动外部 abort 事件（非等待语义）
    const r = await pending;
    return { r, elapsed: Date.now() - t0 };
  };

  it("外部取消走专用错误文案", async () => {
    expect((await probeExternalAbort()).r.error).toBe("fetchData 已被取消");
  });

  it("外部取消立即生效，不等 10s 超时", async () => {
    const { elapsed } = await probeExternalAbort();
    expect(elapsed < 2000, `外部取消立即生效（实际 ${elapsed}ms），不等 10s 超时`).toBeTruthy();
  });

  // 预先已 abort 的外部信号：同步短路立即取消
  const probePreAborted = async () => {
    const external = new AbortController();
    external.abort();
    const t0 = Date.now();
    const r = await safeFetchData(() => new Promise(() => {}), 10_000, external.signal);
    return { r, elapsed: Date.now() - t0 };
  };

  it("预 abort 外部信号立即取消", async () => {
    expect((await probePreAborted()).r.error).toBe("fetchData 已被取消");
  });

  it("同步短路不等超时", async () => {
    const { elapsed } = await probePreAborted();
    expect(elapsed < 2000, `同步短路不等超时（实际 ${elapsed}ms）`).toBeTruthy();
  });

  // 成功路径：外部信号监听器被摘除——后续外部 abort 不再产生任何副作用，
  // 且结果不受影响（防长生命周期外部信号累积监听器泄漏）
  const probeSuccessPath = async () => {
    const external = new AbortController();
    const r = await safeFetchData(async () => ({ ok: 1 }), 1000, external.signal);
    const listenersAfterSettle = getEventListeners(external.signal, "abort").length;
    const dataBeforeAbort = r.data?.ok;
    external.abort(); // 监听器已摘除，此 abort 不产生任何副作用
    return { dataBeforeAbort, listenersAfterSettle, dataAfterAbort: r.data?.ok };
  };

  it("带外部信号的正常取数不受影响", async () => {
    expect((await probeSuccessPath()).dataBeforeAbort).toBe(1);
  });

  // 可观测代理：node:events#getEventListeners 直读 EventTarget 监听器表，锁死
  // 「成功路径必须摘除内部 abort 监听器」（原 eventListenerList 非 Node AbortSignal
  // 公开属性、before>=0 恒真弱断言，已按 hardener 纪律清除）
  it("成功路径后外部信号无残留 abort 监听器", async () => {
    expect((await probeSuccessPath()).listenersAfterSettle).toBe(0);
  });

  it("结果保持不变", async () => {
    expect((await probeSuccessPath()).dataAfterAbort).toBe(1);
  });

  // 外部取消判负后的用户 promise rejection 不产生 unhandledRejection：
  // fn 在 abort 后以 rejected 结束（模拟真实 fetch 抛 AbortError），进程必须存活
  it("外部取消正常上报", async () => {
    const external = new AbortController();
    const onUnhandled = () => {
      throw new Error("出现了 unhandledRejection——safeFetchData 未兜底 race 判负的用户 promise");
    };
    process.once("unhandledRejection", onUnhandled);
    try {
      const pending = safeFetchData((_signal) => new Promise((_res, rej) => {
        external.signal.addEventListener("abort", () => rej(new Error("AbortError: canceled")), { once: true });
      }), 10_000, external.signal);
      setTimeout(() => external.abort(), 5); // 触发用定时器：驱动外部 abort 事件（非等待语义）
      const r = await pending;
      expect(r.error).toBe("fetchData 已被取消");
      await new Promise((res) => setTimeout(res, 30)); // 有意延迟：给潜在 unhandledRejection 留出暴露窗口（fixture）
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

describe("fail-fast：管道内部组装断言", () => {
  // timeoutMs 非法（0/负数/NaN）时不发起任何取数，直接产出既有 error 帧；
  // 不新增配置项、不是对用户适配器的契约约束（#120 P2 判定点=管道组装）
  const probeBadTimeout = async (bad) => {
    let called = false;
    const adapter = mkAdapter("ff-adp", "p-ff", async () => { called = true; return {}; });
    const r = await runV2Pipeline({ adapter, provider: "p-ff", config: {}, staticPath: "", timeoutMs: bad });
    return { r, called };
  };

  for (const bad of [0, -5, Number.NaN]) {
    it(`timeoutMs=${bad} 时 fail-fast 失败帧`, async () => {
      expect((await probeBadTimeout(bad)).r.ok).toBe(false);
    });

    it(`timeoutMs=${bad} 错误形态为既有 stale 帧`, async () => {
      expect((await probeBadTimeout(bad)).r.status).toBe("stale");
    });

    it(`timeoutMs=${bad} fail-fast 文案点明组装非法`, async () => {
      expect((await probeBadTimeout(bad)).r.error ?? "").toMatch(/pipeline 组装非法/);
    });

    it(`timeoutMs=${bad} 未发起任何用户取数`, async () => {
      expect((await probeBadTimeout(bad)).called).toBe(false);
    });
  }
});

afterAll(() => {
  console.log("[unit] #120 signal 接线 + per-provider 配套断言 ✓");
});
