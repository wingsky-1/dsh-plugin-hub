// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 双缺省条目与核心化 service describe 族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 尾段 it 族与 describe 整块迁入本文件
// （#192 AC-1/AC-2 双缺省条目干净可序列化、#192 AC-4 目录消息可 append 且去重、
// 核心化 service（#329 阶段1）runtimeRegistry describe）。fullName 与断言逐字保留。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isCatalogSource,
  renderMcpCatalogMessage,
  renderMcpCatalogUpdate,
} from "../../lib/index.js";
import { composeCatalogEntries } from "../../src/server/catalog/interface.ts";
import { makeAgent, runStep } from "./smoke-catalog-injection-support.ts";
import { normalizeServer } from "../../lib/index.js";
import { installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";
import { fakeManagerCtx } from "../helpers.ts";
import { McpManager } from "../../src/server/connection/orchestrator/interface.ts";
import { McpStore } from "../../src/server/store/interface.ts";

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCompositionPorts();
});

// ---------- issue #192：双缺省条目不得产出 text: undefined ----------

it("composeCatalogEntries 双缺省条目干净可序列化（#192 AC-1/AC-2）", () => {
  const supervisors = new Map([
    ["bare-a", { server: { description: "" }, tools: [], toolMeta: new Map() }],
    ["bare-b", { server: {}, tools: [], toolMeta: new Map() }],
    ["with-desc", { server: { description: "有描述" }, tools: [], toolMeta: new Map() }],
  ]);
  const entries = composeCatalogEntries(
    supervisors as unknown as Parameters<typeof composeCatalogEntries>[0],
    6,
    undefined,
  );
  expect(entries.length, "双缺省服务器按名称保留不丢弃").toBe(3);
  expect(entries.map((e) => e.name)).toEqual(["bare-a", "bare-b", "with-desc"]);
  for (const bare of [entries[0], entries[1]]) {
    expect(Object.hasOwn(bare, "text"), `双缺省条目 ${bare.name} 不含 text 属性`).toBe(false);
  }
  expect(entries[2].text).toBe("有描述");

  // AC-2：两条渲染路径的完整消息 JSON 往返后深度相等（载荷无 undefined 属性）
  for (const rendered of [renderMcpCatalogMessage(entries), renderMcpCatalogUpdate(entries)]) {
    expect(() => JSON.stringify(rendered)).not.toThrow();
    expect(JSON.parse(JSON.stringify(rendered)), "完整消息 JSON 往返深度相等").toEqual(rendered);
    // 故「双缺省条目不产出 text: undefined」的约束落在正文渲染上。
    const sections = (rendered.source as unknown as { sections: { text: string }[] }).sections;
    expect(Array.isArray(sections) && sections.length, "snapshot 只有一个目录段").toBe(1);
    for (const name of ["bare-a", "bare-b", "with-desc"]) {
      expect(sections[0].text.includes(`- \`${name}\``), `正文含条目 ${name}`).toBeTruthy();
    }
    expect(
      sections[0].text.includes("- `bare-a`\n"),
      "双缺省条目只渲染服务器名（不产出 text: undefined）",
    ).toBeTruthy();
  }
});

it("双缺省服务器目录消息可 append 为 user/message 且去重（#192 AC-4）", () => {
  const supervisors = new Map([
    ["bare-only", { server: { description: "" }, tools: [], toolMeta: new Map() }],
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
  const catalogEvents = agent.session!.snapshotEvents!().filter(
    (e) => e.type === "user/message" && isCatalogSource(e.data?.source),
  );
  expect(catalogEvents.length, "首轮注入成功（append 为 user/message 未被拒绝）").toBe(1);
  const appended = catalogEvents[0]!.data as unknown as {
    source: { kind: unknown; form: unknown; sections: { text: string }[] };
  };
  expect(appended.source.kind).toBe("plugin:@wingsky-1/dsh-mcp-manager");
  expect(appended.source.form).toBe("snapshot");
  expect(Object.hasOwn(appended.source, "plugin"), "V4 source 不携带旧 plugin 字段").toBe(false);
  expect(
    appended.source.sections[0].text.includes("- `bare-only`"),
    "正文含双缺省服务器名",
  ).toBeTruthy();
  expect(
    () => JSON.stringify(appended),
    "事件载荷可 JSON 序列化（dsh-session 序列化校验等价物）",
  ).not.toThrow();
  expect(JSON.parse(JSON.stringify(appended)), "往返深度相等").toEqual(appended);

  // digest 去重语义不变：同集合再次 pre-step 不重复注入
  result = runStep(
    { kind: "enter", messages: [...messages] },
    messages,
    supervisors,
    undefined,
    agent,
  );
  expect(
    agent.session!.snapshotEvents!().filter(
      (e) => e.type === "user/message" && isCatalogSource(e.data?.source),
    ).length,
    "次轮不重复注入（digest 去重不变）",
  ).toBe(1);
});

// 用 enabled:false 的服务器（不连接、不 spawn 子进程，避免重连悬挂）验证登记语义。

describe("核心化 service（#329 阶段1）：runtimeRegistry / registerServer / unregisterServer", () => {
  let dir: string;
  let store: McpStore;
  let manager: McpManager;
  const quiet = () => ({
    transport: "stdio" as const,
    command: "echo",
    args: ["ok"],
    enabled: false,
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-service-"));
    store = new McpStore(join(dir, "mcp.json"));
    store.data = { version: 1, servers: [] };
    manager = new McpManager(fakeManagerCtx(), store);
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registerServer 新注册 → existing:false 且条目进 runtimeRegistry（不落盘）", async () => {
    const r1 = await manager.registerServer({ name: "svc-a", ...quiet() });
    expect(r1.existing).toBe(false);
    expect(manager.runtimeRegistry.has("svc-a"), "runtime 条目已登记").toBeTruthy();
    expect(!store.find("svc-a"), "不落盘（store 无条目）").toBeTruthy();
  });

  it("同名再注册幂等 → existing:true 不抛错", async () => {
    const r2 = await manager.registerServer({ name: "svc-a", ...quiet() });
    expect(r2.existing, "同名幂等返回 existing").toBe(true);
  });

  it("与 store 同名冲突 → existing:true（不覆盖持久化条目）", async () => {
    store.upsert(normalizeServer({ name: "svc-store", ...quiet() }));
    const r3 = await manager.registerServer({ name: "svc-store", ...quiet() });
    expect(r3.existing, "store 同名返回 existing").toBe(true);
  });

  it("双轨合并：reconcile 后 runtime + store 条目都在 registry（不 spawn）", () => {
    manager.reconcileServers();
    expect(manager.runtimeRegistry.has("svc-a"), "runtime 条目在 registry").toBeTruthy();
    expect(store.find("svc-store") !== undefined, "store 条目保留").toBeTruthy();
  });

  it("unregisterServer 移除 runtime 条目；store 条目不受影响", async () => {
    await manager.unregisterServer("svc-a");
    expect(!manager.runtimeRegistry.has("svc-a"), "runtime 条目已移除").toBeTruthy();
    expect(store.find("svc-store") !== undefined, "store 条目保留").toBeTruthy();
  });

  it("dispose() 拆空全部池单元（含 runtime）", async () => {
    await manager.registerServer({ name: "svc-b", ...quiet() });
    expect(manager.runtimeRegistry.has("svc-b")).toBeTruthy();
    await manager.dispose();
    expect(manager.middleware, "dispose 后中间层实例已释放").toBe(undefined);
  });

  it("reconcile 不杀 runtime 条目（QA 复审回归）", async () => {
    await manager.registerServer({
      name: "svc-all",
      transport: "stdio",
      command: "echo",
      args: ["x"],
      enabled: false,
    });
    manager.reconcileServers();
    expect(manager.runtimeRegistry.has("svc-all"), "runtime 条目保留").toBeTruthy();
  });

  it("#767 笔 2：summary 不再回显 middlewareMode", () => {
    expect("middlewareMode" in manager.summary(), "/servers 的 summary 已无模式字段").toBe(false);
  });

  it("summary 并入 runtime 条目（查询面可见 / disabled 工具列表为空）", async () => {
    await manager.registerServer({ name: "svc-q", ...quiet() });
    const sum = manager.summary() as unknown as {
      servers: { name: string; scope: string; status: string; tools: unknown[] }[];
    };
    const qEntry = sum.servers.find((s: { name: string }) => s.name === "svc-q");
    expect(qEntry !== undefined, "summary 含 runtime 条目（查询面可见）").toBeTruthy();
    expect(qEntry!.scope, "runtime 条目 scope 为 global").toBe("global");
    expect(qEntry!.status, "enabled:false → disabled 状态").toBe("disabled");
    expect(qEntry!.tools, "disabled 服务器工具列表为空").toEqual([]);
  });
});
