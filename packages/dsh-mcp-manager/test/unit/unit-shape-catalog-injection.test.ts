/**
 * dsh-mcp-manager — unit：resolveCatalogInjection 注入决策域（六条路径）。
 *
 * 自然职责拆分（#1174 阶段 2 形状清债）：本域原与目录渲染/历史域同处 unit/catalog.test.ts
 * 一个 726 行文件（挂账 max-lines + max-lines-per-function 两条）。注入决策是**独立职责**
 * ——只读 supervisor 表与 agent 快照，产出 enter/reject 与目录帧，与目录文本渲染域无共享
 * 断言面，故整块迁到本文件；describe 标题沿用原名，fullName 不变。
 */
import { describe, expect, it } from "vitest";

const { renderMcpCatalogMessage, resolveCatalogInjection } =
  await import("../../src/server/catalog/interface.ts");

const supervisors = () =>
  new Map([["s", { server: { name: "s", transport: "stdio" as const, description: "d" } }]]);
const baseDecision = () => ({ kind: "enter", messages: [] });
const plainMessage = (id: string) => ({ id, role: "user", content: [] });

function sameDigestAgent() {
  const entry = [{ name: "s", text: "d" }];
  return {
    entry,
    agentSame: {
      session: {
        surface: { nodes: [1] },
        snapshotEvents: () => [
          {
            type: "user/message",
            seq: 1,
            data: { source: renderMcpCatalogMessage(entry).source! },
          },
        ],
      },
    },
  };
}

function otherDigestAgent() {
  return {
    session: {
      surface: { nodes: [] },
      snapshotEvents: () => [
        {
          type: "user/message",
          seq: 1,
          data: { source: renderMcpCatalogMessage([{ name: "old" }]).source! },
        },
      ],
    },
  };
}

function registerInjectionPassthroughCases() {
  it("reject 直接透传", () => {
    // 1. reject 直接透传。
    const rejected = { kind: "reject", messages: [] };
    expect(resolveCatalogInjection(rejected, [], supervisors(), 6, new Map(), undefined)).toBe(
      rejected,
    );
  });

  it("历史 digest 相同 + 本轮已带目录 → kind 保持 enter", () => {
    // 2. 历史 digest 相同 + 本轮已带目录 → 过滤掉该目录（幂等撤销）。
    const { entry, agentSame } = sameDigestAgent();
    const existingMsg = renderMcpCatalogMessage(entry);
    const decisionWith = { kind: "enter", messages: [plainMessage("keep"), existingMsg] };
    const filtered = resolveCatalogInjection(
      decisionWith,
      [],
      supervisors(),
      6,
      new Map(),
      agentSame,
    );
    expect(filtered.kind).toBe("enter");
  });

  it("历史相同 → 撤销本轮目录消息", () => {
    const { entry, agentSame } = sameDigestAgent();
    const existingMsg = renderMcpCatalogMessage(entry);
    const decisionWith = { kind: "enter", messages: [plainMessage("keep"), existingMsg] };
    const filtered = resolveCatalogInjection(
      decisionWith,
      [],
      supervisors(),
      6,
      new Map(),
      agentSame,
    );
    expect(filtered.messages.map((m) => m.id)).toEqual(["keep"]);
  });

  it("历史 digest 相同 + 本轮无目录 → 原样返回", () => {
    // 3. 历史 digest 相同 + 本轮无目录 → 原样返回。
    const { agentSame } = sameDigestAgent();
    const decisionPlain = { kind: "enter", messages: [plainMessage("k")] };
    expect(resolveCatalogInjection(decisionPlain, [], supervisors(), 6, new Map(), agentSame)).toBe(
      decisionPlain,
    );
  });
}

function registerInjectionPublishCases() {
  it("existing digest 相同 → 不重复追加", () => {
    // 4. 本轮已带相同 digest 的目录且历史不同 → 原样返回（就地复用）。
    const entry = [{ name: "s", text: "d" }];
    const freshExisting = renderMcpCatalogMessage(entry);
    const decisionReuse = { kind: "enter", messages: [freshExisting] };
    const resultReuse = resolveCatalogInjection(
      decisionReuse,
      [],
      supervisors(),
      6,
      new Map(),
      undefined,
    );
    expect(resultReuse.messages.map((m) => m.id)).toEqual([freshExisting.id]);
  });

  it("未发布且空目录 → 保持原样", () => {
    // 5. 未发布且无服务器 → 不注入。
    const emptyResult = resolveCatalogInjection(
      baseDecision(),
      [],
      new Map(),
      6,
      new Map(),
      undefined,
    );
    expect(emptyResult.messages).toEqual([]);
  });

  it("未发布且有服务器 → kind enter", () => {
    // 6. 未发布且有服务器 → 注入普通目录帧（append）。
    const injected = resolveCatalogInjection(
      baseDecision(),
      [],
      supervisors(),
      6,
      new Map(),
      undefined,
    );
    expect(injected.kind).toBe("enter");
  });

  it("未发布且有服务器 → 注入 1 条", () => {
    const injected = resolveCatalogInjection(
      baseDecision(),
      [],
      supervisors(),
      6,
      new Map(),
      undefined,
    );
    expect(injected.messages.length).toBe(1);
  });

  it("首次注入用普通帧", () => {
    const injected = resolveCatalogInjection(
      baseDecision(),
      [],
      supervisors(),
      6,
      new Map(),
      undefined,
    );
    expect(
      injected.messages[0]!.content![0]!.text!.includes(
        "Available MCP servers (capability snapshot):",
      ),
    ).toBeTruthy();
  });
}

function registerInjectionUpdateCases() {
  it("digest 变化 → 更新帧", () => {
    // 6b. 已发布但 digest 变化 → 注入更新帧。
    const updated = resolveCatalogInjection(
      baseDecision(),
      [],
      supervisors(),
      6,
      new Map(),
      otherDigestAgent(),
    );
    expect(updated.messages[0]!.content![0]!.text!.includes("MCP catalog updated")).toBeTruthy();
  });

  it("本轮已有旧目录且 digest 变化 → 替换不追加", () => {
    // 6c. 本轮已有旧目录且 digest 变化 → 原位替换而非追加。
    const stale = renderMcpCatalogMessage([{ name: "stale" }]);
    const replaced = resolveCatalogInjection(
      { kind: "enter", messages: [plainMessage("k2"), stale] },
      [],
      supervisors(),
      6,
      new Map(),
      otherDigestAgent(),
    );
    expect(replaced.messages.length).toBe(2);
  });

  it("替换保留前序消息 id", () => {
    const stale = renderMcpCatalogMessage([{ name: "stale" }]);
    const replaced = resolveCatalogInjection(
      { kind: "enter", messages: [plainMessage("k2"), stale] },
      [],
      supervisors(),
      6,
      new Map(),
      otherDigestAgent(),
    );
    expect(replaced.messages[0].id).toBe("k2");
  });

  it("替换后的消息为更新帧", () => {
    const stale = renderMcpCatalogMessage([{ name: "stale" }]);
    const replaced = resolveCatalogInjection(
      { kind: "enter", messages: [plainMessage("k2"), stale] },
      [],
      supervisors(),
      6,
      new Map(),
      otherDigestAgent(),
    );
    expect(replaced.messages[1]!.content![0]!.text!.includes("MCP catalog updated")).toBeTruthy();
  });

  it("替换后 id 与旧目录不同", () => {
    const stale = renderMcpCatalogMessage([{ name: "stale" }]);
    const replaced = resolveCatalogInjection(
      { kind: "enter", messages: [plainMessage("k2"), stale] },
      [],
      supervisors(),
      6,
      new Map(),
      otherDigestAgent(),
    );
    expect(replaced.messages[1].id).not.toBe(stale.id);
  });
}
describe("resolveCatalogInjection：六条路径", () => {
  registerInjectionPassthroughCases();
  registerInjectionPublishCases();
  registerInjectionUpdateCases();
});
