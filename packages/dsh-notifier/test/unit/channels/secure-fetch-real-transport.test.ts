/**
 * dsh-notifier channels secure-fetch real loopback transport.
 *
 * Each case owns and closes its local server. No DNS lookup or public connection is used.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { realTransport } from "../../../src/server/channels/impl/dry-run/secure-fetch.ts";
import { INIT } from "./secure-fetch-support.ts";

describe("realTransport：真实回环建连（离线）", () => {
  it.each([
    { label: "IPv4", ip: "127.0.0.1", family: 4 as const },
    { label: "IPv6", ip: "::1", family: 6 as const },
  ])("域名 URL 经 $label 已核验地址钉定后可真实建连（Node 20+）", async ({ ip, family }) => {
    let receivedHost = "";
    const server = createServer((req, res) => {
      receivedHost = req.headers.host ?? "";
      res.writeHead(200);
      res.end("pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, ip, resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const outcome = await realTransport(
        new URL("http://pinned.test:" + port + "/hook"),
        ip,
        family,
        INIT,
      );
      expect(outcome).toEqual({ kind: "response", status: 200, body: "pinned" });
      expect(receivedHost).toBe("pinned.test:" + port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
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
