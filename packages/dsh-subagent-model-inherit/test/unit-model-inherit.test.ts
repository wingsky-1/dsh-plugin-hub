// @ts-nocheck
/**
 * dsh-subagent-model-inherit — unit：三道门判定 + 注入纯函数 + apply 装配路径。
 *
 * 覆盖（issue #153 单测清单 9 条）：
 * 1. inject 声明正确性
 * 2. apply 在未挂载 agents 服务时静默跳过
 * 3. agent/created 中 origin !== 'subagent' 跳过
 * 4. agent/created 中无 parentSession 跳过
 * 5. 子 Agent 显式 agentOptions（provider/model 与父不同）跳过
 * 6. 快照优先读 parent.session.requestHeader()?.config
 * 7. 快照回退 ctx.agentDefaultModel?.currentSelection()
 * 8. waterfall 首请求注入 provider/model/reasoningEffort
 * 9. waterfall 后续请求跳过（injected 标志）
 *
 * 补充边界：父无日志且无默认模型 → 不注入；快照无 effort 时剥离子的继承
 * effort；采样字段（temperature/maxTokens/stop）保留；fork 型会话不误伤。
 */
import assert from "node:assert/strict";
import { apply, resolveInheritedSelection, injectSelection, name, inject } from "../lib/index.js";

// ---------------------------------------------------------------- 测试基建

/** 构造最小 Session 面：header + requestHeader。 */
function makeSession({ header = {}, headerConfig } = {}) {
  return {
    header,
    requestHeader: () => (headerConfig === undefined ? undefined : { config: headerConfig }),
  };
}

/** 构造最小 Agent 面：id/options/session/ctx。 */
function makeAgent(id, { options = {}, header = {}, headerConfig, on } = {}) {
  const listeners = {};
  return {
    id,
    options,
    session: makeSession({ header, headerConfig }),
    ctx: {
      on: (event, handler) => {
        listeners[event] ??= [];
        listeners[event].push(handler);
      },
    },
    __listeners: listeners,
  };
}

/** 构造 apply() 兼容的 fake 根 ctx：捕获 agent/created handler，可注册服务。 */
function makeRootCtx({ services = {} } = {}) {
  const created = [];
  return {
    get: (service) => services[service],
    // 真实 cordis Context 上服务以同名属性暴露（declare module 类型面）。
    get agents() { return services.agents; },
    on: (event, handler) => {
      if (event === "agent/created") created.push(handler);
    },
    __created: created,
  };
}

const PARENT_HEADER_CONFIG = {
  provider: "deepseek",
  model: "deepseek-chat",
  reasoningEffort: "high",
  temperature: 0.7,
  maxTokens: 4096,
};

// ---------------------------------------------------------------- 纯函数

// #1 inject 声明
assert.deepEqual(inject, ["agents"]);
assert.equal(name, "subagent-model-inherit");

// 门 1：origin 非 subagent / 缺 parentSession
{
  const child = makeAgent("child", { header: { origin: "subagent" } });
  assert.equal(resolveInheritedSelection(child, makeAgent("p"), undefined), undefined,
    "缺 parentSession 应跳过");
  const forkChild = makeAgent("fork", { header: { parentSession: "p" } });
  assert.equal(resolveInheritedSelection(forkChild, makeAgent("p"), undefined), undefined,
    "fork 型会话（无 origin 标记）不应被误伤");
}

// 门 2：父不存在（冷恢复）
{
  const child = makeAgent("child", { header: { origin: "subagent", parentSession: "gone" } });
  assert.equal(resolveInheritedSelection(child, undefined, { provider: "x", model: "y" }), undefined,
    "父已销毁应跳过（即使有 fallback）");
}

// 门 3：显式覆盖跳过
{
  const parent = makeAgent("p", { options: { provider: "deepseek", model: "deepseek-chat" } });
  const child = makeAgent("child", {
    options: { provider: "openai", model: "gpt-x" },
    header: { origin: "subagent", parentSession: "p" },
  });
  assert.equal(resolveInheritedSelection(child, parent, undefined), undefined,
    "显式指定不同模型应跳过");
}

// 未指定 → 注入；#6 快照优先 logged header；采样字段不入快照
{
  const parent = makeAgent("p", { options: { provider: "deepseek", model: "deepseek-chat" }, headerConfig: PARENT_HEADER_CONFIG });
  const child = makeAgent("child", {
    options: { provider: "deepseek", model: "deepseek-chat", maxTokens: 2048 },
    header: { origin: "subagent", parentSession: "p" },
  });
  const sel = resolveInheritedSelection(child, parent, { provider: "fb", model: "fb" });
  assert.deepEqual(sel, { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
    "#6 应优先取父日志 header config");
}

// #7 回退 agentDefaultModel
{
  const parent = makeAgent("p", { options: { provider: "deepseek", model: "deepseek-chat" }, headerConfig: undefined });
  const child = makeAgent("child", {
    options: { provider: "deepseek", model: "deepseek-chat" },
    header: { origin: "subagent", parentSession: "p" },
  });
  const sel = resolveInheritedSelection(child, parent, { provider: "fb", model: "fb-model" });
  assert.deepEqual(sel, { provider: "fb", model: "fb-model" },
    "#7 父无日志时应回退默认模型选择");
}

// 父无日志且无 fallback → undefined
{
  const parent = makeAgent("p", { options: {} });
  const child = makeAgent("child", { header: { origin: "subagent", parentSession: "p" }, options: {} });
  assert.equal(resolveInheritedSelection(child, parent, undefined), undefined);
}

// injectSelection：三字段覆盖 + effort 剥离语义 + 采样保留
{
  const out = injectSelection(
    { provider: "base-p", model: "base-m", reasoningEffort: "low", temperature: 0.5, maxTokens: 100, stop: ["END"] },
    { provider: "snap-p", model: "snap-m", reasoningEffort: "high" },
  );
  assert.deepEqual(out, {
    provider: "snap-p", model: "snap-m", reasoningEffort: "high",
    temperature: 0.5, maxTokens: 100, stop: ["END"],
  }, "覆盖 provider/model/effort，其余采样字段原样保留");

  const cleared = injectSelection(
    { provider: "a", model: "b", reasoningEffort: "low" },
    { provider: "a", model: "b" },
  );
  assert.equal(cleared.reasoningEffort, undefined,
    "快照无 effort 时应剥离继承 effort（对齐 installModelSelection 语义）");
  assert.ok(!("reasoningEffort" in cleared), "effort 键应彻底缺席而非 undefined 残留");
}

// ---------------------------------------------------------------- apply 装配路径

// #2 未挂载 agents 静默跳过
{
  const root = makeRootCtx({ services: {} });
  apply(root);
  assert.equal(root.__created.length, 0, "缺 agents 服务时不得注册监听");
}

// #3–#9 全链路：经 apply 注册的 created handler 驱动
function setupWorld({ childOptions, parentHeaderConfig, defaultSelection }) {
  const parent = makeAgent("parent-1", {
    options: { provider: "deepseek", model: "deepseek-chat" },
    headerConfig: parentHeaderConfig,
  });
  const child = makeAgent("child-1", {
    options: childOptions,
    header: { origin: "subagent", parentSession: "parent-1" },
  });
  const root = makeRootCtx({
    services: {
      agents: { get: (id) => (id === "parent-1" ? parent : undefined) },
      ...(defaultSelection === undefined ? {} : { agentDefaultModel: { currentSelection: () => defaultSelection } }),
    },
  });
  apply(root);
  assert.equal(root.__created.length, 1, "应注册 agent/created 监听");
  return { parent, child, fire: () => root.__created[0]({ agent: child }) };
}

// 未指定模型 → 注入首请求（#6/#8），后续请求跳过（#9）
{
  const world = setupWorld({
    childOptions: { provider: "deepseek", model: "deepseek-chat" },
    parentHeaderConfig: PARENT_HEADER_CONFIG,
  });
  world.fire();
  const wf = world.child.__listeners["agent/request"];
  assert.equal(wf?.length, 1, "#8 应在子 scope 安装恰好一个 waterfall");

  const next = async () => ({
    provider: "deepseek", model: "deepseek-chat", reasoningEffort: "medium",
    temperature: 1, maxTokens: 8192,
  });
  const first = await wf[0]({}, next);
  assert.deepEqual(first, {
    provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high",
    temperature: 1, maxTokens: 8192,
  }, "首请求应注入父快照（含 effort），保留采样字段");
  const second = await wf[0]({}, next);
  assert.equal(second.reasoningEffort, "medium", "#9 第二次请求应原样放行（injected 标志）");
}

// 显式覆盖 → 不装 waterfall（#5）；origin 不符 → 不装（#3）；父不存在 → 不装（#4 经 get 返回 undefined）
{
  const overridden = setupWorld({
    childOptions: { provider: "openai", model: "gpt-x" },
    parentHeaderConfig: PARENT_HEADER_CONFIG,
  });
  overridden.fire();
  assert.equal(overridden.child.__listeners["agent/request"], undefined, "#5 显式覆盖不得安装 waterfall");

  const noOrigin = makeRootCtx({
    services: { agents: { get: () => makeAgent("p") } },
  });
  apply(noOrigin);
  const plainChild = makeAgent("c", { header: { parentSession: "p" } });
  noOrigin.__created[0]({ agent: plainChild });
  assert.equal(plainChild.__listeners["agent/request"], undefined, "#3 非 subagent origin 不得安装");

  const deadParent = makeRootCtx({ services: { agents: { get: () => undefined } } });
  apply(deadParent);
  const orphan = makeAgent("c", { header: { origin: "subagent", parentSession: "ghost" } });
  deadParent.__created[0]({ agent: orphan });
  assert.equal(orphan.__listeners["agent/request"], undefined, "#4 父不存在不得安装");
}

console.log("unit-model-inherit: all assertions passed");
