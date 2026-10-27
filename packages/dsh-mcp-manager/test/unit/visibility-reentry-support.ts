import { expect, it } from "vitest";
import type { ToolRestriction } from "@deepseek-ai/dsh-tools";
import type { AgentFace } from "../../src/server/shared/interface.ts";
import { startAgentVisibility } from "../../src/server/visibility/interface.ts";
import {
  fakeAgent,
  flakyAgent,
  makeEvents,
  unitsWith,
  makeLogger,
} from "./visibility-test-support.ts";

const reentry = "session append cannot reenter while another append is being published";

function registerReplacementCases() {
  it("非空限制更新遇到发布期重入时保留旧限制，重试后清理全部句柄", async () => {
    const events = makeEvents();
    const names = ["mcp__x__one"];
    const layers = new Set<string>();
    let publishing = false;
    const agent: AgentFace = {
      id: "update" as AgentFace["id"],
      tools: {
        restrict(filter: ToolRestriction) {
          const key = [...(filter.deny ?? [])].join("|");
          layers.add(key);
          if (publishing) {
            // Cordis effect 的通知失败会撤销刚添加的层；回滚通知也可能抛错。
            layers.delete(key);
            throw new Error(reentry);
          }
          return () => {
            layers.delete(key);
          };
        },
      },
    };
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => names,
      logger: makeLogger(),
    });
    events.handlers.created[0](agent);
    publishing = true;
    names.push("mcp__x__two");
    events.handlers.changed[0]();
    expect([...layers]).toEqual(["mcp__x__one"]);
    publishing = false;
    await Promise.resolve();
    expect([...layers]).toEqual(["mcp__x__one|mcp__x__two"]);
    stop();
    expect(layers.size).toBe(0);
  });

  it("摘除器在变更前失败时保留句柄供销毁清理", () => {
    const events = makeEvents();
    const names = ["mcp__x__one"];
    const layers = new Set<string>();
    let failDispose = true;
    const agent: AgentFace = {
      id: "cleanup" as AgentFace["id"],
      tools: {
        restrict(filter: ToolRestriction) {
          const key = [...(filter.deny ?? [])].join("|");
          layers.add(key);
          return () => {
            if (failDispose) {
              failDispose = false;
              throw new Error("before undo");
            }
            layers.delete(key);
          };
        },
      },
    };
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => names,
      logger: makeLogger(),
    });
    events.handlers.created[0](agent);
    names.push("mcp__x__two");
    events.handlers.changed[0]();
    stop();
    expect([...layers]).toEqual([]);
  });
}

function registerFirstMountLifecycleCases() {
  it("首次挂载重入后仅对失败 agent 延迟重试，其他 agent 同步隐藏", async () => {
    const events = makeEvents();
    const calls: string[] = [];
    let publishing = true;
    const a = flakyAgent("a", calls, () => (publishing ? new Error(reentry) : undefined));
    const b = fakeAgent("b", calls, () => events.handlers.changed);
    const logger = makeLogger();
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => ["mcp__x__one"],
      logger,
    });
    events.handlers.created[0](a);
    events.handlers.created[0](b);
    expect(calls).toEqual(["restrict:b[mcp__x__one]"]);
    publishing = false;
    await Promise.resolve();
    expect(calls).toEqual(["restrict:b[mcp__x__one]", "restrict:a[mcp__x__one]"]);
    expect(logger.warns).toEqual([]);
    stop();
  });

  it("销毁 agent 或域后取消待重试，旧任务不触碰同 id 新 agent", async () => {
    const events = makeEvents();
    let attempts = 0;
    const old = flakyAgent("a", [], () => {
      attempts++;
      return new Error(reentry);
    });
    const log: string[] = [];
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => ["mcp__x__one"],
      logger: makeLogger(),
    });
    events.handlers.created[0](old);
    events.handlers.disposed[0]({ id: "a" });
    events.handlers.created[0](fakeAgent("a", log));
    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(log).toEqual(["restrict:a[mcp__x__one]"]);
    const other = flakyAgent("b", [], () => {
      attempts++;
      return new Error(reentry);
    });
    events.handlers.created[0](other);
    stop();
    await Promise.resolve();
    expect(attempts).toBe(2);
  });

  it("已有空名单记录时首次工具注册重入后重试", async () => {
    const events = makeEvents();
    const names: string[] = [];
    const log: string[] = [];
    let publishing = true;
    const agent = flakyAgent("a", log, () => (publishing ? new Error(reentry) : undefined));
    const logger = makeLogger();
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => names,
      logger,
    });
    events.handlers.created[0](agent);
    names.push("mcp__x__one");
    events.handlers.changed[0]();
    expect(log).toEqual([]);
    publishing = false;
    await Promise.resolve();
    expect(log).toEqual(["restrict:a[mcp__x__one]"]);
    expect(logger.warns).toEqual([]);
    stop();
  });
}

function registerRetryLimitCases() {
  it("已有非空限制的更新重入仅重试一次且成功前不撤旧", async () => {
    const events = makeEvents();
    const names = ["mcp__x__one"];
    const log: string[] = [];
    let publishing = false;
    let attempts = 0;
    const agent = flakyAgent("a", log, () => {
      attempts++;
      return publishing ? new Error(reentry) : undefined;
    });
    const logger = makeLogger();
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => names,
      logger,
    });
    events.handlers.created[0](agent);
    publishing = true;
    names.push("mcp__x__two");
    events.handlers.changed[0]();
    expect(log).toEqual(["restrict:a[mcp__x__one]"]);
    publishing = false;
    await Promise.resolve();
    expect(attempts).toBe(3);
    expect(log).toEqual([
      "restrict:a[mcp__x__one]",
      "restrict:a[mcp__x__one|mcp__x__two]",
      "dispose:a#1",
    ]);
    expect(logger.warns).toEqual([]);
    stop();
  });

  it("普通异常不自动重试并立即告警", async () => {
    const events = makeEvents();
    const logger = makeLogger();
    let attempts = 0;
    const agent = flakyAgent("a", [], () => {
      attempts++;
      return new Error("scope disposed");
    });
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => ["mcp__x__one"],
      logger,
    });
    events.handlers.created[0](agent);
    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain("scope disposed");
    stop();
  });

  it("持续重入只自动重试一次并告警", async () => {
    const events = makeEvents();
    const logger = makeLogger();
    let attempts = 0;
    const agent = flakyAgent("a", [], () => {
      attempts++;
      return new Error(reentry);
    });
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => ["mcp__x__one"],
      logger,
    });
    events.handlers.created[0](agent);
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);
    expect(logger.warns).toHaveLength(1);
    stop();
  });
}

export function registerFirstMountReentryCases() {
  registerReplacementCases();
  registerFirstMountLifecycleCases();
  registerRetryLimitCases();
}

/** 模拟宿主层先变更再通知、挂载通知失败时撤销并再次通知；不模拟 visibility 的决策。 */
function restrictionHost(id: string, notify: (kind: string, handle: number) => void = () => {}) {
  const layers = new Map<number, string[]>();
  const disposed: number[] = [];
  let mounts = 0;
  const face: AgentFace = {
    id: id as AgentFace["id"],
    tools: {
      restrict(filter: ToolRestriction) {
        const handle = ++mounts;
        layers.set(handle, [...(filter.deny ?? [])]);
        try {
          notify("mount", handle);
        } catch (error) {
          layers.delete(handle);
          notify("rollback", handle);
          throw error;
        }
        return () => {
          layers.delete(handle);
          disposed.push(handle);
          notify("dispose", handle);
        };
      },
    },
  };
  return { face, layers, disposed, mounts: () => mounts };
}

function registerCleanupNotificationCases() {
  it("tools/change 缺席时新 agent 创建仍同步更新全部已知 agent", () => {
    const events = makeEvents();
    const names = ["mcp__x__one"];
    const a = restrictionHost("a");
    const b = restrictionHost("b");
    const stop = startAgentVisibility({
      events: { ...events.port, onToolsChange: undefined },
      units: unitsWith("x"),
      registeredNames: () => names,
      logger: makeLogger(),
    });
    events.handlers.created[0](a.face);
    names.push("mcp__x__two");
    events.handlers.created[0](b.face);
    expect([...a.layers.values()]).toEqual([["mcp__x__one", "mcp__x__two"]]);
    expect([...b.layers.values()]).toEqual([["mcp__x__one", "mcp__x__two"]]);
    stop();
  });

  it("新层成功后旧层撤销通知重入，保留句柄且合并待重试期间的新名单", async () => {
    const events = makeEvents();
    const names = ["mcp__x__one"];
    let publishing = false;
    const host = restrictionHost("a", (kind) => {
      events.handlers.changed[0]();
      if (kind === "dispose" && publishing) throw new Error(reentry);
    });
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => names,
      logger: makeLogger(),
    });
    events.handlers.created[0](host.face);
    names.push("mcp__x__two");
    publishing = true;
    events.handlers.changed[0]();
    expect([...host.layers.values()]).toEqual([["mcp__x__one", "mcp__x__two"]]);
    names.push("mcp__x__three");
    events.handlers.changed[0]();
    publishing = false;
    await Promise.resolve();
    expect(host.mounts()).toBe(3);
    expect([...host.layers.values()]).toEqual([["mcp__x__one", "mcp__x__three", "mcp__x__two"]]);
    expect(host.disposed).toEqual([1, 2, 1]);
    stop();
    expect(host.layers.size).toBe(0);
  });

  it("空名单撤销重入只重试清理，不调用空 restrict", async () => {
    const events = makeEvents();
    const names = ["mcp__x__one"];
    let publishing = false;
    const host = restrictionHost("a", (kind) => {
      if (kind === "dispose" && publishing) throw new Error(reentry);
    });
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => names,
      logger: makeLogger(),
    });
    events.handlers.created[0](host.face);
    names.length = 0;
    publishing = true;
    events.handlers.changed[0]();
    expect(host.layers.size).toBe(0);
    publishing = false;
    await Promise.resolve();
    expect(host.mounts()).toBe(1);
    expect(host.disposed).toEqual([1, 1]);
    stop();
  });
}

function registerNestedLifecycleCases() {
  it("restrict 返回句柄前 nested disposed 与同 id 重建，旧句柄事后清理", () => {
    const events = makeEvents();
    const fresh = restrictionHost("a");
    const old = restrictionHost("a", (kind) => {
      if (kind === "mount") {
        events.handlers.disposed[0]({ id: "a" });
        events.handlers.created[0](fresh.face);
      }
    });
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => ["mcp__x__one"],
      logger: makeLogger(),
    });
    events.handlers.created[0](old.face);
    expect(old.layers.size).toBe(0);
    expect(old.disposed).toEqual([1]);
    expect(fresh.layers.size).toBe(1);
    events.handlers.changed[0]();
    expect(old.mounts()).toBe(1);
    expect(fresh.mounts()).toBe(1);
    stop();
    expect(fresh.layers.size).toBe(0);
  });

  it("已取出的批次中 B 被 A 同步销毁后不会重新规范化复活", () => {
    const live: AgentFace[] = [];
    const events = makeEvents(() => live);
    const b = restrictionHost("b");
    const a = restrictionHost("a", (kind) => {
      if (kind === "mount") {
        live.splice(1, 1);
        events.handlers.disposed[0]({ id: "b" });
      }
    });
    live.push(a.face, b.face);
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => ["mcp__x__one"],
      logger: makeLogger(),
    });
    expect(a.mounts()).toBe(1);
    expect(b.mounts()).toBe(0);
    stop();
    expect(a.layers.size).toBe(0);
  });
}

function registerRollbackAndStopCases() {
  it("partial mount 回滚清理失败保留句柄，发布结束后重新挂全并清理", async () => {
    const events = makeEvents();
    let publishing = true;
    const host = restrictionHost("a", (kind, handle) => {
      if (publishing && ((kind === "mount" && handle === 2) || kind === "dispose"))
        throw new Error(reentry);
    });
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith(),
      registeredNames: () => ["mcp__x__one", "mcp__x__two"],
      logger: makeLogger(),
    });
    events.handlers.created[0](host.face);
    expect(host.layers.size).toBe(0);
    publishing = false;
    await Promise.resolve();
    expect(host.mounts()).toBe(4);
    expect([...host.layers.values()]).toEqual([["mcp__x__one"], ["mcp__x__two"]]);
    expect(host.disposed).toEqual([1, 1]);
    stop();
    expect(host.layers.size).toBe(0);
  });

  it("domain stop 取消 pending 挂载且重试失败清理一次，无自激", async () => {
    const events = makeEvents();
    const logger = makeLogger();
    let publishing = false;
    const host = restrictionHost("a", () => {
      events.handlers.changed[0]();
      if (publishing) throw new Error(reentry);
    });
    const names = ["mcp__x__one"];
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith("x"),
      registeredNames: () => names,
      logger,
    });
    events.handlers.created[0](host.face);
    publishing = true;
    names.push("mcp__x__two");
    events.handlers.changed[0]();
    stop();
    expect(host.layers.size).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(host.mounts()).toBe(2);
    expect(host.disposed).toEqual([1, 1]);
    expect(logger.warns).toHaveLength(1);
  });
}

function registerOrdinaryCleanupCases() {
  it("普通 partial mount 失败后只重试失败清理，不自动重新挂载", async () => {
    const events = makeEvents();
    let failCleanup = true;
    const logger = makeLogger();
    const host = restrictionHost("a", (kind, handle) => {
      if (kind === "mount" && handle === 2) throw new Error("ordinary mount failure");
      if (kind === "dispose" && failCleanup) {
        failCleanup = false;
        throw new Error("ordinary cleanup failure");
      }
    });
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith(),
      registeredNames: () => ["mcp__x__one", "mcp__x__two"],
      logger,
    });
    events.handlers.created[0](host.face);
    await Promise.resolve();
    expect(host.mounts()).toBe(2);
    expect(host.disposed).toEqual([1, 1]);
    expect(host.layers.size).toBe(0);
    expect(logger.warns).toHaveLength(2);
    stop();
  });

  it("首次 ordinary partial 失败的清理等待中保留外部新名单事件", async () => {
    const events = makeEvents();
    const names = ["mcp__x__one", "mcp__x__two"];
    let cleanupFailed = false;
    const host = restrictionHost("a", (kind, handle) => {
      events.handlers.changed[0]();
      if (kind === "mount" && handle === 2) throw new Error("ordinary mount failure");
      if (kind === "dispose" && !cleanupFailed) {
        cleanupFailed = true;
        throw new Error("ordinary cleanup failure");
      }
    });
    const stop = startAgentVisibility({
      events: events.port,
      units: unitsWith(),
      registeredNames: () => names,
      logger: makeLogger(),
    });
    events.handlers.created[0](host.face);
    expect(host.mounts()).toBe(2);
    names.push("mcp__x__three");
    events.handlers.changed[0]();
    await Promise.resolve();
    expect([...host.layers.values()]).toEqual([
      ["mcp__x__one"],
      ["mcp__x__three"],
      ["mcp__x__two"],
    ]);
    stop();
  });
}

export function registerRecordLifecycleCases() {
  registerCleanupNotificationCases();
  registerNestedLifecycleCases();
  registerRollbackAndStopCases();
  registerOrdinaryCleanupCases();
}
