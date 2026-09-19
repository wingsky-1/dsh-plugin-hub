/**
 * dsh-mcp-manager — unit：GET /servers 只读投影与回写链锁定（#770-A3）。
 *
 * 用户裁决：manager.summarize 两分支不再明文下发 server（含 env/headers/url）。
 * - env/headers 敏感值整体省略（字段缺省，不用 "[REDACTED]" 占位符；有无秘密只经
 *   hasSecrets 布尔告知 GUI）；
 * - url 按 B8 仅脱敏 userinfo/searchParams（host/path/查询键保留）；
 * - 写路径（add/update）永不消费投影值（缺键即沿用既有，占位符 URL 丢弃/新建抛错）。
 *
 * 覆盖：
 * - 两分支投影：fallback（stopped/disabled）与 connected 分支均无明文、无 env/headers
 *   占位符，hasSecrets 置位正确，URL host/path 保留而 userinfo/查询值被抹；
 * - 无秘密时 hasSecrets 为 false 且字段缺省无害；
 * - 回写链：投影整体喂给 update 时既有秘密与原 URL 不变、盘上无占位符；
 *   add 含占位符时抛错（新建无既有可保）。
 *   （客户端 guard 见 test/client-unit/unit-summary-a3-guard.test.ts：I8① 禁 unit 层值引
 *   src/client，isProjectionValue 的两形态锁在 client-unit 层直连源码断言。）
 *
 * 消费者核查：
 * GET/POST/PATCH/DELETE/session/resume/connect/tool-disable 的响应 summary 均经
 * manager.summary()（已投影）；#770-L3 起 POST/PATCH 响应中的 server 字段亦经
 * manager.summarize 投影（不再明文回显写路径原文，与 A3 同一红线伞；锁见
 * test/unit/unit-routes-a2.test.ts 的 L3 面）；
 * src/index.ts getStatus/list 直转 summary（自动得投影，无需改代码）；
 * 客户端 beginEdit→fillForm→readForm→saveForm→PATCH 链由 fillForm 省略语义 +
 * saveForm 省略占位符 URL + 宿主 stripProjectionPatch 三道锁（本文件锁后两道，
 * fillForm 省略由 saveForm/宿主单测间接覆盖）。
 *
 * 凭据全为虚构测试串；落盘仅进 mkdtempSync 隔离目录；离线。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/server/config/interface.ts";
import * as configModelApi from "../../src/server/config/interface.ts";
import * as pipelineApi from "../../src/server/pipeline/interface.ts";
import * as catalogApi from "../../src/server/catalog/interface.ts";
import * as configStoreApi from "../../src/server/store/interface.ts";
import * as statsApi from "../../src/server/stats/interface.ts";
import { McpStore } from "../../src/server/store/interface.ts";
import {
  installOrchestrator,
  releaseOrchestrator,
  McpManager,
} from "../../src/server/connection/orchestrator/interface.ts";
import { fakeManagerCtx } from "../helpers.ts";

const SECRET_ENV = "a3-fake-env-secret-X1y2Z3";
const SECRET_HEADER = "a3-fake-header-secret-A4b5C6";
const SECRET_USER = "a3-fake-url-user-D7e8F9";
const SECRET_PASS = "a3-fake-url-pass-G1h2I3";
const SECRET_QUERY = "a3-fake-query-secret-J4k5L6";

let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  try {
    releaseOrchestrator();
  } catch {
    // 未装配忽略
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function installPorts(): void {
  installOrchestrator({
    catalog: catalogApi,
    configModel: configModelApi,
    configStore: configStoreApi,
    runtime: {} as never,
    lifecycle: {} as never,
    pipeline: pipelineApi,
    stats: statsApi,
    workspace: {} as never,
    upgrade: {} as never,
  });
}

function stdioSecret(name: string): ServerConfig {
  return {
    name,
    transport: "stdio",
    command: "echo",
    enabled: false,
    env: { HIDDEN_TOKEN: SECRET_ENV },
  } as unknown as ServerConfig;
}

function httpSecret(name: string): ServerConfig {
  return {
    name,
    transport: "streamable-http",
    enabled: false,
    url: `https://${SECRET_USER}:${SECRET_PASS}@example.com:8080/mcp/path?token=${SECRET_QUERY}&plain=1`,
    headers: { Authorization: `Bearer ${SECRET_HEADER}` },
  } as unknown as ServerConfig;
}

function managerWith(servers: ServerConfig[]): InstanceType<typeof McpManager> {
  const dir = makeTempDir("dsh-mcp-a3-");
  const store = new McpStore(join(dir, "global.json"));
  store.data = { version: 1, servers } as unknown as McpStore["data"];
  return new McpManager(fakeManagerCtx(), store as never) as InstanceType<typeof McpManager>;
}

describe("#770-A3 只读投影（fallback 分支）", () => {
  it("stdio：env 省略无占位符，hasSecrets 为 true", () => {
    installPorts();
    const manager = managerWith([stdioSecret("s-stdio")]);
    const out = manager.summarize(stdioSecret("s-stdio"), "global") as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET_ENV);
    expect(out.env).toBeUndefined();
    expect(text).not.toContain("[REDACTED]");
    expect(out.hasSecrets).toBe(true);
    expect(out.command).toBe("echo");
    expect(out.status).toBe("disabled");
  });

  it("http：headers 省略，url 仅脱敏 userinfo/查询值且 host/path 保留", () => {
    installPorts();
    const manager = managerWith([httpSecret("s-http")]);
    const out = manager.summarize(httpSecret("s-http"), "global") as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET_HEADER);
    expect(text).not.toContain(SECRET_USER);
    expect(text).not.toContain(SECRET_PASS);
    expect(text).not.toContain(SECRET_QUERY);
    expect(out.headers).toBeUndefined();
    expect(out.hasSecrets).toBe(true);
    const url = String(out.url ?? "");
    expect(url).toContain("[REDACTED]");
    expect(url).toContain("example.com:8080");
    expect(url).toContain("/mcp/path");
    // B8 口径：全部查询值均视为秘密（与 pipeline.createRedactor 同口径），
    // 查询键保留可诊断、值一律脱敏——非秘密查询值被一并脱敏属预期。
    expect(url).toContain("token=[REDACTED]");
    expect(url).toContain("plain=[REDACTED]");
  });

  it("无秘密：hasSecrets 为 false，缺键无害", () => {
    installPorts();
    const plain = {
      name: "plain",
      transport: "stdio",
      command: "echo",
      enabled: false,
    } as unknown as ServerConfig;
    const manager = managerWith([plain]);
    const out = manager.summarize(plain, "global") as Record<string, unknown>;
    expect(out.hasSecrets).toBe(false);
    expect(out.env).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("[REDACTED]");
  });
});

describe("#770-A3 只读投影（connected 分支同样投影）", () => {
  it("池内条目分支亦省略秘密（状态经投影取，不影响秘密面）", () => {
    installPorts();
    const server = stdioSecret("s-conn");
    const manager = managerWith([server]);
    // 最小池桩：unit + entry 命中 connected 分支（目录无条目 → tools 为空）。
    (manager as unknown as { middleware: unknown }).middleware = {
      units: new Map([
        ["@global", { root: "@global", connections: new Map([["s-conn", { error: undefined }]]) }],
      ]),
      statusOf: () => "connected",
    };
    (manager as unknown as { disabledTools: Map<string, Map<string, Set<string>>> }).disabledTools =
      new Map();
    const out = manager.summarize(server, "global") as Record<string, unknown>;
    expect(out.status).toBe("connected");
    expect(JSON.stringify(out)).not.toContain(SECRET_ENV);
    expect(out.env).toBeUndefined();
    expect(out.hasSecrets).toBe(true);
  });
});

describe("#770-A3 回写链锁定（投影值永不进入写路径）", () => {
  it("投影整体喂给 update 时既有秘密与原 URL 不变、盘上无占位符", async () => {
    installPorts();
    const server = httpSecret("s-wb");
    const manager = managerWith([server]);
    const projection = manager.summarize(server, "global") as Record<string, unknown>;
    expect(String(projection.url ?? "")).toContain("[REDACTED]");
    const merged = await manager.update("s-wb", projection, "global");
    expect((merged as unknown as ServerConfig).url).toBe(server.url);
    expect((merged as unknown as ServerConfig).headers).toEqual(server.headers);
    const stored = (manager.store.find("s-wb") as unknown as ServerConfig | undefined)!;
    expect(stored.url).toBe(server.url);
    expect(stored.headers).toEqual(server.headers);
    expect(JSON.stringify(stored)).not.toContain("[REDACTED]");
  });

  it("stdio 投影（缺 env 键）update 时沿用既有 env", async () => {
    installPorts();
    const server = stdioSecret("s-wb-stdio");
    const manager = managerWith([server]);
    const projection = manager.summarize(server, "global") as Record<string, unknown>;
    expect(projection.env).toBeUndefined();
    const merged = await manager.update("s-wb-stdio", projection, "global");
    expect((merged as unknown as ServerConfig).env).toEqual(server.env);
  });

  it("add 含占位符 URL 时抛错（新建无既有可保）", async () => {
    installPorts();
    const manager = managerWith([]);
    await expect(
      manager.add(
        {
          name: "new-http",
          transport: "streamable-http",
          url: "https://[REDACTED]@example.com/mcp",
        },
        "global",
      ),
    ).rejects.toThrow(/REDACTED/);
  });

  it("summary() 全量无明文（含 runtime 条目亦投影）", () => {
    installPorts();
    const manager = managerWith([stdioSecret("g1")]);
    (manager as unknown as { runtimeRegistry: Map<string, ServerConfig> }).runtimeRegistry.set(
      "rt1",
      httpSecret("rt1"),
    );
    const summary = manager.summary() as unknown as { servers: Array<Record<string, unknown>> };
    const text = JSON.stringify(summary);
    expect(text).not.toContain(SECRET_ENV);
    expect(text).not.toContain(SECRET_HEADER);
    expect(text).not.toContain(SECRET_USER);
    expect(text).not.toContain(SECRET_PASS);
    expect(text).not.toContain(SECRET_QUERY);
    // env/headers 面无占位符（省略语义）；url 脱敏占位符是预期内的唯一占位符。
    for (const entry of summary.servers) {
      expect(entry.env).toBeUndefined();
      expect(entry.headers).toBeUndefined();
    }
  });
});

// I8①：客户端 guard（isProjectionValue 两形态）已迁
// test/client-unit/unit-summary-a3-guard.test.ts直连 src/client 断言，本层不再值引 src/client。

describe("#770-L4 错误面显示侧脱敏（settled 原文可含凭据）", () => {
  function poolWith(name: string, status: string, error: unknown): unknown {
    return {
      units: new Map([["@global", { root: "@global", connections: new Map([[name, { error }]]) }]]),
      statusOf: () => status,
    };
  }

  function managerWithPool(
    server: ServerConfig,
    status: string,
    error: unknown,
  ): InstanceType<typeof McpManager> {
    installPorts();
    const manager = managerWith([server]);
    (manager as unknown as { middleware: unknown }).middleware = poolWith(
      server.name,
      status,
      error,
    );
    (manager as unknown as { disabledTools: Map<string, Map<string, Set<string>>> }).disabledTools =
      new Map();
    return manager;
  }

  it("failed：settled 原文含 stdio 秘密时 error 被脱敏", () => {
    const server = stdioSecret("s-err");
    const raw = `连接超时（10000ms）：官方实例保留不 dispose，仍在后台退避重连；官方日志：connection attempt failed: ${SECRET_ENV}`;
    const manager = managerWithPool(server, "failed", raw);
    const out = manager.summarize(server, "global") as Record<string, unknown>;
    expect(out.status).toBe("failed");
    const text = String(out.error ?? "");
    expect(text).not.toContain(SECRET_ENV);
    expect(text).toContain("[REDACTED]");
  });

  it("connected 携 stale failed 文案时同样脱敏（状态与错因分源）", () => {
    const server = stdioSecret("s-err");
    const raw = `首连失败已结算；官方日志：connection attempt failed: ${SECRET_ENV}`;
    const manager = managerWithPool(server, "connected", raw);
    const out = manager.summarize(server, "global") as Record<string, unknown>;
    expect(out.status).toBe("connected");
    const text = String(out.error ?? "");
    expect(text).not.toContain(SECRET_ENV);
    expect(text).toContain("[REDACTED]");
  });

  it("http 形态秘密（header/url 值）在 error 中亦被抹", () => {
    const server = httpSecret("s-err-http");
    const raw = `connection failed: fetch ${server.url} with header Bearer ${SECRET_HEADER} (user ${SECRET_USER})`;
    const manager = managerWithPool(server, "failed", raw);
    const out = manager.summarize(server, "global") as Record<string, unknown>;
    const text = String(out.error ?? "");
    expect(text).not.toContain(SECRET_HEADER);
    expect(text).not.toContain(SECRET_USER);
    expect(text).not.toContain(SECRET_PASS);
    expect(text).not.toContain(SECRET_QUERY);
    expect(text).toContain("[REDACTED]");
  });

  it("无 error 时 error 仍为 undefined（脱敏不注入占位符）", () => {
    const server = stdioSecret("s-err");
    const manager = managerWithPool(server, "failed", undefined);
    const out = manager.summarize(server, "global") as Record<string, unknown>;
    expect(out.error).toBeUndefined();
  });
});

describe("#925 展示侧 args 脱敏（凭据形 flag 值掩码）", () => {
  const ARG_SECRET = "a925-fake-arg-secret-Q1w2E3";

  function argsServer(args: string[]): ServerConfig {
    return {
      name: "s-args",
      transport: "stdio",
      command: "echo",
      enabled: false,
      args,
    } as unknown as ServerConfig;
  }

  it("独立元素与等号形态的值被掩码，flag 名保留", () => {
    installPorts();
    const manager = managerWith([argsServer(["-y", "--token", ARG_SECRET, `--key=${ARG_SECRET}`])]);
    const out = manager.summarize(
      argsServer(["-y", "--token", ARG_SECRET, `--key=${ARG_SECRET}`]),
      "global",
    ) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain(ARG_SECRET);
    expect(out.args).toEqual(["-y", "--token", "[REDACTED]", "--key=[REDACTED]"]);
    expect(out.hasSecrets).toBe(true);
  });

  it("短 flag 下一拍与非秘密元素：掩码与保留并存，空值不掩", () => {
    installPorts();
    const manager = managerWith([argsServer(["-p", ARG_SECRET, "--turkey", "big", "--token="])]);
    const out = manager.summarize(
      argsServer(["-p", ARG_SECRET, "--turkey", "big", "--token="]),
      "global",
    ) as Record<string, unknown>;
    expect(out.args).toEqual(["-p", "[REDACTED]", "--turkey", "big", "--token="]);
    expect(JSON.stringify(out)).not.toContain(ARG_SECRET);
  });

  it("无秘密 args：原样下发且 hasSecrets 为 false", () => {
    installPorts();
    const manager = managerWith([argsServer(["-y", "pkg"])]);
    const out = manager.summarize(argsServer(["-y", "pkg"]), "global") as Record<string, unknown>;
    expect(out.args).toEqual(["-y", "pkg"]);
    expect(out.hasSecrets).toBe(false);
  });

  it("投影整体回写 update 时既有 args 不变、盘上无占位符", async () => {
    installPorts();
    const server = argsServer(["--token", ARG_SECRET]);
    const manager = managerWith([server]);
    const projection = manager.summarize(server, "global") as Record<string, unknown>;
    expect(JSON.stringify(projection.args)).toContain("[REDACTED]");
    const merged = await manager.update("s-args", projection, "global");
    expect((merged as unknown as ServerConfig).args).toEqual(["--token", ARG_SECRET]);
    const stored = manager.store.find("s-args") as unknown as ServerConfig | undefined;
    expect(stored?.args).toEqual(["--token", ARG_SECRET]);
  });

  it("add 含占位符 args 时抛错", async () => {
    installPorts();
    const manager = managerWith([]);
    await expect(
      manager.add(
        { name: "new-args", transport: "stdio", command: "echo", args: ["--token", "[REDACTED]"] },
        "global",
      ),
    ).rejects.toThrow(/REDACTED/);
  });
});
