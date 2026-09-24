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

interface StyleTestNode {
  id: string;
  textContent: string;
  dataset: Record<string, string>;
  remove(): void;
}
/** vm 沙箱 factory 形态：require 按 spec 解析；模块 apply 接收未知上下文。 */
type StyleTestFactory = (require: (spec: string) => unknown) => {
  apply: (ctx: unknown) => unknown;
  inject: string[];
};

describe("客户端样式注入行为哨兵（issue #477 验收 3/8）", () => {
  let injectIdInProduct = false;
  let factoryRegistered = false;
  let applyIsFunction = "";
  let nodesAfterFirstApply = 0;
  let datasetVersionAfterFirstApply = "";
  let nodesAfterSecondApply = 0;
  let createdAfterSecondApply = 0;
  let nodesAfterDispose = 0;
  let nodesAfterReapply = 0;
  let createdAfterReapply = 0;
  let productInject: string[] = [];
  let packageClientInject: string[] = [];

  beforeAll(() => {
    const clientCode = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
    injectIdInProduct = clientCode.includes("dsh-lan-proxy-style");

    const counts = { created: 0, removed: 0 };
    const byId = new Map<string, StyleTestNode>();
    const headNodes: StyleTestNode[] = [];
    function makeStyleNode(): StyleTestNode {
      const node: StyleTestNode = {
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
    const documentStub: {
      head: StyleTestNode[] & { appendChild?(node: StyleTestNode): void };
      body: { appendChild(): void };
      getElementById(id: string): StyleTestNode | null;
      createElement(tag: string): unknown;
      addEventListener(): void;
      removeEventListener(): void;
    } = {
      head: headNodes,
      body: { appendChild() {} },
      getElementById(id: string) {
        return byId.get(id) ?? null;
      },
      createElement(tag: string) {
        if (tag === "style") {
          counts.created += 1;
          return styleEl;
        }
        return { appendChild() {}, remove() {}, textContent: "", dataset: {}, style: {} };
      },
      addEventListener() {},
      removeEventListener() {},
    };
    documentStub.head.appendChild = (node: StyleTestNode) => {
      headNodes.push(node);
      if (node.id !== "") byId.set(node.id, node);
    };
    const styleNodes = () =>
      headNodes.filter((n: StyleTestNode) => n.id === "dsh-lan-proxy-style").length;

    let loadedFactory: unknown = null;
    const sandbox: Record<string, unknown> = {
      console: { ...console, warn: () => {} },
      Symbol,
      Object,
      Array,
      JSON,
      Math,
      Date,
      Promise,
      setTimeout,
      clearTimeout,
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
      document: documentStub,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    sandbox["window"] = sandbox;
    (sandbox["window"] as Record<string, unknown>)["__ModuleLoader__"] = {
      load(handoff: { factory: StyleTestFactory }) {
        loadedFactory = handoff.factory;
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(clientCode, sandbox);
    factoryRegistered = loadedFactory !== null;
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { dsh: { client: { inject: string[] } } };
    packageClientInject = [...packageJson.dsh.client.inject];
    const mod = (loadedFactory as StyleTestFactory)((spec: string) => {
      if (spec === "react") {
        return { createElement: (_type: unknown, props: unknown) => ({ props }) };
      }
      throw new Error(`unexpected require: ${spec}`);
    });
    applyIsFunction = typeof mod.apply;
    productInject = [...mod.inject];

    const disposers: Array<() => void> = [];
    const ctx = {
      // slots 必须在（缺失则 apply 提前 return）：inject 只注册不执行回调
      get(name: string): unknown {
        if (name === "slots") return { inject() {}, register() {} };
        if (name === "configForms") return { whileServed: () => () => {} };
        if (name === "locale") return { register() {}, bind: () => () => "" };
        return undefined;
      },
      effect(fn: () => () => void) {
        const d = fn();
        disposers.push(d);
        return d;
      },
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

  it("0.1.7-rc.1：产物 inject 精确声明当前服务依赖", () => {
    expect(productInject).toEqual(["slots", "configForms", "locale", "remote"]);
  });

  it("0.1.7-rc.1：package client inject 精确声明当前 providers", () => {
    expect(packageClientInject).toEqual([
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-slots",
    ]);
  });
});
