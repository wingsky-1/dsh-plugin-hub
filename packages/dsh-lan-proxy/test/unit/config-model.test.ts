// dsh-lan-proxy unit：配置模型纯函数（sanitizeSettings / validateSettings / WS 压缩键 / httpCompress 档位）
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出（该文件名为 e2e 却混装 unit 场景族）。
// 断言与 describe 名逐字保留。unit 层直连 src 源码，不 import 包根组合根与构建产物面
// （DEVELOPMENT §I8① 判据）。
// 被测面：src/server/config/impl/model.ts（经域门面 src/server/config/interface.ts）。
// 四块合并的依据是「同一被测模块」，不是行数切割。

import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_WSS_COMPRESS_PATHS,
  normalizeLegacyWsCompressPaths,
  sanitizeSettings,
  validateSettings,
} from "../../src/server/config/interface.ts";

describe("unit: sanitizeSettings", () => {
  it("keeps valid keys, drops empty cert paths", () => {
    const out = sanitizeSettings({
      enabled: false,
      port: 4099,
      tlsCertFile: "",
      tlsKeyFile: "",
      printBanner: true,
      unknownKey: 1,
    });
    expect(out).toEqual({ enabled: false, port: 4099, printBanner: true });
  });

  it("rejects type-invalid value wholesale", () => {
    expect(sanitizeSettings({ port: "abc" })).toBe(null);
  });

  it("rejects non-object payload", () => {
    expect(sanitizeSettings("nope")).toBe(null);
  });

  it("rejects null payload", () => {
    expect(sanitizeSettings(null)).toBe(null);
  });

  it("rejects out-of-range port", () => {
    expect(sanitizeSettings({ port: 70000 })).toBe(null);
  });
});

describe("unit: validateSettings（非法值定位到字段与范围）", () => {
  describe("validateSettings 定位首个非法键并给出范围提示", () => {
    let bad!: NonNullable<ReturnType<typeof validateSettings>>;

    beforeAll(() => {
      bad = validateSettings({ enabled: "yes", port: "abc" }) as NonNullable<
        ReturnType<typeof validateSettings>
      >;
    });

    it("非法配置返回非 null", () => {
      expect(bad !== null).toBeTruthy();
    });

    it("按 FILE_CONFIG_VALIDATORS 键序取首个非法键", () => {
      expect(bad.key).toBe("enabled");
    });

    it("hint 指明类型要求", () => {
      expect(bad.hint.includes("布尔")).toBeTruthy();
    });
  });

  // 原脚本把校验写在取值循环内，故按取值展开为逐条可见用例。
  describe("validateSettings 端口越界提示 1-65535", () => {
    const portValues = [0, 70000, 1.5, "4099"];
    const titled = (suffix: string) =>
      portValues.map((v) => ({ title: `port=${String(v)} ${suffix}`, v }));

    it.each(titled("应非法"))("$title", ({ v }) => {
      expect(validateSettings({ port: v }) !== null).toBeTruthy();
    });

    it.each(titled("定位 key=port"))("$title", ({ v }) => {
      expect(validateSettings({ port: v })!.key).toBe("port");
    });

    it.each(titled("hint 含合法范围"))("$title", ({ v }) => {
      expect(validateSettings({ port: v })!.hint.includes("1-65535")).toBeTruthy();
    });
  });

  describe("validateSettings 档位越界提示 0-3；旧档位 4..9 迁移后合法；全合法返回 null", () => {
    let bad!: NonNullable<ReturnType<typeof validateSettings>>;

    beforeAll(() => {
      bad = validateSettings({ httpCompressLevel: 10 }) as NonNullable<
        ReturnType<typeof validateSettings>
      >;
    });

    it("非法档位返回非 null", () => {
      expect(bad !== null).toBeTruthy();
    });

    it("定位 key=httpCompressLevel", () => {
      expect(bad.key).toBe("httpCompressLevel");
    });

    it("hint 含档位范围", () => {
      expect(bad.hint.includes("0-3")).toBeTruthy();
    });

    it("旧档位 4..9 迁移为高档后合法", () => {
      expect(validateSettings({ httpCompressLevel: 6 })).toBe(null);
    });

    it("全合法配置返回 null", () => {
      expect(
        validateSettings({
          enabled: false,
          port: 4099,
          httpsPort: 3443,
          printBanner: true,
          wsCompressPaths: ["/x"],
          httpCompressEnabled: true,
          httpCompressLevel: 2,
        }),
      ).toBe(null);
    });
  });

  it("validateSettings 非对象 payload 指明需配置对象", () => {
    const bad = validateSettings("nope");
    expect(bad !== null && bad.key === "(payload)").toBeTruthy();
  });
});

describe("unit: WS 压缩设置键（sanitize / normalizeLegacyWsCompressPaths）", () => {
  // sanitize：接受 wsCompressEnabled / wsCompressPaths（字符串数组），非法整体拒绝。
  it("sanitize 接受 ws 压缩配置", () => {
    const out = sanitizeSettings({
      wsCompressEnabled: false,
      wsCompressPaths: ["/api/remote.mux"],
    });
    expect(out).toEqual({ wsCompressEnabled: false, wsCompressPaths: ["/api/remote.mux"] });
  });

  // issue #552 解耦：wsBridgeEnabled（桥接总开关）为新配置键——sanitize 接受布尔，
  // 非法拒绝；与 wsCompressEnabled 正交独立保存。
  describe("sanitize 接受 wsBridgeEnabled 布尔", () => {
    it("false 保留", () => {
      expect(sanitizeSettings({ wsBridgeEnabled: false })).toEqual({ wsBridgeEnabled: false });
    });

    it("true 保留", () => {
      expect(sanitizeSettings({ wsBridgeEnabled: true })).toEqual({ wsBridgeEnabled: true });
    });
  });

  it("sanitize 拒绝非布尔 wsBridgeEnabled", () => {
    expect(sanitizeSettings({ wsBridgeEnabled: "yes" })).toBe(null);
  });

  it("validateSettings 接受 wsBridgeEnabled", () => {
    expect(validateSettings({ wsBridgeEnabled: false, wsCompressPaths: ["/x"] })).toBe(null);
  });

  it("sanitize 拒绝非字符串数组 paths", () => {
    expect(sanitizeSettings({ wsCompressPaths: [1, 2] })).toBe(null);
  });

  // normalizeLegacyWsCompressPaths（#395 M2）：旧默认乱序等价归一化，自定义不动。
  describe("normalizeLegacyWsCompressPaths 旧默认无序等价归一化到 remote.mux", () => {
    it("正序旧默认", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.host"])).toEqual([
        "/api/remote.mux",
      ]);
    });

    it("顺序不同也等价", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/events.host", "/api/events.mux"])).toEqual([
        "/api/remote.mux",
      ]);
    });

    it("与默认常量同源", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.host"])).toEqual([
        ...DEFAULT_WSS_COMPRESS_PATHS,
      ]);
    });
  });

  describe("normalizeLegacyWsCompressPaths 自定义/undefined/空数组原样", () => {
    it("自定义白名单原样", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/custom/ws"])).toEqual(["/api/custom/ws"]);
    });

    it("含废弃端点的自定义组合不改写", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/custom/ws"])).toEqual([
        "/api/events.mux",
        "/api/custom/ws",
      ]);
    });

    it("undefined 原样", () => {
      expect(normalizeLegacyWsCompressPaths(undefined)).toBe(undefined);
    });

    it("空数组原样", () => {
      expect(normalizeLegacyWsCompressPaths([])).toEqual([]);
    });

    it("重复元素非等价", () => {
      expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.mux"])).toEqual([
        "/api/events.mux",
        "/api/events.mux",
      ]);
    });
  });
});

describe("unit: httpCompress 配置键", () => {
  it("sanitize 接受 httpCompressEnabled/httpCompressLevel 档位", () => {
    const out = sanitizeSettings({ httpCompressEnabled: false, httpCompressLevel: 2 });
    expect(out).toEqual({ httpCompressEnabled: false, httpCompressLevel: 2 });
  });

  describe("sanitize 档位越界/非整数整体拒绝；旧档位 4..9 迁移为高（3）；0=默认合法", () => {
    it("非整数 1.5 拒绝", () => {
      expect(sanitizeSettings({ httpCompressLevel: 1.5 })).toBe(null);
    });

    it('字符串 "3" 拒绝', () => {
      expect(sanitizeSettings({ httpCompressLevel: "3" })).toBe(null);
    });

    it("越界 10 拒绝", () => {
      expect(sanitizeSettings({ httpCompressLevel: 10 })).toBe(null);
    });

    it("0 合法保留", () => {
      expect(sanitizeSettings({ httpCompressLevel: 0 })).toEqual({ httpCompressLevel: 0 });
    });

    it("旧档位 6 迁移为 3（高）", () => {
      expect(sanitizeSettings({ httpCompressLevel: 6 })).toEqual({ httpCompressLevel: 3 });
    });

    it("旧档位 9 迁移为 3（高）", () => {
      expect(sanitizeSettings({ httpCompressLevel: 9 })).toEqual({ httpCompressLevel: 3 });
    });
  });
});
