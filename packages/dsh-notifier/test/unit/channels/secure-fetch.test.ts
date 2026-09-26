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

// ── 抽出判据的直接单测（#732 E6）────────────────────────────────────────────
// 下面每组都对着一条被抽出来的纯判定：段的前缀定基数、字符集、逐段上限、按段数拼装、
// 字节拆分、v4/v6 前缀掩码表的每条边界、整地址特殊值表、内嵌 v4 的三种布局、v6 展开。
// 它们是 SSRF 判据的判据——改错时表现为这里断言变红，而不是某次 dry-run 恰好没走到那条分支。
// 期望值全部由「重构前原判据」的逐字副本算出，不是抄新实现的输出。
describe("parseIpLiteral：v4 段的前缀定基数（ipv4PartBase + 字符集表）", () => {
  it.each<[string, string]>([
    ["0x7f000001", "127.0.0.1"],
    ["0X7F000001", "127.0.0.1"],
    ["0x7f.1", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["0377.0.0.1", "255.0.0.1"],
    ["00", "0.0.0.0"],
    ["2130706433", "127.0.0.1"],
    ["127.0.0.1", "127.0.0.1"],
    ["10.0.0.1", "10.0.0.1"],
    ["0xc0.0.0.2", "192.0.0.2"],
    ["0x1.2.3.4", "1.2.3.4"],
  ])("%s → %s", (input, octets) => {
    const parsed = parseIpLiteral(input);
    if (parsed === undefined || parsed.family !== 4) throw new Error("期望解析出 v4：" + input);
    expect(parsed.octets.join(".")).toBe(octets);
  });
  it.each([
    // 空 digits：0x / 0 之后没有数字
    "0x",
    "0X",
    // 字符集越出基数：八进制不得有 8/9，十进制不得有 a-f，十六进制不得有 g
    "08.0.0.1",
    "0399.0.0.1",
    "1a.0.0.1",
    "0xfg",
    // 空段（末尾那个点不算空段：先被 FQDN 尾点剥离，见下条）
    "1..2.3",
    "1.2..3",
    ".1.2.3",
    // 段数越界（inet_aton 最多四段）
    "1.2.3.4.5",
    // 数字超出安全整数
    "99999999999999999999",
    "0x99999999999999999999",
  ])("非法形态 %s 即不是字面量", (input) => {
    expect(parseIpLiteral(input)).toBeUndefined();
  });
  it("FQDN 尾点先剥掉再判形态（1.2.3. → 1.2.3）", () => {
    const parsed = parseIpLiteral("1.2.3.");
    if (parsed === undefined || parsed.family !== 4) throw new Error("期望解析出 v4");
    expect(parsed.octets.join(".")).toBe("1.2.0.3");
  });
});

describe("parseIpLiteral：逐段上限（ipV4PartOverflows）", () => {
  it.each<[string, boolean]>([
    // 上限按段序递减：1 段 32 位、2 段 24 位、3 段 16 位、4 段 8 位
    ["4294967295", true],
    ["4294967296", false],
    ["0x10000.0.0", false],
    ["1.16777215", true],
    ["1.16777216", false],
    ["0x100.0.0", false],
    ["0xff.0.0.0", true],
    ["1.2.65535", true],
    ["1.2.65536", false],
    ["1.2.3.255", true],
    ["1.2.3.256", false],
    ["0.255.255.255", true],
    // 0.256.0.0 是 3 段写法：第二段上限 24 位，256 过不了——但 0.256.0.0 也可读成
    // 4 段 0.256.0.0？段数就是 4，故走 8 位上限，256 越界；此行钉住「段数决定上限」这条。
    ["0.256.0.0", true],
  ])("%s 可解析=%s", (input, parses) => {
    expect(parseIpLiteral(input) !== undefined).toBe(parses);
  });
});

describe("parseIpLiteral：按段数拼装（assembleIpv4）", () => {
  it.each<[string, string]>([
    // 末段吃掉剩余全部位：1 段 32 位、2 段 8+24、3 段 8+8+16、4 段逐字节
    ["0x7f000001", "127.0.0.1"],
    ["0x7f.1", "127.0.0.1"],
    ["0x7f.0.1", "127.0.0.1"],
    ["0x7f.0.0.1", "127.0.0.1"],
    ["0xac.10.0.1", "172.10.0.1"],
    ["0xc0.0.0", "192.0.0.0"],
    ["0xc0.0.0.0", "192.0.0.0"],
    ["0xff.255.255.255", "255.255.255.255"],
  ])("%s → %s", (input, octets) => {
    const parsed = parseIpLiteral(input);
    if (parsed === undefined || parsed.family !== 4) throw new Error("期望解析出 v4：" + input);
    expect(parsed.octets.join(".")).toBe(octets);
  });
  it.each(["0x6440.1", "0xc612.0", "0xac1f.ffff.ffff"])(
    "末段越出该段上限 %s 即非法（拼装本身不兜底）",
    (input) => {
      expect(parseIpLiteral(input)).toBeUndefined();
    },
  );
});

describe("parseIpLiteral：字节拆分（ipv4Bytes）", () => {
  it.each<[string, string]>([
    ["2130706433", "127.0.0.1"],
    ["16909060", "1.2.3.4"],
    ["16777216", "1.0.0.0"],
    ["16777217", "1.0.0.1"],
    ["16843008", "1.1.1.0"],
    ["1048576", "0.16.0.0"],
    ["1024", "0.0.4.0"],
    ["256", "0.0.1.0"],
    ["4294967295", "255.255.255.255"],
  ])("%s → %s", (input, octets) => {
    const parsed = parseIpLiteral(input);
    if (parsed === undefined || parsed.family !== 4) throw new Error("期望解析出 v4：" + input);
    expect(parsed.octets.join(".")).toBe(octets);
  });
});

describe("ipBlockCause：v4 规则表每条的前缀/掩码边界", () => {
  it.each<[string, string | undefined]>([
    // 每条规则两侧各一个反例：命中侧给原文案，未命中侧必须放行
    ["0.0.0.0", "未指定地址（0.0.0.0/8）"],
    ["0.255.255.255", "未指定地址（0.0.0.0/8）"],
    ["1.0.0.0", undefined],
    ["10.0.0.0", "私网地址（10.0.0.0/8）"],
    ["9.255.255.255", undefined],
    ["11.0.0.0", undefined],
    ["172.16.0.0", "私网地址（172.16.0.0/12）"],
    ["172.31.255.255", "私网地址（172.16.0.0/12）"],
    ["172.15.255.255", undefined],
    ["172.32.0.0", undefined],
    ["192.168.0.0", "私网地址（192.168.0.0/16）"],
    ["192.167.255.255", undefined],
    ["192.169.0.0", undefined],
    ["100.64.0.0", "运营商级 NAT 保留段（100.64.0.0/10）"],
    ["100.127.255.255", "运营商级 NAT 保留段（100.64.0.0/10）"],
    ["100.63.255.255", undefined],
    ["100.128.0.0", undefined],
    ["127.0.0.0", "回环地址（127.0.0.0/8）"],
    ["127.255.255.255", "回环地址（127.0.0.0/8）"],
    ["126.255.255.255", undefined],
    ["128.0.0.0", undefined],
    ["169.254.0.0", "链路本地地址（169.254.0.0/16，含云元数据地址）"],
    ["169.253.255.255", undefined],
    ["169.255.0.0", undefined],
    // 192.0.0/24 与 192.0.2/24 共用 IETF 文案：判据看第三字节是 0 还是 2，不看第四字节
    ["192.0.0.1", "IETF 保留段（192.0.0.0/24，含文档网段）"],
    ["192.0.2.1", "IETF 保留段（192.0.0.0/24，含文档网段）"],
    ["192.0.1.1", undefined],
    ["192.0.3.1", undefined],
    ["192.88.99.1", "已退役的 6to4 中继段（192.88.99.0/24）"],
    ["192.88.98.1", undefined],
    ["192.88.100.1", undefined],
    // TEST-NET 三段：192.0.113 / 198.51.100 / 203.0.113
    ["192.0.113.1", "文档保留段（TEST-NET，不可路由）"],
    ["198.51.100.1", "文档保留段（TEST-NET，不可路由）"],
    ["203.0.113.1", "文档保留段（TEST-NET，不可路由）"],
    ["198.51.99.1", undefined],
    ["198.51.101.1", undefined],
    ["203.0.112.1", undefined],
    ["203.0.114.1", undefined],
    ["198.18.0.0", "基准测试保留段（198.18.0.0/15）"],
    ["198.19.255.255", "基准测试保留段（198.18.0.0/15）"],
    ["198.17.255.255", undefined],
    ["198.20.0.0", undefined],
    ["223.255.255.255", undefined],
    ["224.0.0.0", "组播地址（224.0.0.0/4）"],
    ["239.255.255.255", "组播地址（224.0.0.0/4）"],
    ["240.0.0.0", "保留地址（240.0.0.0/4，含广播地址）"],
    ["255.255.255.255", "保留地址（240.0.0.0/4，含广播地址）"],
  ])("%s → %s", (ip, cause) => {
    if (cause === undefined) expectPublic(ip);
    else expectBlocked(ip, cause);
  });
});

describe("ipBlockCause：v6 三类判据（整地址 / 内嵌 v4 / 前缀段）的边界", () => {
  it.each<[string, string | undefined]>([
    // 整地址特殊值表：:: 与 ::1 逐字比对
    ["::", "未指定地址（::）"],
    ["::1", "回环地址（::1）"],
    ["0:0:0:0:0:0:0:1", "回环地址（::1）"],
    // ::2 落进「兼容形」（:: + 内嵌 v4），内层 0.0.0.2 归未指定地址——不是整地址表命中
    ["::2", "未指定地址（0.0.0.0/8）"],
    // 内嵌 v4：映射 ::ffff: 与兼容 :: 共用末 32 位布局
    ["::ffff:0.0.0.0", "未指定地址（0.0.0.0/8）"],
    ["::ffff:127.0.0.1", "回环地址（127.0.0.0/8）"],
    ["::ffff:169.254.169.254", "链路本地地址（169.254.0.0/16，含云元数据地址）"],
    ["::ffff:8.8.8.8", undefined],
    ["::127.0.0.1", "回环地址（127.0.0.0/8）"],
    ["::10.0.0.1", "私网地址（10.0.0.0/8）"],
    ["::8.8.8.8", undefined],
    // 6to4：内层 v4 藏在第 2~3 个字（2002:V4HIGH:V4LOW::/48），不是末 32 位
    ["2002:7f00:1::", "回环地址（127.0.0.0/8）"],
    ["2002:a00:1::", "私网地址（10.0.0.0/8）"],
    ["2002:808:808::", undefined],
    ["2002:7f00:0:1::1", "回环地址（127.0.0.0/8）"],
    ["2002:0:0::", "未指定地址（0.0.0.0/8）"],
    // 首 32 位前缀段表：每条两侧各一个反例
    ["fe80::", "链路本地地址（fe80::/10）"],
    ["febf:ffff::", "链路本地地址（fe80::/10）"],
    ["fec0::", undefined],
    ["fe7f:ffff::", undefined],
    ["fc00::", "唯一本地地址（fc00::/7）"],
    ["fdff:ffff::", "唯一本地地址（fc00::/7）"],
    ["fbff:ffff::", undefined],
    ["fe00::", undefined],
    ["ff00::", "组播地址（ff00::/8）"],
    ["ffff:ffff::", "组播地址（ff00::/8）"],
    ["feff::", undefined],
    ["2001:db8::", "文档保留段（2001:db8::/32）"],
    ["2001:db8:ffff::", "文档保留段（2001:db8::/32）"],
    ["2001:db9::", undefined],
    ["2001::", "Teredo 保留段（2001::/32）"],
    ["2001:ffff::", undefined],
    ["2000::", undefined],
    ["2606:4700:4700::1111", undefined],
    ["2001:4860:4860::8888", undefined],
  ])("%s → %s", (ip, cause) => {
    if (cause === undefined) expectPublic(ip);
    else expectBlocked(ip, cause);
  });
  it("字数不足 8 即解析失败（不是放行）", () => {
    const short = { family: 6 as const, words: [0, 0, 0, 0, 0, 0, 0], text: "::" };
    expect(ipBlockCause(short)).toBe("IPv6 解析失败");
    const long = { family: 6 as const, words: [0, 0, 0, 0, 0, 0, 0, 0, 0], text: "::" };
    expect(ipBlockCause(long)).toBe("IPv6 解析失败");
  });
});

describe("parseIpLiteral：v6 展开（splitIpv6Tail / 无压缩 / 压缩）", () => {
  it.each<[string, string]>([
    ["::1", "0,0,0,0,0,0,0,1"],
    ["::", "0,0,0,0,0,0,0,0"],
    ["1:2:3:4:5:6:7:8", "1,2,3,4,5,6,7,8"],
    ["2001:db8::1", "8193,3512,0,0,0,0,0,1"],
    ["fe80::1", "65152,0,0,0,0,0,0,1"],
    ["2001:4860:4860::8888", "8193,18528,18528,0,0,0,0,34952"],
    // 点分十进制尾收成两个字
    ["::ffff:127.0.0.1", "0,0,0,0,0,65535,32512,1"],
    ["::127.0.0.1", "0,0,0,0,0,0,32512,1"],
    ["::ffff:8.8.8.8", "0,0,0,0,0,65535,2056,2056"],
    ["::0.0.0.1", "0,0,0,0,0,0,0,1"],
    // 方括号包裹的 v6
    ["[::1]", "0,0,0,0,0,0,0,1"],
    ["[fe80::1]", "65152,0,0,0,0,0,0,1"],
  ])("%s → [%s]", (input, words) => {
    const parsed = parseIpLiteral(input);
    if (parsed === undefined || parsed.family !== 6) throw new Error("期望解析出 v6：" + input);
    expect(parsed.words.join(",")).toBe(words);
  });
  it.each([
    // 无压缩形必须恰好 8 个字（少一个、多一个都不是字面量）
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    // :: 至少要吃掉一个字（两侧已写满）
    "1:2:3:4:1:2:3:4::",
    // 多个 ::
    "1::2::3",
    // 组长度越界
    "1:2:3:4:5:6:7:12345",
    "1:2:3:4:5:6:7:xyz",
    // 点分尾本身非法
    "::ffff:1.2.3.256",
    "::1.2.3",
  ])("非法 v6 形态 %s 即不是字面量", (input) => {
    expect(parseIpLiteral(input)).toBeUndefined();
  });
});
