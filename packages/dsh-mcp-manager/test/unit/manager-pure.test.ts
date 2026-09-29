/**
 * dsh-mcp-manager — unit：#732 复杂度整改为 manager.ts 新拆纯函数补的直接单测。
 *
 * 每条用例直连被拆函数（不经 manager 公开面），锁住拆解后才存在的判定：
 * 投影形状与键序、占位符回写 guard、目录数据源的同名覆盖、池同步的释放/变化口径。
 */
import { describe, expect, it, vi } from "vitest";
// CatalogServers 是 manager.ts 的模块内类型（未导出，属实现面）：按其源码定义
// （Map<string, { server: ServerConfig; scope: string }>）就地声明，形状由下方
// catalogToolNames/collectCatalogServers 的实参在编译期校验。
type CatalogServers = Map<string, { server: ServerConfig; scope: string }>;
import {
  absentFromPool,
  carriesProjectionPlaceholder,
  catalogToolNames,
  collectCatalogServers,
  findProjectionPlaceholderKey,
  hasSecretTable,
  isBlankCwd,
  isPlainRecord,
  isProjectionPlaceholder,
  isToolDisabledIn,
  pooledErrorText,
  projectBaseFieldsForSummary,
  projectHttpFieldsForSummary,
  projectRootForCwd,
  projectStdioFieldsForSummary,
  releaseUndesiredConnections,
  resolveConnectableServer,
  serverEntry,
  summarizeAbsent,
  summarizePooled,
  syncPool,
  touchRootFor,
  urlCarriesSecrets,
} from "../../src/server/connection/orchestrator/manager.ts";
import type { ServerConfig } from "../../src/server/config/interface.ts";
import type { ProjectUnit } from "../../src/server/connection/runtime/interface.ts";

const identityMask = (args: readonly string[]): string[] => [...args];

describe("manager 纯函数：投影占位符与秘密判定", () => {
  it("isPlainRecord：null / 数组判假，对象判真", () => {
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(["a"])).toBe(false);
  });

  it("isProjectionPlaceholder：明文与 URL 编码两种形态都命中，其余不命中", () => {
    expect(isProjectionPlaceholder("u:[REDACTED]")).toBe(true);
    expect(isProjectionPlaceholder("u:%5BREDACTED%5D")).toBe(true);
    expect(isProjectionPlaceholder("https://real.example")).toBe(false);
    expect(isProjectionPlaceholder(7)).toBe(false);
  });

  it("carriesProjectionPlaceholder：args 看元素、env/headers 看一层值、其余看字符串", () => {
    expect(carriesProjectionPlaceholder("args", ["--token", "[REDACTED]"])).toBe(true);
    expect(carriesProjectionPlaceholder("args", "[REDACTED]")).toBe(true);
    expect(carriesProjectionPlaceholder("env", { A: "[REDACTED]" })).toBe(true);
    expect(carriesProjectionPlaceholder("headers", { A: "plain" })).toBe(false);
    // 更深的嵌套历史不判（口径逐字照搬，不递归）。
    expect(carriesProjectionPlaceholder("env", { A: { B: "[REDACTED]" } })).toBe(false);
    expect(carriesProjectionPlaceholder("reconnect", { A: "[REDACTED]" })).toBe(false);
  });

  it("findProjectionPlaceholderKey：返回首个命中键，无则 undefined（键序即判定序）", () => {
    expect(findProjectionPlaceholderKey({ name: "s", env: { A: "[REDACTED]" } })).toBe("env");
    expect(findProjectionPlaceholderKey({ name: "s", args: ["--k", "v"] })).toBeUndefined();
  });

  it("hasSecretTable：缺省与空表都判无秘密", () => {
    expect(hasSecretTable(undefined)).toBe(false);
    expect(hasSecretTable({})).toBe(false);
    expect(hasSecretTable({ A: "v" })).toBe(true);
  });

  it("urlCarriesSecrets：userinfo / 非空查询值命中；非法 URL 与纯路径判无", () => {
    expect(urlCarriesSecrets("https://u:p@example.com")).toBe(true);
    expect(urlCarriesSecrets("https://example.com?k=v")).toBe(true);
    expect(urlCarriesSecrets("https://example.com?k=")).toBe(false);
    expect(urlCarriesSecrets("not a url")).toBe(false);
    expect(urlCarriesSecrets(undefined)).toBe(false);
  });
});

describe("manager 纯函数：只读投影三段", () => {
  const stdio: ServerConfig = { name: "s", transport: "stdio", enabled: true };

  it("projectBaseFieldsForSummary：缺省字段不落键，键序固定", () => {
    expect(Object.keys(projectBaseFieldsForSummary(stdio))).toEqual([
      "name",
      "transport",
      "enabled",
    ]);
  });

  it("projectStdioFieldsForSummary：args 经掩码口，掩码值即「有秘密」", () => {
    const masked = projectStdioFieldsForSummary(
      { ...stdio, command: "echo", args: ["--token", "s3cret"], cwd: "/w" },
      (args) => args.map((a) => (a === "s3cret" ? "[REDACTED]" : a)),
    );
    expect(masked.argsHadSecret).toBe(true);
    expect(masked.fields).toEqual({ command: "echo", args: ["--token", "[REDACTED]"], cwd: "/w" });
  });

  it("projectStdioFieldsForSummary：无 args 时不落键也不报有秘密", () => {
    const out = projectStdioFieldsForSummary(stdio, identityMask);
    expect(out).toEqual({ fields: {}, argsHadSecret: false });
  });

  it("projectHttpFieldsForSummary：url 的 userinfo 原位替换，缺省 url 不落键", () => {
    // 口径照搬 B8 原串形态替换：host/path/查询键保留，凭据值换成占位符。
    expect(
      projectHttpFieldsForSummary({
        name: "s",
        transport: "streamable-http",
        url: "https://user:pass@x/y",
      }).url,
    ).toBe("https://[REDACTED]:[REDACTED]@x/y");
    expect(
      projectHttpFieldsForSummary({
        name: "s",
        transport: "streamable-http",
        url: "https://x/y?token=abc",
      }).url,
    ).toBe("https://x/y?token=[REDACTED]");
    expect(projectHttpFieldsForSummary({ name: "s", transport: "streamable-http" })).toEqual({});
  });
});

describe("manager 纯函数：目录数据源与会话 cwd", () => {
  it("isBlankCwd：undefined / null / 空串三形态都判无项目（类型谓词）", () => {
    expect(isBlankCwd(undefined)).toBe(true);
    expect(isBlankCwd(null)).toBe(true);
    expect(isBlankCwd("")).toBe(true);
    expect(isBlankCwd("/w")).toBe(false);
  });

  it("projectRootForCwd：空 cwd 不查表直接无项目，非空才委派查表口", async () => {
    const find = vi.fn(async () => "/root");
    expect(await projectRootForCwd("", find)).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
    expect(await projectRootForCwd("/w/cwd", find)).toBe("/root");
    expect(find).toHaveBeenCalledWith("/w/cwd");
  });

  it("serverEntry：目录键取 server.name", () => {
    expect(serverEntry({ name: "a", transport: "stdio" })).toEqual([
      "a",
      { name: "a", transport: "stdio" },
    ]);
  });

  it("collectCatalogServers：enabled=false 跳过，同名后者覆盖前者", () => {
    const into: CatalogServers = new Map();
    const a = { name: "a", transport: "stdio" } as ServerConfig;
    collectCatalogServers(into, [serverEntry(a), serverEntry({ ...a, enabled: false })], "global");
    expect([...into.keys()]).toEqual(["a"]);
    collectCatalogServers(into, [serverEntry(a)], "project");
    expect(into.get("a")?.scope).toBe("project");
  });
});

describe("manager 纯函数：池同步口径", () => {
  const unit = (root: string, names: string[]): ProjectUnit => ({
    root,
    connections: new Map(names.map((n) => [n, {} as never])),
    userDisabled: new Set(),
    lastTouchedAt: 0,
    inFlight: new Map(),
  });

  it("absentFromPool：中间层缺失不算变化（在册条目不算缺失）", () => {
    const mw = { units: new Map([["@global", unit("@global", ["a"])]]) } as never;
    expect(absentFromPool(mw, "@global", "a")).toBe(false);
    expect(absentFromPool(mw, "@global", "b")).toBe(true);
    expect(absentFromPool(undefined, "@global", "a")).toBe(false);
  });

  it("releaseUndesiredConnections：配置已无 / 已禁用的条目被释放，其余保留", () => {
    const released: string[] = [];
    const mw = {
      units: new Map([["@global", unit("@global", ["keep", "gone", "off"])]]),
      releaseConnection: (root: string, name: string) => {
        released.push(name);
        return true;
      },
    } as never;
    const off = { name: "off", transport: "stdio", enabled: false } as ServerConfig;
    const keep = { name: "keep", transport: "stdio" } as ServerConfig;
    // desired 里只有 keep / off：「gone」不在集合内（配置已删），故被释放。
    const desired = new Map([
      ["@global\u0000keep", { name: "keep", server: keep, scope: "global" }],
      ["@global\u0000off", { name: "off", server: off, scope: "global" }],
    ]);
    expect(releaseUndesiredConnections(mw, desired)).toBe(true);
    expect(released.sort()).toEqual(["gone", "off"]);
  });

  it("touchRootFor：项目级取会话 root，其余落 @global", () => {
    expect(touchRootFor("project", "/root")).toBe("/root");
    expect(touchRootFor("project", undefined)).toBeUndefined();
    expect(touchRootFor("global", "/root")).toBe("@global");
  });

  it("syncPool：释放计入变化；触达逐条下沉 start", () => {
    const started: string[] = [];
    const released: string[] = [];
    const mw = {
      units: new Map([["@global", unit("@global", ["stale"])]]),
      releaseConnection: (root: string, name: string) => {
        released.push(name);
        return true;
      },
    } as never;
    const want = { name: "fresh", transport: "stdio" } as ServerConfig;
    const desired = new Map([
      ["@global\u0000fresh", { name: "fresh", server: want, scope: "global" }],
    ]);
    const changed = syncPool(mw, desired, undefined, (name) => started.push(name));
    expect(changed).toBe(true);
    expect(released).toEqual(["stale"]);
    expect(started).toEqual(["fresh"]);
  });

  it("syncPool：无项目 root 时项目级条目不触达、也不算变化", () => {
    const started: string[] = [];
    const mw = { units: new Map(), releaseConnection: () => false } as never;
    const want = { name: "p", transport: "stdio" } as ServerConfig;
    const desired = new Map([["/r\u0000p", { name: "p", server: want, scope: "project" }]]);
    expect(syncPool(mw, desired, undefined, (name) => started.push(name))).toBe(false);
    expect(started).toEqual([]);
  });
});

describe("manager 纯函数：connect 目标与 summary 投影", () => {
  it("resolveConnectableServer：store 优先；global scope 未命中回退 runtime 并 warn", () => {
    const store = { find: (name: string) => (name === "in" ? { name: "in" } : undefined) } as never;
    // satisfies 固定 transport 的字面量类型，否则数组推导成 string 宽度、与 ServerConfig 不兼容。
    const rt = { name: "rt", transport: "stdio" } satisfies ServerConfig;
    const runtime = new Map([["rt", rt]]);
    const warnings: string[] = [];
    expect(
      resolveConnectableServer(store, runtime, "in", "global", (m) => warnings.push(m))?.name,
    ).toBe("in");
    expect(
      resolveConnectableServer(store, runtime, "rt", "global", (m) => warnings.push(m))?.name,
    ).toBe("rt");
    expect(warnings).toHaveLength(1);
    expect(
      resolveConnectableServer(store, runtime, "rt", "project", (m) => warnings.push(m)),
    ).toBeUndefined();
  });

  it("catalogToolNames：目录缺失或发现失败一律空表", () => {
    expect(catalogToolNames(undefined)).toEqual([]);
    expect(catalogToolNames({ tools: new Map([["t", {}]]), unavailable: "boom" } as never)).toEqual(
      [],
    );
    expect(catalogToolNames({ tools: new Map([["t", {}]]) } as never)).toEqual(["t"]);
  });

  it("pooledErrorText：entry.error 优先、目录 unavailable 次之、都没有则 undefined", () => {
    const redact = (e: unknown) => `R:${String(e)}`;
    expect(pooledErrorText({ error: "e1" } as never, { unavailable: "u" } as never, redact)).toBe(
      "R:e1",
    );
    expect(
      pooledErrorText({ error: undefined } as never, { unavailable: "u" } as never, redact),
    ).toBe("R:u");
    expect(pooledErrorText({ error: undefined } as never, undefined, redact)).toBeUndefined();
  });

  it("isToolDisabledIn：本单元与 @global 继承集并集命中", () => {
    expect(isToolDisabledIn("t", new Set(["t"]), undefined)).toBe(true);
    expect(isToolDisabledIn("t", undefined, new Set(["t"]))).toBe(true);
    expect(isToolDisabledIn("t", new Set(), undefined)).toBe(false);
  });

  it("summarizePooled：禁用清单非空才落键，否则显式 undefined", () => {
    const view = {
      tools: ["a", "b"],
      disabled: new Set(["a"]),
      inheritedDisabled: undefined,
      status: "connected" as const,
      error: undefined,
    };
    const out = summarizePooled({ name: "s" }, "global", view);
    expect(out.disabledTools).toEqual(["a"]);
    expect(out.status).toBe("connected");
    expect(
      summarizePooled({ name: "s" }, "global", { ...view, disabled: undefined }).disabledTools,
    ).toBeUndefined();
    expect(
      "disabledTools" in summarizePooled({ name: "s" }, "global", { ...view, disabled: undefined }),
    ).toBe(true);
  });

  it("summarizeAbsent：配置禁用判 disabled，其余 stopped，工具面空", () => {
    // transport 是 ServerConfig 必填项，fixture 补齐（不靠断言绕过）。
    const off = { name: "s", transport: "stdio", enabled: false } satisfies ServerConfig;
    const on = { name: "s", transport: "stdio" } satisfies ServerConfig;
    expect(summarizeAbsent({ name: "s" }, "global", off).status).toBe("disabled");
    expect(summarizeAbsent({ name: "s" }, "global", on).status).toBe("stopped");
    expect(summarizeAbsent({ name: "s" }, "global", on).tools).toEqual([]);
  });
});
