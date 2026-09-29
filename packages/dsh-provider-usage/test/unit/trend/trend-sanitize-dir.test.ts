/**
 * dsh-provider-usage — unit：sanitizeDirName 直测（#732 T3-A 复杂度整改配套）。
 *
 * 为什么单独建文件：sanitizeDirName 是**控制字符剥除口径的权威定义**（见 trend.ts 文件头
 * 与函数注释：generate.ts 注入面 / report-config normalizeReportDirectories / apply.ts listDirs /
 * 客户端 trend-math.ts dirDisplayLabel 一律注明「与 sanitizeDirName 口径一致」），但此前只被
 * tracker 落盘路径的集成用例间接覆盖 3 例（Windows basename / 盘符根 / UNC）。口径定义者
 * 没有直接测试，等于改口径时无人拦。
 *
 * 锁的**契约**（剥除哪些、归一化成什么、何时归 null），不锁实现：本次整改只把控制字符
 * 判定提取成 isControlCodePoint，判定逻辑一字未改，下列断言对提取前后同真。
 */
import { describe, expect, it } from "vitest";
import { sanitizeDirName, TREND_DIR_MAX } from "../../../src/server/shared/interface.ts";

describe("sanitizeDirName：入参形态", () => {
  it("非字符串一律归未识别（null）", () => {
    for (const bad of [null, undefined, 42, 0, true, false, {}, [], Symbol("s"), 1n]) {
      expect(sanitizeDirName(bad), String(bad?.toString?.() ?? bad)).toBe(null);
    }
  });

  it("空串归未识别（空 basename）", () => {
    expect(sanitizeDirName("")).toBe(null);
  });

  it("已是 basename 的串原样返回（幂等）", () => {
    for (const name of ["proj", "my app", "dot.dir", "a"]) {
      expect(sanitizeDirName(name)).toBe(name);
    }
  });
});

describe("sanitizeDirName：控制字符剥除（C0 + DEL + C1，口径权威面）", () => {
  it("纯控制字符串剥空后归未识别", () => {
    expect(sanitizeDirName("\u0000")).toBe(null);
    expect(sanitizeDirName("\u001f\u007f\u009f")).toBe(null);
  });

  it("串内嵌控制字符被剥除而非截断", () => {
    expect(sanitizeDirName("pro\u0000j")).toBe("proj");
    expect(sanitizeDirName("pro\u009fj")).toBe("proj");
    expect(sanitizeDirName("\u0000proj\u0000")).toBe("proj");
  });

  it("控制字符不能当分隔符用（剥除后仍是同一段，不切 basename）", () => {
    // \u001f 是 C0 单元分隔符，若误当分隔符会切成 "b"；正确口径是剥除后得 "ab"。
    expect(sanitizeDirName("a\u001fb")).toBe("ab");
  });

  it("边界码点不误伤：0x20 空格、0x7e 波浪号、0xa0 _nbsp_ 均保留", () => {
    expect(sanitizeDirName("a b")).toBe("a b");
    expect(sanitizeDirName("a~b")).toBe("a~b");
    expect(sanitizeDirName("a\u00a0b")).toBe("a\u00a0b");
  });

  it("剥除带闭区间恰为 0x7f–0x9f（DEL + 整段 C1，两端都剥）", () => {
    // 边界四连：0x7e 留 / 0x7f 剥 / 0x80 剥（属 C1 段内）/ 0x9f 剥 / 0xa0 留。
    expect(sanitizeDirName("a\u007eb")).toBe("a\u007eb");
    expect(sanitizeDirName("a\u007fb")).toBe("ab");
    expect(sanitizeDirName("a\u0080b")).toBe("ab");
    expect(sanitizeDirName("a\u009fb")).toBe("ab");
    expect(sanitizeDirName("a\u00a0b")).toBe("a\u00a0b");
  });

  it("多字节与代理对逐码点处理，不切碎代理对", () => {
    expect(sanitizeDirName("/home/用户/项目")).toBe("项目");
    expect(sanitizeDirName("/home/user/\u{1f600}")).toBe("\u{1f600}");
    expect(sanitizeDirName("/a/\u{1f600}\u0000")).toBe("\u{1f600}");
  });
});

describe("sanitizeDirName：分隔符归一（POSIX 与 Windows 同取末段）", () => {
  it("POSIX 正斜杠取末段", () => {
    expect(sanitizeDirName("/home/user/proj")).toBe("proj");
    expect(sanitizeDirName("a/b/c")).toBe("c");
  });

  it("Windows 反斜杠取末段", () => {
    expect(sanitizeDirName("C:\\Users\\bob\\proj")).toBe("proj");
  });

  it("UNC 形态取末段", () => {
    expect(sanitizeDirName("\\\\server\\share\\notes")).toBe("notes");
  });

  it("混合分隔符取两系 lastIndexOf 的较大者（更深一段）", () => {
    expect(sanitizeDirName("a/b\\c")).toBe("c");
    expect(sanitizeDirName("a\\b/c")).toBe("c");
  });

  it("中间空段不构成无效（只有末段为空才归未识别）", () => {
    expect(sanitizeDirName("/a//b")).toBe("b");
  });
});

describe("sanitizeDirName：尾部斜杠剥除", () => {
  it("单个尾部斜杠取前段", () => {
    expect(sanitizeDirName("/a/proj/")).toBe("proj");
    expect(sanitizeDirName("proj\\")).toBe("proj");
  });

  it("连续多个尾部斜杠全剥（两系混排也算）", () => {
    expect(sanitizeDirName("/a/proj///")).toBe("proj");
    expect(sanitizeDirName("/a/proj\\\\/")).toBe("proj");
    expect(sanitizeDirName("proj/\\")).toBe("proj");
  });

  it("剥斜杠后仍取 basename（不是剥完就返回）", () => {
    expect(sanitizeDirName("/a/b/c//")).toBe("c");
  });
});

describe("sanitizeDirName：归未识别（null）的四类", () => {
  it("根路径归未识别", () => {
    expect(sanitizeDirName("/")).toBe(null);
    expect(sanitizeDirName("///")).toBe(null);
    expect(sanitizeDirName("\\")).toBe(null);
  });

  it('盘符根归未识别（剥尾斜杠后剩 "C:"，非目录名）', () => {
    expect(sanitizeDirName("C:\\")).toBe(null);
    expect(sanitizeDirName("C:/")).toBe(null);
    expect(sanitizeDirName("c:")).toBe(null);
  });

  it("纯空白末段归未识别（根路径/空段/纯空白）", () => {
    expect(sanitizeDirName("   ")).toBe(null);
    expect(sanitizeDirName("/a/   ")).toBe(null);
    expect(sanitizeDirName("\t\n")).toBe(null);
  });

  it("空 basename 归未识别", () => {
    expect(sanitizeDirName("a/b/")).toBe("b");
    expect(sanitizeDirName("/a/b//")).toBe("b");
  });

  it("正常路径不归未识别（对照组：上面的 null 不是恒真）", () => {
    expect(sanitizeDirName("/home/user/proj")).toBe("proj");
    expect(sanitizeDirName("C:\\Users\\bob")).toBe("bob");
    expect(sanitizeDirName("C")).toBe("C"); // 单字母不是盘符根
  });
});

describe("sanitizeDirName：不截断长度（数据层不暗中合并同桶）", () => {
  it("超 TREND_DIR_MAX 的 basename 原样返回，不截断", () => {
    const long = "x".repeat(TREND_DIR_MAX + 1);
    expect(sanitizeDirName("/a/" + long)).toBe(long);
    expect(sanitizeDirName("/a/" + long)).toHaveLength(TREND_DIR_MAX + 1);
  });

  it("不同长目录不塌成同一桶（B1 可区分性）", () => {
    const a = "y".repeat(TREND_DIR_MAX + 10);
    const b = "y".repeat(TREND_DIR_MAX + 20);
    expect(sanitizeDirName("/x/" + a)).not.toBe(sanitizeDirName("/x/" + b));
  });

  it("恰好等于上限的 basename 合法", () => {
    const exact = "z".repeat(TREND_DIR_MAX);
    expect(sanitizeDirName("/a/" + exact)).toBe(exact);
  });
});
