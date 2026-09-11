// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — 客户端样式注入行为哨兵。
 *
 * vm 沙箱执行真实 lib/client.js（既有沙箱先例形态），documentStub 行为计数断言：
 * - 按 id 注入（dsh-notifier-style + dataset.version）；
 * - 幂等（重复 apply 仅 1 个 <style>）；
 * - disposer 卸载 remove 该 style；
 * - 卸载后再 apply 重新注入（幂等键随节点移除复位）。
 *
 * 形态纪律：仍读 lib 产物字符串 + vm 执行（验证的正是构建产物），不直连 src。
 * 原脚本块为「apply → 断言 → apply → 断言」交错序列：按检查点拆分并用夹具
 * 前缀重放，保证每个用例只观察自己该看到的时点状态。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const clientCode = () => readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");

/** 样式注入夹具：vm 沙箱 + documentStub 计数面。 */
function styleFixture() {
  const code = clientCode();
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

  // ---- 沙箱（先例骨架精简：本段只驱动 apply/disposer 样式路径） ----
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
  vm.runInContext(code, sandbox);
  const mod = loadedFactory === null
    ? null
    : loadedFactory((spec) => {
      if (spec === "react") return { createElement: () => ({}) };
      throw new Error(`unexpected require: ${spec}`);
    });

  const disposers = [];
  const ctx = {
    get(name) {
      if (name === "locale") return { register() {}, bind: () => () => "" };
      return undefined; // slots 缺失：tab 不挂载（通知半区照常）
    },
    effect(fn) { const d = fn(); disposers.push(d); return d; },
  };
  const apply = () => mod.apply(ctx);
  const disposeAll = () => { for (const d of disposers.splice(0)) d(); };
  return { code, counts, headNodes, styleNodes, loadedFactory, mod, apply, disposeAll };
}

describe("客户端样式注入：产物与装配面", () => {
  it("#477：注入 id 进产物", () => {
    expect(clientCode().includes("dsh-notifier-style")).toBeTruthy();
  });

  it("#477：产物 load 已注册 factory", () => {
    expect(styleFixture().loadedFactory !== null).toBeTruthy();
  });

  it("#477：materialize 后 apply 为函数", () => {
    expect(typeof styleFixture().mod.apply).toBe("function");
  });
});

describe("客户端样式注入：按 id 注入与幂等", () => {
  it("#477：首次 apply 注入 1 个 dsh-notifier-style", () => {
    const f = styleFixture();
    f.apply();
    expect(f.styleNodes()).toBe(1);
  });

  it("#477：dataset.version 承载 CSS_VERSION（#640 bump）", () => {
    const f = styleFixture();
    f.apply();
    expect(f.headNodes[0].dataset.version).toBe("640-1");
  });

  it("#477：重复 apply 后仍仅 1 个 style（幂等）", () => {
    // 重复 apply（宿主热更/重挂载）：幂等，仍 1 个，不重建
    const f = styleFixture();
    f.apply();
    f.apply();
    expect(f.styleNodes()).toBe(1);
  });

  it("#477：幂等路径不重建节点", () => {
    const f = styleFixture();
    f.apply();
    f.apply();
    expect(f.counts.created).toBe(1);
  });
});

describe("客户端样式注入：disposer 卸载与重注入", () => {
  it("#477：disposer 卸载后 style 已 remove", () => {
    const f = styleFixture();
    f.apply();
    f.disposeAll();
    expect(f.styleNodes()).toBe(0);
  });

  it("#477：卸载后再 apply 重新注入", () => {
    const f = styleFixture();
    f.apply();
    f.disposeAll();
    // 卸载后再 apply：重新注入（幂等键随节点移除复位）
    f.apply();
    expect(f.styleNodes()).toBe(1);
  });

  it("#477：重注入走新建节点", () => {
    const f = styleFixture();
    f.apply();
    f.disposeAll();
    f.apply();
    expect(f.counts.created).toBe(2);
  });
});
