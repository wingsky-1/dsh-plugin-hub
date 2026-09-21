/**
 * dsh-notifier channels 域 secure-fetch —— dry-run 专用 SSRF 安全 fetch（提案 B4）。
 *
 * 三层判据：纯分类（parseIpLiteral / ipBlockCause，无 IO，矩阵逐条覆盖反例）→
 * 环路（secureFetch，DNS 与建连皆可注入桩，坏地址建连前被拦下）→
 * 传输（realTransport，对回环起真实建连，全程离线：重定向不跟、熔断、超时、截流）。
 * 真实 DNS 与公网建连不在任何一层出现——离线是硬约束，不是环境巧合。
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import {
  ipBlockCause,
  parseIpLiteral,
  realTransport,
  secureFetch,
} from "../../../src/server/channels/impl/dry-run/secure-fetch.ts";
import type {
  DnsAnswer,
  ParsedIp,
  PinnedOutcome,
  PinnedTransport,
} from "../../../src/server/channels/impl/dry-run/secure-fetch.ts";

function expectBlocked(ip: string, cause: string): void {
  const parsed = parseIpLiteral(ip);
  if (parsed === undefined) throw new Error("期望能解析：" + ip);
  expect(ipBlockCause(parsed)).toBe(cause);
}

function expectPublic(ip: string): void {
  const parsed = parseIpLiteral(ip);
  if (parsed === undefined) throw new Error("期望能解析：" + ip);
  expect(ipBlockCause(parsed)).toBeUndefined();
}

function causeOf(ip: string): string | undefined {
  const parsed: ParsedIp | undefined = parseIpLiteral(ip);
  return parsed === undefined ? undefined : ipBlockCause(parsed);
}

describe("ipBlockCause：v4 字面量（含非点分形态）", () => {
  it.each<[string, string]>([
    ["127.0.0.1", "回环地址（127.0.0.0/8）"],
    ["2130706433", "回环地址（127.0.0.0/8）"],
    ["0x7f000001", "回环地址（127.0.0.0/8）"],
    ["0177.0.0.1", "回环地址（127.0.0.0/8）"],
    ["127.1", "回环地址（127.0.0.0/8）"],
    ["0.0.0.0", "未指定地址（0.0.0.0/8）"],
    ["10.1.2.3", "私网地址（10.0.0.0/8）"],
    ["172.16.5.4", "私网地址（172.16.0.0/12）"],
    ["172.31.255.255", "私网地址（172.16.0.0/12）"],
    ["192.168.0.1", "私网地址（192.168.0.0/16）"],
    ["100.64.0.1", "运营商级 NAT 保留段（100.64.0.0/10）"],
    ["169.254.169.254", "链路本地地址（169.254.0.0/16，含云元数据地址）"],
    ["192.0.2.1", "IETF 保留段（192.0.0.0/24，含文档网段）"],
    ["198.51.100.7", "文档保留段（TEST-NET，不可路由）"],
    ["203.0.113.9", "文档保留段（TEST-NET，不可路由）"],
    ["198.18.0.1", "基准测试保留段（198.18.0.0/15）"],
    ["192.88.99.1", "已退役的 6to4 中继段（192.88.99.0/24）"],
    ["224.0.0.1", "组播地址（224.0.0.0/4）"],
    ["255.255.255.255", "保留地址（240.0.0.0/4，含广播地址）"],
    ["240.0.0.1", "保留地址（240.0.0.0/4，含广播地址）"],
  ])("%s → %s", (ip, cause) => {
    expectBlocked(ip, cause);
  });
  it.each(["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1"])(
    "%s 公开可连",
    (ip) => {
      expectPublic(ip);
    },
  );
});
describe("ipBlockCause：v6 字面量（含内嵌 v4）", () => {
  it.each<[string, string]>([
    ["::", "未指定地址（::）"],
    ["::1", "回环地址（::1）"],
    ["::ffff:127.0.0.1", "回环地址（127.0.0.0/8）"],
    ["::ffff:10.0.0.1", "私网地址（10.0.0.0/8）"],
    ["::10.0.0.1", "私网地址（10.0.0.0/8）"],
    ["fe80::1", "链路本地地址（fe80::/10）"],
    ["fc00::1", "唯一本地地址（fc00::/7）"],
    ["ff02::1", "组播地址（ff00::/8）"],
    ["2001:db8::1", "文档保留段（2001:db8::/32）"],
    ["2001::1", "Teredo 保留段（2001::/32）"],
  ])("%s → %s", (ip, cause) => {
    expectBlocked(ip, cause);
  });
  it.each(["::ffff:8.8.8.8", "2606:4700:4700::1111", "2002:808:808::"])("%s 公开可连", (ip) => {
    expectPublic(ip);
  });
  it("非字面量走 DNS（不抛错、不断言分类）", () => {
    expect(parseIpLiteral("not-an-ip")).toBeUndefined();
    expect(parseIpLiteral("example.com")).toBeUndefined();
    expect(causeOf("not-an-ip")).toBeUndefined();
  });
});
function stubDns(table: Record<string, DnsAnswer[]>): {
  resolveAll: (host: string) => Promise<DnsAnswer[]>;
} {
  return {
    resolveAll: (host: string) => Promise.resolve(table[host] ?? []),
  };
}
function stubTransport(script: PinnedOutcome[]): { transport: PinnedTransport; calls: string[] } {
  const calls: string[] = [];
  let step = 0;
  const transport: PinnedTransport = (url, ip) => {
    calls.push(url.toString() + " @" + ip);
    const outcome = script[Math.min(step, script.length - 1)];
    step += 1;
    if (outcome === undefined) throw new Error("桩建连剧本耗尽");
    return Promise.resolve(outcome);
  };
  return { transport, calls };
}
const INIT = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
  timeoutMs: 1000,
};
describe("secureFetch：预检与 DNS 全量分类", () => {
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
describe("realTransport：真实回环建连（离线）", () => {
  it("302 只读 Location 不跟（命中计数证明只打一跳）", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(302, { location: "/landed" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const outcome = await realTransport(
        new URL("http://127.0.0.1:" + port + "/jump"),
        "127.0.0.1",
        4,
        INIT,
      );
      expect(outcome).toEqual({ kind: "redirect", location: "/landed" });
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("remoteAddress 对不上即熔断（期望 1.2.3.4，实际回环）", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("hi");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      await expect(
        realTransport(new URL("http://127.0.0.1:" + port + "/"), "1.2.3.4", 4, INIT),
      ).rejects.toThrow("熔断");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("超时即拒绝（挂起的服务端 + 100ms）", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      await expect(
        realTransport(new URL("http://127.0.0.1:" + port + "/"), "127.0.0.1", 4, {
          ...INIT,
          timeoutMs: 100,
        }),
      ).rejects.toThrow("超时");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("响应体按 16K 截流（32K 只读一半）", async () => {
    const big = "x".repeat(32 * 1024);
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end(big);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const outcome = await realTransport(
        new URL("http://127.0.0.1:" + port + "/"),
        "127.0.0.1",
        4,
        INIT,
      );
      if (outcome.kind !== "response") throw new Error("期望响应，实际重定向");
      expect(outcome.body).toBe(big.slice(0, 16 * 1024));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
