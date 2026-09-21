// @ts-nocheck
/**
 * dsh-lan-proxy — issue #911 证书下发与存储命名空间单测。
 *
 * 覆盖：TLS 首证书提取与下发装配、下发路由三态与围栏、
 * 旧目录迁出（resolvePluginDir）、下发路由三态与围栏、CA 清除语义、
 * apply 接线（路由注册 + health caConfigured）。不碰真实端口与真实 DSH_HOME。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { apply, pluginDir } from "../../src/server/apply.ts";
import {
  ROUTES,
  applyConfigPatch,
  buildCaCertRoutes,
} from "../../src/server/config/impl/routes.ts";
import { sanitizeSettings, validateSettings } from "../../src/server/config/impl/model.ts";
import {
  SELF_SIGNED_CERT,
  SELF_SIGNED_KEY,
  encodeCertificatePem,
  ensureSelfSignedTls,
  extractFirstCertificateDer,
  loadDownloadableCertificate,
} from "../../src/server/tls/impl/index.ts";
import { MIGRATED_BAK_NAME } from "../../src/server/migrate/impl/file/index.ts";
import { resolvePluginDir } from "../../src/server/migrate/impl/layout/index.ts";

let prevHome;
let home;
beforeEach(() => {
  prevHome = process.env.DSH_HOME;
  home = mkdtempSync(join(tmpdir(), "dsh-911-"));
  process.env.DSH_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/**
 * 下发路由调用（同步 handler；捕获状态/头/字节体）。证书装配走真实 tls 域
 * loader（与 apply 内接线同构），fake 面只剩围栏与格式——三态/读取/解析的
 * 行为强度与直连 tls 单测等同，不重复断言 loader 内部分支。
 */
function callCaCert(source, options = {}) {
  const {
    method = "GET",
    remote = "127.0.0.1",
    host = "127.0.0.1:3080",
    url = ROUTES.caCert,
  } = options;
  const route = buildCaCertRoutes({
    loadCertificate: (format) => loadDownloadableCertificate(source, format),
  })[0];
  let status = 0;
  let headers = {};
  const chunks = [];
  const res = {
    writeHead(c, h) {
      status = c;
      headers = h;
    },
    end(c) {
      if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    },
  };
  route.handler({ method, socket: { remoteAddress: remote }, headers: { host }, url }, res);
  return { path: route.path, status, headers, body: Buffer.concat(chunks) };
}

describe("TLS 首证书提取", () => {
  it("下发路由挂在共享来源上（锚：改路径同步改客户端镜像）", () => {
    expect(ROUTES.caCert).toBe("/api/dsh-lan-proxy/ca-cert");
  });
  it("PEM 自签证书提首证书 DER（0x30 开头）", () => {
    const dir = mkdtempSync(join(home, "tls-"));
    const mat = ensureSelfSignedTls({ dir });
    const der = extractFirstCertificateDer(mat.cert);
    expect(der[0]).toBe(0x30);
  });
  it("PEM 编码往返一致", () => {
    const dir = mkdtempSync(join(home, "tls-"));
    const mat = ensureSelfSignedTls({ dir });
    const der = extractFirstCertificateDer(mat.cert);
    const pem = encodeCertificatePem(der);
    expect(pem.startsWith("-----BEGIN CERTIFICATE-----\n")).toBe(true);
    expect(extractFirstCertificateDer(pem).equals(der)).toBe(true);
  });
  it("含链 PEM 只取首个", () => {
    const a = ensureSelfSignedTls({ dir: mkdtempSync(join(home, "tls-a-")) });
    const b = ensureSelfSignedTls({ dir: mkdtempSync(join(home, "tls-b-")) });
    const chain = String(a.cert) + String(b.cert);
    expect(extractFirstCertificateDer(chain).equals(extractFirstCertificateDer(a.cert))).toBe(true);
  });
  it("私钥在前证书在后：跳过私钥取证书（仍只出公钥）", () => {
    const dir = mkdtempSync(join(home, "tls-"));
    const mat = ensureSelfSignedTls({ dir });
    const mixed = String(mat.key) + String(mat.cert);
    expect(extractFirstCertificateDer(mixed).equals(extractFirstCertificateDer(mat.cert))).toBe(
      true,
    );
  });
  it("纯私钥与垃圾抛错（调用方映射 404）", () => {
    const dir = mkdtempSync(join(home, "tls-"));
    const mat = ensureSelfSignedTls({ dir });
    expect(() => extractFirstCertificateDer(mat.key)).toThrow();
    expect(() => extractFirstCertificateDer("not-a-cert")).toThrow();
  });
});

describe("旧目录迁出 resolvePluginDir", () => {
  const NAMES = [SELF_SIGNED_KEY, SELF_SIGNED_CERT, "config.json", MIGRATED_BAK_NAME];
  it("全新安装：生效新命名空间目录", () => {
    const out = resolvePluginDir({ files: NAMES });
    expect(out.dir).toBe(join(home, "@wingsky-1", "dsh-lan-proxy"));
    expect(out.moved).toEqual([]);
    expect(out.fallback).toBe(false);
    expect(existsSync(out.dir)).toBe(true);
  });
  it("存量文件搬运且幂等", () => {
    mkdirSync(join(home, "lan-proxy"), { recursive: true });
    writeFileSync(join(home, "lan-proxy", SELF_SIGNED_CERT), "CERT");
    writeFileSync(join(home, "lan-proxy", "config.json"), "{}");
    const first = resolvePluginDir({ files: NAMES });
    expect(first.moved.sort()).toEqual([SELF_SIGNED_CERT, "config.json"].sort());
    expect(existsSync(join(home, "@wingsky-1", "dsh-lan-proxy", SELF_SIGNED_CERT))).toBe(true);
    expect(existsSync(join(home, "lan-proxy", SELF_SIGNED_CERT))).toBe(false);
    const second = resolvePluginDir({ files: NAMES });
    expect(second.moved).toEqual([]);
    expect(second.fallback).toBe(false);
  });
  it("新位置已有：旧文件归档不覆盖", () => {
    mkdirSync(join(home, "lan-proxy"), { recursive: true });
    mkdirSync(join(home, "@wingsky-1", "dsh-lan-proxy"), { recursive: true });
    writeFileSync(join(home, "lan-proxy", SELF_SIGNED_CERT), "OLD");
    writeFileSync(join(home, "@wingsky-1", "dsh-lan-proxy", SELF_SIGNED_CERT), "NEW");
    const out = resolvePluginDir({ files: NAMES });
    expect(out.moved).toEqual([]);
    expect(readFileSync(join(home, "@wingsky-1", "dsh-lan-proxy", SELF_SIGNED_CERT), "utf8")).toBe(
      "NEW",
    );
    expect(existsSync(join(home, "lan-proxy", SELF_SIGNED_CERT + ".migrated.bak"))).toBe(true);
  });
  it("穿越文件名跳过", () => {
    const out = resolvePluginDir({ files: ["../evil", "", "."] });
    expect(out.moved).toEqual([]);
    expect(out.fallback).toBe(false);
  });
  it("pluginDir 末段为包名分区", () => {
    expect(pluginDir()).toBe(join(home, "@wingsky-1", "dsh-lan-proxy"));
    expect(basename(pluginDir())).toBe("dsh-lan-proxy");
  });
});

describe("下发路由三态与围栏", () => {
  it("非回环 403（先于 405）", () => {
    const r = callCaCert(
      { selfSignedDir: home },
      { remote: "192.168.31.99", host: "192.168.31.99:3443", method: "POST" },
    );
    expect(r.status).toBe(403);
  });
  it("回环 POST 405", () => {
    const r = callCaCert({ selfSignedDir: home }, { method: "POST" });
    expect(r.status).toBe(405);
  });
  it("自签模式无 CA 下发 404 并指引生成（#930 Phase 1：外观可用但无用的叶子不再下发）", () => {
    const dir = mkdtempSync(join(home, "self-"));
    ensureSelfSignedTls({ dir });
    const r = callCaCert({ selfSignedDir: dir });
    expect(r.path).toBe(ROUTES.caCert);
    expect(r.status).toBe(404);
    const body = JSON.parse(r.body.toString("utf8"));
    expect(body.error.code).toBe("ca-unconfigured");
    expect(body.error.details).toContain("一键生成");
  });
  it("?format=pem 下发 PEM 文本（CA 模式；自签模式已 404）", () => {
    const dir = mkdtempSync(join(home, "ca-"));
    const ca = ensureSelfSignedTls({ dir });
    const r = callCaCert(
      { tlsCaCertFile: join(dir, SELF_SIGNED_CERT), selfSignedDir: dir },
      { url: ROUTES.caCert + "?format=pem" },
    );
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/x-pem-file");
    expect(
      extractFirstCertificateDer(r.body.toString("utf8")).equals(
        extractFirstCertificateDer(ca.cert),
      ),
    ).toBe(true);
    expect(r.body.toString("utf8").startsWith("-----BEGIN CERTIFICATE-----")).toBe(true);
  });
  it("?format=cer 显式走 DER（CA 模式，.cer 头齐全）", () => {
    const dir = mkdtempSync(join(home, "ca-"));
    ensureSelfSignedTls({ dir });
    const deps = { tlsCaCertFile: join(dir, SELF_SIGNED_CERT), selfSignedDir: dir };
    const r = callCaCert(deps, { url: ROUTES.caCert + "?format=cer" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/x-x509-ca-cert");
    expect(r.body[0]).toBe(0x30);
    expect(r.headers["content-disposition"]).toContain("dsh-lan-ca.cer");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });
  it("畸形 request-target 同样 400（解析抛错不回落 DER）", () => {
    const dir = mkdtempSync(join(home, "self-"));
    ensureSelfSignedTls({ dir });
    const r = callCaCert({ selfSignedDir: dir }, { url: "http://[::1" });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body.toString("utf8")).error.code).toBe("bad-format");
  });
  it("未知 format 值 400（fail-closed，不静默回落）", () => {
    const dir = mkdtempSync(join(home, "self-"));
    ensureSelfSignedTls({ dir });
    const r = callCaCert({ selfSignedDir: dir }, { url: ROUTES.caCert + "?format=bogus" });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body.toString("utf8")).error.code).toBe("bad-format");
  });
  it("CA 模式下发 CA（非叶子）", () => {
    const caDir = mkdtempSync(join(home, "ca-"));
    const ca = ensureSelfSignedTls({ dir: caDir });
    const leafDir = mkdtempSync(join(home, "leaf-"));
    ensureSelfSignedTls({ dir: leafDir });
    const r = callCaCert({
      tlsCaCertFile: join(caDir, "dsh-lan-proxy-cert.pem"),
      selfSignedDir: leafDir,
    });
    expect(r.status).toBe(200);
    expect(r.body.equals(extractFirstCertificateDer(ca.cert))).toBe(true);
  });
  it("自定义叶子无 CA 返回 404 且不给叶子", () => {
    const r = callCaCert({
      tlsCertFile: "/x.pem",
      tlsKeyFile: "/y.pem",
      selfSignedDir: home,
    });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body.toString("utf8")).error.code).toBe("ca-unconfigured");
  });
  it("文件缺失返回 404 ca-unavailable", () => {
    const r = callCaCert({
      tlsCaCertFile: join(home, "nope.pem"),
      selfSignedDir: home,
    });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body.toString("utf8")).error.code).toBe("ca-unavailable");
  });
  it("误指私钥返回 404 且私钥不出网", () => {
    const dir = mkdtempSync(join(home, "self-"));
    const mat = ensureSelfSignedTls({ dir });
    writeFileSync(join(dir, "key-as-ca.pem"), mat.key);
    const r = callCaCert({
      tlsCaCertFile: join(dir, "key-as-ca.pem"),
      selfSignedDir: dir,
    });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body.toString("utf8")).error.code).toBe("ca-invalid");
    expect(r.body.toString("utf8")).not.toContain("PRIVATE KEY");
  });
});

describe("CA 键校验与清除", () => {
  it("数字形态非法，字符串与空串合法", () => {
    expect(validateSettings({ tlsCaCertFile: 42 })?.key).toBe("tlsCaCertFile");
    expect(validateSettings({ tlsCaCertFile: "/x/ca.pem" })).toBe(null);
    expect(validateSettings({ tlsCaCertFile: "" })).toBe(null);
  });
  it("sanitize 剔除空串 CA", () => {
    expect(sanitizeSettings({ tlsCaCertFile: "", httpsEnabled: true })).toEqual({
      httpsEnabled: true,
    });
    expect(sanitizeSettings({ tlsCaCertFile: "/x/ca.pem" })).toEqual({
      tlsCaCertFile: "/x/ca.pem",
    });
  });
  it("显式空串经 replace 独立清除", async () => {
    let replaced = null;
    const deps = {
      resolve: () => ({}),
      readUser: () => ({ user: { tlsCaCertFile: "/old/ca.pem", port: 3000 }, revision: 7 }),
      writable: () => true,
      update: async () => {},
      replace: async (s) => {
        replaced = s;
      },
      compress: () => ({}),
    };
    const r = await applyConfigPatch(deps, { patch: { tlsCaCertFile: "" }, expectedRevision: 7 });
    expect(r.ok).toBe(true);
    expect("tlsCaCertFile" in replaced).toBe(false);
    expect(replaced.port).toBe(3000);
  });
  it("单清 CA 不连带删叶子（P1 回归）", async () => {
    let replaced = null;
    const deps = {
      resolve: () => ({}),
      readUser: () => ({
        user: {
          tlsCertFile: "/c.pem",
          tlsKeyFile: "/k.pem",
          tlsCaCertFile: "/old/ca.pem",
          port: 3000,
        },
        revision: 7,
      }),
      writable: () => true,
      update: async () => {},
      replace: async (s) => {
        replaced = s;
      },
      compress: () => ({}),
    };
    const r = await applyConfigPatch(deps, { patch: { tlsCaCertFile: "" }, expectedRevision: 7 });
    expect(r.ok).toBe(true);
    expect("tlsCaCertFile" in replaced).toBe(false);
    expect(replaced.tlsCertFile).toBe("/c.pem");
    expect(replaced.tlsKeyFile).toBe("/k.pem");
    expect(replaced.port).toBe(3000);
  });
});

describe("apply 接线", () => {
  function runApply(entry) {
    const routes = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: {
        port: 3801,
        register(r) {
          routes.push(r);
          return () => {};
        },
        tapIndex() {
          return () => {};
        },
        on() {
          return () => {};
        },
      },
      inject() {},
      effect(fn) {
        return fn();
      },
    };
    apply(ctx, { enabled: false, httpsEnabled: false, ...entry });
    return routes;
  }
  function callHealth(routes) {
    const route = routes.find((r) => r.path === ROUTES.health);
    let text = "";
    route.handler(
      {
        method: "GET",
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3801" },
        url: ROUTES.health,
      },
      {
        writeHead() {},
        end(c) {
          text = String(c);
        },
      },
    );
    return JSON.parse(text);
  }
  it("注册下发路由且命名空间目录建出", () => {
    const routes = runApply({});
    expect(routes.map((r) => r.path)).toContain(ROUTES.caCert);
    expect(existsSync(join(home, "@wingsky-1", "dsh-lan-proxy"))).toBe(true);
  });
  it("配 CA 时 health caConfigured 为 true，否则 false", () => {
    expect(callHealth(runApply({ tlsCaCertFile: "/x/ca.pem" })).caConfigured).toBe(true);
    expect(callHealth(runApply({})).caConfigured).toBe(false);
  });
  it("自签模式 caConfigured=false 且下载 404 联合（#930 Phase 1 口径诚实）", () => {
    const routes = runApply({});
    expect(callHealth(routes).caConfigured).toBe(false);
    const dir = mkdtempSync(join(home, "self-"));
    ensureSelfSignedTls({ dir });
    const r = callCaCert({ selfSignedDir: dir });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body.toString("utf8")).error.code).toBe("ca-unconfigured");
  });
});
