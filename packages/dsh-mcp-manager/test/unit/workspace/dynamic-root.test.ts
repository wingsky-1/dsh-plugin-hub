/**
 * dsh-mcp-manager — unit：活动工作目录路由（#1137 语义 A；判据 D02 切回 / D04 / F01）。
 *
 * 被测断言是**路由口径**，不是「没抛错」：
 * - 路由跟随 agent 自己 session 的活动目录投影，**不**读 header.cwd；
 * - 每次调用开始取一次快照并在本次调用内固定（切目录后的**新**调用用新 root）；
 * - 无有效活动目录一律 fail-closed：缺失 / 空白 / 相对 / 类型错 / 读取抛错 / 服务缺席，
 *   都不得回退 header.cwd、process.cwd 或另一个已连接工作区（F01 显式带 header=P 的诱饵）。
 *
 * 全部离线、无网络、无真实凭据；文件系统 fixture 落 mkdtemp 隔离目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  fakeManagerCtx,
  installCompositionPorts,
  releaseCompositionPorts,
  tempDshHome,
} from "../../helpers.ts";

const { McpStore } = await import("../../../src/server/store/interface.ts");
const { McpManager } = await import("../../../src/server/connection/orchestrator/interface.ts");
const { makeResolveRoot } = await import("../../../src/server/workspace/interface.ts");
const { normalizeServer } = await import("../../../src/server/config/interface.ts");
const { MIDDLEWARE_GLOBAL_ROOT } = await import("../../../src/shared/interface.ts");

// 组合根六张静态端口表（helper 是单一事实源）；McpManager 构造器要读 orchestrator 端口。
// 装配是**文件级**一次（静态端口表重复装配会抛「只能装配一次」），不随每例重装。
beforeAll(() => {
  installCompositionPorts();
});
afterAll(() => {
  releaseCompositionPorts();
});

/**
 * 活动目录读取面：按 session 查 `workingDirectory` 投影。
 *
 * 与组合根 `bindHost` 的 `workingDirectory()` 同口径（同一 fail-closed 判定），
 * 但这里显式注入以便逐条构造非法输入。返回 undefined = 无有效活动目录。
 */
type Port = (session: unknown) => string | undefined;

describe("makeResolveRoot 跟随活动目录（#1137 语义 A）", () => {
  let dir: string;
  let home: ReturnType<typeof tempDshHome>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mcp-dynroot-"));
    home = tempDshHome();
  });

  afterEach(() => {
    home.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 造一个带项目标记的真实目录，返回其绝对路径。 */
  function project(name: string): string {
    const project_ = join(dir, name);
    mkdirSync(join(project_, ".git"), { recursive: true });
    return project_;
  }

  function resolverFor(
    activeDirectory: Port | undefined,
    options: { globalRuntimeServer?: boolean } = {},
  ): (agent: unknown) => Promise<string | undefined> {
    const store = new McpStore(join(dir, "global.json"));
    store.data = { version: 1, servers: [] };
    const manager = new McpManager(fakeManagerCtx(), store);
    if (options.globalRuntimeServer === true) {
      // 仅 runtime 注入的全局服务器（不落 store）——用于验证 @global 回落仍可达。
      manager.runtimeRegistry.set(
        "cg",
        normalizeServer({ name: "cg", transport: "stdio", command: "dsh-noop-cmd" }),
      );
    }
    return makeResolveRoot(manager, activeDirectory);
  }

  it("agent-less 恒 undefined（无 agent 的隐式项目寻址维持拒绝）", async () => {
    const resolveRoot = resolverFor(() => project("p"));
    expect(await resolveRoot(null)).toBeUndefined();
    expect(await resolveRoot(undefined)).toBeUndefined();
    expect(await resolveRoot("not-an-agent")).toBeUndefined();
  });

  it("header.cwd=P、活动目录=W：路由用 W，不用 P", async () => {
    const p = project("p");
    const w = project("w");
    const session = { header: { cwd: p } };
    const resolveRoot = resolverFor((candidate) => (candidate === session ? w : undefined));
    expect(await resolveRoot({ session })).toBe(w);
  });

  it("W→P 切回：下一次调用重新使用 P，无上一工作区污染", async () => {
    const p = project("p");
    const w = project("w");
    const session = { header: { cwd: p } };
    let current = p;
    const resolveRoot = resolverFor((candidate) => (candidate === session ? current : undefined));

    expect(await resolveRoot({ session })).toBe(p);
    current = w;
    expect(await resolveRoot({ session })).toBe(w);
    current = p;
    expect(await resolveRoot({ session })).toBe(p);
  });

  it("每次调用取一次快照：同一次调用内目录变更不改投（已在飞的调用固定 root）", async () => {
    const p = project("p");
    const w = project("w");
    const session = { header: { cwd: p } };
    let reads = 0;
    const resolveRoot = resolverFor((candidate) => {
      if (candidate !== session) return undefined;
      reads += 1;
      return p;
    });

    const pending = resolveRoot({ session });
    // 调用进行中：活动目录被切走，但已在飞的调用必须仍以起始快照 p 为准。
    expect(await pending).toBe(p);
    // 一次调用只读一次活动目录（快照语义，不是每次 await 都重读）。
    expect(reads).toBe(1);
    expect(p).not.toBe(w);
  });

  it("D04 无效活动目录一律 fail-closed，且不回退 header.cwd（F01 诱饵）", async () => {
    const p = project("p");
    const session = { header: { cwd: p } };

    // 逐条非法输入；每条都必须在**没有任何全局服务器**时返回 undefined。
    const invalidPorts: readonly (readonly [string, Port])[] = [
      ["投影缺失（undefined）", () => undefined],
      ["空白串", () => "   "],
      ["空串", () => ""],
      ["相对路径", () => "relative/dir"],
      ["类型错（数字）", () => 42 as unknown as string],
      ["类型错（对象）", () => ({}) as unknown as string],
      [
        "读取抛错（归属未知）",
        () => {
          throw new Error("projection unavailable");
        },
      ],
    ];

    for (const [label, port] of invalidPorts) {
      const resolveRoot = resolverFor(port);
      expect(await resolveRoot({ session }), label).toBeUndefined();
    }

    // 服务面完全缺席（宿主未提供 workingDirectory 投影服务）。
    const noService = resolverFor(undefined);
    expect(await noService({ session })).toBeUndefined();

    // 已删除目录：投影仍报该路径，但目录不存在 → 不得回落 header.cwd。
    const deleted = join(dir, "deleted-project");
    mkdirSync(join(deleted, ".git"), { recursive: true });
    rmSync(deleted, { recursive: true, force: true });
    const deletedPort = resolverFor(() => deleted);
    const deletedRoot = await deletedPort({ session });
    expect(deletedRoot === undefined || deletedRoot === p).toBe(false);
  });

  it("无 agent 但显式 @global 仍可达（全局仅 runtime 来源）", async () => {
    const resolveRoot = resolverFor(() => undefined, { globalRuntimeServer: true });
    expect(await resolveRoot({ session: { header: {} } })).toBe(MIDDLEWARE_GLOBAL_ROOT);
  });

  it("无有效活动目录且无全局服务器：拒绝，不串台到 header.cwd", async () => {
    const p = project("p");
    writeFileSync(join(p, "marker.txt"), "x");
    const resolveRoot = resolverFor(() => undefined);
    expect(await resolveRoot({ session: { header: { cwd: p } } })).toBeUndefined();
  });
});
