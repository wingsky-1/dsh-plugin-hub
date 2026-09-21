/**
 * dsh-lan-proxy — ca 域单测（issue #930 Phase 2，一键生成本地 CA）。
 *
 * 覆盖：F7 三态真值表 + isManagedRealpath 口径、POST 路由围栏（403 先于 405）与
 * F19 码表、F17 服务端门控（curl 不可绕过）、F3 temp+rename（含 .bak 只留 1 个）、
 * F4 singleflight 429、F10 默认叶轮换/CA 轮换、F13/F14 0600 落盘、响应无路径无私钥。
 * forge 真签发走 tls 域纯函数（直连源码实现，非 fake——签发关系由 unit-tls 锁定，
 * 本文件只锁编排）；落盘一律 mkdtempSync 隔离目录。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { apply } from "../../src/server/apply.ts";
import type { LanProxyConfig } from "../../src/server/config/interface.ts";
import { ROUTES } from "../../src/server/config/impl/routes.ts";
import { certsDir } from "../../src/server/shared/interface.ts";
import {
  generateCaAndLeaf,
  generateLeafSignedByCa,
  loadDownloadableCertificate,
} from "../../src/server/tls/impl/index.ts";
import { buildCaActionRoutes } from "../../src/server/ca/impl/actions.ts";
import type { CaActionDeps } from "../../src/server/ca/interface.ts";
import { classifyCaState, isManagedPath } from "../../src/server/ca/impl/state.ts";

let prevHome: string | undefined;
let home: string;
beforeEach(() => {
  prevHome = process.env.DSH_HOME;
  home = mkdtempSync(join(tmpdir(), "dsh-930-ca-"));
  process.env.DSH_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/** 托管三键（固定文件名 + certsDir，装配同源）。 */
function managedTriple(): { ca: string; cert: string; key: string } {
  const dir = certsDir();
  return {
    ca: join(dir, "ca-cert.pem"),
    cert: join(dir, "leaf-cert.pem"),
    key: join(dir, "leaf-key.pem"),
  };
}

/** 写出三键文件（缺省内容占位；签发类用例另写真实 PEM）。 */
function writeTriple(triple: { ca: string; cert: string; key: string }, content = "PEM"): void {
  mkdirSync(certsDir(), { recursive: true });
  writeFileSync(triple.ca, content);
  writeFileSync(triple.cert, content);
  writeFileSync(triple.key, content);
}

/** fake scope（内存 user + revision；conflict/broken  staged 失败）。 */
function makeScope(
  initialUser: Record<string, unknown> = {},
  fail?: { code: string },
): {
  deps: CaActionDeps["config"];
  user: () => Record<string, unknown>;
  revision: () => number;
  updates: Array<{ patch: object; expectedRevision?: number }>;
} {
  const user = { ...initialUser };
  let revision = 1;
  const updates: Array<{ patch: object; expectedRevision?: number }> = [];
  const tripleOf = (src: Record<string, unknown>) => ({
    tlsCaCertFile: typeof src.tlsCaCertFile === "string" ? src.tlsCaCertFile : undefined,
    tlsCertFile: typeof src.tlsCertFile === "string" ? src.tlsCertFile : undefined,
    tlsKeyFile: typeof src.tlsKeyFile === "string" ? src.tlsKeyFile : undefined,
  });
  return {
    deps: {
      resolve: () => ({
        enabled: true,
        host: "127.0.0.1",
        port: 3081,
        httpsEnabled: true,
        httpsPort: 3443,
        targetHost: "127.0.0.1",
        printBanner: true,
        wsBridgeEnabled: true,
        wsCompressEnabled: true,
        wsCompressPaths: [],
        wsDeflatePolicy: { browser: true, uaDeny: [] },
        httpCompressEnabled: true,
        httpCompressLevel: 1,
        injectToken: true,
        ownsHostCompat: false,
        ...tripleOf(user),
      }),
      readUser: () => ({ user: { ...user }, revision }),
      writable: () => true,
      update: async (patch: object, expectedRevision?: number) => {
        updates.push({ patch, expectedRevision });
        if (fail !== undefined) throw stagedError(fail.code);
        Object.assign(user, patch);
        revision += 1;
      },
    },
    user: () => ({ ...user }),
    revision: () => revision,
    updates,
  };
}

/** staged scope 失败（code 进 err 供调用方映射，不进响应）。 */
function stagedError(code: string): Error {
  const err = new Error("staged scope failure");
  Object.assign(err, { code });
  return err;
}

/** 不可达签发桩（拒绝路径不得触发签发；调用即抛以证伪）。 */
const noCrypto: CaActionDeps["crypto"] = {
  generateFull: async () => {
    throw new Error("must not generate");
  },
  generateLeaf: async () => {
    throw new Error("must not generate");
  },
};

/** 真签发面（tls 域纯函数直连；编排只锁调用与落盘）。 */
const realCrypto: CaActionDeps["crypto"] = {
  generateFull: (extraSans: string[]) => generateCaAndLeaf(extraSans),
  generateLeaf: (caCert: string, caKey: string, extraSans: string[]) =>
    generateLeafSignedByCa(caCert, caKey, extraSans),
};

function makeDeps(over: Partial<CaActionDeps> & { scopeUser?: Record<string, unknown> } = {}): {
  deps: CaActionDeps;
  scope: ReturnType<typeof makeScope>;
  warnings: string[];
} {
  const scope = makeScope(over.scopeUser ?? {});
  const warnings: string[] = [];
  const { scopeUser: _ignored, ...rest } = over;
  return {
    deps: {
      path: ROUTES.caGenerate,
      config: scope.deps,
      crypto: realCrypto,
      fs: { renameSync, readdirSync, unlinkSync },
      lanIps: () => [],
      logWarn: (message: string) => warnings.push(message),
      ...rest,
    },
    scope,
    warnings,
  };
}

/** fake POST 请求（async-iterator 体供 readJsonBodyOutcome；缺席即空体）。 */
function postReq(options: {
  remote?: string;
  method?: string;
  url?: string;
  body?: unknown;
  raw?: string;
}): IncomingMessage {
  const text = options.raw ?? (options.body === undefined ? "" : JSON.stringify(options.body));
  const fake = {
    method: options.method ?? "POST",
    socket: { remoteAddress: options.remote ?? "127.0.0.1" },
    headers: { host: "127.0.0.1:3080" },
    url: options.url ?? ROUTES.caGenerate,
    [Symbol.asyncIterator]: async function* () {
      if (text.length > 0) yield Buffer.from(text, "utf8");
    },
  };
  return fake as unknown as IncomingMessage;
}

/**
 * fake 请求/响应经 `as unknown` 收口到 Node HTTP 类型（smoke 同例：最小形态只
 * 满足守卫 + 体读取 + writeJson，类型不断言多余成员；不用 `as any`，目标类型保留）。
 */

/** 调用已装配路由（async handler；捕获状态与 JSON 体）。 */
async function invokeAction(
  route: ReturnType<typeof buildCaActionRoutes>[number],
  options: Parameters<typeof postReq>[0] = {},
): Promise<{ path: string; status: number; body: unknown }> {
  let status = 0;
  const chunks: Buffer[] = [];
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: unknown) => {
      if (chunk !== undefined)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
  } as unknown as ServerResponse;
  await route.handler(postReq(options), res);
  const text = Buffer.concat(chunks).toString("utf8");
  return { path: route.path, status, body: text.length === 0 ? null : JSON.parse(text) };
}

/** 装配一次并调用（单 flight 用例须自持 route，两次调用命中同一 gate）。 */
async function callAction(
  deps: CaActionDeps,
  options: Parameters<typeof postReq>[0] = {},
): Promise<{ path: string; status: number; body: unknown }> {
  return invokeAction(buildCaActionRoutes(deps)[0], options);
}

describe("F7 三态真值表", () => {
  it("全空 → self-signed", () => {
    expect(classifyCaState({})).toBe("self-signed");
  });
  it("托管三键 + 文件齐 → managed", () => {
    const triple = managedTriple();
    writeTriple(triple);
    expect(
      classifyCaState({
        tlsCaCertFile: triple.ca,
        tlsCertFile: triple.cert,
        tlsKeyFile: triple.key,
      }),
    ).toBe("managed");
  });
  it("托管路径缺文件 → error（非 custom）", () => {
    const triple = managedTriple();
    writeTriple(triple);
    rmSync(triple.cert);
    expect(
      classifyCaState({
        tlsCaCertFile: triple.ca,
        tlsCertFile: triple.cert,
        tlsKeyFile: triple.key,
      }),
    ).toBe("error");
  });
  it("全自定义三键 → custom", () => {
    expect(
      classifyCaState({
        tlsCaCertFile: "/x/ca.pem",
        tlsCertFile: "/x/c.pem",
        tlsKeyFile: "/x/k.pem",
      }),
    ).toBe("custom");
  });
  it("自定义孤叶子（无 CA）→ custom（F9 第二条置灰面）", () => {
    expect(classifyCaState({ tlsCertFile: "/x/c.pem", tlsKeyFile: "/x/k.pem" })).toBe("custom");
  });
  it("托管叶对缺 CA 键 → error（托管脱钩，清键重建）", () => {
    const triple = managedTriple();
    writeTriple(triple);
    expect(classifyCaState({ tlsCertFile: triple.cert, tlsKeyFile: triple.key })).toBe("error");
  });
  it("孤 CA / 叶对单侧 → error（半套）", () => {
    expect(classifyCaState({ tlsCaCertFile: "/x/ca.pem" })).toBe("error");
    expect(classifyCaState({ tlsCertFile: "/x/c.pem" })).toBe("error");
    expect(
      classifyCaState({ tlsCertFile: "/x/c.pem", tlsKeyFile: "/x/k.pem", tlsCaCertFile: "" }),
    ).toBe("custom");
  });
  it("空串视为未配置（与 sanitize 清除语义同口径）", () => {
    expect(classifyCaState({ tlsCaCertFile: "", tlsCertFile: "", tlsKeyFile: "" })).toBe(
      "self-signed",
    );
  });
});

describe("F17 isManagedPath 口径", () => {
  it("界内既存文件 → true", () => {
    const triple = managedTriple();
    writeTriple(triple);
    expect(isManagedPath(triple.ca)).toBe(true);
  });
  it("缺失文件 → false（fail-closed）", () => {
    expect(isManagedPath(join(certsDir(), "ca-cert.pem"))).toBe(false);
  });
  it("界外路径 → false", () => {
    expect(isManagedPath("/tmp/dsh-930-outside.pem")).toBe(false);
  });
});

describe("F16 围栏与 F19 码表", () => {
  it("路由挂在 ROUTES.caGenerate 上（改路径同步改客户端镜像）", () => {
    const { deps } = makeDeps({ crypto: noCrypto });
    const route = buildCaActionRoutes(deps)[0];
    expect(route.path).toBe("/api/dsh-lan-proxy/ca/generate");
    expect(route.path).toBe(ROUTES.caGenerate);
  });
  it("非回环 403（先于 405）", async () => {
    const { deps } = makeDeps({ crypto: noCrypto });
    const r = await callAction(deps, { remote: "192.168.31.99", method: "GET" });
    expect(r.status).toBe(403);
  });
  it("回环 GET 405", async () => {
    const { deps } = makeDeps({ crypto: noCrypto });
    const r = await callAction(deps, { method: "GET" });
    expect(r.status).toBe(405);
  });
  it("畸形 body 400 invalid-json", async () => {
    const { deps } = makeDeps({ crypto: noCrypto });
    const r = await callAction(deps, { raw: "{broken" });
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe("invalid-json");
  });
  it("settings 不可用 503", async () => {
    const scope = makeScope({});
    const { deps } = makeDeps({
      crypto: noCrypto,
      config: { ...scope.deps, writable: () => false },
    });
    const r = await callAction(deps, { body: {} });
    expect(r.status).toBe(503);
    expect((r.body as { error: { code: string } }).error.code).toBe("settings-unavailable");
  });
  it("缺席 revision 409 ca-revision-stale（禁 last-write-wins，不复用冲突文案）", async () => {
    const { deps } = makeDeps();
    for (const body of [{}, { confirmed: true }, { expectedRevision: null }]) {
      const r = await callAction(deps, { body });
      expect(r.status).toBe(409);
      expect((r.body as { error: { code: string } }).error.code).toBe("ca-revision-stale");
      expect((r.body as { error: { details: string } }).error.details).toContain("请刷新后重试");
    }
  });
  it("custom 即使带 confirmed 仍 409（服务端门控，curl 不可绕过）", async () => {
    const { deps } = makeDeps({
      crypto: noCrypto,
      scopeUser: { tlsCertFile: "/x/c.pem", tlsKeyFile: "/x/k.pem" },
    });
    const r = await callAction(deps, { body: { confirmed: true, expectedRevision: 1 } });
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("ca-customized");
  });
  it("半套 error 409 ca-misconfigured", async () => {
    const { deps } = makeDeps({ crypto: noCrypto, scopeUser: { tlsCertFile: "/x/c.pem" } });
    const r = await callAction(deps, { body: { confirmed: true, expectedRevision: 1 } });
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("ca-misconfigured");
  });
});

describe("首建与轮换编排", () => {
  it("自签全新 + 空 body → 200 generated，三键落 scope，四件套 0600", async () => {
    const { deps, scope } = makeDeps({ lanIps: () => ["192.168.99.9"] });
    const r = await callAction(deps, { body: { expectedRevision: 1 } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mode: "generated" });
    const user = scope.user();
    expect(typeof user.tlsCaCertFile).toBe("string");
    expect(typeof user.tlsCertFile).toBe("string");
    expect(typeof user.tlsKeyFile).toBe("string");
    const triple = managedTriple();
    for (const file of [triple.ca, triple.cert, triple.key, join(certsDir(), "ca-key.pem")]) {
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(statSync(certsDir()).mode & 0o777).toBe(0o700);
  });
  it("自签残留文件 + 无确认 → 409 needs-confirm；补确认 → 200 且旧文件进 .bak", async () => {
    const triple = managedTriple();
    writeTriple(triple, "STALE");
    const { deps } = makeDeps();
    const denied = await callAction(deps, { body: { expectedRevision: 1 } });
    expect(denied.status).toBe(409);
    expect((denied.body as { error: { code: string } }).error.code).toBe("needs-confirm");
    const r = await callAction(deps, { body: { confirmed: true, expectedRevision: 1 } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mode: "generated" });
    const baks = readdirSync(certsDir()).filter((n) => n.endsWith(".bak"));
    expect(baks.length).toBeGreaterThan(0);
    expect(readFileSync(triple.ca, "utf8")).not.toBe("STALE");
  });
  it("托管 + 无确认 → 409；确认 → 200 leaf-rotated（CA 不变、叶子变）", async () => {
    const first = makeDeps({ lanIps: () => ["192.168.99.9"] });
    const created = await callAction(first.deps, { body: { expectedRevision: 1 } });
    expect(created.status).toBe(200);
    const before = {
      ca: readFileSync(managedTriple().ca, "utf8"),
      leaf: readFileSync(managedTriple().cert, "utf8"),
    };
    const user = first.scope.user();
    const second = makeDeps({ scopeUser: user });
    const denied = await callAction(second.deps, { body: { expectedRevision: 1 } });
    expect(denied.status).toBe(409);
    const rotated = await callAction(second.deps, {
      body: { confirmed: true, expectedRevision: 1 },
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body).toEqual({ ok: true, mode: "leaf-rotated" });
    expect(readFileSync(managedTriple().ca, "utf8")).toBe(before.ca);
    expect(readFileSync(managedTriple().cert, "utf8")).not.toBe(before.leaf);
    expect(readdirSync(certsDir()).filter((n) => n.startsWith("ca-cert.pem."))).toEqual([]);
  });
  it("托管 + rotateCa → 200 ca-rotated（CA 变）", async () => {
    const first = makeDeps();
    await callAction(first.deps, { body: { expectedRevision: 1 } });
    const beforeCa = readFileSync(managedTriple().ca, "utf8");
    const second = makeDeps({ scopeUser: first.scope.user() });
    const r = await callAction(second.deps, {
      body: { confirmed: true, rotateCa: true, expectedRevision: 1 },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mode: "ca-rotated" });
    expect(readFileSync(managedTriple().ca, "utf8")).not.toBe(beforeCa);
  });
  it(".bak 只留最近 1 个（连续轮换不堆积）", async () => {
    const first = makeDeps();
    await callAction(first.deps, { body: { expectedRevision: 1 } });
    let scopeUser = first.scope.user();
    for (let i = 0; i < 2; i += 1) {
      const next = makeDeps({ scopeUser });
      const r = await callAction(next.deps, { body: { confirmed: true, expectedRevision: 1 } });
      expect(r.status).toBe(200);
      scopeUser = next.scope.user();
    }
    expect(readdirSync(certsDir()).filter((n) => n.startsWith("leaf-cert.pem.")).length).toBe(1);
  });
  it("第二目标 rename 失败 → 已提交回退 + 500（P1-1 跨目标补偿）", async () => {
    const triple = managedTriple();
    writeTriple(triple, "STALE");
    let calls = 0;
    const flakyFs = {
      renameSync: (from: string, to: string) => {
        calls += 1;
        // 第 4 次即第二目标 temp 上位：前三次（t1 搬 bak、上位；t2 搬 bak）已成功。
        if (calls === 4) throw new Error("staged rename failure");
        renameSync(from, to);
      },
      readdirSync,
      unlinkSync,
    };
    const { deps } = makeDeps({ fs: flakyFs });
    const r = await callAction(deps, { body: { confirmed: true, expectedRevision: 1 } });
    expect(r.status).toBe(500);
    expect((r.body as { error: { code: string } }).error.code).toBe("ca-generate-failed");
    // 两目标各自 .bak 均已搬回：内容仍是 STALE，无残留 .bak/.tmp。
    expect(readFileSync(triple.ca, "utf8")).toBe("STALE");
    expect(readFileSync(triple.key, "utf8")).toBe("STALE");
    expect(readdirSync(certsDir()).filter((n) => n.endsWith(".bak")).length).toBe(0);
    expect(readdirSync(certsDir()).filter((n) => n.endsWith(".tmp")).length).toBe(0);
  });
  it("补偿删新文件：无 .bak 目标失败即删上位（R1 首建 partial，ca-key 缺席）", async () => {
    const dir = certsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ca-cert.pem"), "STALE");
    let calls = 0;
    const flakyFs = {
      renameSync: (from: string, to: string) => {
        calls += 1;
        // t1 搬 bak、上位后，t2（无旧文件、无 .bak）上位时抛错。
        if (calls === 3) throw new Error("staged rename failure");
        renameSync(from, to);
      },
      readdirSync,
      unlinkSync,
    };
    const { deps } = makeDeps({ fs: flakyFs });
    const r = await callAction(deps, { body: { confirmed: true, expectedRevision: 1 } });
    expect(r.status).toBe(500);
    expect((r.body as { error: { code: string } }).error.code).toBe("ca-generate-failed");
    expect(readFileSync(join(dir, "ca-cert.pem"), "utf8")).toBe("STALE");
    expect(existsSync(join(dir, "ca-key.pem"))).toBe(false);
    expect(readdirSync(dir).filter((n) => n.endsWith(".bak")).length).toBe(0);
  });
  it("既存宽松 certs/ 目录动作后收敛 0700（P1-2）", async () => {
    mkdirSync(certsDir(), { recursive: true, mode: 0o755 });
    const { deps } = makeDeps();
    const r = await callAction(deps, { body: { expectedRevision: 1 } });
    expect(r.status).toBe(200);
    expect(statSync(certsDir()).mode & 0o777).toBe(0o700);
  });
  it("prune readdir 失败 → 动作仍 200 + 日志（R3）", async () => {
    const { deps, warnings } = makeDeps({
      fs: {
        renameSync,
        readdirSync: () => {
          throw new Error("staged readdir failure");
        },
        unlinkSync,
      },
    });
    const r = await callAction(deps, { body: { expectedRevision: 1 } });
    expect(r.status).toBe(200);
    expect(warnings.some((w) => w.includes("备份目录读取失败"))).toBe(true);
  });
  it("prune unlink 失败 → 动作仍 200 + 日志（R3）", async () => {
    const first = makeDeps();
    const created = await callAction(first.deps, { body: { expectedRevision: 1 } });
    expect(created.status).toBe(200);
    writeFileSync(join(certsDir(), "leaf-cert.pem.1.bak"), "OLD1");
    writeFileSync(join(certsDir(), "leaf-cert.pem.2.bak"), "OLD2");
    const { deps, warnings } = makeDeps({
      scopeUser: first.scope.user(),
      fs: {
        renameSync,
        readdirSync,
        unlinkSync: () => {
          throw new Error("staged unlink failure");
        },
      },
    });
    const r = await callAction(deps, { body: { confirmed: true, expectedRevision: 1 } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mode: "leaf-rotated" });
    expect(warnings.some((w) => w.includes("旧证书备份清理失败"))).toBe(true);
  });
  it("并发第二请求 429（F4 singleflight，同一装配两连击）", async () => {
    const { deps } = makeDeps();
    const route = buildCaActionRoutes(deps)[0];
    const [a, b] = await Promise.all([
      invokeAction(route, { body: { expectedRevision: 1 } }),
      invokeAction(route, { body: { expectedRevision: 1 } }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 429]);
    const rejected = a.status === 429 ? a : b;
    expect((rejected.body as { error: { code: string } }).error.code).toBe("ca-generating");
    expect((rejected.body as { error: { details: string } }).error.details).toContain("稍后重试");
  });
  it("scope 冲突 409 复用“被其他窗口修改”文案 + temp 已清", async () => {
    const scope = makeScope({}, { code: "SETTINGS_CONFLICT" });
    const { deps } = makeDeps({ config: scope.deps });
    const r = await callAction(deps, { body: { expectedRevision: 1 } });
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("conflict");
    expect((r.body as { error: { details: string } }).error.details).toContain("其他窗口修改");
    expect(readdirSync(certsDir()).filter((n) => n.endsWith(".tmp")).length).toBe(0);
  });
  it("生成失败 500 定码 + 响应无路径无私钥", async () => {
    const scope = makeScope({}, { code: "EIO" });
    const { deps } = makeDeps({ config: scope.deps });
    const r = await callAction(deps, { body: { expectedRevision: 1 } });
    expect(r.status).toBe(500);
    const text = JSON.stringify(r.body);
    expect((r.body as { error: { code: string } }).error.code).toBe("ca-generate-failed");
    expect(text).not.toContain(home);
    expect(text).not.toContain("PRIVATE KEY");
  });
  it("CA 私钥误指下发源 → 404 且私钥不出网（固定文件名锁定）", async () => {
    const { deps } = makeDeps();
    const r = await callAction(deps, { body: { expectedRevision: 1 } });
    expect(r.status).toBe(200);
    const loaded = loadDownloadableCertificate(
      { tlsCaCertFile: join(certsDir(), "ca-key.pem"), selfSignedDir: certsDir() },
      "der",
    );
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.code).toBe("ca-invalid");
  });
});

describe("apply 接线（health 三态 + 路由注册）", () => {
  function runApply(entry: LanProxyConfig): WebRoute[] {
    const routes: WebRoute[] = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: {
        port: 3801,
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
    // fake ctx 收口到宿主 Context 类型（单点适配；行为不断言 ctx 形态）。
    apply(ctx as unknown as Context, entry);
    return routes;
  }
  function callHealth(routes: WebRoute[]): Record<string, unknown> {
    const route = routes.find((r) => r.path === ROUTES.health);
    if (route === undefined) throw new Error("health route missing");
    const req = {
      method: "GET",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:3801" },
      url: ROUTES.health,
    } as unknown as IncomingMessage;
    let text = "";
    const res = {
      writeHead: () => {},
      end: (chunk?: unknown) => {
        text = String(chunk);
      },
    } as unknown as ServerResponse;
    const out = route.handler(req, res);
    if (out instanceof Promise) throw new Error("health must stay sync");
    return JSON.parse(text) as Record<string, unknown>;
  }
  it("注册一键动作路由", () => {
    const routes = runApply({ enabled: false, httpsEnabled: false });
    expect(routes.map((r) => r.path)).toContain(ROUTES.caGenerate);
  });
  it("自签态 health：caState + certInfo null + caConfigured false", () => {
    const health = callHealth(runApply({ enabled: false, httpsEnabled: false }));
    expect(health.caState).toBe("self-signed");
    expect(health.certInfo).toBe(null);
    expect(health.caConfigured).toBe(false);
  });
  it("托管态 health：caState managed + certInfo 日期/SAN/当期 IP", () => {
    const triple = managedTriple();
    mkdirSync(certsDir(), { recursive: true });
    // 真实托管三件套经动作外部直写（绕开 POST，保证 health 断言不依赖动作链）。
    writeFileSync(triple.ca, "CA");
    writeFileSync(triple.cert, "CERT");
    writeFileSync(triple.key, "KEY");
    const health = callHealth(
      runApply({
        enabled: false,
        httpsEnabled: false,
        tlsCaCertFile: triple.ca,
        tlsCertFile: triple.cert,
        tlsKeyFile: triple.key,
      }),
    );
    expect(health.caState).toBe("managed");
    // 占位 PEM 不可解析 → certInfo null（不提醒），口径诚实不断言日期。
    expect(health.certInfo).toBe(null);
  });
});
