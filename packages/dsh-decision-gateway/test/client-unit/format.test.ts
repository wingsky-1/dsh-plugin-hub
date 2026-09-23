/** 显示格式纯函数（node 直跑，零 DOM）。
 *
 * 守的是用户可见的时间/id 文案：fmtTime 非法输入吞空、本地分量补零与月份 +1、
 * shortId 超长截断与边界等长；任一改动本文件必红。
 * 构造时间一律经 new Date(y,m,d,h,mi,s) 本地分量生成——断言与运行 TZ 无关。
 * fmtTime 的 try/catch 是不可达防御（isFinite 前置后 catch 无输入可触发），
 * 其 BlockStatement 变异体不可杀，不追。
 */
import { describe, expect, it } from "vitest";
import { fmtTime, shortId } from "../../src/client/settings/format.ts";

describe("fmtTime", () => {
  it("非有限数一律吞空", () => {
    expect(fmtTime(Number.NaN)).toBe("");
    expect(fmtTime(Number.POSITIVE_INFINITY)).toBe("");
    expect(fmtTime(Number.NEGATIVE_INFINITY)).toBe("");
    expect(fmtTime("x" as never)).toBe("");
  });
  it("个位分量补零", () => {
    const ts = new Date(2024, 0, 2, 3, 4, 5).getTime();
    expect(fmtTime(ts)).toBe("2024-01-02 03:04:05");
  });
  it("月份 +1 且十位不补零（含 10 分边界）", () => {
    const ts = new Date(2024, 5, 10, 13, 10, 9).getTime();
    expect(fmtTime(ts)).toBe("2024-06-10 13:10:09");
  });
  it("年末跨天分量各自正确", () => {
    const ts = new Date(2024, 11, 25, 0, 0, 0).getTime();
    expect(fmtTime(ts)).toBe("2024-12-25 00:00:00");
  });
});

describe("shortId", () => {
  it("短 id 原样返回（含等长边界）", () => {
    expect(shortId("abc")).toBe("abc");
    expect(shortId("12345678")).toBe("12345678");
  });
  it("超长按缺省 8 截断；自定义 len 生效", () => {
    expect(shortId("123456789")).toBe("12345678");
    expect(shortId("abcdef", 3)).toBe("abc");
    expect(shortId("ab", 3)).toBe("ab");
  });
});
