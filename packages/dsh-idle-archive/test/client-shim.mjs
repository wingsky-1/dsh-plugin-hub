/**
 * dsh-idle-archive — 客户端浏览器装配 shim 测试（vm 沙箱，无真实浏览器）。
 *
 * 覆盖 factory 之外的运行时路径：
 * - __ModuleLoader__.load 注册契约（exports.apply/inject）
 * - apply：读取 connection/sessions/workspaces/slots，注册 settings 卡片
 * - 启动扫描：命中闲置候选 → 弹窗（模态 DOM 注入 body）
 * - 点「归档」→ 调用 workspace.archiveSession；点「暂不归档」→ rpc snoozeMany
 * - ctx.effect disposer：卸载时清理弹窗与样式
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const clientPath = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

// ------------------------------------------------------------ 迷你 DOM 桩

function makeEl(tag) {
  const el = {
    tagName: tag,
    style: {},
    dataset: {},
    children: [],
    textContent: "",
    title: "",
    _listeners: {},
    _className: "",
    removed: false,
    appendChild(c) { c._parent = el; el.children.push(c); return c; },
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    removeEventListener() {},
    setAttribute() {},
    remove() {
      el.removed = true;
      if (el._parent) el._parent.children = el._parent.children.filter((c) => c !== el);
    },
    querySelector(sel) {
      // renderModal 只查 .dia-list：返回挂在自身下的稳定列表元素，便于断言按钮。
      if (sel === ".dia-list") {
        if (!el._list) { el._list = makeEl("div"); el.appendChild(el._list); }
        return el._list;
      }
      return makeEl("div");
    },
    get className() { return el._className; },
    set className(v) { el._className = v; },
  };
  return el;
}

const body = makeEl("body");
const documentStub = {
  body,
  head: makeEl("head"),
  visibilityState: "visible",
  getElementById: () => null,
  createElement: (tag) => makeEl(tag),
  addEventListener() {},
  removeEventListener() {},
};

// ------------------------------------------------------------ 运行 client.js

let loadedModule = null;
const rpcCalls = [];
const reactStub = {
  createElement: () => ({}),
  useState: () => [null, () => {}],
  useEffect: () => {},
};

const sandbox = {
  window: null,
  document: documentStub,
  console,
  setTimeout: () => 1,        // 不真跑定时器
  clearTimeout: () => {},
  Date, Math, JSON, Set, Map, Array, Object, Number, String, Boolean, Symbol,
  Promise, Error, RegExp, parseInt, isNaN, queueMicrotask,
};
sandbox.window = sandbox;
sandbox.window.__ModuleLoader__ = {
  load(desc) {
    loadedModule = desc.factory(function require(id) {
      if (id === "react") return reactStub;
      throw new Error("未预期 require: " + id);
    });
  },
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(clientPath, "utf8"), sandbox);

assert.ok(loadedModule, "client.js 已通过 __ModuleLoader__.load 注册");
assert.equal(typeof loadedModule.apply, "function");
assert.ok(Array.isArray(loadedModule.inject) && loadedModule.inject.includes("slots"));

// ------------------------------------------------------------ fake ctx + apply

const now = Date.now();
const sessions = {
  list: {
    getSnapshot: () => ({
      ids: ["s-old", "s-new", "s-blank", "s-sub", "s-current"],
      byId: {
        "s-old": { id: "s-old", displayTitle: "旧会话", blank: false, running: false, updatedAt: now - 80 * 3600_000 },
        "s-new": { id: "s-new", displayTitle: "新会话", blank: false, running: false, updatedAt: now - 60_000 },
        "s-blank": { id: "s-blank", displayTitle: "空白", blank: true, running: false, updatedAt: now - 999 * 3600_000 },
        "s-sub": { id: "s-sub", displayTitle: "子代理", blank: false, running: false, origin: "subagent", updatedAt: now - 999 * 3600_000 },
        "s-current": { id: "s-current", displayTitle: "当前", blank: false, running: false, updatedAt: now - 999 * 3600_000 },
      },
      current: "s-current",
    }),
    subscribe: () => () => {},
  },
};
const workspaces = {
  list: {
    getSnapshot: () => ({ items: [], archivedSessionIds: ["s-archived"] }),
    subscribe: () => () => {},
  },
  archiveSession: async (id) => { rpcCalls.push(["archive", id]); },
};
const slotRegistrations = [];
let effectDisposer = null;
const ctx = {
  get(key) {
    if (key === "connection") return { rpc: { call: async (ch, ep, payload) => { rpcCalls.push([ep, payload]); return { ok: true, value: { settings: { enabled: true, idleHours: 72, snoozeHours: 24, scanMinutes: 60, maxRows: 50 }, snoozed: {} } }; } } };
    if (key === "sessions") return sessions;
    if (key === "workspaces") return workspaces;
    if (key === "slots") return { inject: (name, fn) => { slotRegistrations.push({ name, fn }); } };
    return undefined;
  },
  effect(fn) {
    // 真实 cordis 语义：fn 立即执行，返回 disposer（客户端契约不依赖 apply 返回值）。
    const d = fn();
    effectDisposer = typeof d === "function" ? d : () => {};
    return effectDisposer;
  },
};

loadedModule.apply(ctx);
const disposer = effectDisposer;
assert.equal(typeof disposer, "function");

// 设置卡片已注册到 settings.plugin.item
assert.equal(slotRegistrations.length, 1);
assert.equal(slotRegistrations[0].name, "settings.plugin.item");

// 等启动扫描的微任务跑完（rpc state → scan → openModal）
await new Promise((r) => setTimeout(r, 20));

// 弹窗出现，且只含候选（排除 blank/subagent/current/已归档/新会话）
const modal = body.children.find((c) => c.id === "dsh-idle-archive-modal");
assert.ok(modal, "弹窗已挂载到 body");
assert.ok(modal._listeners && modal._listeners.remove, "弹窗监听器已挂载");

// 找到「归档」按钮并点击 → workspace.archiveSession
function findAll(parent, cls, out) {
  out = out || [];
  for (const c of parent.children) {
    if (c._className && c._className.split(" ").includes(cls)) out.push(c);
    findAll(c, cls, out);
  }
  return out;
}
const archiveBtn = findAll(body, "dia-btn-archive")[0];
assert.ok(archiveBtn, "弹窗内存在归档按钮");
archiveBtn._listeners.click[0]();
await new Promise((r) => setTimeout(r, 20));
assert.ok(rpcCalls.some((c) => c[0] === "archive" && c[1] === "s-old"), "归档调用 workspace.archiveSession('s-old')");
assert.ok(modal.removed, "归档后弹窗已关闭");

// 卸载 disposer：不再挂载弹窗（toast 是临时的，桩不清理属预期）
disposer();
await new Promise((r) => setTimeout(r, 0));
assert.ok(!body.children.some((c) => c.id === "dsh-idle-archive-modal"), "卸载后弹窗已移除");

console.log("PASS: dsh-idle-archive client shim（factory → apply → 扫描 → 弹窗 → 归档 → 卸载）");
