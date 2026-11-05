/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  __clearReportIndexCacheForTests,
  __reportIndexCacheStatsForTests,
  appendFileSync,
  join,
  mkdirSync,
  mkdtempSync,
  parseReportIndexLines,
  readReportIndex,
  renameSync,
  tmpdir,
  utimesSync,
  writeFileSync,
  type ReportMeta,
} from "./report-generation-support.ts";

describe("#626 读侧投影：一行/窗口=最新版 + 坏行防御", () => {
  let list: Array<ReportMeta & { id?: string }>;
  let d06Id: string | undefined;
  let parsedLen: number;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-proj-"));
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true });
    const indexFile = join(reports, "index.jsonl");
    const line = (generatedAt: number, key: string, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({
        period: "daily",
        key,
        startDay: key,
        endDay: key,
        generatedAt,
        ok: true,
        ...extra,
      });
    writeFileSync(
      indexFile,
      [
        line(100, "2026-09-06", { id: "v1" }), // 同日两次手动生成的旧版本
        line(200, "2026-09-06", { id: "v2" }), // 最新版本
        line(300, "2026-09-05", { id: "v3" }),
        "garbage-line", // 坏行跳过
      ].join("\n") + "\n",
    );
    list = await readReportIndex(root);
    d06Id = list.find((m) => m.key === "2026-09-06")!.id;
    parsedLen = parseReportIndexLines(
      "bad\n" + JSON.stringify({ period: "weekly", key: "2026-08-31", generatedAt: 1, ok: true }),
    ).length;
  });

  it("同窗口去重为一行", () => {
    expect(list.length).toBe(2);
  });

  it("倒序：最新 generatedAt 窗口在前", () => {
    expect(list[0].key).toBe("2026-09-05");
  });

  it("同窗口保留最新 generatedAt 版本", () => {
    expect(d06Id).toBe("v2");
  });

  it("坏行跳过、合法行保留", () => {
    expect(parsedLen).toBe(1);
  });
});

describe("#629 P1 readReportIndex 解析记忆化（mtime 感知缓存）", () => {
  let missingFirst: unknown;
  let missingSecond: unknown;
  let firstLen: number;
  let firstProjection: unknown;
  let secondProjection: unknown;
  let stats: { hits: number; misses: number };
  let thirdLen: number;
  let thirdFirstKey: string;
  let fourthGeneratedAt: number | undefined;
  let hitBefore: number;
  let hitAfter: number;
  let missFirstLen: number;
  let missSecondLen: number;
  let missHasMutated: boolean;
  let otherRootProjection: unknown;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-report-cache-"));
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true });
    const indexFile = join(reports, "index.jsonl");
    const metaA: ReportMeta = {
      period: "daily",
      key: "2026-09-05",
      startDay: "2026-09-05",
      endDay: "2026-09-05",
      generatedAt: 100,
      ok: true,
      provider: "",
      model: "",
      durationMs: 0,
    };
    __clearReportIndexCacheForTests(); // 隔离：清同进程其他块可能残留的缓存与计数

    // 缺失文件 → 空表（不缓存）
    missingFirst = JSON.parse(JSON.stringify(await readReportIndex(root)));
    missingSecond = JSON.parse(JSON.stringify(await readReportIndex(root)));

    // 首读建缓存
    writeFileSync(indexFile, `${JSON.stringify(metaA)}\n`);
    const first = await readReportIndex(root);
    firstLen = first.length;
    firstProjection = JSON.parse(JSON.stringify(first));

    // 二读命中缓存（投影一致即证，不重复解析语义漂移）
    const second = await readReportIndex(root);
    secondProjection = JSON.parse(JSON.stringify(second));

    // 计数器确定性证明：连续两读只解析一次（#629 P1「可测」——重复读不再线性重解析）
    const s = __reportIndexCacheStatsForTests();
    stats = { hits: s.hits, misses: s.misses };

    // append 一行（size/mtime 双变）→ 重新解析读到新行
    appendFileSync(
      indexFile,
      `${JSON.stringify({ ...metaA, key: "2026-09-06", generatedAt: 200 })}\n`,
    );
    const third = await readReportIndex(root);
    thirdLen = third.length;
    thirdFirstKey = third[0].key;

    // 原子替换改写（size 不变场景：同字节数内容替换 + utimes 显式设置不同 mtime，
    // 规避同毫秒粒度）→ mtime 变化独立失效
    const tmpSwap = `${indexFile}.swap`;
    writeFileSync(
      tmpSwap,
      `${JSON.stringify({ ...metaA, generatedAt: 999 })}\n${JSON.stringify({ ...metaA, key: "2026-09-06", generatedAt: 200 })}\n`,
    );
    utimesSync(tmpSwap, /* atime */ new Date(), /* mtime */ new Date(1_700_000_000_000)); // 显式旧 mtime：与 append 时刻必然不同
    renameSync(tmpSwap, indexFile);
    const fourth = await readReportIndex(root);
    fourthGeneratedAt = fourth.find((m) => m.key === "2026-09-05")?.generatedAt;

    // 命中路径返回浅拷贝——调用方改写返回值不污染缓存
    hitBefore = (await readReportIndex(root)).length;
    const hit = await readReportIndex(root);
    hit.length = 0;
    hitAfter = (await readReportIndex(root)).length;

    // miss 路径返回浅拷贝——与命中路径防御对称：首读（miss）返回值上就地突变不污染缓存
    const missRoot = mkdtempSync(join(tmpdir(), "dou-report-cache-miss-"));
    mkdirSync(join(missRoot, "reports"), { recursive: true });
    writeFileSync(join(missRoot, "reports", "index.jsonl"), `${JSON.stringify(metaA)}\n`);
    const missFirst = await readReportIndex(missRoot);
    missFirstLen = missFirst.length;
    missFirst.push({ ...metaA, key: "MUTATED", generatedAt: 1 });
    const missSecond = await readReportIndex(missRoot);
    missSecondLen = missSecond.length;
    missHasMutated = missSecond.some((m) => m.key === "MUTATED");

    // root 隔离：不同 historyRoot 互不串缓存
    const otherRoot = mkdtempSync(join(tmpdir(), "dou-report-cache-other-"));
    otherRootProjection = JSON.parse(JSON.stringify(await readReportIndex(otherRoot)));
    __clearReportIndexCacheForTests();
  });

  it("index 缺失 → 空表", () => {
    expect(missingFirst).toEqual([]);
  });

  it("index 缺失 → 空表（二次调用语义不变）", () => {
    expect(missingSecond).toEqual([]);
  });

  it("首读解析 1 条", () => {
    expect(firstLen).toBe(1);
  });

  it("stat 未变 → 命中缓存，投影一致", () => {
    expect(secondProjection).toEqual(firstProjection);
  });

  it("连续两读：miss=1（只解析一次）+ hit=1（第二读走缓存）", () => {
    expect(stats).toEqual({ hits: 1, misses: 1 });
  });

  it("append 后缓存失效并重解析", () => {
    expect(thirdLen).toBe(2);
  });

  it("倒序语义在缓存路径同样成立", () => {
    expect(thirdFirstKey).toBe("2026-09-06");
  });

  it("size 不变仅 mtime 变 → 仍失效重解析", () => {
    expect(fourthGeneratedAt).toBe(999);
  });

  it("命中路径返回的投影不被调用方改写污染", () => {
    expect(hitAfter).toBe(hitBefore);
  });

  it("miss 首读解析 1 条", () => {
    expect(missFirstLen).toBe(1);
  });

  it("miss 路径返回值就地 push 后，缓存不被污染", () => {
    expect(missSecondLen).toBe(1);
  });

  it("后续读不含调用方注入的污染项", () => {
    expect(missHasMutated).toBeFalsy();
  });

  it("另一 root（无 index）→ 空表，不命中前 root 缓存", () => {
    expect(otherRootProjection).toEqual([]);
  });
});
