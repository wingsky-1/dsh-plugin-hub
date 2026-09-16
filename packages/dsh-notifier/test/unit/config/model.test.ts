/**
 * dsh-notifier config 域 model 块 —— 默认形态与布尔键清单。
 *
 * 为什么默认值要在这里用手写字面量再写一遍：本域其余用例的期望值都取自 `DEFAULT_CONFIG[key]`
 * 本身，而实现的回落源就是同一个对象——两侧同源同变，把 `notifyAsk: true` 改成 `false` 之后
 * 全套测试照样绿。而默认值同时是设置页的初始形态与跨端契约（客户端按同一份形状渲染），
 * 不能是「实现说什么就是什么」：它必须有一份独立于实现的书面形态。
 *
 * `BOOLEAN_KEYS` 同理——它是校验闸门的分支依据，漏登记一个键就等于该键的布尔闸门静默消失
 * （陌生键落到校验的兜底出口即放行），故清单也在测试里手写一份，两边逐字对齐。
 *
 * 本块是 L1 纯函数块，直引 `impl/model/index.ts` 与 `impl/input/index.ts`。
 */
import { describe, expect, it } from "vitest";

import {
  BOOLEAN_KEYS,
  normalizeConfig,
  validateSettings,
} from "../../../src/server/config/impl/input/index.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type { RawSettingValue } from "../../../src/server/config/impl/model/type.ts";

/** 手写默认形态：与实现零共享（不 import 它的任何取值），改动默认值必须在这里也显式改一次。 */
const EXPECTED_DEFAULTS = {
  notifyAsk: true,
  notifyQuestion: true,
  notifyTaskDone: true,
  notifySubagentDone: false,
  notifyTaskError: true,
  notifyTurnEnd: false,

  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  // 两条内置频道是默认形态的一部分：读面靠它们才谈得上「与默认表逐字一致」，权威形态也住在它们身上。
  channels: [
    { type: "browser", id: "browser", enabled: true, popup: true, sound: true, whenVisible: false },
    { type: "system", id: "system", enabled: true, popup: true, sound: true },
  ],
  kindRoutes: {},
  allowKinds: [],

  historyMaxAgeDays: 0,
} as const;

/** 受布尔闸门管的键：手写清单，与实现的 `BOOLEAN_KEYS` 是两份独立文本。 */
const BOOLEAN_SETTING_KEYS: readonly string[] = [
  "notifyAsk",
  "notifyQuestion",
  "notifyTaskDone",
  "notifySubagentDone",
  "notifyTaskError",
  "notifyTurnEnd",
];

describe("DEFAULT_CONFIG：默认形态以手写字面量为准，不由实现自述", () => {
  it("整份默认设置等于手写形态：布尔偏置、两条内置条目与计数/列表类默认值逐个锚住（改坏一行不该悄无声息）", () => {
    expect(DEFAULT_CONFIG).toEqual(EXPECTED_DEFAULTS);
  });

  it("空输入归一化后与默认表逐字相等：默认表同时是读面的物化基准（两侧不等就说明物化补了默认表没有的东西）", () => {
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("quietHours 只有 enabled / start / end：allowKinds 缺省表示「时段内不额外放行谁」（整体相等看不出多出来的键值是 undefined）", () => {
    expect(Object.keys(DEFAULT_CONFIG.quietHours)).toEqual(["enabled", "start", "end"]);
    expect("allowKinds" in DEFAULT_CONFIG.quietHours).toBe(false);
  });
});

describe("BOOLEAN_KEYS：布尔闸门的清单必须覆盖每个布尔键", () => {
  it("清单逐字一致，且清单里每个键的非布尔值都被拦下并指向它自己（漏登记一个键 = 该键的闸门静默消失）", () => {
    expect([...BOOLEAN_KEYS].sort()).toEqual([...BOOLEAN_SETTING_KEYS].sort());

    for (const key of BOOLEAN_SETTING_KEYS) {
      const patch: Record<string, RawSettingValue> = { [key]: 1 };
      const verdict = validateSettings(patch);
      if (verdict.ok) throw new Error(`${key} 的非布尔值被判放行`);
      expect(verdict.error.key, key).toBe(key);
      expect(verdict.error.hint, key).toContain("true 或 false");
    }
  });
});
