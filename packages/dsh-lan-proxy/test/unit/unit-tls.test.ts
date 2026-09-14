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

import { certStillValid, toSanEntry } from "../../src/server/tls/impl/index.ts";
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
