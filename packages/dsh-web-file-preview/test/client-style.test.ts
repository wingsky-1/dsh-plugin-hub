// @ts-nocheck
/**
 * dsh-web-file-preview — 客户端样式注入行为哨兵（issue #477 验收 3/8）。
 *
 * vm 沙箱执行真实 lib/client.js（wrapper/IIFE 自执行 load 注册），documentStub
 * 行为计数断言：按 id 注入（dsh-web-file-preview-style）/ 幂等（重复 apply 仅
 * 1 个 <style>）/ disposer 卸载 remove / 卸载后再 apply 重注入。
 *
 * 本包无 version（cssText 由 STYLE 单点装配，幂等键仅 id）。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

{
  const clientCode = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(clientCode.includes("dsh-web-file-preview-style"), "#477：注入 id 进产物");

  const counts = { created: 0, removed: 0 };
  const byId = new Map();
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
  const documentStub = {
    head: headNodes,
    body: { appendChild() {}, style: {} },
    fullscreenElement: null,
    contains() { return false; },
    getElementById(id) { return byId.get(id) ?? null; },
    createElement(tag) {
      if (tag === "style") {
        counts.created += 1;
        return makeStyleNode();
      }
      // 其它标签（预览 Modal/灯箱等，哨兵不驱动）惰性 no-op
      return { appendChild() {}, remove() {}, textContent: "", dataset: {}, style: {}, classList: { add() {}, remove() {} } };
    },
    addEventListener() {},
    removeEventListener() {},
  };
  documentStub.head.appendChild = (node) => {
    headNodes.push(node);
    if (node.id !== "") byId.set(node.id, node);
  };
  const styleNodes = () => headNodes.filter((n) => n.id === "dsh-web-file-preview-style").length;

  // wrapper 模式：IIFE 自执行直接调 window.__ModuleLoader__.load
  let loadedFactory = null;
  const sandbox = {
    console: { ...console, warn: () => {} },
    Symbol, Object, Array, JSON, Math, Date, Promise,
    setTimeout, clearTimeout,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
    document: documentStub,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.window.matchMedia = undefined; // watchMermaidTheme 无 matchMedia → no-op unwatch
  sandbox.window.__ModuleLoader__ = { load(handoff) { loadedFactory = handoff.factory; } };
  sandbox.window.isSecureContext = false;
  sandbox.window.open = () => null;
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox);
  assert.ok(loadedFactory !== null, "#477：产物 load 已注册 factory");
  const mod = loadedFactory(() => {
    throw new Error("unexpected require（wfp 无 external，内联自包含）");
  });
  assert.equal(typeof mod.apply, "function", "#477：materialize 后 apply 为函数");

  const disposers = [];
  const ctx = {
    // ctx 属性直访（#486-fix）：locale 注册走 shared i18n；sessions/remote 不驱动
    locale: undefined,
    sessions: undefined,
    remote: undefined,
    effect(fn) { const d = fn(); disposers.push(d); return d; },
  };

  mod.apply(ctx);
  assert.equal(styleNodes(), 1, "#477：首次 apply 注入 1 个 dsh-web-file-preview-style");
  assert.equal(headNodes[0].dataset.version, undefined, "#477：无 version 不写 dataset.version");

  mod.apply(ctx);
  assert.equal(styleNodes(), 1, "#477：重复 apply 后仍仅 1 个 style（幂等）");
  assert.equal(counts.created, 1, "#477：幂等路径不重建节点");

  for (const d of disposers.splice(0)) d();
  assert.equal(styleNodes(), 0, "#477：disposer 卸载后 style 已 remove");

  mod.apply(ctx);
  assert.equal(styleNodes(), 1, "#477：卸载后再 apply 重新注入");
  assert.equal(counts.created, 2, "#477：重注入走新建节点");
  for (const d of disposers.splice(0)) d();
}
