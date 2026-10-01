// @vitest-environment happy-dom
/**
 * T1 五原语层判据（shared/client/ui —— 跨包档 C 原语层）。
 *
 * 本文件随原语层上提到仓库根 shared/client/ui/ 而调整了两处「位置」，判据本身不变：
 *   1. 导入面从 `../../src/client/shared/ui/index.ts` 改为直连
 *      `../../../../shared/client/ui/index.tsx`（**源码**不是 emit 产物）——
 *      直连源码是覆盖率与变异面能看见目标模块的前提，断言重建副本时两者恒为零。
 *   2. 文件仍放在消费包的 test/client-dom/ 下，而不是 shared/test/：vitest 的 project
 *      由 scripts/data/mutation-topology.json 的 $testLayers 生成，include 一律是
 *      「packages 下的包名通配 + 该层 glob」，shared/test/ 不在任何 project 的收集面内
 *      ——放那儿等于一条永不执行的判据（假绿）。要把它搬进 shared 层需先给 shared
 *      建 vitest project，那是 coverage.config.json 那条 pending-project 排除项的
 *      exitCriteria 所指的事，本轮不做。
 *
 * 守的事实：五原语的**语义层**（role / aria-*）与行为面，判据一律走
 * @testing-library/react 的 role/aria 查询，不用 className 选元素——这正是
 * 「契约能换实现」的前提：换类名、换皮肤、改 DOM 层级都不该打红本文件，
 * 而拿掉 aria-label、改掉 role、断掉 onChange 必须打红。
 *
 * 唯一按类名选元素的例外是 #128 触控热区那条：那里**类名本身就是契约**
 * （.dou-panel[data-dou-bp="narrow"] .dou-btn::before 按名字选中按钮），故照旧按名查。
 *
 * 纪律：本目录是 .ts（vitest include 只收 *.test.ts），故用 React.createElement
 * 而非 JSX，与 trend-section.test.ts / report-section.test.ts 同一套写法；
 * locale 经 bindLocale 回落为 key 本体，断言只看用户可见标签与 ARIA 属性；
 * fetch 为手写窄假件，不实现任何服务端语义；无真实时钟、无落盘。
 */
import * as React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindLocale } from "../../../../shared/client/i18n.js";
import {
  Badge,
  Button,
  FieldRow,
  NumberField,
  SegmentedControl,
  SelectField,
  Status,
  Surface,
} from "../../../../shared/client/ui/index.tsx";

(globalThis as Record<string, unknown>).__DSH_ROUTES__ = undefined;
const { UiSection } = await import("../../src/client/settings/ui.tsx");

const h = React.createElement;
const realFetch = globalThis.fetch;

const OPTIONS = [
  { value: "a", label: "甲" },
  { value: "b", label: "乙" },
  { value: "c", label: "丙" },
];

beforeEach(() => {
  document.body.textContent = "";
  bindLocale(
    {
      bind:
        () =>
        (key: string): string =>
          key,
    },
    "providerUsage",
  );
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  document.body.textContent = "";
  bindLocale(
    {
      bind:
        () =>
        (key: string): string =>
          key,
    },
    "providerUsage",
  );
});

describe("SegmentedControl 语义层", () => {
  it("容器是具名 group，项是 button 且用 aria-pressed 表态", () => {
    const view = render(
      h(SegmentedControl, {
        variant: "bar",
        label: "页签",
        value: "b",
        onChange: () => {},
        options: OPTIONS,
      }),
    );
    const group = view.getByRole("group", { name: "页签" });
    expect(group.getAttribute("aria-label")).toBe("页签");
    const items = view.getAllByRole("button");
    expect(items.map((el) => el.textContent)).toEqual(["甲", "乙", "丙"]);
    expect(items.map((el) => el.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
  });

  it("点击项回调该项的 value", () => {
    const onChange = vi.fn();
    const view = render(
      h(SegmentedControl, {
        variant: "bar",
        label: "页签",
        value: "a",
        onChange,
        options: OPTIONS,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "丙" }));
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("disabled 项不可触发回调（热力图当前档位即禁用档）", () => {
    const onChange = vi.fn();
    const view = render(
      h(SegmentedControl, {
        variant: "plain",
        label: "档位",
        value: "b",
        onChange,
        options: OPTIONS.map((o) => ({ ...o, disabled: o.value === "b" })),
      }),
    );
    const cur = view.getByRole("button", { name: "乙" }) as HTMLButtonElement;
    expect(cur.disabled).toBe(true);
    fireEvent.click(cur);
    expect(onChange).not.toHaveBeenCalled();
  });

  // R2 复核意见：原用例只断言 role，而 role 在本层是硬编码常量（不随 variant 变），
  // 判别力偏弱。补断言「variant 既决定形态钩子 data-dsu-seg 的取值、又不影响语义层」——
  // 前半句在把 variant 接到错误钩子上时打红，后半句守住「换皮肤不换语义」。
  it("三档形态都保持 group 语义，且形态钩子随 variant 取到对应值", () => {
    for (const variant of ["bar", "pill", "plain"] as const) {
      const view = render(
        h(SegmentedControl, {
          variant,
          label: "标签-" + variant,
          value: "a",
          onChange: () => {},
          options: OPTIONS,
        }),
      );
      const group = view.getByRole("group", { name: "标签-" + variant });
      expect(group.getAttribute("data-dsu-seg")).toBe(variant);
      expect(view.getAllByRole("button").length).toBe(OPTIONS.length);
      cleanup();
    }
  });
});

describe("SegmentedControl 窄屏横滑通路（bar 档）", () => {
  it("groupRef 落在 role=group 容器上，激活项可经 aria-pressed 定位并滚进视野", () => {
    // 复刻 settings/index.tsx 的窄屏逻辑：ref 取分组容器 → 容器内按
    // [aria-pressed="true"] 找激活项 → scrollIntoView。定位不依赖任何类名，
    // 因此换皮肤换实现都不会把「激活档滚进视野」打坏。
    const ref = React.createRef<HTMLDivElement>();
    const view = render(
      h(SegmentedControl, {
        variant: "bar",
        label: "设置导航",
        value: "c",
        groupRef: ref,
        onChange: () => {},
        options: OPTIONS,
      }),
    );
    const group = view.getByRole("group", { name: "设置导航" });
    expect(ref.current).toBe(group);
    const active = group.querySelector('[aria-pressed="true"]') as HTMLElement | null;
    expect(active).not.toBeNull();
    expect(active?.textContent).toBe("丙");
    // happy-dom 无滚动实现，这里锁「定位得到且调用不抛」这条通路本身
    expect(() => active?.scrollIntoView({ block: "nearest", inline: "nearest" })).not.toThrow();
  });
});

describe("Button 语义层与 #128 触控热区通路", () => {
  it("渲染 button，透传 disabled 与 onClick", () => {
    const onClick = vi.fn();
    const view = render(h(Button, { disabled: true, onClick }, "保存"));
    const btn = view.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("type")).toBe("button");
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  // R2：原语层上提后不再硬编码本包的 .dou-btn（跨包层不能替某个包挑按钮外观），
  // 领域类改由调用点传入。#128 触控热区按**类名**选中 .dou-btn，故这条判据同时守住
  // 两件事：调用点仍传得出去、原语仍把传入的类原样挂到 button 上。
  it("窄屏档（data-dou-bp=narrow）下传入的领域类按钮仍被 #128 热区选择器命中", () => {
    const view = render(
      h(
        "div",
        { className: "dou-panel", "data-dou-bp": "narrow" },
        h(Button, { className: "dou-btn" }, "主操作"),
      ),
    );
    const hit = view.container.querySelector(
      '.dou-panel[data-dou-bp="narrow"] .dou-btn',
    ) as HTMLElement | null;
    expect(hit).not.toBeNull();
    expect(hit?.textContent).toBe("主操作");
  });

  // plain 档的项同理：领域类经 itemClassName 逐项传入（热力范围切换那处调用点靠它
  // 命中 .dou-btn 的触控热区与既有按钮外观）。
  it("plain 档的项挂上调用点传入的领域类", () => {
    const view = render(
      h(SegmentedControl, {
        variant: "plain",
        itemClassName: "dou-btn",
        label: "热力范围",
        value: "a",
        onChange: () => {},
        options: OPTIONS,
      }),
    );
    const items = view.getAllByRole("button");
    expect(items.every((el) => el.classList.contains("dou-btn"))).toBe(true);
  });
});

describe("Field 语义层与钳制", () => {
  it("数字字段是可命名的 spinbutton，并按 min/max 钳制", () => {
    const onValue = vi.fn();
    const view = render(
      h(NumberField, { label: "横向偏移", value: 10, min: 0, max: 2000, onValue }),
    );
    const input = view.getByRole("spinbutton", { name: "横向偏移" }) as HTMLInputElement;
    expect(input.getAttribute("min")).toBe("0");
    expect(input.getAttribute("max")).toBe("2000");
    fireEvent.change(input, { target: { value: "9999" } });
    expect(onValue).toHaveBeenCalledWith(2000);
    fireEvent.change(input, { target: { value: "-5" } });
    expect(onValue).toHaveBeenCalledWith(0);
    fireEvent.change(input, { target: { value: "12.7" } });
    expect(onValue).toHaveBeenCalledWith(13);
  });

  it("数字字段非数字输入回落到 min（钳制口径单点）", () => {
    const onValue = vi.fn();
    const view = render(
      h(NumberField, { label: "层级基准", value: 10, min: 1, max: 9000, onValue }),
    );
    fireEvent.change(view.getByRole("spinbutton", { name: "层级基准" }), { target: { value: "" } });
    expect(onValue).toHaveBeenCalledWith(1);
  });

  it("下拉字段是可命名的 combobox 并回调所选值", () => {
    const onValue = vi.fn();
    const view = render(
      h(SelectField, {
        label: "锚点",
        value: "top-right",
        onValue,
        options: [
          { value: "top-right", label: "右上" },
          { value: "bottom-left", label: "左下" },
        ],
      }),
    );
    const select = view.getByRole("combobox", { name: "锚点" }) as HTMLSelectElement;
    expect(select.value).toBe("top-right");
    fireEvent.change(select, { target: { value: "bottom-left" } });
    expect(onValue).toHaveBeenCalledWith("bottom-left");
  });

  // R2 复核意见：原用例标题承诺「窄屏换行落点」，但 happy-dom 没有布局引擎，
  // flex-wrap 根本测不到，实际只验了三个字段各自的可访问名。标题按实际测量面收窄——
  // 「一个不留承诺的用例」比「留一个空头承诺」安全。换行能力由 style.css 的
  // .dsu-field-row { flex-wrap: wrap } 承担，判据在样式层（smoke 断言该规则在）。
  it("字段行内每个控件都保有自己的可访问名", () => {
    const view = render(
      h(
        FieldRow,
        null,
        h(NumberField, { label: "偏移一", value: 0, min: 0, max: 2000, onValue: () => {} }),
        h(NumberField, { label: "偏移二", value: 0, min: 0, max: 2000, onValue: () => {} }),
        h(SelectField, {
          label: "锚点下拉",
          value: "top-left",
          onValue: () => {},
          options: [{ value: "top-left", label: "左上" }],
        }),
      ),
    );
    expect(view.getByRole("spinbutton", { name: "偏移一" })).toBeTruthy();
    expect(view.getByRole("spinbutton", { name: "偏移二" })).toBeTruthy();
    expect(view.getByRole("combobox", { name: "锚点下拉" })).toBeTruthy();
  });
});

describe("Status / Badge 语义层", () => {
  it("无 label 的状态点是装饰件：带 aria-hidden，且不进无障碍树", () => {
    const view = render(
      h("div", null, h(Status, { tone: "ok" }), h("span", null, "承载状态的文字")),
    );
    // 正面断言：装饰性由 aria-hidden 承担。删掉它时 aria-hidden 断言与下面的
    // queryByRole 断言会同时打红——原先只测后者，给装饰点加回一个 role 也测不出来。
    const dot = view.container.querySelector("[data-dsu-tone]") as HTMLElement | null;
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(view.queryByRole("img")).toBeNull();
    expect(view.getByText("承载状态的文字")).toBeTruthy();
  });

  it("给了 label 的状态点升级为具名 img", () => {
    const view = render(h(Status, { tone: "warn", label: "陈旧" }));
    expect(view.getByRole("img", { name: "陈旧" })).toBeTruthy();
  });

  // R2 复核意见：原标题承诺「成败两态互不串味」，但色调在 CSS 里、happy-dom 测不到，
  // 断言其实只验了「两个徽标各自承载自己的文本」。标题按实际测量面收窄；色调不串味
  // 由样式层的 [data-dsu-tone] 规则保证（smoke 断言那些规则仍在）。
  it("徽标是纯文字容器：各自承载自己的文本且不注入 role", () => {
    const view = render(
      h(
        "div",
        null,
        h(Badge, { tone: "ok", size: "xs" }, "成功"),
        h(Badge, { tone: "err", size: "xs" }, "失败"),
      ),
    );
    expect(view.getByText("成功")).toBeTruthy();
    expect(view.getByText("失败")).toBeTruthy();
    expect(view.queryByRole("img")).toBeNull();
  });
});

describe("Surface 语义层", () => {
  // ① R2 复核点名的最重要一条：role="navigation" 是本仓最致命的失败模式
  // （宿主 :not(:has([role=navigation])) 规则，命中即整弹窗退回桌面 row 布局，
  // 手机内容区被压至约 106px）。原用例只按文本查容器，给 Surface 注入
  // role="navigation" 不会打红；这里对两种形态都正面断言「不带 role」。
  it("两种形态都渲染容器内容，且都不自带 role（保持裸容器）", () => {
    const view = render(
      h(
        "div",
        null,
        h(Surface, { variant: "pane" }, h("span", null, "窗格")),
        h(Surface, { variant: "card" }, h("span", null, "外壳")),
      ),
    );
    expect(view.getByText("窗格")).toBeTruthy();
    expect(view.getByText("外壳")).toBeTruthy();
    for (const variant of ["pane", "card"] as const) {
      const el = view.container.querySelector(`[data-dsu-surface="${variant}"]`);
      expect(el).not.toBeNull();
      expect(el?.getAttribute("role")).toBeNull();
    }
  });
});

describe("设置页「悬浮窗」窗格改走原语后仍可被 role/aria 查询", () => {
  it("四个数字字段与锚点下拉都带可访问名，按钮可点并落出保存态", async () => {
    globalThis.fetch = (async (): Promise<unknown> => ({
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => ({
        ui: { placement: "top-right", offsetX: 12, offsetY: 48, panelOffsetY: 8, zIndexBase: 4000 },
      }),
    })) as unknown as typeof fetch;

    const view = render(React.createElement(UiSection));
    await act(async () => {});

    expect(view.getByRole("combobox", { name: "uiAnchor" })).toBeTruthy();
    expect(view.getByRole("spinbutton", { name: "offsetX" })).toBeTruthy();
    expect(view.getByRole("spinbutton", { name: "offsetY" })).toBeTruthy();
    expect(view.getByRole("spinbutton", { name: "panelOffsetY" })).toBeTruthy();
    expect(view.getByRole("spinbutton", { name: "zIndexBase" })).toBeTruthy();
    expect((view.getByRole("spinbutton", { name: "offsetX" }) as HTMLInputElement).value).toBe(
      "12",
    );

    const save = view.getByRole("button", { name: "save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await act(async () => {});
    // 假件对保存同样回 ok，落出成功提示
    expect(view.getByText("uiSavedOk")).toBeTruthy();
  });
});
