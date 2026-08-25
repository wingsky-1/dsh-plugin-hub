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
// 父带可注入快照：若门误放行，后续会取到快照返回非 undefined，从而暴露漏洞
{
  const injectableParent = makeAgent("p", { options: {}, headerConfig: PARENT_HEADER_CONFIG });
  const child = makeAgent("child", { header: { origin: "subagent" } });
  assert.equal(resolveInheritedSelection(child, injectableParent), undefined,
    "缺 parentSession 应跳过");
  const forkChild = makeAgent("fork", {
    header: { parentSession: "p" },
    options: {},
    headerConfig: PARENT_HEADER_CONFIG,
  });
  assert.equal(resolveInheritedSelection(forkChild, injectableParent), undefined,
    "fork 型会话（无 origin 标记）不应被误伤");
}

// 门 2：父不存在（冷恢复）
{
  const child = makeAgent("child", { header: { origin: "subagent", parentSession: "gone" } });
  assert.equal(resolveInheritedSelection(child, undefined), undefined,
    "父已销毁应跳过");
}

// 门 3：显式覆盖跳过（含单字段不等的或语义分支）
// 父带可注入快照：若门误放行会取到快照，从而暴露漏洞
{
  const parent = makeAgent("p", {
    options: { provider: "deepseek", model: "deepseek-chat" },
    headerConfig: PARENT_HEADER_CONFIG,
  });
  const child = makeAgent("child", {
    options: { provider: "openai", model: "gpt-x" },
    header: { origin: "subagent", parentSession: "p" },
  });
  assert.equal(resolveInheritedSelection(child, parent), undefined,
    "显式指定不同模型应跳过");
  // 或语义分支：仅单字段不等也必须跳过
  const provOnly = makeAgent("child", {
    options: { provider: "openai", model: "deepseek-chat" },
    header: { origin: "subagent", parentSession: "p" },
  });
  assert.equal(resolveInheritedSelection(provOnly, parent), undefined,
    "仅 provider 不同也应跳过");
  const modelOnly = makeAgent("child", {
    options: { provider: "deepseek", model: "other-model" },
    header: { origin: "subagent", parentSession: "p" },
  });
  assert.equal(resolveInheritedSelection(modelOnly, parent), undefined,
    "仅 model 不同也应跳过");
}

// 未指定 → 注入；#6 快照取 logged header；采样字段不入快照
{
  const parent = makeAgent("p", { options: { provider: "deepseek", model: "deepseek-chat" }, headerConfig: PARENT_HEADER_CONFIG });
  const child = makeAgent("child", {
    options: { provider: "deepseek", model: "deepseek-chat", maxTokens: 2048 },
    header: { origin: "subagent", parentSession: "p" },
  });
  const sel = resolveInheritedSelection(child, parent);
  assert.deepEqual(sel, { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
    "#6 应取父日志 header config");
}

// 父无日志 → 放行（undefined）：门 3 已保证子 options 与父相等，放行即真继承；
// 注入部署默认反而会在「父以非默认模型初始化且未发请求就委派」时改错路由（评审 M1）
{
  const parent = makeAgent("p", { options: { provider: "deepseek", model: "parent-custom" }, headerConfig: undefined });
  const child = makeAgent("child", {
    options: { provider: "deepseek", model: "parent-custom" },
    header: { origin: "subagent", parentSession: "p" },
  });
  assert.equal(resolveInheritedSelection(child, parent), undefined,
    "父无日志时应放行（不注入部署默认，评审 M1 回归钉死）");
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
function setupWorld({ childOptions, parentHeaderConfig }) {
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
  assert.deepEqual(second, {
    provider: "deepseek", model: "deepseek-chat", reasoningEffort: "medium",
    temperature: 1, maxTokens: 8192,
  }, "#9 第二次请求应整体原样放行（injected 标志，含 provider/model）");
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
