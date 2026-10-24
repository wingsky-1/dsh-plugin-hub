/**
 * dsh-mcp-manager middleware unit：workspace-session 职责分片。
 *
 * 组合端口在本文件显式装卸；fixture、池清理与临时资源由 middleware-shape-support.ts 收口。
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import {
  createMiddlewareShapeSupport,
  installMiddlewareShapeComposition,
  releaseMiddlewareShapeComposition,
} from "./middleware-shape-support.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { ProjectUnit } from "../../src/server/connection/runtime/interface.ts";
import type { DisabledToolsMap } from "../../src/server/store/interface.ts";
/**
 * JSON 值面（render/value 入参口径）：从官方 ToolOutputDefinition 声明派生，不自造第二套
 * （`@deepseek-ai/dsh-util-values` 不在本包依赖内，不直引）。
 */
import type { ServerConfig } from "../../src/server/config/interface.ts";

// I8①：单元层不得值引组合根 src/index.ts——中间层类与注册入口改经各自域门面直取，
// 组合根顶层那六张静态端口表由 helpers 以同实参、同顺序手装，不经组合根求值装配。
const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
beforeAll(installMiddlewareShapeComposition);

afterAll(releaseMiddlewareShapeComposition);
const { fullServerName, parseFullServerName, normalizeToolName } =
  await import("../../src/server/workspace/interface.ts");
const { loadUserState, saveUserState, loadDisabledTools, saveDisabledTools } =
  await import("../../src/server/store/interface.ts");

const middlewareShape = createMiddlewareShapeSupport();
const ROOT = middlewareShape.root;
const makeHost = middlewareShape.makeHost.bind(middlewareShape);
const trackMw = middlewareShape.trackMw.bind(middlewareShape);
const makeUnit = middlewareShape.makeUnit.bind(middlewareShape);
const ownTempDir = middlewareShape.ownTempDir.bind(middlewareShape);

afterEach(async () => {
  await middlewareShape.cleanup();
});

describe("fullServerName / parseFullServerName", () => {
  it("fullServerName 拼接 @root/server", () => {
    expect(fullServerName("/a/b", "ctx")).toBe("@/a/b/ctx");
  });

  it("parse 还原 root + server", () => {
    expect(parseFullServerName("@/a/b/ctx")).toEqual({ root: "/a/b", server: "ctx" });
  });

  it("parse 以最后一段为 server", () => {
    expect(parseFullServerName("@/a/b")).toEqual({ root: "/a", server: "b" });
  });

  it("裸名 parse 为 undefined", () => {
    expect(parseFullServerName("ctx")).toBeUndefined();
  });

  it("空 server 形态 → undefined（@/）", () => {
    expect(parseFullServerName("@/")).toBeUndefined();
  });

  it("空 server 形态 → undefined（@/a/）", () => {
    expect(parseFullServerName("@/a/")).toBeUndefined();
  });
});

describe("normalizeToolName", () => {
  it("裸工具名原样", () => {
    expect(normalizeToolName("ctx", "use_ctx")).toBe("use_ctx");
  });

  it("剥离 mcp__ 前缀", () => {
    expect(normalizeToolName("ctx", "mcp__ctx__use_ctx")).toBe("use_ctx");
  });

  it("多重前缀一并剥离", () => {
    expect(normalizeToolName("ctx", "mcp__ctx__mcp__ctx__use_ctx")).toBe("use_ctx");
  });

  it("跨 server 前缀抛错", () => {
    expect(() => normalizeToolName("ctx", "mcp__other__tool")).toThrow(/疑似其他/);
  });
});

describe("McpMiddleware：projectUnitFor / userDisabled / inFlight", () => {
  async function projectUnitFixture() {
    const servers: ServerConfig[] = [
      { name: "ctx", transport: "stdio", command: "npx", enabled: true },
    ];
    const { host, log } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    mw.disabledByRoot.set(ROOT, new Set(["ctx"]));
    const unit = await mw.projectUnitFor(ROOT);
    return { mw, unit, log };
  }

  it("项目单元已创建", async () => {
    const { unit } = await projectUnitFixture();
    expect(unit !== undefined).toBeTruthy();
  });

  it("userDisabled 合并", async () => {
    const { unit } = await projectUnitFixture();
    // 存在性由上一用例保证（同一装配器），此处断言存在。
    expect(unit!.userDisabled.has("ctx")).toBe(true);
  });

  it("惰性：未显式连接前不建连接", async () => {
    const { unit } = await projectUnitFixture();
    expect(unit!.connections.size).toBe(0);
  });

  it("惰性创建不广播状态", async () => {
    const { log } = await projectUnitFixture();
    expect(log.emits).toBe(0);
  });

  it("无项目标记目录 → undefined", async () => {
    const { mw } = await projectUnitFixture();
    const none = await mw.projectUnitFor("/no/such/root");
    expect(none).toBeUndefined();
  });
});

describe("evictIfNeeded LRU", () => {
  function evictedFixture() {
    const { host } = makeHost(new Map());
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    // 注入 18 个假单元（无服务器配置，projectUnitFor 会返回 undefined —— 直接塞 map）
    for (let index = 0; index < 18; index += 1) {
      // 同上：catalog 残留形状，收窄不断言（evict 只读 root/lastTouchedAt）。
      mw.units.set(`/root-${index}`, {
        root: `/root-${index}`,
        connections: new Map(),
        catalog: new Map(),
        userDisabled: new Set(),
        lastTouchedAt: 1000 + index,
        inFlight: new Map(),
      } as unknown as ProjectUnit);
    }
    mw.evictIfNeeded(16);
    return mw;
  }

  it("LRU 淘汰到上限", () => {
    expect(evictedFixture().units.size).toBe(16);
  });

  it("最旧被淘汰", () => {
    expect(evictedFixture().units.has("/root-0")).toBe(false);
  });

  it("最新保留", () => {
    expect(evictedFixture().units.has("/root-17")).toBe(true);
  });
});

describe("userState 持久化", () => {
  async function saveAndLoad() {
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-")));
    const file = join(dir, "user-state.json");
    // catalog 字段是目录域搬迁前的残留形状（ProjectUnit 已无此键）：saveUserState 只读写 userDisabled，
    // 此处不断言、只收窄。
    const units = new Map([
      [
        ROOT,
        {
          root: ROOT,
          connections: new Map(),
          catalog: new Map(),
          userDisabled: new Set(["ctx"]),
          lastTouchedAt: Date.now(),
          inFlight: new Map(),
        },
      ],
    ]) as unknown as Map<string, ProjectUnit>;
    await saveUserState(file, units);
    const loaded = await loadUserState(file);
    mkdirSync(join(dir, "sub"));
    return { file, loaded };
  }

  it("saveUserState/loadUserState 往返", async () => {
    const { loaded } = await saveAndLoad();
    // save/load 往返保证键存在，此处断言存在。
    expect([...loaded.get(ROOT)!]).toEqual(["ctx"]);
  });

  it("双键互存 A 向：saveUserState 不抹 disabledTools（#903 S1）", async () => {
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-s1a-")));
    const file = join(dir, "user-state.json");
    const tools: DisabledToolsMap = new Map([[ROOT, new Map([["srv", new Set(["toolA"])]])]]);
    await saveDisabledTools(file, tools);
    const units = new Map([[ROOT, { userDisabled: new Set(["srv"]) }]]) as unknown as Map<
      string,
      ProjectUnit
    >;
    await saveUserState(file, units);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.disabled).toEqual({ [ROOT]: ["srv"] });
    expect(raw.disabledTools).toEqual({ [ROOT]: { srv: ["toolA"] } });
    expect([...(await loadUserState(file)).get(ROOT)!]).toEqual(["srv"]);
    expect([...(await loadDisabledTools(file)).get(ROOT)!.get("srv")!]).toEqual(["toolA"]);
  });

  it("双键互存 B 向：saveDisabledTools 不抹 disabled（#903 S1）", async () => {
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-s1b-")));
    const file = join(dir, "user-state.json");
    const units = new Map([[ROOT, { userDisabled: new Set(["srv"]) }]]) as unknown as Map<
      string,
      ProjectUnit
    >;
    await saveUserState(file, units);
    const tools: DisabledToolsMap = new Map([[ROOT, new Map([["srv", new Set(["toolA"])]])]]);
    await saveDisabledTools(file, tools);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.disabled).toEqual({ [ROOT]: ["srv"] });
    expect(raw.disabledTools).toEqual({ [ROOT]: { srv: ["toolA"] } });
    expect([...(await loadUserState(file)).get(ROOT)!]).toEqual(["srv"]);
    expect([...(await loadDisabledTools(file)).get(ROOT)!.get("srv")!]).toEqual(["toolA"]);
  });

  it("损坏文件 → 空", async () => {
    const { file } = await saveAndLoad();
    writeFileSync(file, "{bad json");
    const empty = await loadUserState(file);
    expect(empty.size).toBe(0);
  });
});

describe("last-good 目录缓存", () => {
  function cacheFixture() {
    const dir = ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-cat-")));
    const baseHost = makeHost(new Map());
    const catalogHost = {
      ...baseHost.host,
      catalogCachePath: (root: string) => join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`),
    };
    const mw = trackMw(new McpMiddleware(catalogHost as unknown as MiddlewareHost));
    const unit = makeUnit({
      catalog: new Map([
        [
          "ctx",
          {
            discoveredAt: Date.now(),
            tools: new Map([["use_ctx", { description: "查询文档", inputSchema: {} }]]),
          },
        ],
      ]),
    });
    mw.units.set(ROOT, unit);
    // 落盘路径是调用点的入参契约：这里直接给 catalogDirectory 递同一个路径。
    return { mw, unit, catalogHost, cachePath: catalogHost.catalogCachePath(ROOT) };
  }

  it("有工具的目录落盘", async () => {
    const { cachePath } = cacheFixture();
    await catalogDirectory.persistRoot(ROOT, {
      cachePath: () => cachePath,
      isRuntimeServer: () => false,
      warn: () => {},
    });
    expect(existsSync(cachePath)).toBe(true);
  });

  it("空采集不覆盖已有缓存（保留 last-good）", async () => {
    const { cachePath } = cacheFixture();
    await catalogDirectory.persistRoot(ROOT, {
      cachePath: () => cachePath,
      isRuntimeServer: () => false,
      warn: () => {},
    });
    const before = readFileSync(cachePath, "utf8");
    // 空采集不写盘：清空目录后 persist 不覆盖已有缓存（保留 last-good）
    catalogDirectory.dropServer(ROOT, "ctx");
    catalogDirectory.projectWrappedTools({ root: ROOT, serverName: "ctx", definitions: [] });
    catalogDirectory.markUnavailable(ROOT, "ctx", "failed");
    await catalogDirectory.persistRoot(ROOT, {
      cachePath: () => cachePath,
      isRuntimeServer: () => false,
      warn: () => {},
    });
    expect(readFileSync(cachePath, "utf8")).toBe(before);
  });
});
