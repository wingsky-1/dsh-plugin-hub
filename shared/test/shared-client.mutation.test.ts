import { describe, expect, it } from "vitest";

/**
 * shared/client/** 的**直连 .ts 源**判据（root-shared 变异面，#1074）。
 *
 * 为什么必须重写成这一份，而不是沿用 scripts/test 下的两个 node:test 文件：
 *   ① 旧两文件 import 的是 `shared/client/ensure-style.js` / `i18n.js`——**tsc 原地 emit 的产物**。
 *      istanbul 逐个「被 import 的文件」插桩，而 shared 下的 .js 产物被 not-source 条目排除，
 *      于是 .ts 源恒 0%。这正是 coverage.config.json 里 shared/client/** 那条豁免的成因。
 *   ② 旧两文件由 `node --test` 跑，而 shared/test 下的 mutation 用例由 **vitest** 收集
 *      （root-shared 面，见 mutation-topology.mjs 的 ROOT_SHARED_TEST_ROOT/PATTERN）。
 *   ③ 静态导入图里必须有目标模块，变异体才不是恒 noCoverage——故此处 import **带 .ts 后缀**。
 *
 * 断言一条不少地折自：scripts/test/shared-client-ensure-style.test.ts（8 条）
 * 与 scripts/test/shared-client-i18n.test.ts（5 条）。两个旧文件已删除，不并存两套判据。
 */
import { ensureStyle } from "../client/ensure-style.ts";
import { t, bindLocale } from "../client/i18n.ts";

/* ------------------------------------------------------------------ *
 * ensureStyle：自写 DOM 桩（无 jsdom，#487 documentStub 形态延伸）
 * ------------------------------------------------------------------ */

interface StubNode {
  tag: string;
  id: string;
  textContent: string;
  dataset: Record<string, string>;
  parentElement: unknown;
  remove: () => void;
}
interface StubHead extends Array<StubNode> {
  appendChild?: (node: StubNode) => void;
}
interface StubDocument {
  head: StubHead | null;
  getElementById: (id: string) => StubNode | null;
  createElement: (tag: string) => StubNode;
}
function makeDom() {
  const counts = { created: 0, removed: 0, appended: 0 };
  const byId = new Map<string, StubNode>();
  const nodes: StubNode[] = [];
  const head: StubHead = [];
  function makeNode(tag: string): StubNode {
    const node: StubNode = {
      tag,
      id: "",
      textContent: "",
      dataset: {},
      parentElement: null,
      remove() {
        counts.removed += 1;
        const i = nodes.indexOf(node);
        if (i !== -1) nodes.splice(i, 1);
        const hi = head.indexOf(node);
        if (hi !== -1) head.splice(hi, 1);
        if (node.id !== "" && byId.get(node.id) === node) byId.delete(node.id);
        node.parentElement = null;
      },
    };
    return node;
  }
  head.appendChild = (node: StubNode) => {
    counts.appended += 1;
    node.parentElement = head;
    head.push(node);
    if (node.id !== "") byId.set(node.id, node);
  };
  const documentStub: StubDocument = {
    head,
    getElementById(id: string) {
      return byId.get(id) ?? null;
    },
    createElement(tag: string) {
      counts.created += 1;
      const node = makeNode(tag);
      nodes.push(node);
      return node;
    },
  };
  return { document: documentStub, counts, head, nodes };
}

/** 在桩环境下跑一步（临时替换全局 document，跑完还原）。桩不是完整 Document，
 * 挂载到 globalThis 上是测试 harness 的已知近似（实现侧按鸭子类型只用三成员）。 */
function withDom(dom: { document: StubDocument }, fn: () => void) {
  const prev = globalThis.document;
  globalThis.document = dom.document as unknown as Document;
  try {
    fn();
  } finally {
    globalThis.document = prev;
  }
}

const CSS_A = ".x{color:red}";
const CSS_B = ".x{color:blue}";

describe("shared/client/ensure-style：七项注入契约 + 参数 fail-loud", () => {
  it("首次注入：head 挂 1 个 style 节点，id/cssText 落位", () => {
    const dom = makeDom();
    withDom(dom, () => {
      const dispose = ensureStyle({ id: "dsh-demo-style", cssText: CSS_A });
      expect(typeof dispose).toBe("function");
      expect(dom.head.length).toBe(1);
      expect(dom.nodes[0].tag).toBe("style");
      expect(dom.nodes[0].id).toBe("dsh-demo-style");
      expect(dom.nodes[0].textContent).toBe(CSS_A);
    });
  });

  it("同 id 幂等：重复调用仅 1 节点，不重建", () => {
    const dom = makeDom();
    withDom(dom, () => {
      ensureStyle({ id: "dsh-demo-style", cssText: CSS_A });
      ensureStyle({ id: "dsh-demo-style", cssText: CSS_A });
      expect(dom.head.length).toBe(1);
      expect(dom.counts.created).toBe(1);
      expect(dom.counts.removed).toBe(0);
    });
  });

  it("version 变化 → 旧节点 remove 后重建（热更新失效）", () => {
    const dom = makeDom();
    withDom(dom, () => {
      ensureStyle({ id: "dsh-demo-style", cssText: CSS_A, version: "1" });
      const first = dom.nodes[0];
      expect(first.dataset.version).toBe("1");
      ensureStyle({ id: "dsh-demo-style", cssText: CSS_B, version: "2" });
      expect(dom.head.length).toBe(1);
      expect(dom.counts.removed).toBe(1);
      expect(dom.nodes[0]).not.toBe(first);
      expect(dom.nodes[0].textContent).toBe(CSS_B);
      expect(dom.nodes[0].dataset.version).toBe("2");
    });
  });

  it("同 version → 不重建（节点引用不变、cssText 不覆盖）", () => {
    const dom = makeDom();
    withDom(dom, () => {
      ensureStyle({ id: "dsh-demo-style", cssText: CSS_A, version: "1" });
      const first = dom.nodes[0];
      ensureStyle({ id: "dsh-demo-style", cssText: CSS_B, version: "1" });
      expect(dom.nodes[0]).toBe(first);
      expect(dom.nodes[0].textContent).toBe(CSS_A);
      expect(dom.counts.created).toBe(1);
    });
  });

  it("无 version → 不写 dataset.version", () => {
    const dom = makeDom();
    withDom(dom, () => {
      ensureStyle({ id: "dsh-demo-style", cssText: CSS_A });
      expect(Object.keys(dom.nodes[0].dataset).length).toBe(0);
    });
  });

  it("head 缺失 → 静默 return 不抛（no-op），返回函数可安全调用", () => {
    const dom = makeDom();
    dom.document.head = null;
    withDom(dom, () => {
      expect(() => {
        const dispose = ensureStyle({ id: "dsh-demo-style", cssText: CSS_A });
        expect(typeof dispose).toBe("function");
        dispose();
      }).not.toThrow();
      expect(dom.counts.created).toBe(0);
      expect(dom.counts.appended).toBe(0);
    });
  });

  it("remove（disposer 卸载）后再 ensureStyle → 重新注入", () => {
    const dom = makeDom();
    withDom(dom, () => {
      const dispose = ensureStyle({ id: "dsh-demo-style", cssText: CSS_A });
      expect(dom.head.length).toBe(1);
      dispose();
      expect(dom.head.length).toBe(0);
      expect(dom.counts.removed).toBe(1);
      dispose();
      expect(dom.counts.removed).toBe(1);
      ensureStyle({ id: "dsh-demo-style", cssText: CSS_A });
      expect(dom.head.length).toBe(1);
    });
  });

  it("入参为 null/undefined ⇒ 抛本模块契约消息（options || {} 的假支有判别力）", () => {
    // 为什么这条有判别力而不是装饰：ensure-style.ts:49 是 `const opts = options || {}`。
    // 加 `|| {}` ⇒ opts 为 {} ⇒ 走进下面那条校验 ⇒ 抛**本模块的契约消息**；
    // 去掉 `|| {}`（或换成 `?? {}`）⇒ opts 为 null ⇒ `opts.id` 先炸，
    // 抛的是 `TypeError: Cannot read properties of null (reading 'id')`。
    // 两者消息不同 ⇒ 这条断言能把「防御分支被删掉」打红。
    // （水位不是验证：branches 94.73% 的唯一缺口就是这一支，此前无任何用例走到。）
    const CONTRACT = "ensureStyle: { id, cssText } 为必填且须为字符串（id 非空）";
    expect(() => ensureStyle(null as unknown as Parameters<typeof ensureStyle>[0])).toThrow(
      CONTRACT,
    );
    expect(() => ensureStyle(undefined as unknown as Parameters<typeof ensureStyle>[0])).toThrow(
      CONTRACT,
    );
    // 反向锁定：不得退化成引擎的 TypeError（那说明 || {} 被摘掉）
    expect(() => ensureStyle(null as unknown as Parameters<typeof ensureStyle>[0])).not.toThrow(
      /Cannot read properties of null/,
    );
  });

  it("参数契约：id/cssText 缺失抛 TypeError（编程错误 fail-loud）", () => {
    // 缺字段是故意的反例输入（fail-loud 契约）：实现仍按 JSDoc 把两字段标为必填，测试侧整体断言。
    expect(() => ensureStyle({ cssText: CSS_A } as Parameters<typeof ensureStyle>[0])).toThrow(
      TypeError,
    );
    expect(() => ensureStyle({ id: "x" } as Parameters<typeof ensureStyle>[0])).toThrow(TypeError);
    expect(() => ensureStyle({ id: "", cssText: CSS_A })).toThrow(TypeError);
  });
});

/* ------------------------------------------------------------------ *
 * i18n：活绑定三契约 + 防御分支
 * ⚠️ 串行依赖：本 describe 内用例共享模块级活绑定状态（export let t），
 *    顺序即语义（未装配 → 装配 → 重绑 → 保持）。vitest 同文件内串行执行，
 *    勿给这些用例加 concurrent / 并行。
 * ------------------------------------------------------------------ */

/** 测试侧单点收口（#1028 后续：shared/client/i18n.ts 的入参面改用官方 LocaleRuntime 派生）。
 * 生产面只要求 bindLocale 真正消费的那一个成员（bind），上游改名即 tsc 判红；而本文件要驱动的
 * 恰恰是 i18n 的**运行时防御分支**（无 bind、bind 非函数），这些入参按实现契约有意不合生产类型。
 * 故在此单点收口，不放宽生产声明。 */
function localeStub(stub: object): Parameters<typeof bindLocale>[0] {
  return stub as Parameters<typeof bindLocale>[0];
}

// 模拟调用方：经共享模块活绑定引用翻译函数（对齐各包 client 文件的 import 侧形态）
function readT(key: string, params?: Record<string, unknown>) {
  return t(key, params);
}

describe("shared/client/i18n：活绑定契约 + 防御分支", () => {
  it("未装配时 t 回落 key 本体", () => {
    expect(typeof t).toBe("function");
    expect(readT("some.key", undefined)).toBe("some.key");
    expect(readT("a.key", { name: "x" })).toBe("a.key");
  });

  it("bindLocale(mock) 后 t 命中 mock", () => {
    const calls: unknown[][] = [];
    const bound = (key: string, params: unknown) => {
      calls.push([key, params]);
      return `TRANSLATED:${key}`;
    };
    bindLocale(localeStub({ bind: () => bound }), "test-ns");
    expect(readT("hello", undefined)).toBe("TRANSLATED:hello");
    expect(calls[0]).toEqual(["hello", undefined]);
  });

  it("重绑后调用方即时可见（活绑定语义）", () => {
    bindLocale(localeStub({ bind: () => (key: string) => `FIRST:${key}` }), "ns-a");
    const first = readT("k", undefined);
    bindLocale(localeStub({ bind: () => (key: string) => `SECOND:${key}` }), "ns-b");
    expect(first).toBe("FIRST:k");
    expect(readT("k", undefined)).toBe("SECOND:k");
  });

  it("bindLocale 传 undefined / 无 bind 方法时保持既有 t 不变", () => {
    bindLocale(undefined, "ns");
    expect(typeof t).toBe("function");
    const before = readT("kept", undefined);
    bindLocale(localeStub({}), "ns");
    expect(readT("kept", undefined)).toBe(before);
  });

  it("bindLocale(locale 有 bind 但非函数) 保持既有 t", () => {
    bindLocale(localeStub({ bind: "not-a-function" }), "ns");
    expect(typeof t).toBe("function");
  });
});
