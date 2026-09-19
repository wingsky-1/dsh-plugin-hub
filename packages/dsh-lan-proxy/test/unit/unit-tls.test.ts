/**
 * dsh-lan-proxy — TLS 域纯函数（源码层，ARCHITECTURE-METHOD §8）。
 *
 * 这些判据此前只住在 test/e2e（从 lib/ 产物导入）：纯函数的边界用例放在产物层属
 * 导入面倒置——产物层该证明的是「bundle 之后这些导出仍然可用」，同域纯函数应直连
 * src 白盒。e2e 侧对应断言保留（产物契约不受影响），本文件补源码层这一份。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { X509Certificate } from "node:crypto";
import * as forge from "node-forge";
import {
  certStillValid,
  generateCaAndLeaf,
  generateLeafSignedByCa,
  readLeafCertInfo,
  toSanEntry,
} from "../../src/server/tls/impl/index.ts";
import type { SanAltName } from "../../src/server/tls/impl/index.ts";

const SAN_CASES: Array<[string, SanAltName]> = [
  ["192.168.1.5", { type: 7, ip: "192.168.1.5" }],
  ["::1", { type: 7, ip: "::1" }],
  ["myhost.lan", { type: 2, value: "myhost.lan" }],
  ["localhost", { type: 2, value: "localhost" }],
];

describe("unit: toSanEntry 的 IP / DNS 判别", () => {
  it.each(SAN_CASES)("%s 编码为对应 SAN 条目", (input, expected) => {
    expect(toSanEntry(input)).toEqual(expected);
  });
});

describe("unit: certStillValid 的边界", () => {
  it("路径不存在 → false（不得抛出）", () => {
    expect(certStillValid("/nonexistent/cert-826.pem")).toBe(false);
  });

  it("内容不可解析 → false（不得抛出）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-tls-"));
    try {
      const bad = join(dir, "bad.pem");
      writeFileSync(bad, "not a certificate");
      expect(certStillValid(bad)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 有效期天数（X509 侧读回实测值与期望的允许摆动：签发耗时 + 整秒截断）。 */
const DAY_MS = 86400 * 1000;

/**
 * 扩展表回读（forge 解码器读 DER：与编码器独立路径，表错即红；背景：本机
 * Node 24 的 X509Certificate.keyUsage/extKeyUsage getter 失真——openssl 实测
 * 字节正确（Digital Signature, Key Encipherment / serverAuth 均在位），Node 侧
 * keyUsage 恒 undefined、extKeyUsage 值误入 keyUsage，故用法类不断 Node 口径）。
 */
/** 解码扩展视图（断言所需的标志位具名收口；库类型侧为 any[]，边界一次收窄）。 */
interface DecodedExtension {
  name?: string;
  cA?: boolean;
  keyCertSign?: boolean;
  cRLSign?: boolean;
  digitalSignature?: boolean;
  keyEncipherment?: boolean;
  serverAuth?: boolean;
}

function extension(pem: string, name: string): DecodedExtension | undefined {
  const cert = forge.pki.certificateFromPem(pem) as unknown as {
    extensions?: DecodedExtension[];
  };
  return cert.extensions?.find((ext) => ext.name === name);
}

describe("unit: generateCaAndLeaf 的 CA/叶子 profile（#930 F6）", () => {
  it("CA 自签 + cA:true + 签证用法 + 10 年", async () => {
    const mat = await generateCaAndLeaf([]);
    expect(mat.caCert.startsWith("-----BEGIN CERTIFICATE-----")).toBe(true);
    expect(mat.caKey).toContain("PRIVATE KEY");
    const ca = new X509Certificate(mat.caCert);
    expect(ca.ca).toBe(true);
    expect(extension(mat.caCert, "basicConstraints")?.cA).toBe(true);
    expect(extension(mat.caCert, "keyUsage")?.keyCertSign).toBe(true);
    expect(extension(mat.caCert, "keyUsage")?.cRLSign).toBe(true);
    expect(ca.issuer).toBe(ca.subject);
    expect(ca.subject).toContain("dsh-lan-proxy CA");
    const days = (ca.validToDate.getTime() - ca.validFromDate.getTime()) / DAY_MS;
    expect(days).toBeGreaterThan(3649);
    expect(days).toBeLessThan(3651);
  });

  it("叶子 cA:false + 用法 + serverAuth + SAN 含额外 IP + 398 天", async () => {
    const mat = await generateCaAndLeaf(["192.168.99.9"]);
    const leaf = new X509Certificate(mat.leafCert);
    expect(leaf.ca).toBe(false);
    expect(extension(mat.leafCert, "basicConstraints")?.cA).toBe(false);
    expect(extension(mat.leafCert, "keyUsage")?.digitalSignature).toBe(true);
    expect(extension(mat.leafCert, "keyUsage")?.keyEncipherment).toBe(true);
    expect(extension(mat.leafCert, "extKeyUsage")?.serverAuth).toBe(true);
    expect(leaf.subjectAltName).toContain("IP Address:192.168.99.9");
    expect(leaf.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(leaf.subjectAltName).toContain("DNS:localhost");
    expect(leaf.issuer).toContain("dsh-lan-proxy CA");
    const days = (leaf.validToDate.getTime() - leaf.validFromDate.getTime()) / DAY_MS;
    expect(days).toBeGreaterThan(397);
    expect(days).toBeLessThan(399);
  });

  it("叶子经 CA 公钥验签通过（签发关系非自签）", async () => {
    const mat = await generateCaAndLeaf([]);
    const ca = new X509Certificate(mat.caCert);
    const leaf = new X509Certificate(mat.leafCert);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.raw.equals(ca.raw)).toBe(false);
  });
});

describe("unit: generateLeafSignedByCa 仅换叶子（#930 F10）", () => {
  it("新叶子沿用 CA：验签通过 + CA 材料原样可用", async () => {
    const mat = await generateCaAndLeaf(["192.168.99.9"]);
    const rotated = await generateLeafSignedByCa(mat.caCert, mat.caKey, ["192.168.99.10"]);
    const ca = new X509Certificate(mat.caCert);
    const leaf = new X509Certificate(rotated.leafCert);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.subjectAltName).toContain("IP Address:192.168.99.10");
    expect(new X509Certificate(mat.leafCert).raw.equals(leaf.raw)).toBe(false);
  });

  it("CA 材料非法即抛错（调用方映射 500，原文只进日志）", async () => {
    await expect(generateLeafSignedByCa("not-a-cert", "not-a-key", [])).rejects.toThrow(
      /invalid CA materials/,
    );
  });
});

describe("unit: readLeafCertInfo 摘要（#930 F8）", () => {
  it("可读叶子 → validTo ISO + SAN 原串", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-tls-"));
    try {
      const mat = await generateCaAndLeaf(["192.168.99.9"]);
      const path = join(dir, "leaf.pem");
      writeFileSync(path, mat.leafCert);
      const summary = readLeafCertInfo(path);
      expect(summary.ok).toBe(true);
      if (summary.ok) {
        expect(Number.isNaN(Date.parse(summary.validTo))).toBe(false);
        expect(summary.validTo.endsWith("Z")).toBe(true);
        expect(summary.sans).toContain("IP Address:192.168.99.9");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缺失/垃圾 → ok:false（health 置 null，不提醒）", () => {
    expect(readLeafCertInfo("/nonexistent/leaf-930.pem")).toEqual({ ok: false });
    const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-tls-"));
    try {
      const bad = join(dir, "bad.pem");
      writeFileSync(bad, "not a certificate");
      expect(readLeafCertInfo(bad)).toEqual({ ok: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
