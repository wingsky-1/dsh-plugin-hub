/**
 * dsh-mcp-manager middleware unit：catalog-cache 职责分片。
 *
 * 组合端口在本文件显式装卸；fixture、池清理与临时资源由 middleware-shape-support.ts 收口。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
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
const middlewareShape = createMiddlewareShapeSupport();
const ROOT = middlewareShape.root;
const makeHost = middlewareShape.makeHost.bind(middlewareShape);
const remoteEntry = middlewareShape.remoteEntry.bind(middlewareShape);
const trackMw = middlewareShape.trackMw.bind(middlewareShape);
const makeUnit = middlewareShape.makeUnit.bind(middlewareShape);
const ownTempDir = middlewareShape.ownTempDir.bind(middlewareShape);

afterEach(async () => {
  await middlewareShape.cleanup();
});

describe("#767 S1-3b：目录归属与载入不变式", () => {
  const DOMAIN_ROOT = "/tmp/ws-s1-3b-root";
  const DOMAIN_CACHE = () =>
    join(ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-s13b-"))), "catalog.json");

  /** 写一份 last-good 文件（内容 → 该 root 的目录）；落点目录由 mkdtempSync 现建。 */
  function writeCache(file: string, root: string, entries: unknown) {
    writeFileSync(file, JSON.stringify({ version: 1, root, entries }, null, 2), "utf8");
  }

  it("归属锁：ProjectUnit 不再持目录字段、McpMiddleware 不再有 discover", async () => {
    // 两条反证：
    //  - 把 catalog 字段加回 ProjectUnit → 两个 fixture（makeUnit 的字面量、以及真实
    //    projectUnitFor 建出来的单元）都会带上它，第一条红；
    //  - 把 discover 加回 McpMiddleware → 原型上就能取到，第二条红。
    const fixtureUnit = makeUnit();
    expect("catalog" in fixtureUnit, "夹具形状：ProjectUnit 无 catalog 字段").toBe(false);
    const { host } = makeHost(new Map([[ROOT, []]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const realUnit = await mw.projectUnitFor(ROOT);
    expect("catalog" in realUnit!, "真实建单元路径：目录不落在单元上（归 catalog 域）").toBe(false);
    expect(
      typeof (McpMiddleware.prototype as { discover?: unknown }).discover,
      "McpMiddleware 已无 discover 成员（投影归 catalog 域）",
    ).toBe("undefined");
  });

  it("前缀单源：hasRegisteredTools 只认 mcp__<id>__ 前缀", () => {
    // 反证：把前缀写死成别的形态（或去掉 id 维度）→ 三条断言里至少一条红。
    const schemas = [
      { name: "mcp__id-py__echo" },
      { name: "mcp__other-id__echo" },
      { name: "plain_tool" },
    ];
    expect(catalogDirectory.hasRegisteredTools(schemas, "id-py")).toBe(true);
    expect(catalogDirectory.hasRegisteredTools(schemas, "other-id")).toBe(true);
    expect(catalogDirectory.hasRegisteredTools(schemas, "id-nope")).toBe(false);
    // 名字里含 mcp__ 但与 id 不符（前缀只认完整 `mcp__<id>__`，不是「包含」）。
    expect(catalogDirectory.hasRegisteredTools([{ name: "xmcp__id-py__echo" }], "id-py")).toBe(
      false,
    );
    // 空注册面 / 非字符串名一律 false（读不到注册表不许阻塞，也不许误判已连上）。
    expect(catalogDirectory.hasRegisteredTools([], "id-py")).toBe(false);
    expect(catalogDirectory.hasRegisteredTools([{ name: 42 }], "id-py")).toBe(false);
  });

  it("statusOf 的「已连上」极性由目录读口决定（单源）", async () => {
    // 反证：hasRegisteredTools 若绕过目录域自读注册面（或前缀口径分叉），这里极性会漂。
    const py: ServerConfig = { name: "py", transport: "stdio", command: "python", enabled: true };
    const { host, tools } = makeHost(new Map([[DOMAIN_ROOT, [py]]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit({ root: DOMAIN_ROOT });
    mw.units.set(DOMAIN_ROOT, unit);
    unit.connections.set("py", remoteEntry(py, "id-py"));
    tools.entries = [{ name: "mcp__id-py__echo" }];
    expect(
      catalogDirectory.hasRegisteredTools(tools.schemas(), "id-py"),
      "前置：目录读口认该前缀",
    ).toBe(true);
    expect(mw.statusOf(DOMAIN_ROOT, "py")).toBe("connected");
    tools.entries = [{ name: "mcp__id-other__echo" }];
    expect(
      catalogDirectory.hasRegisteredTools(tools.schemas(), "id-py"),
      "前置：换 id 后读口不再认",
    ).toBe(false);
    expect(mw.statusOf(DOMAIN_ROOT, "py")).toBe("reconnecting");
  });

  it("载入幂等：root 在册后 ensureRootLoaded 不再读盘、也不被磁盘内容覆盖", async () => {
    // 反证：删掉 ensureRootLoaded 的 `if (this.byRoot.has(root)) return;` 短路 → 内存被 B 覆盖。
    const file = DOMAIN_CACHE();
    catalogDirectory.dropRoot(DOMAIN_ROOT);
    catalogDirectory.projectWrappedTools({
      root: DOMAIN_ROOT,
      serverName: "mem",
      definitions: [{ name: "mem_tool", description: "内存那份", parameters: {} }],
    });
    // 内存目录 A 已就位；此刻磁盘写成 B（另一台服务器）。
    writeCache(file, DOMAIN_ROOT, {
      disk: {
        discoveredAt: 1,
        tools: [{ name: "disk_tool", description: "磁盘那份", inputSchema: {} }],
      },
    });
    // 第一次：root 已在册 → 短路，磁盘 B 只被忽略、不被读回。
    await catalogDirectory.ensureRootLoaded(DOMAIN_ROOT, file);
    // 第二次同样短路。
    await catalogDirectory.ensureRootLoaded(DOMAIN_ROOT, file);
    // 内存仍是 A：磁盘那份进不来（单元创建是唯一载入点，内存态才是权威）。
    expect([...catalogDirectory.serversFor(DOMAIN_ROOT)!.keys()]).toEqual(["mem"]);
    // 在册条目恒存在（上一段已建），此处断言存在。
    expect(catalogDirectory.entryFor(DOMAIN_ROOT, "mem")!.tools.has("mem_tool")).toBe(true);
    // 反证：删掉短路 → 第一次就会把 B 载回来，上面两条断言必红（内存变成 disk-only）。
    // 「只读盘一次」是短路的直接后果：短路发生在任何 fs 调用之前，故不存在第二次读盘。
    // 这里不引 fs spy——语义判据（内存未被磁盘覆盖）比计数更强，且不依赖实现细节。
  });

  it("先投影后建单元：内存目录不被随后的磁盘载入盖回", async () => {
    // 反证：把 ensureRootLoaded 的短路条件从 `this.byRoot.has(root)` 改成 `this.roots.has(root)`
    // （即在「表已建、root 未登记」这一支上放行读盘）→ 这里必红。
    const fresh = "/tmp/ws-s1-3b-fresh";
    const file = DOMAIN_CACHE();
    writeCache(file, fresh, {
      disk: { discoveredAt: 1, tools: [{ name: "disk_tool", description: "", inputSchema: {} }] },
    });
    catalogDirectory.dropRoot(fresh);
    // 投影先到（此后 root 已在册，只是没有走过载入路径）。
    catalogDirectory.projectWrappedTools({
      root: fresh,
      serverName: "mem",
      definitions: [{ name: "mem_tool", description: "", parameters: {} }],
    });
    expect([...(catalogDirectory.serversFor(fresh) ?? new Map()).keys()]).toEqual(["mem"]);
    await catalogDirectory.ensureRootLoaded(fresh, file);
    expect([...catalogDirectory.serversFor(fresh)!.keys()], "磁盘那份不得盖回内存投影").toEqual([
      "mem",
    ]);
    expect(catalogDirectory.entryFor(fresh, "mem")!.tools.has("mem_tool")).toBe(true);
    expect(catalogDirectory.entryFor(fresh, "disk")).toBeUndefined();
  });
});
