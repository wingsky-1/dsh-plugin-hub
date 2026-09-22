/**
 * dsh-provider-usage — integration：采集域组合根四维度 + 超时验收（#768 计划表 rev2 D9 验收）。
 *
 * 白盒直连 src（读装配源码文本 + 经 server/collect 门面活装配）；落盘一律进
 * mkdtempSync 隔离目录（产物零污染；路径禁令：本文件只用隔离目录，走 dshHome 接缝检查由门禁覆盖）。
 * 中止验收经 server/pipeline 门面直连（白盒）调用
 * safeFetchData/runV2Pipeline。四维度 + 一验收：
 * - D9一 经 server/collect 域门面装配：TrendCollector/防御纯函数只经
 *   server/collect/interface.ts，不走旧 domain2/collect 入口；apply/index.ts、
 *   server/aggregate 六文件、server/config/normalize.ts、server/execute 四文件
 *   的采集消费收口新门面；门面禁整文件 re-export；包导出面（apply/index.ts 转发名）收窄后集合（B波）。
 * - D9二 采集线路钉住：60s tick 汇入（结算事件经 emit 汇入 + 60min TTL 驱逐可复现）与
 *   60s 惰性节流哨兵；5min 预热线路（apply startWarmupTimer 接 config.warmupIntervalMs
 *   默认 300000，下界 60000 钳制）。
 * - D9三 deps 注入面窄面：CollectWarn/CollectClock/CollectResolveCwd 命名接缝与
 *   块内联双生子（TrendCollectorOptions 保留内联函数类型，不 import type 本面）；
 *   deps.ts 纯类型面运行时零出口。
 * - D9四 resolveCwd 冻结（owner collect，延期未验证）：per-session 惰性单查、
 *   抛错归未识别桶、缺省不接归未识别桶——行为锁，不改语义。
 * - D9验收 超时悬挂必须红：悬挂 fetchData 经 5s 信号合并守卫变红（超时文案 + 合并信号
 *   已 abort + 外部信号合流取消），runV2Pipeline 悬挂端到端 stale 红帧；生产恒 5000
 *   由配置守卫常量锁定（用例内短超时只为速度，走同一 safeFetchData 代码路径）。
 *
 * 每条附判据句（把 X 改坏必须红）；文本哨兵仅锚真实 ABI 与装配关系，不做风格断言。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupIsolatedDirs, containsAny, hasExportStar, makeIsolatedDir } from "../../helpers.ts";
import { TrendCollector, TREND_DONE_MAX } from "../../../src/server/collect/interface.ts";
import {
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  TREND_DIR_MAX,
  sanitizeDirName,
  hourOfDay,
  sumToken,
  safeToken,
  safeId,
  isValidShardRow,
} from "../../../src/server/shared/interface.ts";
import { TrendCollector as ImplCollector } from "../../../src/server/collect/collector.ts";
import {
  sanitizeDirName as ImplSanitize,
  hourOfDay as ImplHour,
  sumToken as ImplSum,
  safeToken as ImplSafeToken,
  safeId as ImplSafeId,
  isValidShardRow as ImplValid,
} from "../../../src/server/shared/trend.ts";
import * as collectDepsNs from "../../../src/server/collect/deps.ts";
import type {
  CollectWarn,
  CollectClock,
  CollectResolveCwd,
} from "../../../src/server/collect/deps.ts";
import type {
  TrendCallRecord,
  TrendCollectorOptions,
  TrendEmit,
} from "../../../src/server/collect/interface.ts";
import type { FetchContext, UsageStatsAdapter } from "../../../src/shared/interface.ts";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import { safeFetchData, runV2Pipeline } from "../../../src/server/pipeline/interface.ts";
import { safeFetchData as ImplSafeFetch } from "../../../src/server/pipeline/guards.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const pkgDir = join(here, "..", "..", "..");
const repoRoot = join(here, "..", "..", "..", "..", "..");
const readText = (p: string): string => readFileSync(p, "utf8");
const applySrc = readText(join(srcDir, "apply", "apply.ts"));
const applyFaceSrc = readText(join(srcDir, "apply", "index.ts"));
const collectFaceSrc = readText(join(srcDir, "server", "collect", "interface.ts"));
const collectDepsSrc = readText(join(srcDir, "server", "collect", "deps.ts"));
const collectorSrc = readText(join(srcDir, "server", "collect", "collector.ts"));
const aggIndexSrc = readText(join(srcDir, "server", "aggregate", "index.ts"));
const aggStoreSrc = readText(join(srcDir, "server", "aggregate", "store.ts"));
const aggMainSrc = readText(join(srcDir, "server", "aggregate", "aggregator.ts"));
const aggQuerySrc = readText(join(srcDir, "server", "aggregate", "aggregate-query.ts"));
const aggRowsSrc = readText(join(srcDir, "server", "aggregate", "aggregate-rows.ts"));
const normalizeSrc = readText(join(srcDir, "server", "config", "normalize.ts"));
const runnerSrc = readText(join(srcDir, "server", "execute", "runner.ts"));
const generateSrc = readText(join(srcDir, "server", "execute", "generate.ts"));
const listDirsSrc = readText(join(srcDir, "server", "execute", "list-dirs.ts"));
const executeDepsSrc = readText(join(srcDir, "server", "execute", "deps.ts"));
const aggregateDepsSrc = readText(join(srcDir, "server", "aggregate", "deps.ts"));
const d8TestSrc = readText(
  join(pkgDir, "test", "integration", "aggregate", "composition-root.test.ts"),
);
const uiRoutesSrc = readText(join(srcDir, "server", "ui-routes", "trend.ts"));
const configSrc = readText(join(srcDir, "shared", "config.ts"));
const statsServiceSrc = readText(join(srcDir, "server", "pipeline", "stats-service.ts"));
const topologySrc = readText(join(repoRoot, "scripts", "data", "mutation-topology.json"));
const strykerCollectSrc = readText(
  join(repoRoot, "stryker.conf.d", "dsh-provider-usage-trend-collect.json"),
);

/** 旧门面判据：旧 domain2/collect 长路径或 ../../server/ 非规范深路径残留即红（针脚为域事实，命中循环见 helpers）。同级短径 ../collect/ 为新规（#768 跨域路径统一）。 */
function usesOldFace(src: string): boolean {
  return containsAny(src, ["domain2/collect", "../../server/"]);
}

/**
 * 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：窄面在此复用名称。
 * resolveCwd 缺省不接 store（目录恒归未识别桶）；clock 固定推进可复现。
 */
const warnSeam: CollectWarn = () => undefined;
const clockSeam: CollectClock = () => 1_700_000_000_000;
const resolveCwdSeam: CollectResolveCwd = () => undefined;

const tmpDirs: string[] = [];
function isolatedDir(prefix: string): string {
  return makeIsolatedDir(tmpDirs, prefix);
}
afterEach(() => {
  cleanupIsolatedDirs(tmpDirs);
});

// ---------------------------------------------------------------- 事件夹具
const T0 = new Date(2026, 8, 4, 12, 0, 0).getTime();
const nowBox = { t: T0 };
const tickClock = () => nowBox.t;
// 事件信封经 unknown 断言为 SessionEvent：与生产边界同构（最小 payload + 品牌类型，
// collector 防御性解析——ledger 同款）。
function headerEv(provider: string, model: string, time: number, seq = 1): SessionEvent {
  return {
    type: "request/header",
    seq,
    time,
    data: { header: { config: { provider, model } }, reason: "initial" },
  } as unknown as SessionEvent;
}
function msgEv(
  turn: number,
  step: number,
  usage: Record<string, unknown> | null,
  time: number,
  seq = 2,
  source?: { kind: string; provider: string; model: string },
): SessionEvent {
  return {
    type: "assistant/message",
    seq,
    time,
    data: {
      turn,
      step,
      ...(usage !== null ? { usage } : {}),
      message: {
        role: "assistant",
        source: source ?? { kind: "model", provider: "deepseek", model: "deepseek-chat" },
      },
    },
  } as unknown as SessionEvent;
}
const USAGE = (input = 100, output = 50) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
function mkCollector(extra: Partial<TrendCollectorOptions> = {}) {
  const emitted: TrendEmit[] = [];
  const collector = new TrendCollector({ now: tickClock, emit: (e) => emitted.push(e), ...extra });
  nowBox.t = T0;
  return { collector, emitted };
}
const callsOf = (emitted: TrendEmit[]): TrendCallRecord[] =>
  emitted
    .filter((e): e is Extract<TrendEmit, { type: "call" }> => e.type === "call")
    .map((e) => e.record);

// 探针 ctx：生产 v2.ts 以 `{...fetchCtx, signal, fetch} as unknown as FetchContext` 注入 fetch
// （运行时恒有，类型面隐藏），探针侧以交集如实建模；fetch 可选以满足 UsageStatsAdapter 逆变。
type ProbeCtx = FetchContext & { fetch?: typeof fetch };
function mkAdapter(
  name: string,
  provider: string,
  fetchData: (ctx: ProbeCtx) => Promise<Record<string, unknown>>,
): UsageStatsAdapter {
  return {
    version: 2,
    name,
    providers: [provider],
    fetchData,
    formatCapsule: () => "<span>s</span>",
    formatPanel: () => "<p>s</p>",
  };
}
const hangListen = (seen: { signal?: AbortSignal }) => (signal: AbortSignal) =>
  new Promise((_res, rej) => {
    seen.signal = signal;
    signal.addEventListener("abort", () => rej(new Error("adapter-aborted")), { once: true });
  });

describe("D9一 经 server/collect 域门面装配", () => {
  it("组合根与消费方只经新门面取采集（旧入口残留必须红）", () => {
    for (const src of [
      applyFaceSrc,
      aggIndexSrc,
      aggStoreSrc,
      aggMainSrc,
      aggQuerySrc,
      aggRowsSrc,
      normalizeSrc,
      runnerSrc,
      generateSrc,
      listDirsSrc,
      executeDepsSrc,
      aggregateDepsSrc,
      collectFaceSrc,
      collectDepsSrc,
      d8TestSrc,
      uiRoutesSrc,
    ]) {
      expect(usesOldFace(src)).toBe(false);
    }
    expect(applyFaceSrc.includes("server/collect/interface")).toBe(true);
    // #768 B1：TrendCollector 有状态注入后 aggregate 值边清零（仅 type 复用）；
    // 纯面（TREND_*/sumToken/sanitize 等）一律经 shared 门面
    expect(aggIndexSrc.includes("../collect/interface")).toBe(true);
    expect(aggIndexSrc.includes("makeCollector")).toBe(true);
    expect(aggIndexSrc.includes("import { TrendCollector }")).toBe(false);
    expect(normalizeSrc.includes("../collect/interface")).toBe(false);
    expect(normalizeSrc.includes("../shared/interface")).toBe(true);
    expect(runnerSrc.includes("../collect/interface")).toBe(false);
    expect(runnerSrc.includes("../shared/interface")).toBe(true);
    expect(uiRoutesSrc.includes("../collect/interface")).toBe(false);
    expect(uiRoutesSrc.includes("../shared/interface")).toBe(true); // #768 跨域路径统一：同级短径，与余下消费一致
  });

  it("门面收口：interface 与实现同一引用（包装即红）", () => {
    expect(TrendCollector).toBe(ImplCollector);
    expect(sanitizeDirName).toBe(ImplSanitize);
    expect(hourOfDay).toBe(ImplHour);
    expect(sumToken).toBe(ImplSum);
    expect(safeToken).toBe(ImplSafeToken);
    expect(safeId).toBe(ImplSafeId);
    expect(isValidShardRow).toBe(ImplValid);
  });

  it("门面禁整文件 re-export（加星导出即红）", () => {
    for (const src of [collectFaceSrc, collectDepsSrc]) {
      const codeLines = src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("*"));
      expect(hasExportStar(codeLines)).toBe(false);
    }
  });

  it("门面值出口恰为 11 项（多一项即公共面膨胀）", async () => {
    const faceNs = await import("../../../src/server/collect/interface.ts");
    expect(Object.keys(faceNs).sort()).toEqual(
      [
        "TrendCollector",
        "TREND_DONE_MAX",
        "TREND_ROW_VERSION",
        "TREND_UNIDENTIFIED",
        "TREND_DIR_MAX",
        "sanitizeDirName",
        "hourOfDay",
        "sumToken",
        "safeToken",
        "safeId",
        "isValidShardRow",
      ].sort(),
    );
  });

  it("变异面登记随域改址（旧路径残留即红）", () => {
    expect(topologySrc.includes("src/domain2/collect/")).toBe(false);
    for (const p of ["src/server/collect/collector.ts", "src/server/collect/types.ts"]) {
      expect(topologySrc.includes(p)).toBe(true);
    }
    expect(strykerCollectSrc.includes("src/domain2/collect/")).toBe(false);
    expect(strykerCollectSrc.includes("src/server/collect/collector.ts")).toBe(true);
    expect(strykerCollectSrc.includes("src/server/collect/types.ts")).toBe(true);
  });
});
describe("D9二 采集线路钉住（60s tick 汇入 + 5min 预热）", () => {
  it("结算事件经 emit 汇入：同键重试逐次计（删汇入即红）", () => {
    const { collector, emitted } = mkCollector();
    collector.handleEvent("s1", headerEv("deepseek", "deepseek-chat", T0));
    collector.handleEvent("s1", msgEv(1, 1, USAGE(10, 5), T0 + 100));
    collector.handleEvent("s1", msgEv(1, 1, USAGE(10, 5), T0 + 200));
    const calls = callsOf(emitted);
    expect(calls).toHaveLength(2);
    expect(calls[0].retry).toBe(1);
    expect(calls[1].retry).toBe(2);
    expect(calls[0].provider).toBe("deepseek");
    expect(calls[0].tokens!.input).toBe(10);
  });

  it("60min TTL 驱逐可复现：闲置会话被他会话 tick 清掉后序号重起（冻 TTL 即红）", () => {
    const { collector, emitted } = mkCollector();
    collector.handleEvent("sa", headerEv("deepseek", "deepseek-chat", T0));
    collector.handleEvent("sa", msgEv(7, 0, USAGE(1, 1), T0 + 10));
    collector.handleEvent("sa", msgEv(7, 0, USAGE(1, 1), T0 + 20));
    expect(callsOf(emitted).map((c) => c.retry)).toEqual([1, 2]);
    // 时钟拨过 60min TTL，他会话一次 header tick 触发惰性扫描驱逐 sa
    nowBox.t = T0 + 61 * 60 * 1000;
    collector.handleEvent("sb", headerEv("deepseek", "deepseek-chat", nowBox.t));
    collector.handleEvent("sa", msgEv(7, 0, USAGE(1, 1), nowBox.t + 10));
    expect(callsOf(emitted).map((c) => c.retry)).toEqual([1, 2, 1]);
  });

  it("防御纯面经门面活可用（删调用即红）", () => {
    expect(sumToken(1, 2)).toBe(3);
    expect(sumToken(null, 5)).toBe(5);
    expect(sanitizeDirName("/a/b/proj")).toBe("proj");
    expect(safeToken(3.7)).toBe(4);
    expect(safeId("x")).toBe("x");
    expect(hourOfDay(T0)).toBe(new Date(T0).getHours());
    expect(TREND_ROW_VERSION).toBe(1);
    expect(TREND_DIR_MAX).toBe(256);
    expect(isValidShardRow({ v: 1, kind: "nope" })).toBe(false);
  });

  it("60s 惰性节流哨兵仍在实现内（删节流即红）", () => {
    expect(collectorSrc.includes("60_000")).toBe(true);
    expect(collectorSrc.includes("TREND_SESSION_TTL_MS")).toBe(true);
    expect(collectorSrc.includes("TREND_DONE_MAX")).toBe(true);
    expect(TREND_DONE_MAX).toBe(200);
  });

  it("5min 预热线路钉住：apply 经 warmupIntervalMs 启定时预热（拆线即红）", () => {
    expect(applySrc.includes("startWarmupTimer")).toBe(true);
    expect(applySrc.includes("warmupIntervalMs")).toBe(true);
    expect(applySrc.includes("statsService.getStats")).toBe(true);
    expect(configSrc.includes("warmupIntervalMs: 300000")).toBe(true);
    expect(configSrc.includes("Math.max(60000")).toBe(true);
  });
});

describe("D9三 deps 注入面窄面", () => {
  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(collectDepsNs)).toEqual([]);
  });

  it("命名接缝装配 TrendCollector（改名断链即红）", () => {
    const c = new TrendCollector({
      now: clockSeam,
      emit: () => undefined,
      onAnomaly: warnSeam,
      resolveCwd: resolveCwdSeam,
    });
    c.handleEvent("s", headerEv("deepseek", "deepseek-chat", 1_700_000_000_000));
    expect(c).toBeInstanceOf(ImplCollector);
  });

  it("归属异常经 warn 接缝出声（吞告警即红）", () => {
    const warns: string[] = [];
    const { collector } = mkCollector({ onAnomaly: (m) => warns.push(m) });
    collector.handleEvent("s9", headerEv("deepseek", "deepseek-chat", T0));
    collector.handleEvent(
      "s9",
      msgEv(1, 1, USAGE(1, 1), T0 + 10, 2, { kind: "model", provider: "other", model: "m" }),
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("归属不一致");
  });
});

describe("D9四 resolveCwd 冻结（延期未验证，行为锁）", () => {
  it("per-session 惰性单查：同会话两次结算只查一次（多查即红）", () => {
    let queries = 0;
    const seen: string[] = [];
    const { collector } = mkCollector({
      resolveCwd: (s) => {
        queries += 1;
        seen.push(s);
        return "/home/u/proj";
      },
    });
    collector.handleEvent("sq", headerEv("deepseek", "deepseek-chat", T0));
    collector.handleEvent("sq", msgEv(1, 1, USAGE(1, 1), T0 + 10));
    collector.handleEvent("sq", msgEv(1, 2, USAGE(1, 1), T0 + 20));
    expect(queries).toBe(1);
    expect(seen).toEqual(["sq"]);
  });

  it("目录归属取 basename（错归即红）", () => {
    const { collector, emitted } = mkCollector({ resolveCwd: () => "/home/u/proj" });
    collector.handleEvent("sd", headerEv("deepseek", "deepseek-chat", T0));
    collector.handleEvent("sd", msgEv(1, 1, USAGE(1, 1), T0 + 10));
    expect(callsOf(emitted)[0].dir).toBe("proj");
  });

  it("resolveCwd 抛错归未识别桶且不丢数（抛错连坐即红）", () => {
    const { collector, emitted } = mkCollector({
      resolveCwd: () => {
        throw new Error("store 炸了");
      },
    });
    collector.handleEvent("se", headerEv("deepseek", "deepseek-chat", T0));
    collector.handleEvent("se", msgEv(1, 1, USAGE(1, 1), T0 + 10));
    const calls = callsOf(emitted);
    expect(calls).toHaveLength(1);
    expect(calls[0].dir).toBe(TREND_UNIDENTIFIED);
  });

  it("缺省不接 store 恒归未识别桶（静默丢弃即红）", () => {
    const { collector, emitted } = mkCollector();
    collector.handleEvent("sn", headerEv("deepseek", "deepseek-chat", T0));
    collector.handleEvent("sn", msgEv(1, 1, USAGE(1, 1), T0 + 10));
    expect(callsOf(emitted)[0].dir).toBe(TREND_UNIDENTIFIED);
  });
});
describe("D9验收 超时悬挂必须红（5s 信号合并 abort 集成用例）", () => {
  it("域门面与实现同一 safeFetchData（包装即红）", () => {
    // B波续批收窄后集合：产物入口转发已退役，断言域门面与实现同一。
    expect(safeFetchData).toBe(ImplSafeFetch);
  });

  it("生产恒 5s：fetchTimeoutMs 固定 5000 且管线原值透传（改小/可配即红）", () => {
    expect(configSrc.includes("fetchTimeoutMs: 5000")).toBe(true);
    expect(statsServiceSrc.includes("timeoutMs: this.config.fetchTimeoutMs")).toBe(true);
  });

  it("悬挂取数超时变红：文案稳定 fetchData 超时（吞超时即红）", async () => {
    const seen: { signal?: AbortSignal } = {};
    const r = await safeFetchData(hangListen(seen), 25);
    expect(r.error).toBe("fetchData 超时");
    expect(r.data).toBe(undefined);
  }, 10000);

  it("合并信号已下发且超时后 abort：透传给 fetch 即中断真实请求（悬挂不断即红）", async () => {
    const seen: { signal?: AbortSignal } = {};
    await safeFetchData(hangListen(seen), 25);
    expect(seen.signal instanceof AbortSignal).toBe(true);
    expect(seen.signal!.aborted).toBe(true);
  }, 10000);

  it("外部信号合流：宿主断连时悬挂取数立即取消（不合流即红）", async () => {
    const controller = new AbortController();
    const seen: { signal?: AbortSignal } = {};
    const p = safeFetchData(hangListen(seen), 5000, controller.signal);
    setTimeout(() => controller.abort(), 5);
    const r = await p;
    expect(r.error).toBe("fetchData 已被取消");
    expect(seen.signal!.aborted).toBe(true);
  }, 10000);

  it("runV2Pipeline 悬挂端到端 stale 红帧：ok=false 且不落 fresh（挂起不红即红）", async () => {
    const adapter = mkAdapter(
      "hang-adp",
      "p-hang",
      (): Promise<Record<string, unknown>> => new Promise<Record<string, unknown>>(() => {}),
    );
    const r = await runV2Pipeline({
      adapter,
      provider: "p-hang",
      config: {},
      staticPath: "",
      timeoutMs: 25,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("stale");
    expect(r.error).toBe("fetchData 超时");
    expect(r.rawData).toBe(undefined);
  }, 15000);
});

describe("探针：detector 失明则本段先红", () => {
  it("旧门面 detector 对脏输入有效", () => {
    expect(usesOldFace("import { x } from ../domain2/collect/interface.ts")).toBe(true);
    expect(usesOldFace("import { x } from ../collect/interface.ts")).toBe(false);
    expect(usesOldFace("import { x } from ../server/collect/interface.ts")).toBe(false);
    expect(usesOldFace("import { x } from ../../server/collect/interface.ts")).toBe(true);
  });

  it("export * detector 对脏输入有效", () => {
    expect(hasExportStar(["export * from ./collector.ts"])).toBe(true);
    expect(hasExportStar(["export { a } from ./collector.ts"])).toBe(false);
  });

  it("隔离目录可用（mkdtemp 探针）", () => {
    const dir = isolatedDir("dou-collectD9-");
    expect(typeof dir).toBe("string");
  });
});
