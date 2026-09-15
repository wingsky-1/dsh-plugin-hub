/**
 * dsh-mcp-manager — unit：config 域模板预展开与 reconnect 收紧（#767 S1-1）。
 *
 * 直引域内实现文件而不经组合根：单元层是白盒面（ARCHITECTURE-METHOD §8.1），走入口会把
 * 装配顺序与端口实参一起带进用例，失败点会从「展开器写错」漂到「装配写错」。
 */
import { describe, expect, it } from "vitest";
import { expandEnv, expandServerEnv } from "../../src/server/config/impl/env/index.ts";
import { normalizeServer } from "../../src/server/config/normalize.ts";

const ENV_SET = "DSH_S11_CFG_ENV_SET";
const ENV_MISSING = "DSH_S11_CFG_ENV_MISSING";

describe("expandEnv", () => {
  process.env[ENV_SET] = "va";
  delete process.env[ENV_MISSING];

  it("已设置变量展开", () => {
    expect(expandEnv("${" + ENV_SET + "}")).toBe("va");
  });

  it("未设置变量展开为空串", () => {
    expect(expandEnv("x${" + ENV_MISSING + "}y")).toBe("xy");
  });

  it("混合展开", () => {
    expect(expandEnv("${" + ENV_SET + "}-${" + ENV_MISSING + "}")).toBe("va-");
  });

  it("无引用原样返回", () => {
    expect(expandEnv("plain")).toBe("plain");
  });

  it("非字符串 String 化", () => {
    expect(expandEnv(42)).toBe("42");
  });

  it("非法变量名不匹配替换", () => {
    expect(expandEnv("${1BAD}")).toBe("${1BAD}");
  });
});

describe("expandServerEnv", () => {
  process.env[ENV_SET] = "va";
  delete process.env[ENV_MISSING];

  it("stdio 面：env 模板展开，其余字段原样带上", () => {
    const expanded = expandServerEnv({
      name: "s",
      transport: "stdio",
      command: "cmd",
      args: ["--flag"],
      env: { A: "${" + ENV_SET + "}", B: "x${" + ENV_MISSING + "}y" },
    });
    expect(expanded.env).toEqual({ A: "va", B: "xy" });
    expect(expanded.command).toBe("cmd");
    expect(expanded.args).toEqual(["--flag"]);
  });

  it("http 面：headers 模板展开", () => {
    const expanded = expandServerEnv({
      name: "s",
      transport: "streamable-http",
      url: "http://localhost:1/mcp",
      headers: { Authorization: "Bearer ${" + ENV_SET + "}", Plain: "p" },
    });
    expect(expanded.headers).toEqual({ Authorization: "Bearer va", Plain: "p" });
  });

  it("非字符串值 String 化", () => {
    const expanded = expandServerEnv({
      name: "s",
      transport: "stdio",
      command: "c",
      env: { N: 42 as unknown as string },
    });
    expect(expanded.env).toEqual({ N: "42" });
  });

  it("无 env / headers 时不凭空造键", () => {
    const expanded = expandServerEnv({ name: "s", transport: "stdio", command: "c" });
    expect("env" in expanded).toBe(false);
    expect("headers" in expanded).toBe(false);
  });

  it("返回新对象，源配置的模板不被就地展开", () => {
    const source = {
      name: "s",
      transport: "stdio" as const,
      command: "c",
      env: { A: "${" + ENV_SET + "}" },
    };
    const expanded = expandServerEnv(source);
    expect(expanded).not.toBe(source);
    expect(expanded.env).not.toBe(source.env);
    expect(source.env.A).toBe("${" + ENV_SET + "}");
  });
});

describe("normalizeServer：reconnect 收紧", () => {
  const withReconnect = (reconnect: unknown) => ({
    name: "s",
    transport: "stdio",
    command: "c",
    reconnect,
  });

  it("未知键丢弃且不出声（归一器保持纯函数）", () => {
    const server = normalizeServer(withReconnect({ enabled: false, jitter: 1 }));
    expect(server.reconnect).toEqual({ enabled: false });
    expect(JSON.stringify(server.reconnect)).not.toContain("jitter");
  });

  it("只保留输入里写了的键，不补齐默认值", () => {
    expect(normalizeServer(withReconnect(undefined)).reconnect).toEqual({});
    expect(normalizeServer(withReconnect({ maxAttempts: 3 })).reconnect).toEqual({
      maxAttempts: 3,
    });
  });

  it("合法 4 键原样保留", () => {
    const reconnect = { enabled: true, initialDelayMs: 100, maxDelayMs: 200, maxAttempts: 3 };
    expect(normalizeServer(withReconnect(reconnect)).reconnect).toEqual(reconnect);
  });

  it("initialDelayMs > maxDelayMs 拒绝", () => {
    expect(() => normalizeServer(withReconnect({ initialDelayMs: 5000, maxDelayMs: 100 }))).toThrow(
      /initialDelayMs must be less than or equal to maxDelayMs/,
    );
  });

  it("只写 initialDelayMs 且大于默认 maxDelayMs 时拒绝（官方会先补默认值再判关系）", () => {
    // 官方 RECONNECT_DEFAULTS.maxDelayMs = 30000；只写 initialDelayMs 时它会在装载期抛，
    // 这一条守住的正是「错误不许被推迟到连接期」。
    expect(() => normalizeServer(withReconnect({ initialDelayMs: 60_000 }))).toThrow(
      /initialDelayMs must be less than or equal to maxDelayMs/,
    );
    // 两段都显式写出且关系成立时仍然放行（默认值不参与判定）。
    expect(
      normalizeServer(withReconnect({ initialDelayMs: 40_000, maxDelayMs: 50_000 })).reconnect,
    ).toEqual({ initialDelayMs: 40_000, maxDelayMs: 50_000 });
  });

  it("enabled 非布尔拒绝", () => {
    for (const enabled of ["yes", 1, null]) {
      expect(() => normalizeServer(withReconnect({ enabled }))).toThrow(
        /enabled must be a boolean/,
      );
    }
  });

  it("退避时长非正数或非有限数拒绝", () => {
    for (const initialDelayMs of [0, -1, Number.POSITIVE_INFINITY, "500"]) {
      expect(() => normalizeServer(withReconnect({ initialDelayMs }))).toThrow(/initialDelayMs/);
    }
  });

  it("maxAttempts 非正整数拒绝", () => {
    for (const maxAttempts of [0, -1, 1.5, "3"]) {
      expect(() => normalizeServer(withReconnect({ maxAttempts }))).toThrow(
        /maxAttempts must be a positive integer/,
      );
    }
  });

  it("reconnect 不是对象时拒绝", () => {
    expect(() => normalizeServer(withReconnect("nope"))).toThrow(/reconnect must be an object/);
  });
});
