// @ts-nocheck
/**
 * dsh-notifier — 客户端样式注入行为哨兵（issue #477 验收 3/8）。
 *
 * vm 沙箱执行真实 lib/client.js（#469 先例形态），documentStub 行为计数断言：
 * - 按 id 注入（dsh-notifier-style + dataset.version）；
 * - 幂等（重复 apply 仅 1 个 <style>）；
 * - disposer 卸载 remove 该 style；
 * - 卸载后再 apply 重新注入（幂等键随节点移除复位）。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { assert } from "./helpers.ts";

{
  const clientCode = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(clientCode.includes("dsh-notifier-style"), "#477：注入 id 进产物");

  // ---- documentStub：head 容器数组 + 按 id 索引 + createElement/remove 计数 ----
  const counts = { created: 0, removed: 0 };
  const byId = new Map();
  const nodes = [];
  const headNodes = [];
  function makeStyleNode() {
    const node = {
      id: "",
      textContent: "",
      dataset: {},
      remove() {
        counts.removed += 1;
        const hi = headNodes.indexOf(node);
        if (hi !== -1) headNodes.splice(hi, 1);
        if (node.id !== "" && byId.get(node.id) === node) byId.delete(node.id);
      },
    };
    return node;
  }
  const styleEl = makeStyleNode();
  const listeners = { byType: new Map() };
  const documentStub = {
    visibilityState: "visible",
    title: "",
    hidden: false,
    head: headNodes,
    body: { appendChild() {} },
    getElementById(id) { return byId.get(id) ?? null; },
    createElement(tag) {
      if (tag === "style") {
        counts.created += 1;
        nodes.push(styleEl);
        return styleEl;
      }
      return { appendChild() {}, remove() {}, textContent: "", dataset: {}, style: {} };
    },
    addEventListener(type, fn) {
      if (!listeners.byType.has(type)) listeners.byType.set(type, new Set());
      listeners.byType.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.byType.get(type)?.delete(fn);
    },
  };
  documentStub.head.appendChild = (node) => {
    headNodes.push(node);
    if (node.id !== "") byId.set(node.id, node);
  };
  const styleNodes = () => headNodes.filter((n) => n.id === "dsh-notifier-style").length;

  // ---- 沙箱（#469 同款骨架精简：本段只驱动 apply/disposer 样式路径） ----
  let loadedFactory = null;
  const sandbox = {
    console: { ...console, warn: () => {} },
    Symbol, Object, Array, JSON, Math, Date, Promise,
    setTimeout, clearTimeout,
    EventSource: function () { this.close = () => {}; },
    Notification: function () {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: documentStub,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.window.__ModuleLoader__ = { load(handoff) { loadedFactory = handoff.factory; } };
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox);
  assert.ok(loadedFactory !== null, "#477：产物 load 已注册 factory");
  const mod = loadedFactory((spec) => {
    if (spec === "react") return { createElement: () => ({}) };
    throw new Error(`unexpected require: ${spec}`);
  });
  assert.equal(typeof mod.apply, "function", "#477：materialize 后 apply 为函数");

  const disposers = [];
  const ctx = {
    get(name) {
      if (name === "locale") return { register() {}, bind: () => () => "" };
      return undefined; // slots 缺失：tab 不挂载（通知半区照常）
    },
    effect(fn) { const d = fn(); disposers.push(d); return d; },
  };

  // 首次 apply：按 id 注入 1 个 <style>，dataset.version 承载 CSS_VERSION
  mod.apply(ctx);
  assert.equal(styleNodes(), 1, "#477：首次 apply 注入 1 个 dsh-notifier-style");
  assert.equal(headNodes[0].dataset.version, "508-1", "#477：dataset.version 承载 CSS_VERSION");

  // 重复 apply（宿主热更/重挂载）：幂等，仍 1 个，不重建
  mod.apply(ctx);
  assert.equal(styleNodes(), 1, "#477：重复 apply 后仍仅 1 个 style（幂等）");
  assert.equal(counts.created, 1, "#477：幂等路径不重建节点");

  // disposer 卸载：style 被 remove
  for (const d of disposers.splice(0)) d();
  assert.equal(styleNodes(), 0, "#477：disposer 卸载后 style 已 remove");

  // 卸载后再 apply：重新注入（幂等键随节点移除复位）
  mod.apply(ctx);
  assert.equal(styleNodes(), 1, "#477：卸载后再 apply 重新注入");
  assert.equal(counts.created, 2, "#477：重注入走新建节点");
  for (const d of disposers.splice(0)) d();
}
