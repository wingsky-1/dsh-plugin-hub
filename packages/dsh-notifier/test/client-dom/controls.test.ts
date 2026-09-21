// @vitest-environment happy-dom
//
// 环境声明必须落在文件里，不能只靠 vitest.config.ts 的 client-dom project。
/**
 * dsh-notifier — 输入原子渲染判据（#769 .tsx 面第四个增量，parts/controls.tsx）。
 *
 * 守的事实：一句话——把任一开关/输入的类型映射、类名、值归一或回调接线改坏，对应用例必须红。
 * 回调一律用手写记录数组断言，不用任何 vi 替身；类名断言精确到引号级。
 *
 * 时间纪律：本文件无定时器、无异步等待、无落盘。
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import * as React from "react";
import type { SettingsView } from "../../src/client/settings/types.ts";

import {
  numInput,
  switchControl,
  switchToggle,
  textInput,
} from "../../src/client/settings/parts/controls.tsx";

function inputOf(node: React.ReactNode): HTMLInputElement | null {
  const result = render(React.createElement(() => node));
  return result.container.querySelector("input");
}

describe("switchToggle 开关底层", () => {
  it("基础结构：label 类名与 track 类名与 type 与 aria", () => {
    const result = render(React.createElement(() => switchToggle(false, () => {}, "LBL")));
    const label = result.container.querySelector("label");
    const track = result.container.querySelector("span");
    const input = result.container.querySelector("input");
    expect(label?.className).toBe("dn-switch");
    expect(track?.className).toBe("dn-switch-track");
    expect(input?.getAttribute("type")).toBe("checkbox");
    expect(input?.getAttribute("aria-label")).toBe("LBL");
  });

  it("checked 为 false 时未选中", () => {
    const input = inputOf(switchToggle(false, () => {}, "LBL"));
    expect(input?.checked).toBe(false);
  });

  it("checked 为 true 时选中", () => {
    const input = inputOf(switchToggle(true, () => {}, "LBL"));
    expect(input?.checked).toBe(true);
  });

  it("点击未选中开关回调用 true", () => {
    const received: boolean[] = [];
    function onChange(v: boolean): void {
      received.push(v);
    }
    const result = render(React.createElement(() => switchToggle(false, onChange, "LBL")));
    const input = result.container.querySelector("input");
    expect(input).not.toBeNull();
    fireEvent.click(input!);
    expect(received).toEqual([true]);
  });

  it("点击已选中开关回调用 false", () => {
    const received: boolean[] = [];
    function onChange(v: boolean): void {
      received.push(v);
    }
    const result = render(React.createElement(() => switchToggle(true, onChange, "LBL")));
    const input = result.container.querySelector("input");
    expect(input).not.toBeNull();
    fireEvent.click(input!);
    expect(received).toEqual([false]);
  });
});

describe("switchControl 设置键薄封装", () => {
  it("settings 为 true 时选中", () => {
    const input = inputOf(switchControl("flag", "LBL", { flag: true }, () => {}));
    expect(input?.checked).toBe(true);
  });

  it("真值非 true 仍未选中", () => {
    const input = inputOf(switchControl("flag", "LBL", { flag: 1 }, () => {}));
    expect(input?.checked).toBe(false);
  });

  it("切换后经 patch 写回新值", () => {
    let captured: ((prev: SettingsView) => SettingsView) | undefined = undefined;
    function patch(p: (prev: SettingsView) => SettingsView): void {
      captured = p;
    }
    const result = render(
      React.createElement(() => switchControl("flag", "LBL", { flag: false }, patch)),
    );
    const input = result.container.querySelector("input");
    expect(input).not.toBeNull();
    fireEvent.click(input!);
    expect(captured).not.toBe(undefined);
    const next = captured!({ flag: false });
    expect(next["flag"]).toBe(true);
  });
});

describe("textInput 文本输入", () => {
  it("默认 type 与类名", () => {
    const input = inputOf(textInput("hi", () => {}));
    expect(input?.getAttribute("type")).toBe("text");
    expect(input?.className).toBe("dn-set-input dn-set-inputText");
  });

  it("显式 type 透传", () => {
    const input = inputOf(textInput("hi", () => {}, { type: "password" }));
    expect(input?.getAttribute("type")).toBe("password");
  });

  it("undefined 回落空串", () => {
    const input = inputOf(textInput(undefined, () => {}));
    expect(input?.value).toBe("");
  });

  it("数字转字符串", () => {
    const input = inputOf(textInput(42, () => {}));
    expect(input?.value).toBe("42");
  });

  it("null 回落空串", () => {
    const input = inputOf(textInput(null, () => {}));
    expect(input?.value).toBe("");
  });

  it("aria 优先于 placeholder", () => {
    const input = inputOf(textInput("hi", () => {}, { placeholder: "PH", ariaLabel: "LBL" }));
    expect(input?.getAttribute("aria-label")).toBe("LBL");
    expect(input?.getAttribute("placeholder")).toBe("PH");
  });

  it("无 aria 时回落 placeholder", () => {
    const input = inputOf(textInput("hi", () => {}, { placeholder: "PH" }));
    expect(input?.getAttribute("aria-label")).toBe("PH");
  });

  it("输入透传字符串", () => {
    const received: string[] = [];
    function onChange(v: string): void {
      received.push(v);
    }
    const result = render(React.createElement(() => textInput("hi", onChange)));
    const input = result.container.querySelector("input");
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: "hello" } });
    expect(received).toEqual(["hello"]);
  });
});

describe("numInput 数字输入", () => {
  it("基础 type 与 step 与类名", () => {
    const input = inputOf(numInput(7, () => {}));
    expect(input?.getAttribute("type")).toBe("number");
    expect(input?.getAttribute("step")).toBe("1");
    expect(input?.className).toBe("dn-set-input dn-set-numInput");
  });

  it("min 与 max 与 aria 透传", () => {
    const input = inputOf(numInput(7, () => {}, { ariaLabel: "LBL", min: 1, max: 60 }));
    expect(input?.getAttribute("min")).toBe("1");
    expect(input?.getAttribute("max")).toBe("60");
    expect(input?.getAttribute("aria-label")).toBe("LBL");
  });

  it("undefined 回落空串", () => {
    const input = inputOf(numInput(undefined, () => {}));
    expect(input?.value).toBe("");
  });

  it("数字转字符串", () => {
    const input = inputOf(numInput(42, () => {}));
    expect(input?.value).toBe("42");
  });

  it("null 回落空串", () => {
    const input = inputOf(numInput(null, () => {}));
    expect(input?.value).toBe("");
  });

  it("空串回调用 undefined", () => {
    const received: Array<number | undefined> = [];
    function onChange(v: number | undefined): void {
      received.push(v);
    }
    const result = render(React.createElement(() => numInput(7, onChange)));
    const input = result.container.querySelector("input");
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: "" } });
    expect(received).toEqual([undefined]);
  });

  it("数字串回调用 Number", () => {
    const received: Array<number | undefined> = [];
    function onChange(v: number | undefined): void {
      received.push(v);
    }
    const result = render(React.createElement(() => numInput(7, onChange)));
    const input = result.container.querySelector("input");
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: "42" } });
    expect(received).toEqual([42]);
  });
});
