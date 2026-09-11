// @ts-nocheck
/**
 * dsh-lan-proxy — 客户端样式注入行为哨兵（issue #477 验收 3/8）。
 *
 * vm 沙箱执行真实 lib/client.js（#469/#487 先例形态），documentStub 行为计数断言：
 * - 按 id 注入（dsh-lan-proxy-style + dataset.version=CSS_VERSION）；
 * - 幂等（重复 apply 仅 1 个 <style>，不重建）；
 * - disposer 卸载 remove 该 style（getElementById(STYLE_ID) 沿用常量）；
 * - 卸载后再 apply 重新注入。
 *
 * 本文件由脚本式断言迁为 vitest 结构化用例（#722 阶段 1）：原每条 assert 一个 it。
 * 原块是「动作 → 断言 → 新动作 → 新断言」的交错序列，故 beforeAll 逐行保留原动作
 * 顺序、并在每个原断言位置取观测快照——每个 it 断言的仍是各自当时的观测值。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

describe("客户端样式注入行为哨兵（issue #477 验收 3/8）", () => {
  let injectIdInProduct;
  let factoryRegistered;
  let applyIsFunction;
  let nodesAfterFirstApply;
  let datasetVersionAfterFirstApply;
  let nodesAfterSecondApply;
  let createdAfterSecondApply;
  let nodesAfterDispose;
  let nodesAfterReapply;
  let createdAfterReapply;

  beforeAll(() => {
    const clientCode = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
    injectIdInProduct = clientCode.includes("dsh-lan-proxy-style");

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
    const styleEl = makeStyleNode();
    const documentStub = {
      head: headNodes,
      body: { appendChild() {} },
      getElementById(id) { return byId.get(id) ?? null; },
      createElement(tag) {
        if (tag === "style") {
          counts.created += 1;
          return styleEl;
        }
        return { appendChild() {}, remove() {}, textContent: "", dataset: {}, style: {} };
      },
      addEventListener() {},
      removeEventListener() {},
    };
    documentStub.head.appendChild = (node) => {
      headNodes.push(node);
      if (node.id !== "") byId.set(node.id, node);
    };
    const styleNodes = () => headNodes.filter((n) => n.id === "dsh-lan-proxy-style").length;

    let loadedFactory = null;
    const sandbox = {
      console: { ...console, warn: () => {} },
      Symbol, Object, Array, JSON, Math, Date, Promise,
      setTimeout, clearTimeout,
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
      document: documentStub,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    sandbox.window = sandbox;
    sandbox.window.__ModuleLoader__ = { load(handoff) { loadedFactory = handoff.factory; } };
    vm.createContext(sandbox);
    vm.runInContext(clientCode, sandbox);
    factoryRegistered = loadedFactory !== null;
    const mod = loadedFactory((spec) => {
      if (spec === "react") return { createElement: () => ({}) };
      throw new Error(`unexpected require: ${spec}`);
    });
    applyIsFunction = typeof mod.apply;

    const disposers = [];
    const ctx = {
      // slots 必须在（缺失则 apply 提前 return）：inject 只注册不执行回调
      get(name) {
        if (name === "slots") return { inject() {}, register() {} };
        if (name === "locale") return { register() {}, bind: () => () => "" };
        return undefined;
      },
      effect(fn) { const d = fn(); disposers.push(d); return d; },
    };

    mod.apply(ctx);
    nodesAfterFirstApply = styleNodes();
    datasetVersionAfterFirstApply = headNodes[0].dataset.version;

    mod.apply(ctx);
    nodesAfterSecondApply = styleNodes();
    createdAfterSecondApply = counts.created;

    for (const d of disposers.splice(0)) d();
    nodesAfterDispose = styleNodes();

    mod.apply(ctx);
    nodesAfterReapply = styleNodes();
    createdAfterReapply = counts.created;
    for (const d of disposers.splice(0)) d();
  });

  it("#477：注入 id 进产物", () => {
    expect(injectIdInProduct).toBe(true);
  });

  it("#477：产物 load 已注册 factory", () => {
    expect(factoryRegistered).toBe(true);
  });

  it("#477：materialize 后 apply 为函数", () => {
    expect(applyIsFunction).toBe("function");
  });

  it("#477：首次 apply 注入 1 个 dsh-lan-proxy-style", () => {
    expect(nodesAfterFirstApply).toBe(1);
  });

  it("#477：dataset.version 承载 CSS_VERSION", () => {
    expect(datasetVersionAfterFirstApply).toBe("4");
  });

  it("#477：重复 apply 后仍仅 1 个 style（幂等）", () => {
    expect(nodesAfterSecondApply).toBe(1);
  });

  it("#477：幂等路径不重建节点", () => {
    expect(createdAfterSecondApply).toBe(1);
  });

  it("#477：disposer 卸载后 style 已 remove", () => {
    expect(nodesAfterDispose).toBe(0);
  });

  it("#477：卸载后再 apply 重新注入", () => {
    expect(nodesAfterReapply).toBe(1);
  });

  it("#477：重注入走新建节点", () => {
    expect(createdAfterReapply).toBe(2);
  });
});
