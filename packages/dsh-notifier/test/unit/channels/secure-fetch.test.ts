/**
 * dsh-notifier channels 域 secure-fetch —— dry-run 专用 SSRF 安全 fetch（提案 B4）。
 *
 * 本文件守环路层：secureFetch 的 DNS 与建连都可注入桩，坏地址在建连前被拦下。
 * 纯分类矩阵与 realTransport 回环传输分别在同目录的
 * secure-fetch-ip-block.test.ts / secure-fetch-real-transport.test.ts。
 * 真实 DNS 与公网建连不在三层出现——离线是硬约束，不是环境巧合。
 */
import { describe, expect, it } from "vitest";

import { secureFetch } from "../../../src/server/channels/impl/dry-run/secure-fetch.ts";
import type {
  PinnedOutcome,
  PinnedTransport,
} from "../../../src/server/channels/impl/dry-run/secure-fetch.ts";
import { INIT, stubDns, stubTransport } from "./secure-fetch-support.ts";

function registerSecureFetchInputGuards(): void {
  it("userinfo 直接拒绝（建连零调用）", async () => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
    const outcome = await secureFetch("http://user:pass@example.test/", INIT, stub);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("userinfo");
    expect(stub.calls).toEqual([]);
  });
  it.each([["ftp://example.test/x"], ["file:///etc/passwd"], ["gopher://example.test/1"]])(
    "%s 非 http(s) 直接拒绝",
    async (input) => {
      const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
      const outcome = await secureFetch(input, INIT, stub);
      expect(outcome.ok).toBe(false);
      expect(stub.calls).toEqual([]);
    },
  );
  it("userinfo 无口令同样拒绝（user@ 即凭据位）", async () => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
    const outcome = await secureFetch("http://user@example.test/", INIT, stub);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("userinfo");
    expect(stub.calls).toEqual([]);
  });
  it("非法 URL 直接失败（不建连）", async () => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
    const outcome = await secureFetch("http://[::1", INIT, stub);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("URL 解析失败");
    expect(stub.calls).toEqual([]);
  });
  it("FQDN 尾点不绕过分类（127.0.0.1. 仍是回环）", async () => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
    const outcome = await secureFetch("http://127.0.0.1./", INIT, stub);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("回环");
    expect(stub.calls).toEqual([]);
  });
  it("十进制字面量回环直接拒绝（解析器与分类器同语义）", async () => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
    const outcome = await secureFetch("http://2130706433/", INIT, stub);
    expect(outcome.ok).toBe(false);
    expect(stub.calls).toEqual([]);
  });
}

function registerSecureFetchDnsChecks(): void {
  it("DNS 任一条非公开即整单拒绝（多 A 记录 fail-closed）", async () => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
    const outcome = await secureFetch("http://mixed.example.test/", INIT, {
      dns: stubDns({
        "mixed.example.test": [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.9", family: 4 },
        ],
      }),
      transport: stub.transport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("非公开");
    expect(stub.calls).toEqual([]);
  });
  it.each([
    "0x7f000001",
    "0177.0.0.1",
    "0.0.0.0",
    "10.0.0.9",
    "169.254.169.254",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "2001:db8::1",
  ])("DNS 回 %s 即整单拒绝（逐分类 fail-closed）", async (address) => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
    const outcome = await secureFetch("http://probe.example.test/", INIT, {
      dns: stubDns({ "probe.example.test": [{ address, family: address.includes(":") ? 6 : 4 }] }),
      transport: stub.transport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("非公开");
    expect(stub.calls).toEqual([]);
  });
  it("DNS 返回非法地址即整单拒绝（解析不出字面量不断言公开）", async () => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
    const outcome = await secureFetch("http://probe.example.test/", INIT, {
      dns: stubDns({ "probe.example.test": [{ address: "999.999.999.999", family: 4 }] }),
      transport: stub.transport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("非法地址");
    expect(stub.calls).toEqual([]);
  });
  it("DNS 抛错即失败（不建连）", async () => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
    const outcome = await secureFetch("http://probe.example.test/", INIT, {
      dns: { resolveAll: () => Promise.reject(new Error("dns down")) },
      transport: stub.transport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("DNS 解析失败");
    expect(stub.calls).toEqual([]);
  });
  it("DNS 无结果即失败（不建连）", async () => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
    const outcome = await secureFetch("http://empty.example.test/", INIT, {
      dns: stubDns({}),
      transport: stub.transport,
    });
    expect(outcome.ok).toBe(false);
    expect(stub.calls).toEqual([]);
  });
  it("localhost 即回环：DNS 回 127.0.0.1 即拒绝", async () => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "ok" }]);
    const outcome = await secureFetch("http://localhost/", INIT, {
      dns: stubDns({ localhost: [{ address: "127.0.0.1", family: 4 }] }),
      transport: stub.transport,
    });
    expect(outcome.ok).toBe(false);
    expect(stub.calls).toEqual([]);
  });
  it("全公开即建连：地址钉死为首个解析结果", async () => {
    const stub = stubTransport([{ kind: "response", status: 200, body: "hello" }]);
    const outcome = await secureFetch("http://public.example.test/hook", INIT, {
      dns: stubDns({ "public.example.test": [{ address: "93.184.216.34", family: 4 }] }),
      transport: stub.transport,
    });
    expect(outcome).toEqual({ ok: true, status: 200, body: "hello" });
    expect(stub.calls).toEqual(["http://public.example.test/hook @93.184.216.34"]);
  });
}

describe("secureFetch：预检与 DNS 全量分类", () => {
  registerSecureFetchInputGuards();
  registerSecureFetchDnsChecks();
});
describe("secureFetch：重定向逐跳复检", () => {
  it("跳向内网即拒绝（第二跳建连零调用）", async () => {
    const stub = stubTransport([{ kind: "redirect", location: "http://127.0.0.1/secret" }]);
    const outcome = await secureFetch("http://public.example.test/a", INIT, {
      dns: stubDns({ "public.example.test": [{ address: "93.184.216.34", family: 4 }] }),
      transport: stub.transport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("回环");
    expect(stub.calls).toHaveLength(1);
  });
  it("第二跳 userinfo 同样拒绝（逐跳重过整道闸）", async () => {
    const stub = stubTransport([
      { kind: "redirect", location: "http://user:pass@other.example.test/b" },
    ]);
    const outcome = await secureFetch("http://public.example.test/a", INIT, {
      dns: stubDns({ "public.example.test": [{ address: "93.184.216.34", family: 4 }] }),
      transport: stub.transport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("userinfo");
    expect(stub.calls).toHaveLength(1);
  });
  it("第二跳非 http(s) 同样拒绝（逐跳重验协议）", async () => {
    const stub = stubTransport([{ kind: "redirect", location: "ftp://example.test/x" }]);
    const outcome = await secureFetch("http://public.example.test/a", INIT, {
      dns: stubDns({ "public.example.test": [{ address: "93.184.216.34", family: 4 }] }),
      transport: stub.transport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("仅允许 http(s)");
    expect(stub.calls).toHaveLength(1);
  });
  it("跳向公开地址即跟随（逐跳都过闸）", async () => {
    const stub = stubTransport([
      { kind: "redirect", location: "http://other.example.test/b" },
      { kind: "response", status: 200, body: "final" },
    ]);
    const outcome = await secureFetch("http://public.example.test/a", INIT, {
      dns: stubDns({
        "public.example.test": [{ address: "93.184.216.34", family: 4 }],
        "other.example.test": [{ address: "151.101.1.1", family: 4 }],
      }),
      transport: stub.transport,
    });
    expect(outcome).toEqual({ ok: true, status: 200, body: "final" });
    expect(stub.calls).toEqual([
      "http://public.example.test/a @93.184.216.34",
      "http://other.example.test/b @151.101.1.1",
    ]);
  });
  it("6 跳即失败（上限 5）", async () => {
    const script: PinnedOutcome[] = [];
    for (let hop = 0; hop < 6; hop += 1) {
      script.push({ kind: "redirect", location: "http://public.example.test/h" + hop });
    }
    const stub = stubTransport(script);
    const outcome = await secureFetch("http://public.example.test/start", INIT, {
      dns: stubDns({ "public.example.test": [{ address: "93.184.216.34", family: 4 }] }),
      transport: stub.transport,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.cause).toContain("重定向过多");
    expect(stub.calls).toHaveLength(6);
  });
  it("建连抛错即失败（原因进 cause）", async () => {
    const failing: PinnedTransport = () => Promise.reject(new Error("socket hang up"));
    const outcome = await secureFetch("http://public.example.test/a", INIT, {
      dns: stubDns({ "public.example.test": [{ address: "93.184.216.34", family: 4 }] }),
      transport: failing,
    });
    expect(outcome).toEqual({ ok: false, cause: "socket hang up" });
  });
});
