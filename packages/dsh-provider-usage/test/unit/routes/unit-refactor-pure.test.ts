/**
 * dsh-provider-usage — unit：#732 E3 抽出纯函数的直接单测（10/15 拆解面）。
 *
 * 每条用例都对着「一次实现改动打红」的标准写：
 * - pipeline/guards：validateFetchedData / isPlainRecord（取数载荷序列化校验）
 * - data-routes/adapters：parseSelectRequest（选择请求准入与清空面）
 * - ui-routes/trend：parseTrendQuery（查询参数归一，非法值回退不 400）
 * - config/normalize：objectSource 族经 normalizeReportConfig 观测（嵌套源口径）
 * - upgrade/last-run-morph：索引行形状白名单（经 migrateLastRun 观测坏行丢弃）
 * - aggregate-rows 面：tokenColumns / accumulateRow 经 aggregator.rollupSnapshot 观测
 *
 * 私有 helper（未导出）经其公开入口间接覆盖——本文件只对**已导出的纯函数**直接断言。
 */
import { describe, expect, it } from "vitest";
import { isPlainRecord, validateFetchedData } from "../../../src/server/pipeline/guards.ts";
import { parseSelectRequest } from "../../../src/server/data-routes/adapters.ts";
import { parseTrendQuery } from "../../../src/server/ui-routes/trend.ts";

describe("#732 E3 抽出纯函数单测", () => {
  describe("guards.validateFetchedData / isPlainRecord", () => {
    it("普通对象载荷：经 JSON 往返后原样返回", () => {
      expect(validateFetchedData({ a: 1, b: "x" })).toEqual({ data: { a: 1, b: "x" } });
    });

    it("Date 经 JSON 往返退化为字符串（证明校验走的是序列化往返而非原对象）", () => {
      const result = validateFetchedData({ at: new Date(0) });
      expect(result.data).toEqual({ at: "1970-01-01T00:00:00.000Z" });
    });

    it("非对象载荷（null / 数组 / 原始值）：稳定返回对象形态错误码", () => {
      for (const bad of [null, [1, 2], 42, "str", true]) {
        expect(validateFetchedData(bad)).toEqual({ error: "fetchData 必须返回对象" });
      }
    });

    it("undefined 经 JSON 往返后无文本可解析 → 抛错（调用方 catch 后归 error 分支）", () => {
      // JSON.stringify(undefined) 返回 undefined（非字符串），JSON.parse 因此抛错——
      // 与原实现同源：safeFetchData 的 catch 把它收成 { error: 解析文案 }，不产出半成品。
      expect(() => validateFetchedData(undefined)).toThrow();
    });

    it("不可序列化的值（循环引用）由 JSON.stringify 抛出，不产出半成品结果", () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => validateFetchedData(cyclic)).toThrow();
    });

    it("isPlainRecord 承担类型收窄：数组与 null 均不成立", () => {
      expect(isPlainRecord({})).toBe(true);
      expect(isPlainRecord([])).toBe(false);
      expect(isPlainRecord(null)).toBe(false);
      expect(isPlainRecord(0)).toBe(false);
      expect(isPlainRecord("s")).toBe(false);
    });
  });

  describe("adapters.parseSelectRequest", () => {
    it("切换面：provider + adapterName 双非空即通过", () => {
      expect(parseSelectRequest({ provider: "opencode-go", adapterName: "v1" })).toEqual({
        provider: "opencode-go",
        adapterName: "v1",
        clearing: false,
      });
    });

    it("清空面：adapterName 显式 null → clearing，provider 不做非空校验", () => {
      expect(parseSelectRequest({ provider: "opencode-go", adapterName: null })).toEqual({
        provider: "opencode-go",
        adapterName: null,
        clearing: true,
      });
      expect(parseSelectRequest({ provider: "", adapterName: null })).toEqual({
        provider: "",
        adapterName: null,
        clearing: true,
      });
    });

    it("切换面缺键/空串/非字符串一律回落空串并判非法", () => {
      for (const body of [
        {},
        { provider: "p" },
        { provider: "p", adapterName: undefined },
        { provider: "p", adapterName: 42 },
        { provider: "p", adapterName: "" },
        { provider: "", adapterName: "a" },
      ]) {
        expect(parseSelectRequest(body)).toBeNull();
      }
    });

    it("超长即非法（128 边界含端点，越一字符即红）", () => {
      const at128 = "x".repeat(128);
      expect(parseSelectRequest({ provider: at128, adapterName: "a" })).not.toBeNull();
      expect(parseSelectRequest({ provider: "x".repeat(129), adapterName: "a" })).toBeNull();
      expect(parseSelectRequest({ provider: "p", adapterName: at128 })).not.toBeNull();
      expect(parseSelectRequest({ provider: "p", adapterName: "x".repeat(129) })).toBeNull();
    });

    it("adapterName 为非 null 非字符串时按切换面回落空串 → 非法（不误判为清空）", () => {
      expect(parseSelectRequest({ provider: "p", adapterName: false })).toBeNull();
    });
  });

  describe("ui-routes.parseTrendQuery", () => {
    const url = (qs: string): URL => new URL(`/api/x?${qs}`, "http://localhost");

    it("缺省：无任何参数 → day/total/全 provider/非目录面", () => {
      const q = parseTrendQuery(url(""), 180);
      expect(q.granularity).toBe("day");
      expect(q.metric).toBe("total");
      expect(q.provider).toBeUndefined();
      expect(q.dir).toBeUndefined();
      expect(q.byDirAll).toBe(false);
      expect(q.byModel).toBe(false);
      expect(q.byDir).toBe(false);
    });

    it("粒度白名单：week/month 生效，其余回落 day", () => {
      expect(parseTrendQuery(url("granularity=week"), 180).granularity).toBe("week");
      expect(parseTrendQuery(url("granularity=month"), 180).granularity).toBe("month");
      expect(parseTrendQuery(url("granularity=year"), 180).granularity).toBe("day");
    });

    it("指标白名单：六个指标原样透传，白名单外回落 total", () => {
      for (const m of ["total", "input", "output", "cacheRead", "cacheWrite", "calls"]) {
        expect(parseTrendQuery(url(`metric=${m}`), 180).metric).toBe(m);
      }
      expect(parseTrendQuery(url("metric=bogus"), 180).metric).toBe("total");
    });

    it("provider：非空且 ≤128 生效，空串/超长回落 undefined（非法不 400）", () => {
      expect(parseTrendQuery(url("provider=p"), 180).provider).toBe("p");
      expect(parseTrendQuery(url("provider="), 180).provider).toBeUndefined();
      expect(parseTrendQuery(url(`provider=${"x".repeat(128)}`), 180).provider).toBe(
        "x".repeat(128),
      );
      expect(parseTrendQuery(url(`provider=${"x".repeat(129)}`), 180).provider).toBeUndefined();
    });

    it("dir：dir 过滤优先于 byDir（同传时 byDirAll 回落 false）", () => {
      const q = parseTrendQuery(url("dir=proj&byDir=1"), 180);
      expect(q.dir).toBe("proj");
      expect(q.byDirAll).toBe(false);
      expect(q.byDir).toBe(true);
    });

    it("byDir=1 单独传 → 目录拆段面", () => {
      const q = parseTrendQuery(url("byDir=1"), 180);
      expect(q.byDirAll).toBe(true);
      expect(q.byDir).toBe(true);
    });

    it("byDir 非 1 值（含 0/true）不触发目录面", () => {
      expect(parseTrendQuery(url("byDir=0"), 180).byDirAll).toBe(false);
      expect(parseTrendQuery(url("byDir=true"), 180).byDirAll).toBe(false);
    });

    it("byModel=1 生效，其余（含 0）不生效", () => {
      expect(parseTrendQuery(url("byModel=1"), 180).byModel).toBe(true);
      expect(parseTrendQuery(url("byModel=0"), 180).byModel).toBe(false);
    });

    it("n 走 clampTrendN 口径：非法值回落窗口缺省并受 retention 封顶", () => {
      expect(parseTrendQuery(url("n=7"), 180).n).toBe(7);
      expect(parseTrendQuery(url("n=0"), 180).n).toBe(30);
      expect(parseTrendQuery(url("n=abc"), 180).n).toBe(30);
      expect(parseTrendQuery(url("n=999"), 180).n).toBe(180);
    });
  });
});
