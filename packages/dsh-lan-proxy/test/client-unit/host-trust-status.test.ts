/**
 * dsh-lan-proxy — 客户端 host trust 三段判定的直连判据（issue #856）。
 *
 * 判定函数的唯一职责：把「注入到底有没有生效」变成四种状态之一。每一条都写死在
 * 表里——上游把 `ownsHost` 从 isLoopback 谓词里删掉/改名/重排时，最后一个用例组
 * 会直接转红，而不是靠文字声明。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateHostTrust,
  isLoopbackHostname,
  readHostTrustSignals,
  HOST_TRUST_RUNTIME_MARKER,
  HOST_TRUST_STATUS_KEY,
} from "../../src/client/host-trust-status.ts";

describe("isLoopbackHostname：与上游 isLoopbackHostname 同口径", () => {
  const loopback = ["localhost", "[::1]", "127.0.0.1", "127.9.9.9", "127.255.255.255"];
  it.each(loopback)("%s 判为回环", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  const notLoopback = [
    "128.0.0.1",
    "127.0.0.256",
    "127.0.0",
    "127.0.0.1.evil.example",
    "localhost.evil.example",
    "LOCALHOST",
    "",
    "192.168.1.50",
  ];
  it.each(notLoopback)("%s 不判为回环", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false);
  });

  it("hostname 缺失时不判为回环", () => {
    expect(isLoopbackHostname(undefined)).toBe(false);
  });
});

describe("evaluateHostTrust：三段判定四状态", () => {
  const cases: Array<{
    title: string;
    signals: { hostname?: string; marker?: boolean; isLoopback?: boolean };
    expected: string;
  }> = [
    {
      title: "回环 authority：本机页，无需兼容开关",
      signals: { hostname: "127.0.0.1", marker: false, isLoopback: true },
      expected: "loopback-page",
    },
    {
      title: "localhost 页即便没读上游事实也按本机页处理",
      signals: { hostname: "localhost", marker: false },
      expected: "loopback-page",
    },
    {
      title: "非回环 + marker 在 + isLoopback=true：兼容模式生效",
      signals: { hostname: "192.168.1.50", marker: true, isLoopback: true },
      expected: "compat-active",
    },
    {
      title: "非回环 + marker 在 + isLoopback=false：上游契约已漂移",
      signals: { hostname: "192.168.1.50", marker: true, isLoopback: false },
      expected: "contract-drift",
    },
    {
      title: "非回环 + marker 在 + isLoopback 未知：按漂移 fail-closed",
      signals: { hostname: "192.168.1.50", marker: true },
      expected: "contract-drift",
    },
    {
      title: "非回环 + 无 marker + isLoopback=false：开关关闭，设置面不可用",
      signals: { hostname: "192.168.1.50", marker: false, isLoopback: false },
      expected: "compat-off",
    },
    {
      title: "非回环 + 无 marker + isLoopback 未知：按关闭 fail-closed",
      signals: { hostname: "192.168.1.50", marker: false },
      expected: "compat-off",
    },
    {
      title: "非回环 + 无 marker + isLoopback=true：上游自带 transport（desktop-host），正常态",
      signals: { hostname: "192.168.1.50", marker: false, isLoopback: true },
      expected: "loopback-page",
    },
    {
      title: "hostname 缺失 + 无 marker + isLoopback=false：按关闭处理",
      signals: { marker: false, isLoopback: false },
      expected: "compat-off",
    },
    {
      title: "marker 为 undefined（而非 false）同样不算生效",
      signals: { hostname: "10.0.0.7", isLoopback: false },
      expected: "compat-off",
    },
  ];

  it.each(cases)("$title", ({ signals, expected }) => {
    expect(evaluateHostTrust(signals)).toBe(expected);
  });
});

describe("HOST_TRUST_STATUS_KEY：四种状态都有独立文案键", () => {
  it("键集与状态集一一对应且互不重复", () => {
    const values = Object.values(HOST_TRUST_STATUS_KEY);
    expect(Object.keys(HOST_TRUST_STATUS_KEY).sort()).toEqual([
      "compat-active",
      "compat-off",
      "contract-drift",
      "loopback-page",
    ]);
    expect(new Set(values).size).toBe(values.length);
  });

  it("漂移态不是静默态（有独立告警文案键）", () => {
    expect(HOST_TRUST_STATUS_KEY["contract-drift"]).not.toBe(HOST_TRUST_STATUS_KEY["compat-off"]);
  });
});

describe("readHostTrustSignals：三个信号的读取", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).location;
    delete (globalThis as Record<string, unknown>)[HOST_TRUST_RUNTIME_MARKER];
  });

  it("DOM 缺失（宿主外）时 hostname 为 undefined，marker 缺省不计为真", () => {
    const signals = readHostTrustSignals(undefined);
    expect(signals.hostname).toBeUndefined();
    expect(signals.marker).toBe(false);
    expect(signals.isLoopback).toBeUndefined();
  });

  it("读到 location.hostname 与运行期 marker", () => {
    (globalThis as Record<string, unknown>).location = { hostname: "192.168.1.50" };
    (globalThis as Record<string, unknown>)[HOST_TRUST_RUNTIME_MARKER] = true;
    const signals = readHostTrustSignals({ $host: { isLoopback: true } });
    expect(signals).toEqual({ hostname: "192.168.1.50", marker: true, isLoopback: true });
  });

  it("marker 为真值以外的任何值都不算生效", () => {
    (globalThis as Record<string, unknown>)[HOST_TRUST_RUNTIME_MARKER] = "yes";
    expect(readHostTrustSignals(undefined).marker).toBe(false);
  });

  it("remote 面缺失/变形时 isLoopback 为 undefined（不抛）", () => {
    expect(readHostTrustSignals({}).isLoopback).toBeUndefined();
    expect(readHostTrustSignals({ $host: {} }).isLoopback).toBeUndefined();
    expect(readHostTrustSignals(undefined).isLoopback).toBeUndefined();
  });
});
