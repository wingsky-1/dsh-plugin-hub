// @vitest-environment happy-dom
/**
 * dsh-mcp-manager — client-dom：core/dom.ts 的直接判据（pangu 与 el 的属性通道）。
 *
 * 环境声明必须落在文件里（变异面按拓扑派生的是单 project node 环境配置，本层要进
 * 变异面就得自带环境）。
 *
 * 守的事实（每条一句话）：
 * - pangu：CJK↔拉丁/数字两个方向都插半角空格；**类内不得有裸连字符**（把
 *   `project-1` 撕成 `project- 1` 是本函数历史上真实出现过的 bug）——任一改动必须红。
 * - el 的属性通道：class 走 className、text 走 textContent、dataset 走 dataset、
 *   on* 走事件监听、checked/disabled 走**属性而非 attribute**、children 跳过、
 *   其余走 setAttribute。任一通道被改道必须红。
 * - 子节点：第三位置参数与 attrs.children 两种传法等价；字符串建文本节点；
 *   null/undefined 跳过。
 *
 * 这三条正是覆盖台账里对本文件的判词所指：「水位看似达标（94.44%）但零断言信号」。
 * 本文件此前无任何直连判据，94.44% 全是 float/panel/quick-add 渲染路径的顺带执行——
 * 改坏 pangu 与属性通道后全量测试仍全绿。本文件的存在就是为了让那类改动打红。
 */
import { afterEach, describe, expect, it } from "vitest";

import { el, pangu } from "../../src/client/core/dom.ts";

afterEach(() => {
  document.body.textContent = "";
});

describe("dom：pangu 盘古之白", () => {
  it("中文在前、拉丁在后 → 插一个半角空格", () => {
    expect(pangu("共 3 台")).toBe("共 3 台");
    expect(pangu("失败2台")).toBe("失败 2 台");
  });

  it("拉丁在前、中文在后 → 插一个半角空格（反方向同样成立）", () => {
    expect(pangu("3 台服务器")).toBe("3 台服务器");
    expect(pangu("MCP管理器")).toBe("MCP 管理器");
  });

  it("连字符在字符类内：CJK 后接连字符仍插一个空格（真测连字符归属）", () => {
    // 这一条才是「连字符归属」的真判据。上一版写成 pangu("project-1") === "project-1"，
    // 那是**装饰性断言**：串里没有 CJK，无论连字符在不在类里都不会插空格，改坏也不红。
    // 真测法必须让连字符紧跟 CJK——`-` 在类里时 `目` 与 `-` 之间要插空格；
    // 连字符被解析成范围运算符而丢掉时，输出仍是 `项目-1`，两者可区分。
    expect(pangu("项目-1")).toBe("项目 -1");
    expect(pangu("中文-abc")).toBe("中文 -abc");
  });

  it("纯标识符/服务器名不插空格（纯拉丁无 CJK 时 pangu 是恒等）", () => {
    expect(pangu("project-1")).toBe("project-1");
    expect(pangu("dsh-mcp-manager")).toBe("dsh-mcp-manager");
  });

  it("字符类边界：逗号/句点/冒号/分号不在类内，不触发插空", () => {
    // 钉住字符类的**外沿**，这是 dom.ts 头注释「如需扩面先补单测再放宽」这条契约的载体。
    // 去掉 `\-` 的转义会让 `+` 与 `/` 之间形成范围 0x2B-0x3D，把 , . : ; 一并吞进类里，
    // 这四种标点就会开始插空格。踩这条即红。
    expect(pangu("项目,值")).toBe("项目,值");
    expect(pangu("项目.值")).toBe("项目.值");
    expect(pangu("项目:值")).toBe("项目:值");
    expect(pangu("项目;值")).toBe("项目;值");
  });
  it("标识符下划线与点号不受影响（非字母数字不入插字符类）", () => {
    expect(pangu("a_b")).toBe("a_b");
    expect(pangu("a.b")).toBe("a.b");
  });

  it("纯中文 / 纯拉丁不插空格（无混排即无操作）", () => {
    expect(pangu("运行中")).toBe("运行中");
    expect(pangu("Running")).toBe("Running");
    expect(pangu("")).toBe("");
  });

  it("非字符串输入经 String() 归一（不抛）", () => {
    expect(pangu(undefined as unknown as string)).toBe("undefined");
    expect(pangu(42 as unknown as string)).toBe("42");
  });

  it("假名/谚文不在覆盖范围（本文件注释自承的边界，不扩面也不误插）", () => {
    // 覆盖面说明写明仅 CJK 统一表意文字 + 兼容区。钉住这条是为了「改覆盖面必须改本用例」
    // 而不是悄悄扩面——扩面要先补单测（见 dom.ts 头注释）。
    expect(pangu("サーバ")).toBe("サーバ");
  });
});

describe("dom：el 的属性通道归属", () => {
  it("class 走 className（不是 setAttribute）", () => {
    const node = el("div", { class: "a b" });
    expect(node.className).toBe("a b");
    expect(node.getAttribute("class")).toBe("a b");
  });

  it('class 为 null / undefined → 空串（不得写成 className="undefined"）', () => {
    expect(el("div", { class: null }).className).toBe("");
    expect(el("div", { class: undefined }).className).toBe("");
  });

  it("text 走 textContent（不是 innerHTML，故不解析标签）", () => {
    const node = el("div", { text: "<b>x</b>" });
    expect(node.textContent).toBe("<b>x</b>");
    expect(node.querySelector("b")).toBeNull();
  });

  it("dataset 逐键落到 dataset（驼峰键映射为 data-* 属性）", () => {
    const node = el("div", { dataset: { dmServer: "srv", dmStagger: "1" } });
    expect(node.dataset.dmServer).toBe("srv");
    expect(node.getAttribute("data-dm-server")).toBe("srv");
    expect(node.getAttribute("data-dm-stagger")).toBe("1");
  });

  it("on* 走事件监听（键前缀 on 被剥掉）", () => {
    let hits = 0;
    const node = el("button", {
      onclick: () => {
        hits += 1;
      },
    });
    node.dispatchEvent(new Event("click"));
    expect(hits).toBe(1);
  });

  it("checked 走属性而非 attribute（表单控件语义位）", () => {
    const node = el("input", { type: "checkbox", checked: true });
    expect((node as HTMLInputElement).checked).toBe(true);
    // 走 setAttribute 的话 checked 会变成 "true" 字符串而属性位为 false——这里钉住分道。
    expect(node.hasAttribute("checked")).toBe(false);
  });

  it("disabled 走属性位（表单控件语义位）", () => {
    const node = el("button", { disabled: true });
    expect((node as HTMLButtonElement).disabled).toBe(true);
    // 刻意**不**断言 hasAttribute("disabled") === false：按 HTML 规范 disabled 是
    // 「反射」IDL 属性（set .disabled 会同步反映到 content attribute），而 checked
    // 不是（设置 .checked 只翻 dirty checkedness flag）。两者在 attribute 上的可见性
    // 本就不同，拿 attribute 可见性当「通道归属」的判据是错的——这里只钉属性位取值。
    expect((el("button", { disabled: false }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("checked: false / disabled: false 也落到属性（不是「假值就跳过」）", () => {
    expect((el("input", { checked: false }) as HTMLInputElement).checked).toBe(false);
    expect((el("button", { disabled: false }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("其余键一律 setAttribute（自定义键走通用通道）", () => {
    const node = el("input", { id: "dm-f-name", placeholder: "context7", value: "v" });
    expect(node.getAttribute("id")).toBe("dm-f-name");
    expect(node.getAttribute("placeholder")).toBe("context7");
    expect(node.getAttribute("value")).toBe("v");
  });

  it("attrs.children 不作为属性落到元素上（它是子节点入口）", () => {
    const node = el("div", { children: ["a"] });
    expect(node.hasAttribute("children")).toBe(false);
    expect(node.textContent).toBe("a");
  });

  it("style 作为普通键走 setAttribute（内联样式串原样落 attribute）", () => {
    const node = el("div", { style: "width:100%" });
    expect(node.getAttribute("style")).toBe("width:100%");
  });
});

describe("dom：el 的子节点装配", () => {
  it("第三位置参数：字符串建文本节点", () => {
    const node = el("div", {}, ["hello"]);
    expect(node.childNodes).toHaveLength(1);
    expect(node.childNodes[0]!.nodeType).toBe(3);
    expect(node.textContent).toBe("hello");
  });

  it("attrs.children 传法与第三参数等价（本插件调用点一直用前者）", () => {
    const viaAttrs = el("div", { children: ["a", "b"] });
    const viaArg = el("div", {}, ["a", "b"]);
    expect(viaAttrs.innerHTML).toBe(viaArg.innerHTML);
    expect(viaAttrs.textContent).toBe("ab");
  });

  it("元素节点按 Node 直挂（不转字符串）", () => {
    const child = el("span", { text: "kid" });
    const node = el("div", {}, [child]);
    expect(node.firstElementChild).toBe(child);
  });

  it("null / undefined 子节点跳过（不产生空文本节点）", () => {
    const node = el("div", {}, [null, "a", undefined]);
    expect(node.childNodes).toHaveLength(1);
    expect(node.textContent).toBe("a");
  });

  it("无子节点入参 → 空元素（不抛）", () => {
    expect(el("div").childNodes).toHaveLength(0);
    expect(el("div", {}).childNodes).toHaveLength(0);
  });

  it("第三参数显式给 undefined 时回落到 attrs.children（?? 链的语义）", () => {
    const node = el("div", { children: ["fromAttrs"] }, undefined);
    expect(node.textContent).toBe("fromAttrs");
  });
});

describe("dom：el 的返回类型收窄", () => {
  it("按标签名返回对应元素类型（调用点直接取 .value / .checked）", () => {
    const input = el("input", { type: "text" });
    expect(input.tagName).toBe("INPUT");
    input.value = "x";
    expect(input.value).toBe("x");
    const select = el("select");
    expect(select.tagName).toBe("SELECT");
    const details = el("details");
    expect(details.tagName).toBe("DETAILS");
  });
});
