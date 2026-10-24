/** dsh-provider-usage — unit: 目录归属与落盘。 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayKey } from "../../../src/shared/interface.ts";
import { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import { TREND_UNIDENTIFIED } from "../../../src/server/shared/interface.ts";
import { TrendCollector } from "../../../src/server/collect/interface.ts";
import { sanitizeDirName } from "../../../src/server/shared/interface.ts";
import { HEADER, T0, USAGE, ev, snapshot } from "./collector-test-support.ts";
import { tmpdir } from "node:os";

const roots: string[] = [];

function createRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("#633 A1(a)：per-session 惰性单查（resolveCwd 恰 1 次）", () => {
  let cwdCalls: string[];
  let unpersistedRows: number;

  beforeAll(async () => {
    // A1(a)：per-session 惰性单查——同 session 多次 emit 事件（call 定稿/校正/counter/
    // 新 turn call），resolveCwd 恰查询 1 次（结果缓存进会话状态）
    const root = createRoot("dou-trend-dir-once-");
    const cwdCalls0: string[] = [];
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      resolveCwd: (session) => {
        cwdCalls0.push(session);
        return "/home/u/project-a";
      },
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2)); // call 定稿（首次查询）
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(11, 6), T0, 3)); // 同 fold 校正
    tracker.handleEvent(
      { id: "s1" },
      ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, T0, 4),
    ); // counter
    tracker.handleEvent(
      { id: "s1" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 5),
    ); // counter
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 6));
    tracker.handleEvent(
      { id: "s1" },
      ev(
        "assistant/chunk",
        { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 3, outputTokens: 3 } } },
        T0,
        7,
      ),
    ); // 新 turn call
    await tracker.flushNow();
    cwdCalls = snapshot(cwdCalls0);
    unpersistedRows = tracker.stats().unpersistedRows;
    await tracker.dispose();
  });

  it("同 session 多次 emit 事件，resolveCwd 恰查询 1 次", () => {
    expect(cwdCalls).toEqual(["s1"]);
  });

  it("事件正常入账（2 call + 2 counter）", () => {
    expect(unpersistedRows).toBe(0);
  });
});

describe("#633 A1(b)：resolveCwd 缺失/抛错归未识别桶且各查 1 次", () => {
  let countsS1: number;
  let countsS2: number;
  let s1Dir: string;
  let s2Dir: string;

  beforeAll(async () => {
    // A1(b)：resolveCwd 返回 undefined（store 无该 session / cwd 缺失）或抛错 →
    // 归 TREND_UNIDENTIFIED 且各自仅查询 1 次（未识别结果同样缓存，防重复查询）
    const root = createRoot("dou-trend-dir-miss-");
    const counts: Record<string, number> = { s1: 0, s2: 0 };
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      resolveCwd: (session) => {
        counts[session] = (counts[session] ?? 0) + 1;
        if (session === "s1") return undefined;
        throw new Error("boom");
      },
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    tracker.handleEvent(
      { id: "s1" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3),
    );
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 5));
    tracker.handleEvent(
      { id: "s2" },
      ev("tool/call", { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" }, T0, 6),
    );
    await tracker.flushNow();
    countsS1 = counts.s1;
    countsS2 = counts.s2;
    const rows = readFileSync(join(root, "details", `${dayKey(T0)}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    s1Dir = rows.find((r) => r.kind === "detail" && r.session === "s1").dir;
    s2Dir = rows.find((r) => r.kind === "detail" && r.session === "s2").dir;
    await tracker.dispose();
  });

  it("undefined 路径仅查询 1 次", () => {
    expect(countsS1).toBe(1);
  });

  it("抛错路径仅查询 1 次", () => {
    expect(countsS2).toBe(1);
  });

  it("undefined → 未识别桶", () => {
    expect(s1Dir).toBe(TREND_UNIDENTIFIED);
  });

  it("抛错 → 未识别桶", () => {
    expect(s2Dir).toBe(TREND_UNIDENTIFIED);
  });
});

describe("#633 A1(c)：cwd 经 sanitizeDirName 净化后落盘 + 纯函数面直测", () => {
  let dirS1: string;
  let dirS2: string;
  let dirS3: string;
  let dirS4: string;
  let countersAllBasename: boolean;
  let sanitizedWindows: string | null;
  let sanitizedDriveRoot: string | null;
  let sanitizedUnc: string | null;

  beforeAll(async () => {
    // A1(c)：resolveCwd 返回含路径分隔符/尾斜杠的 cwd → 落盘为 sanitizeDirName
    // 净化后的 basename（数据层即存净化值，B1 可区分性约定）；POSIX '/' 与
    // Windows '\' 分隔符同取（复核闸 P1：反斜杠路径整串落盘即泄漏绝对路径）。
    const root = createRoot("dou-trend-dir-sanitize-");
    let flip = 0;
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      resolveCwd: () =>
        [
          "/home/u/my proj/v2/",
          "C:\\Users\\alice\\repo",
          "D:\\work\\my app\\",
          "/mixed/slash\\back",
        ][flip++ % 4],
    });
    // 四个会话各一次定稿调用 + turn/end（覆盖 POSIX 尾斜杠 / Windows 反斜杠 / Windows 尾反斜杠 / 混合分隔符）
    for (let s = 1; s <= 4; s += 1) {
      tracker.handleEvent({ id: `s${s}` }, ev("request/header", HEADER(), T0, s * 3 - 2));
      tracker.handleEvent({ id: `s${s}` }, ev("assistant/chunk", USAGE(10, 5), T0, s * 3 - 1));
      tracker.handleEvent(
        { id: `s${s}` },
        ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, s * 3),
      );
    }
    await tracker.flushNow();
    const rows = readFileSync(join(root, "details", `${dayKey(T0)}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    const dirOf = (sid: string): string =>
      rows.find((r) => r.kind === "detail" && r.session === sid).dir;
    dirS1 = dirOf("s1");
    dirS2 = dirOf("s2");
    dirS3 = dirOf("s3");
    dirS4 = dirOf("s4");
    const counters = rows.filter((r) => r.kind === "counter");
    countersAllBasename =
      counters.length === 4 && counters.every((r) => !r.dir.includes("\\") && !r.dir.includes("/"));
    await tracker.dispose();
    // 纯函数面直测（复核闸 P1 锁定 sanitizeDirName 本体语义）
    sanitizedWindows = sanitizeDirName("C:\\Users\\bob\\proj");
    sanitizedDriveRoot = sanitizeDirName("C:\\");
    sanitizedUnc = sanitizeDirName("\\\\server\\share\\notes");
  });

  it("POSIX 尾斜杠 → basename（末段）", () => {
    expect(dirS1).toBe("v2");
  });

  it("Windows 反斜杠路径 → basename（复核闸 P1：整串落盘即绝对路径泄漏）", () => {
    expect(dirS2).toBe("repo");
  });

  it("Windows 尾反斜杠 → basename（前段）", () => {
    expect(dirS3).toBe("my app");
  });

  it("混合分隔符取最深一段（lastIndexOf 两系较大者）", () => {
    expect(dirS4).toBe("back");
  });

  it("counter 行 dir 同口径：四例全 basename 化，无任何分隔符残留", () => {
    expect(countersAllBasename).toBeTruthy();
  });

  it("sanitizeDirName: Windows 反斜杠 basename", () => {
    expect(sanitizedWindows).toBe("proj");
  });

  it("sanitizeDirName: 盘符根路径 → null（未识别）", () => {
    expect(sanitizedDriveRoot).toBe(null);
  });

  it("sanitizeDirName: UNC 形态取末段", () => {
    expect(sanitizedUnc).toBe("notes");
  });
});

describe("#633 A1(d)：落盘 detail/counter 行均含 dir 字段且多 session 不串桶", () => {
  let dS1Dir: string;
  let dS2Dir: string;
  let cS1Dir: string;
  let cS2Dir: string;

  beforeAll(async () => {
    // A1(d)：落盘 detail/counter 行均含 dir 字段且值正确（多 session 各自归属不串桶）
    const root = createRoot("dou-trend-dir-persist-");
    const tracker = await TrendTracker.start({
      makeCollector: (o) => new TrendCollector(o),
      root,
      now: () => T0,
      flushDebounceMs: 60000,
      resolveCwd: (session) => (session === "s1" ? "/home/u/alpha" : "/home/u/beta"),
    });
    tracker.handleEvent({ id: "s1" }, ev("request/header", HEADER(), T0, 1));
    tracker.handleEvent({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 2));
    tracker.handleEvent(
      { id: "s1" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 3),
    );
    tracker.handleEvent({ id: "s2" }, ev("request/header", HEADER(), T0, 4));
    tracker.handleEvent({ id: "s2" }, ev("assistant/chunk", USAGE(7, 7), T0, 5));
    tracker.handleEvent(
      { id: "s2" },
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, T0, 6),
    );
    await tracker.flushNow();
    const rows = readFileSync(join(root, "details", `${dayKey(T0)}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    const dS1 = rows.find((r) => r.kind === "detail" && r.session === "s1");
    const dS2 = rows.find((r) => r.kind === "detail" && r.session === "s2");
    const cS1 = rows.find((r) => r.kind === "counter" && r.session === "s1");
    const cS2 = rows.find((r) => r.kind === "counter" && r.session === "s2");
    dS1Dir = dS1.dir;
    dS2Dir = dS2.dir;
    cS1Dir = cS1.dir;
    cS2Dir = cS2.dir;
    await tracker.dispose();
  });

  it("s1 detail 行 dir=alpha", () => {
    expect(dS1Dir).toBe("alpha");
  });

  it("s2 detail 行 dir=beta（多 session 不串桶）", () => {
    expect(dS2Dir).toBe("beta");
  });

  it("s1 counter 行 dir=alpha", () => {
    expect(cS1Dir).toBe("alpha");
  });

  it("s2 counter 行 dir=beta", () => {
    expect(cS2Dir).toBe("beta");
  });
});

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});
