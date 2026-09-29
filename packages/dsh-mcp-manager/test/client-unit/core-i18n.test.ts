/**
 * dsh-mcp-manager — client-unit：core/i18n.ts 的直接判据。
 *
 * 守的事实（每条一句话）：把 tStatus 的已知/未知两支对调（`!== undefined` 改成
 * `=== undefined`）、或把未知状态的回落值从原始 key 改成空串，必须红。
 *
 * 为什么单列一个文件：本条对应 coverage.config.json 里 i18n.ts 那一条 pending-project
 * 豁免，删除条件是「水位达标 + 进入 mutation-topology 某段 mutate」。判据与被测文件
 * 一一对应、逐条独立可回退（不要把别的文件的断言混进来，否则回退本条会牵连它们）。
 *
 * 假件说明（testing SKILL §3）：locale 是手写活绑定假件，只覆盖本文件断言用到的那几个
 * 键，且译文与 key 形态**不同**——这样「走了 t() 翻译路径」与「走了原始 key 回落」在
 * 断言值上可区分，两支对调时立刻红。不用任何 vi 替身。
 *
 * 复位纪律：shared/client/i18n.ts 的 `export let t` 是跨模块活绑定，且
 * `bindLocale(undefined)` 对它是**无操作**（守卫不通过即不赋值）——用它「复原」会留下
 * 上一个用例的译文、让后续断言恒绿。故 afterEach 一律绑恒等译函数（等价于官方未装配时
 * 的缺省行为「回落 key 本体」）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { bindLocale } from "../../../../shared/client/i18n.js";
import { STATUS_ORDER } from "../../src/client/core/constants.ts";
import { tStatus } from "../../src/client/core/i18n.ts";

/** 六态键的字面量锚（tStatus 的取值域；不从被测实现 import 状态表来生成期望）。 */
/** 状态 → 字典键的字面量锚。**不是** `st` + 状态名的模板：reconnecting 的键是
 * stReconnecting（首字母大写），模板拼法会写成 streconnecting。 */
const DICT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["connected", "stConnected"],
  ["connecting", "stConnecting"],
  ["reconnecting", "stReconnecting"],
  ["stopped", "stStopped"],
  ["disabled", "stDisabled"],
  ["failed", "stFailed"],
];

const SIX_STATES = [
  "connected",
  "connecting",
  "reconnecting",
  "stopped",
  "disabled",
  "failed",
] as const;

afterEach(() => {
  bindLocale({ bind: () => (key: string) => key }, "mcpManager");
});

/** 手写活绑定假件：表内键按模板插值，表外键回落 key 本体。 */
function bindFakeLocale(translated: Record<string, string>): void {
  bindLocale(
    {
      bind:
        () =>
        (key: string, params?: Record<string, unknown>): string => {
          const template = translated[key] ?? key;
          if (params === undefined) return template;
          let out = template;
          for (const [name, value] of Object.entries(params)) {
            out = out.split(`{${name}}`).join(String(value));
          }
          return out;
        },
    },
    "mcpManager",
  );
}

describe("i18n：tStatus 状态文案求值", () => {
  it("已知状态：取状态表的字典键再经 t() 求值（不回落原始状态名）", () => {
    bindFakeLocale({ stConnected: "运行中", stFailed: "失败" });
    expect(tStatus("connected")).toBe("运行中");
    expect(tStatus("failed")).toBe("失败");
  });

  it("未知状态：原样回落输入 key，不丢卡（不返回空串、不返回 undefined）", () => {
    bindFakeLocale({ stConnected: "运行中" });
    expect(tStatus("weird")).toBe("weird");
    expect(tStatus("")).toBe("");
  });

  it("六态逐态可求值，且译文与状态名不同形（防两支对调时恒绿）", () => {
    bindFakeLocale(Object.fromEntries(DICT_KEYS.map(([status, key]) => [key, `译-${status}`])));
    expect(DICT_KEYS.map(([status]) => tStatus(status))).toEqual(
      DICT_KEYS.map(([status]) => `译-${status}`),
    );
  });

  it("恒等绑定下：已知状态返回字典键而非状态名（两支未对调）", () => {
    // 官方 t() 未装配时的缺省行为就是「回落 key 本体」，等价于恒等译函数。
    bindFakeLocale({});
    expect(tStatus("connected")).toBe("stConnected");
    expect(tStatus("weird")).toBe("weird");
  });

  it("带占位符的译文原样交给 t（tStatus 只传 key、不吞参数）", () => {
    bindFakeLocale({ stConnected: "运行中 {x}" });
    expect(tStatus("connected")).toBe("运行中 {x}");
  });

  it("六态的字典键是字面量锚（键名改形会让 tStatus 静默回落成状态名）", () => {
    // 这条先于「恒等绑定下返回字典键」那条红，从而把「键映射被改」与「两支被对调」
    // 两类改动区分开。
    bindFakeLocale({});
    expect(DICT_KEYS.map(([status]) => tStatus(status))).toEqual(DICT_KEYS.map(([, key]) => key));
  });
  it("STATUS_ORDER 的六态与本文件取值域一致（渲染面经同一张表求值）", () => {
    expect(STATUS_ORDER.map((g) => g.key)).toEqual([...SIX_STATES]);
  });
});
