// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 目录注入（pre-step）族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的 resolveCatalogInjection it 族整块迁入本文件
// （history-based 去重、描述/缓存变化不注入、compaction 后重建 + 门控 + reject），
// 连同其 makeAgent / runStep 测试桩。fullName 与断言逐字保留（顶层 it 原名，不新增 describe 层级）。
import { expect, it } from "vitest";
import { isCatalogSource, resolveCatalogInjection } from "../../lib/index.js";
import { makeAgent, runStep } from "./smoke-catalog-injection-support.ts";

// ---------- pre-step 目录注入（history-based 去重，复刻官方 tool-skill 语义）

it("resolveCatalogInjection：history-based 去重（核心：多轮不重复注入）", () => {
  const supervisors = new Map([
    ["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }],
  ]) as unknown as Parameters<typeof resolveCatalogInjection>[2];
  const agent = makeAgent();

  // 真实语义：decision.messages 只含本轮新消息（历史在 session.snapshotEvents()）
  let historyCount = 0;
  for (let round = 1; round <= 5; round += 1) {
    const decision = {
      kind: "enter",
      messages: [{ id: `user-${round}`, role: "user", content: [] }],
    };
    const result = runStep(decision, decision.messages, supervisors, undefined, agent);
    historyCount = agent.session!.snapshotEvents!().filter(
      (e) => e.type === "user/message" && isCatalogSource(e.data?.source),
    ).length;
    const inMessages = result.messages.filter((m) => isCatalogSource(m.source)).length;
    if (round === 1) {
      expect(historyCount, "首轮注入 1 条").toBe(1);
      expect(inMessages, "首轮消息列表含目录").toBe(1);
    } else {
      expect(historyCount, `第 ${round} 轮历史目录消息恒为 1（不累积）`).toBe(1);
      expect(inMessages, `第 ${round} 轮不注入新消息`).toBe(0);
    }
  }
  expect(historyCount, "5 轮后目录消息仍只有 1 条（根治重复注入）").toBe(1);
});

it("resolveCatalogInjection：描述/缓存变化不注入、集合变化注入更新消息", () => {
  const base = new Map([
    ["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }],
  ]) as unknown as Parameters<typeof resolveCatalogInjection>[2];
  const agent = makeAgent();
  let messages: Parameters<typeof resolveCatalogInjection>[1] = [
    { id: "m1", role: "user", content: [] },
  ];

  // 首次注入
  let result = runStep(
    { kind: "enter", messages: [...messages] },
    messages,
    base,
    undefined,
    agent,
  );
  messages = result.messages;
  const firstId = (
    agent.session!.snapshotEvents!().find((e) => isCatalogSource(e.data?.source))!
      .data as unknown as { id: unknown }
  ).id;
  expect(firstId, "首次注入").toBeTruthy();

  // 描述变化（集合不变）→ 不注入
  const descChanged = new Map([
    ["code-graph", { server: { description: "新描述" }, tools: [], toolMeta: new Map() }],
  ]) as unknown as Parameters<typeof resolveCatalogInjection>[2];
  result = runStep(
    { kind: "enter", messages: [...messages, { id: "u2", role: "user", content: [] }] },
    messages,
    descChanged,
    undefined,
    agent,
  );
  expect(
    agent.session!.snapshotEvents!().filter((e) => isCatalogSource(e.data?.source)).length,
    "描述变化不注入",
  ).toBe(1);

  // 集合变化（新增服务器）→ 注入"更新"消息（历史 1 + 更新 1，声明作废旧目录）
  const added = new Map([
    ["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }],
    ["playwright", { server: { description: "浏览器自动化" }, tools: [], toolMeta: new Map() }],
  ]) as unknown as Parameters<typeof resolveCatalogInjection>[2];
  result = runStep(
    { kind: "enter", messages: [...messages, { id: "u3", role: "user", content: [] }] },
    messages,
    added,
    undefined,
    agent,
  );
  const afterAdd = agent.session!.snapshotEvents!().filter((e) => isCatalogSource(e.data?.source));
  expect(afterAdd.length, "集合变化注入更新消息（历史目录无法删除，新消息声明作废）").toBe(2);
  const afterAddContent = (afterAdd[1]!.data as unknown as { content: { text: string }[] }).content;
  expect(afterAddContent[0]!.text).toMatch(/replaces all previous available_mcp_servers/);
  expect(afterAddContent[0]!.text).toMatch(/playwright/);

  // 更新后同集合不再注入
  result = runStep(
    { kind: "enter", messages: [...messages, { id: "u4", role: "user", content: [] }] },
    messages,
    added,
    undefined,
    agent,
  );
  expect(
    agent.session!.snapshotEvents!().filter((e) => isCatalogSource(e.data?.source)).length,
    "更新后不再注入",
  ).toBe(2);
});

it("resolveCatalogInjection：compaction 后重建 + 门控 + reject", () => {
  const supervisors = new Map([
    ["code-graph", { server: { description: "代码图谱" }, tools: [], toolMeta: new Map() }],
  ]) as unknown as Parameters<typeof resolveCatalogInjection>[2];
  const agent = makeAgent();
  let messages: Parameters<typeof resolveCatalogInjection>[1] = [
    { id: "m1", role: "user", content: [] },
  ];
  let result = runStep(
    { kind: "enter", messages: [...messages] },
    messages,
    supervisors,
    undefined,
    agent,
  );
  messages = result.messages;
  expect(
    agent.session!.snapshotEvents!().filter((e) => isCatalogSource(e.data?.source)).length,
    "首次注入",
  ).toBe(1);

  // compaction 模拟：surface 清空（旧目录不可见）→ 重新注入
  (agent.session as unknown as { surface: { nodes: Set<number> } }).surface.nodes.clear();
  result = runStep(
    { kind: "enter", messages: [{ id: "m1", role: "user", content: [] }] },
    messages,
    supervisors,
    undefined,
    agent,
  );
  const afterCompact = agent.session!.snapshotEvents!().filter((e) =>
    isCatalogSource(e.data?.source),
  );
  expect(afterCompact.length >= 1, "compaction 后按可见性重建").toBeTruthy();
  expect(result.messages.filter((m) => isCatalogSource(m.source)).length).toBe(1);

  // 门控：从未发布且无服务器 → 不注入
  const agent2 = makeAgent();
  const decisionEmpty = resolveCatalogInjection(
    { kind: "enter", messages: [{ id: "x", role: "user", content: [] }] },
    [],
    new Map(),
    6,
    undefined,
    agent2,
  );
  expect(decisionEmpty.messages.length, "无服务器不注入").toBe(1);

  // reject 不处理
  const rejected = resolveCatalogInjection(
    { kind: "reject", messages: [] } as unknown as Parameters<typeof resolveCatalogInjection>[0],
    [],
    supervisors,
    6,
    undefined,
    agent2,
  );
  expect(rejected.kind).toBe("reject");
});
