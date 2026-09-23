/**
 * dsh-lan-proxy — issue #911 证书下发与存储命名空间单测。
 *
 * 覆盖：TLS 首证书提取与下发装配、下发路由三态与围栏、
 * 旧目录迁出（resolvePluginDir）、下发路由三态与围栏、CA 清除语义、
 * apply 接线（路由注册 + health caConfigured）。不碰真实端口与真实 DSH_HOME。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { apply, pluginDir } from "../../src/server/apply.ts";
import type { ConfigRouteDeps } from "../../src/server/config/interface.ts";
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
import { MANAGED_CERT_FILES, legacyPluginDir } from "../../src/server/shared/paths.ts";

let prevHome: string | undefined;
let home: string;
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
/** 下发路由调用选项（围栏三元组 + 请求目标，缺省为回环 GET）。 */
interface CaCertCallOptions {
  method?: string;
  remote?: string;
  host?: string;
  url?: string;
}
function callCaCert(
  source: Parameters<typeof loadDownloadableCertificate>[0],
  options: CaCertCallOptions = {},
) {
  const {
    method = "GET",
    remote = "127.0.0.1",
    host = "127.0.0.1:3080",
    url = ROUTES.caCert,
  } = options;
  const route = buildCaCertRoutes({
    loadCertificate: (format: "der" | "pem") => loadDownloadableCertificate(source, format),
  })[0];
  let status = 0;
  let headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = {
    writeHead(c: number, h: Record<string, string>) {
      status = c;
      headers = h;
    },
    end(c?: unknown) {
      if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    },
  } as unknown as ServerResponse;
  const req = {
    method,
    socket: { remoteAddress: remote },
    headers: { host },
    url,
  } as unknown as IncomingMessage;
  route.handler(req, res);
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
    expect(pem.endsWith("\n-----END CERTIFICATE-----\n")).toBe(true);
    // 64 列换行无空行（步长/边界变异即多出空行或超长行）。
    const bodyLines = pem.split("\n").slice(1, -2);
    expect(bodyLines.length).toBeGreaterThan(1);
    expect(bodyLines.every((line) => line.length > 0 && line.length <= 64)).toBe(true);
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
  it("托管四件套随旧目录迁出（MANAGED_CERT_FILES 清单行为锚：置空即迁不出）", () => {
    mkdirSync(join(home, "lan-proxy"), { recursive: true });
    writeFileSync(join(home, "lan-proxy", "ca-cert.pem"), "CA");
    const out = resolvePluginDir({ files: [...MANAGED_CERT_FILES] });
    expect(out.moved).toEqual(["ca-cert.pem"]);
    expect(out.fallback).toBe(false);
    expect(existsSync(join(home, "@wingsky-1", "dsh-lan-proxy", "ca-cert.pem"))).toBe(true);
    expect(existsSync(join(home, "lan-proxy", "ca-cert.pem"))).toBe(false);
  });
  it('".." 逐字拒绝（家目录不得被改名归档）', () => {
    const out = resolvePluginDir({ files: [".."] });
    expect(out.moved).toEqual([]);
    expect(out.fallback).toBe(false);
    expect(existsSync(home)).toBe(true);
    rmSync(home + ".migrated.bak", { recursive: true, force: true });
  });
  it("非法名在旧目录存在时仍零触碰（守卫行为锚：合法 keep 照迁）", () => {
    mkdirSync(join(home, "lan-proxy"), { recursive: true });
    writeFileSync(join(home, "lan-proxy", "keep.pem"), "KEEP");
    mkdirSync(join(home, "lan-proxy", "sub"), { recursive: true });
    writeFileSync(join(home, "lan-proxy", "sub", "keep.pem"), "SUB");
    const out = resolvePluginDir({
      files: ["", ".", "..", "../evil", "a/b", "sub/keep.pem", "keep.pem"],
    });
    expect(out.moved).toEqual(["keep.pem"]);
    expect(out.fallback).toBe(false);
    expect(existsSync(join(home, "@wingsky-1", "dsh-lan-proxy", "keep.pem"))).toBe(true);
    expect(existsSync(join(home, "lan-proxy", "sub", "keep.pem"))).toBe(true);
    expect(existsSync(home)).toBe(true);
    rmSync(home + ".migrated.bak", { recursive: true, force: true });
  });
  it("搬运失败回落旧目录（只读新目录 + 日志；回滚循环见分类说明）", () => {
    mkdirSync(join(home, "lan-proxy"), { recursive: true });
    writeFileSync(join(home, "lan-proxy", "a.pem"), "A");
    const fresh = join(home, "@wingsky-1", "dsh-lan-proxy");
    mkdirSync(join(home, "@wingsky-1"), { recursive: true });
    mkdirSync(fresh);
    chmodSync(fresh, 0o555);
    const warns: string[] = [];
    try {
      const out = resolvePluginDir({
        files: ["a.pem"],
        logger: { warn: (...a: unknown[]) => warns.push(a.map(String).join(" ")) },
      });
      expect(out.dir).toBe(legacyPluginDir());
      expect(out.moved).toEqual([]);
      expect(out.fallback).toBe(true);
      expect(readFileSync(join(home, "lan-proxy", "a.pem"), "utf8")).toBe("A");
      expect(warns.some((w) => w.includes("回滚并回落旧目录"))).toBe(true);
      // logger 缺席 warn 方法 → 静默跳过不抛（可选链双保险）。
      const out2 = resolvePluginDir({ files: ["a.pem"], logger: {} });
      expect(out2.fallback).toBe(true);
    } finally {
      chmodSync(fresh, 0o755);
    }
  });
  it("归档失败记日志并保留原位（.bak 被目录占住）", () => {
    mkdirSync(join(home, "lan-proxy"), { recursive: true });
    writeFileSync(join(home, "lan-proxy", "f.pem"), "OLD");
    mkdirSync(join(home, "@wingsky-1", "dsh-lan-proxy"), { recursive: true });
    writeFileSync(join(home, "@wingsky-1", "dsh-lan-proxy", "f.pem"), "NEW");
    mkdirSync(join(home, "lan-proxy", "f.pem.migrated.bak"), { recursive: true });
    const warns: string[] = [];
    const out = resolvePluginDir({
      files: ["f.pem"],
      logger: { warn: (...a: unknown[]) => warns.push(a.map(String).join(" ")) },
    });
    expect(out.moved).toEqual([]);
    expect(out.fallback).toBe(false);
    expect(readFileSync(join(home, "lan-proxy", "f.pem"), "utf8")).toBe("OLD");
    expect(warns.some((w) => w.includes("归档失败") && !w.includes("undefined"))).toBe(true);
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
    expect(body.ok).toBe(false);
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
    const malformed = JSON.parse(r.body.toString("utf8"));
    expect(malformed.ok).toBe(false);
    expect(malformed.error.code).toBe("bad-format");
  });
  it('req.url 缺席 → format 缺省 der（?? "/" 分支：继续走装配态而非 400）', () => {
    const route = buildCaCertRoutes({
      loadCertificate: (format: "der" | "pem") =>
        loadDownloadableCertificate({ selfSignedDir: home }, format),
    })[0];
    let status = 0;
    const chunks: Buffer[] = [];
    const res = {
      writeHead: (c: number) => {
        status = c;
      },
      end: (c?: unknown) => {
        if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
      },
    } as unknown as ServerResponse;
    const req = {
      method: "GET",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:3080" },
    } as unknown as IncomingMessage;
    route.handler(req, res);
    expect(status).toBe(404);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8")).error.code).toBe("ca-unconfigured");
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
    let replaced: Record<string, unknown> | null = null;
    const deps = {
      resolve: () => ({}),
      readUser: () => ({ user: { tlsCaCertFile: "/old/ca.pem", port: 3000 }, revision: 7 }),
      writable: () => true,
      update: async () => {},
      replace: async (s: Record<string, unknown>) => {
        replaced = s;
      },
      compress: () => ({}),
    };
    const r = await applyConfigPatch(deps as unknown as ConfigRouteDeps, {
      patch: { tlsCaCertFile: "" },
      expectedRevision: 7,
    });
    expect(r.ok).toBe(true);
    expect("tlsCaCertFile" in (replaced as unknown as Record<string, unknown>)).toBe(false);
    expect((replaced as unknown as Record<string, unknown>).port).toBe(3000);
  });
  it("单清 CA 不连带删叶子（P1 回归）", async () => {
    let replaced: Record<string, unknown> | null = null;
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
      replace: async (s: Record<string, unknown>) => {
        replaced = s;
      },
      compress: () => ({}),
    };
    const r = await applyConfigPatch(deps as unknown as ConfigRouteDeps, {
      patch: { tlsCaCertFile: "" },
      expectedRevision: 7,
    });
    expect(r.ok).toBe(true);
    expect("tlsCaCertFile" in (replaced as unknown as Record<string, unknown>)).toBe(false);
    expect((replaced as unknown as Record<string, unknown>).tlsCertFile).toBe("/c.pem");
    expect((replaced as unknown as Record<string, unknown>).tlsKeyFile).toBe("/k.pem");
    expect((replaced as unknown as Record<string, unknown>).port).toBe(3000);
  });
});

/**
 * apply 接线 helpers（模块级：供本文件多个 describe 共用；fake ctx 收口到宿主
 * Context 类型（单点适配；行为不断言 ctx 形态）。
 */
function runApply(entry: Record<string, unknown>) {
  const routes: WebRoute[] = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: {
      port: 3801,
      register(r: WebRoute) {
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
    effect(fn: () => unknown) {
      return fn();
    },
  };
  apply(ctx as unknown as Context, { enabled: false, httpsEnabled: false, ...entry });
  return routes;
}
function callHealth(routes: WebRoute[]) {
  const route = routes.find((r: WebRoute) => r.path === ROUTES.health);
  if (route === undefined) throw new Error("health route missing");
  let text = "";
  const req = {
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3801" },
    url: ROUTES.health,
  } as unknown as IncomingMessage;
  const res = {
    writeHead() {},
    end(c?: unknown) {
      text = String(c);
    },
  } as unknown as ServerResponse;
  route.handler(req, res);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("apply 接线", () => {
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

describe("apply 装配层默认与守卫（entry 段补强）", () => {
  it("空 entry health 默认值快照（resolve 单一来源）", () => {
    const health = callHealth(runApply({}));
    expect(health.httpPort).toBe(3081);
    // runApply 为免真实监听强制 httpsEnabled: false（harness 口径，非产品默认）。
    expect(health.httpsEnabled).toBe(false);
    expect(health.httpsPort).toBe(3443);
    expect(health.listening).toBe(false);
    expect(health.ownsHostCompat).toBe(false);
    expect(health.wsBridgeEnabled).toBe(true);
    expect(health.wsCompressEnabled).toBe(true);
    expect(health.wsCompressPaths).toEqual(["/api/remote.mux"]);
    expect(health.connStats).toBe(null);
  });

  it("空串 CA 路径 health caConfigured 为 false（非空判定双条件）", () => {
    expect(callHealth(runApply({ tlsCaCertFile: "" })).caConfigured).toBe(false);
  });

  it("空 entry GET /config effective 默认值（host/目标/压缩/令牌开关）", () => {
    const route = runApply({}).find((r) => r.path === ROUTES.config);
    if (route === undefined) throw new Error("config route missing");
    let text = "";
    const req = {
      method: "GET",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:3801" },
      url: ROUTES.config,
    } as unknown as IncomingMessage;
    const res = {
      writeHead() {},
      end(c?: unknown) {
        text = String(c);
      },
    } as unknown as ServerResponse;
    route.handler(req, res);
    const body = JSON.parse(text) as {
      effective: Record<string, unknown>;
      compress: Record<string, unknown>;
    };
    expect(body.effective.host).toBe("0.0.0.0");
    expect(body.effective.targetHost).toBe("127.0.0.1");
    expect(body.effective.printBanner).toBe(true);
    expect(body.effective.wsDeflatePolicy).toEqual({
      browser: true,
      uaDeny: ["iPhone", "iPad", "iPod"],
    });
    expect(body.effective.httpCompressEnabled).toBe(true);
    expect(body.effective.httpCompressLevel).toBe(1);
    expect(body.effective.injectToken).toBe(true);
    expect(body.compress.httpCompressMounted).toBe(false);
  });

  it("health 非 GET 405（方法白名单）", () => {
    const route = runApply({}).find((r: WebRoute) => r.path === ROUTES.health);
    if (route === undefined) throw new Error("health route missing");
    let status = 0;
    const req = {
      method: "POST",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:3801" },
      url: ROUTES.health,
    } as unknown as IncomingMessage;
    const res = {
      writeHead: (c: number) => {
        status = c;
      },
      end() {},
    } as unknown as ServerResponse;
    route.handler(req, res);
    expect(status).toBe(405);
  });

  it("health 非回环 403（先于 405）", () => {
    const route = runApply({}).find((r: WebRoute) => r.path === ROUTES.health);
    if (route === undefined) throw new Error("health route missing");
    let status = 0;
    const req = {
      method: "GET",
      socket: { remoteAddress: "192.168.31.99" },
      headers: { host: "192.168.31.99:3801" },
      url: ROUTES.health,
    } as unknown as IncomingMessage;
    const res = {
      writeHead: (c: number) => {
        status = c;
      },
      end() {},
    } as unknown as ServerResponse;
    route.handler(req, res);
    expect(status).toBe(403);
  });

  it("装配经 apply 的下发路由可服务托管 CA（闭包接线非直连）", () => {
    const dir = mkdtempSync(join(home, "wired-"));
    const mat = ensureSelfSignedTls({ dir });
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, mat.cert);
    const route = runApply({ tlsCaCertFile: caFile }).find((r) => r.path === ROUTES.caCert);
    if (route === undefined) throw new Error("ca-cert route missing");
    let status = 0;
    const chunks: Buffer[] = [];
    const req = {
      method: "GET",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:3801" },
      url: ROUTES.caCert,
    } as unknown as IncomingMessage;
    const res = {
      writeHead: (c: number) => {
        status = c;
      },
      end: (c?: unknown) => {
        if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
      },
    } as unknown as ServerResponse;
    route.handler(req, res);
    expect(status).toBe(200);
    expect(Buffer.concat(chunks)[0]).toBe(0x30);
  });

  it("旧目录托管 CA 随 apply 迁出（装配清单含 MANAGED 四件套）", () => {
    mkdirSync(join(home, "lan-proxy"), { recursive: true });
    writeFileSync(join(home, "lan-proxy", "ca-cert.pem"), "CA");
    runApply({});
    expect(existsSync(join(home, "@wingsky-1", "dsh-lan-proxy", "ca-cert.pem"))).toBe(true);
    expect(existsSync(join(home, "lan-proxy", "ca-cert.pem"))).toBe(false);
  });

  it("路由 disposer 全部执行（卸载不残留注册）", () => {
    const routes: WebRoute[] = [];
    const disposed: string[] = [];
    const effects: Array<() => void> = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: {
        port: 3801,
        register(route: WebRoute) {
          routes.push(route);
          const path = route.path;
          return () => {
            disposed.push(path);
          };
        },
        tapIndex() {
          return () => {};
        },
        on() {
          return () => {};
        },
      },
      inject() {},
      effect(fn: () => unknown) {
        const d = fn();
        if (typeof d === "function") effects.push(d as () => void);
        return d;
      },
    };
    apply(ctx as unknown as Context, { enabled: false, httpsEnabled: false });
    expect(routes.length).toBeGreaterThan(0);
    for (const dispose of [...effects].reverse()) dispose();
    expect(disposed).toContain(ROUTES.health);
    expect(disposed).toContain(ROUTES.config);
    expect(disposed).toContain(ROUTES.caCert);
    expect(disposed).toContain(ROUTES.caGenerate);
  });

  it("health disposer 抛错不阻断卸载（生命周期 try/catch）", () => {
    const effects: Array<() => void> = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: {
        port: 3801,
        register(route: WebRoute) {
          return () => {
            if (route.path === ROUTES.health) throw new Error("staged dispose failure");
          };
        },
        tapIndex() {
          return () => {};
        },
        on() {
          return () => {};
        },
      },
      inject() {},
      effect(fn: () => unknown) {
        const d = fn();
        if (typeof d === "function") effects.push(d as () => void);
        return d;
      },
    };
    apply(ctx as unknown as Context, { enabled: false, httpsEnabled: false });
    // 生命周期 effect 最后注册：仅调用它（路由级 disposer 本就向调用方抛错，
    // 被保护的只是生命周期内的 healthDisposer 调用）。
    const lifecycle = effects[effects.length - 1];
    expect(() => lifecycle()).not.toThrow();
  });

  it("webServer 无绑定端口 + enabled → 不建转发器（listening false，不抛）", () => {
    const routes: WebRoute[] = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: {
        register(route: WebRoute) {
          routes.push(route);
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
      effect(fn: () => unknown) {
        return fn();
      },
    };
    let listening: unknown;
    expect(() => {
      apply(ctx as unknown as Context, { enabled: true, port: 0, httpsEnabled: false });
      const route = routes.find((r) => r.path === ROUTES.health);
      if (route === undefined) throw new Error("health route missing");
      let text = "";
      const req = {
        method: "GET",
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3801" },
        url: ROUTES.health,
      } as unknown as IncomingMessage;
      const res = {
        writeHead() {},
        end(c?: unknown) {
          text = String(c);
        },
      } as unknown as ServerResponse;
      route.handler(req, res);
      listening = (JSON.parse(text) as Record<string, unknown>).listening;
    }).not.toThrow();
    expect(listening).toBe(false);
  });
});
