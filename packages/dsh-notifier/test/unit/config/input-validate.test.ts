import { describe, expect, it } from "vitest";

import {
  BARK_RESERVED_KEYS,
  RETIRED_KEYS,
  UNSAFE_KEYS,
  WEBHOOK_RESERVED_KEYS,
  normalizeConfig,
  validateSettings,
  validateSettingsWithMerge,
} from "../../../src/server/config/impl/input/index.ts";
import type { SettingsPatch } from "../../../src/server/config/impl/model/type.ts";
import { BARK, BUILTINS, WEBHOOK, invalidOf, withBuiltins } from "./input-input-support.ts";

function registervalidate() {
  describe("validateSettings：只审显式提交（缺键不是错误）", describeValidateSettings);
  return;
  function describeValidateSettings() {
    it(
      "空提交与 undefined 值放行（设置页整份提交时，未改动的字段可能带 undefined）",
      validateTest1,
    );

    it(
      "首个非法键即返回并带上界提示（一次只报一个：设置页的定位光标只能落在一个字段上）",
      validateTest2,
    );

    it(
      "保留键写拒：凭据别名键命中即 400 且提示点名该键（静默剔除会让用户以为设置生效了）",
      validateTest3,
    );

    // 陌生键一律 400（#1016 S2）：透传面要求读面把陌生键收进 `extras` 子对象再原样交回客户端，
    // 而写面只放行 string/number——`extras` 这个**对象**自己撞上那条判据，该频道所在配置从此
    // 再也保存不了（#1016 缺陷 B）。收窄到「本版本认识的键」把那条自撞的口子关掉。
    // 值是什么（对象/布尔/数组/字符串）不再影响结论：只有「认不认识」这一件事。
    it("频道条目里的陌生键一律 400：值是字符串、数字、对象、布尔、数组都不放行", validateTest4);

    it(
      "内置渠道不能删除：显式提交的 channels 少一条内置条目即 400，提示点名缺的那一条（其余一律按普通条目处理）",
      validateTest5,
    );

    // 内置身份由 type 唯一确定：id 只是回显，写了别的值说明提交方在自造身份（归一化会强制改写它，
    // 写面必须当场拒，否则用户以为改掉了而实际没有）。
    it("内置条目的 id 必须与 type 一致：写了别的 id 一律 400", validateTest6);
    // ── 频道身份唯一（#1016 残留 2）──────────────────────────────────────────
    //
    // 重复身份是**凭据销毁**而不是显示重复：设置页对 channels 整组提交，合并的 sameKindBase 按裸 id
    // 取首条、KEEP 又让其余键沿用首条的值，于是第二条的真实密钥被第一条覆盖，每次保存毁一条。
    // 掩码还原的 findById 同样按裸 id 查找，故**跨类型同 id 也撞**。
    it(
      "同类型重复 id 一律 400：两条 bark 用同一个 id 即拒（每次保存都会毁掉第二条的 deviceKey）",
      validateTest7,
    );

    it(
      '跨类型重复 id 也 400：掩码还原按裸 id 查找，bark 写 id="browser" 会命中内置条目',
      validateTest8,
    );

    // 提示要给**下标**与**可自救的动作**：用户改不了 id，只说「重复」等于堵死。文案按 1 起数（界面上的第几条），
    // 所以落盘数组的下标要 +1——这条专门钉那个换算，写成 0 起数时用户会数错条目。
    it(
      "重复身份的提示带 1 起的下标，并明说删掉其中一条（用户改不了 id，文案必须给出路）",
      validateTest9,
    );

    // 零误伤是这条判据的另一半：内置条目的 id **可以缺席**（0.2.4 割接在用户没设过旧键时写出的就是
    // `{type,id}`，而更早的形态连 id 键都没有），身份此时回落 type。口径写错成「id 必填」就会让每一次
    // 无关保存都被拒，用户还看不出是哪一条。
    it(
      "内置条目缺席 id 不误伤：身份回落 type（0.2.4 割接写出的就是没有 id 键的形态）",
      validateTest10,
    );

    // 两条内置的 id 都缺席时身份分别是 browser / system，仍然互不相同——若口径写成「一律空串」或
    // 「一律 type 常量」，这条会当场撞车并把合法的内置配置拒掉。
    it("两条内置同时缺席 id 仍互不相同（口径不是把所有缺席 id 折成同一个身份）", validateTest11);

    // 内置 id 写错仍由既有的「id 只能是 type」判据拒，本组不与之分叉：那条判据更早、话术更贴切。
    it("内置 id 写错仍由既有判据拒（不因新增的数组级判据而改口）", validateTest12);

    // 绝对 400：不给 preexisting 放行。放行是「存量残缺不该让无关保存被拒」，而重复身份是存量**自相矛盾**
    //（同一个身份挂两套凭据）——放行等于把「每次保存毁一条凭据」合法化。走合并入口逐条钉。
    it("存量里就有重复身份时，本次无关保存照样 400（不给 preexisting 放行）", validateTest13);

    // 这一批键已经没有值语义。当陌生键放行会让停在升级前页面上的旧客户端以为存上了
    // （200 + 什么都不发生），所以写面必须拒——提示里给出出路（刷新），用户知道下一步做什么。
    // 期望话术逐键字面写出而不是引用 RETIRED_KEYS 的值：断言若从被测事实源取值，话术改错也照样绿。
    it("退役键写拒：每个退役键提交一律 400，提示是该键自己的话术（与值无关）", validateTest14);

    // maxConnections 与 0.2.3 那批同属「曾经存在、值语义已消失」，但拒收原因不同：不是搬了家，
    // 是 0.2.5 把连接上限机制整体移除。共用 0.2.4 那句话会把用户引到错误的原因上，故它必须有自己那句。
    it(
      "maxConnections 写拒：按退役键拒收，且不套用渠道键那句话术（原因不同，话术不能共用）",
      validateTest15,
    );

    // 顶层陌生键同样 400（#1016 S2）：写面不再「透传保留」它们。存量里已有的陌生键不受影响——
    // 它们不在提交里，按字段合并时原样沿用（服务端那一半见 service.test.ts）。
    it("本版本不认识的顶层键写拒：与频道条目里的陌生键同一条口径", validateTest16);

    // 原型链危险键是**另一类**：它们在落盘前被整条剔除（writableEntries），原型改写已经被挡下，
    // 再报「陌生键」只会把一次安全的写变成 400。
    it("原型链危险键不进判据：它们由写面剔除，不按陌生键拒收", validateTest17);

    it(
      "逐键类型闸门：每个非法值都指向它自己那个键，且提示指向真正拦下它的那条分支（键对了、提示指向别处，等于把用户引到另一个字段）",
      validateTest18,
    );

    it(
      "quietHours.allowKinds 的元素类型与顶层同一口径：错位元素与混合数组都判非法，合法名单放行",
      validateTest19,
    );

    it(
      "quietHours 一次只报首错：首个非法窗口的下标进 hint，后面的错不展开（设置页光标只能落一处）",
      validateTest20,
    );

    it(
      "quietHours.windows 超限 400、上限与空数组放行（静默截断会让用户以为配好的时段生效了）",
      validateTest21,
    );

    it("边界值与整份合法提交放行（闸门把用户正常保存拦住，比放过一个非法值更糟）", validateTest24);
  }
}

registervalidate();

function validateTest1() {
  expect(validateSettings({})).toEqual({ ok: true });
  expect(validateSettings({ notifyAsk: undefined, channels: undefined })).toEqual({ ok: true });
}

function validateTest2() {
  expect(invalidOf({ historyMaxAgeDays: -1, notifyAsk: "yes" }).key).toBe("historyMaxAgeDays");
  expect(invalidOf({ historyMaxAgeDays: -1, notifyAsk: "yes" }).hint).toContain("3650");
  expect(invalidOf({ notifyAsk: "yes", historyMaxAgeDays: -1 }).key).toBe("notifyAsk");
  // 合法值不是出口：扫到它必须继续往下看，否则「合法键 + 非法键」的整份提交会被整体放行。
  expect(invalidOf({ notifyAsk: true, historyMaxAgeDays: -1 }).key).toBe("historyMaxAgeDays");
}

function validateTest3() {
  for (const key of BARK_RESERVED_KEYS) {
    const invalid = invalidOf({ channels: [{ ...BARK, [key]: "x" }] });
    expect(invalid.key, key).toBe("channels");
    expect(invalid.hint, key).toContain(key);
  }
  // webhook 的必需键先过闸，所以这里必须给全 auth，否则拦下提交的是 auth 那条分支。
  for (const key of WEBHOOK_RESERVED_KEYS) {
    const invalid = invalidOf({ channels: [{ ...WEBHOOK, auth: "none", [key]: "x" }] });
    expect(invalid.hint, key).toContain(key);
  }
}

function validateTest4() {
  for (const extra of [5, "1", { a: 1 }, true, [1]] as unknown[]) {
    const invalid = invalidOf({ channels: withBuiltins([{ ...BARK, extraKey: extra }]) });
    expect(invalid.key, JSON.stringify(extra)).toBe("channels");
    expect(invalid.hint, JSON.stringify(extra)).toContain("extraKey");
    expect(invalid.hint, JSON.stringify(extra)).toContain("不是已知键");
  }
}

function validateTest5() {
  const browser = { type: "browser", id: "browser" };
  const system = { type: "system", id: "system" };
  // 两条都在场即放行：内置没有别的特殊之处，出站频道照旧按各自规则校验。
  expect(validateSettings({ channels: [browser, system, BARK] })).toEqual({ ok: true });

  const missingSystem = invalidOf({ channels: [browser, BARK] });
  expect(missingSystem.key).toBe("channels");
  expect(missingSystem.hint).toContain("内置渠道不能删除");
  expect(missingSystem.hint).toContain("system");

  const missingBrowser = invalidOf({ channels: [system, BARK] });
  expect(missingBrowser.key).toBe("channels");
  expect(missingBrowser.hint).toContain("browser");
}

function validateTest6() {
  const wrongId = invalidOf({ channels: [{ ...BUILTINS[0], id: "chrome" }, BUILTINS[1]] });
  expect(wrongId.key).toBe("channels");
  expect(wrongId.hint).toContain("id 只能是");
}

function validateTest7() {
  const invalid = invalidOf({
    channels: [...BUILTINS, BARK, { ...BARK, deviceKey: "key-2" }],
  });
  expect(invalid.key).toBe("channels");
  // 提示必须点名那个身份：用户看得到两条 bark 卡片，却改不了它们的 id（客户端没有 id 编辑器）。
  expect(invalid.hint).toContain("bark:phone");
}

function validateTest8() {
  const invalid = invalidOf({
    channels: [BUILTINS[0], BUILTINS[1], { ...BARK, id: "browser" }],
  });
  expect(invalid.key).toBe("channels");
  expect(invalid.hint).toContain("browser");
}

function validateTest9() {
  const invalid = invalidOf({ channels: [...BUILTINS, BARK, { ...BARK, deviceKey: "key-2" }] });
  // BUILTINS 占前两条，故冲突发生在第 3 条与第 4 条。
  expect(invalid.hint).toContain("第 3 条");
  expect(invalid.hint).toContain("第 4 条");
  expect(invalid.hint).toContain("删掉其中一条");
}

function validateTest10() {
  expect(validateSettings({ channels: [{ type: "browser" }, { type: "system" }, BARK] })).toEqual({
    ok: true,
  });
}

function validateTest11() {
  expect(validateSettings({ channels: [{ type: "browser" }, { type: "system" }, BARK] })).toEqual({
    ok: true,
  });
  // 同一类型重复出现（两条 browser）仍要拒：内置重复是「用户提交了两张一样的卡」，不是合法配置。
  const dup = invalidOf({
    channels: [{ type: "browser" }, { type: "browser" }, { type: "system" }, BARK],
  });
  expect(dup.key).toBe("channels");
  expect(dup.hint).toContain("browser");
}

function validateTest12() {
  const wrongId = invalidOf({ channels: [{ ...BUILTINS[0], id: "chrome" }, BUILTINS[1]] });
  expect(wrongId.hint).toContain("id 只能是");
}

function validateTest13() {
  // 真实形状：客户端只交一条 bark（它改的是别处），合并结果里却留着两条同 id 的——
  // 「每次保存都毁一条凭据」正是这样发生的，不需要用户碰这两张卡。
  const stored = [...BUILTINS, BARK, { ...BARK, deviceKey: "key-2" }];
  const verdict = validateSettingsWithMerge(
    { channels: [BARK] },
    {
      channels: stored,
      inherited: stored.map(() => new Set<string>()),
    },
  );
  expect(verdict.ok).toBe(false);
  if (verdict.ok) throw new Error("期望判非法，实际放行");
  expect(verdict.error.key).toBe("channels");
  expect(verdict.error.hint).toContain("bark:phone");
}

function validateTest14() {
  const expected: Readonly<Record<string, string>> = {
    systemEnabled: "0.2.4 升级时已移入渠道条目",
    browserEnabled: "0.2.4 升级时已移入渠道条目",
    systemNotify: "0.2.4 升级时已移入渠道条目",
    browserNotify: "0.2.4 升级时已移入渠道条目",
    notifyWhenVisible: "0.2.4 升级时已移入渠道条目",
    notifySound: "0.2.4 升级时已移入渠道条目",
    browserSound: "0.2.4 升级时已移入渠道条目",
    systemSound: "0.2.4 升级时已移入渠道条目",
    maxConnections: "0.2.5 升级时已随 SSE 连接上限机制一并移除",
  };
  // 新退役键必须在本表登记期望话术：漏登记就没人审它的话术，等于没有判据。
  for (const key of Object.keys(RETIRED_KEYS)) {
    expect(expected[key], key).toBeDefined();
    const verdict = validateSettings({ [key]: true } as SettingsPatch);
    expect(verdict.ok, key).toBe(false);
    expect(verdict.ok ? "" : verdict.error.key).toBe(key);
    expect(verdict.ok ? "" : verdict.error.hint, key).toContain(expected[key]);
  }
  // 合法布尔值也一样拒：拒的是键本身，不是值
  expect(validateSettings({ browserNotify: true } as SettingsPatch).ok).toBe(false);
}

function validateTest15() {
  const verdict = validateSettings({ maxConnections: 64 } as SettingsPatch);
  expect(verdict.ok).toBe(false);
  expect(verdict.ok ? "" : verdict.error.key).toBe("maxConnections");
  expect(verdict.ok ? "" : verdict.error.hint).toContain("0.2.5");
  expect(verdict.ok ? "" : verdict.error.hint).not.toContain("已移入渠道条目");
}

function validateTest16() {
  const invalid = invalidOf({ futureKey: 1 } as unknown as SettingsPatch);
  expect(invalid.key).toBe("futureKey");
  expect(invalid.hint).toContain("不是已知配置键");
  // 归一化本来就不认它，值得不到生效位——400 只是让「你以为存上了」这件事当场暴露。
  expect("futureKey" in normalizeConfig({ futureKey: 1 })).toBe(false);
}

function validateTest17() {
  for (const key of UNSAFE_KEYS) {
    expect(validateSettings({ [key]: { pwned: true } } as unknown as SettingsPatch), key).toEqual({
      ok: true,
    });
  }
}

function validateTest18() {
  const scalarRows: ReadonlyArray<readonly [SettingsPatch, string, string]> = [
    [{ notifyAsk: "false" }, "notifyAsk", "true 或 false"],
    [{ historyMaxAgeDays: -1 }, "historyMaxAgeDays", "0 到 3650"],
    [{ historyMaxAgeDays: 3_651 }, "historyMaxAgeDays", "0 到 3650"],
    [{ historyMaxAgeDays: 1.5 }, "historyMaxAgeDays", "0 到 3650"],
    [{ historyMaxAgeDays: "8" }, "historyMaxAgeDays", "0 到 3650"],
    [{ allowKinds: "error" }, "allowKinds", "字符串数组"],
    [{ allowKinds: ["a", 1] }, "allowKinds", "字符串数组"],
  ];
  const quietHoursRows: ReadonlyArray<readonly [SettingsPatch, string, string]> = [
    // quietHours：「不是对象」与「缺了哪个子键」是不同分支，提示分不开用户就改不对。
    // 下标一律进 hint（key 恒为 quietHours）：设置页光标只能落一处，行号靠 hint 指。
    [{ quietHours: "22:00" }, "quietHours", "需要对象"],
    [{ quietHours: { enabled: true } }, "quietHours", "windows"],
    [{ quietHours: { enabled: true, windows: "22:00" } }, "quietHours", "windows 需要数组"],
    [
      { quietHours: { enabled: true, windows: [{ start: "9:30", end: "08:00" }] } },
      "quietHours",
      "windows[0].start",
    ],
    [
      { quietHours: { enabled: true, windows: [{ start: "x22:00", end: "08:00" }] } },
      "quietHours",
      "windows[0].start",
    ],
    [
      { quietHours: { enabled: true, windows: [{ start: "22:00", end: "24:00" }] } },
      "quietHours",
      "windows[0].end",
    ],
    [
      { quietHours: { enabled: true, windows: [{ start: "22:00", end: "08:00x" }] } },
      "quietHours",
      "windows[0].end",
    ],
    [
      { quietHours: { enabled: true, windows: [{ start: "22:00", end: "08:00" }, "x"] } },
      "quietHours",
      "windows[1]",
    ],
    [
      { quietHours: { enabled: true, windows: [{ start: "22:00", end: "22:00" }] } },
      "quietHours",
      "不能相同",
    ],
    [{ quietHours: { enabled: "yes", windows: [] } }, "quietHours", "enabled"],
    // 旧形（有 start/end 而无 windows）写面 400：升级步会搬，旧客户端靠这句提示去刷新。
    [{ quietHours: { enabled: true, start: "22:00", end: "08:00" } }, "quietHours", "刷新后重试"],
    [
      {
        quietHours: {
          enabled: true,
          windows: [{ start: "22:00", end: "08:00" }],
          allowKinds: "error",
        },
      },
      "quietHours",
      "allowKinds",
    ],
  ];
  const channelRows = channelTypeRows();
  const kindRouteRows = kindRouteRowsTable();
  const rows: ReadonlyArray<readonly [SettingsPatch, string, string]> = [
    ...scalarRows,
    ...quietHoursRows,
    ...channelRows,
    ...kindRouteRows,
  ];
  for (const [patch, key, hint] of rows) {
    const error = invalidOf(patch);
    expect(error.key, JSON.stringify(patch)).toBe(key);
    expect(error.hint, JSON.stringify(patch)).toContain(hint);
  }
}

function validateTest19() {
  const win = { start: "22:00", end: "08:00" };
  const wrongElement: SettingsPatch = {
    quietHours: { enabled: true, windows: [win], allowKinds: [1] },
  };
  const mixed: SettingsPatch = {
    quietHours: { enabled: true, windows: [win], allowKinds: ["error", 3] },
  };
  for (const patch of [wrongElement, mixed]) {
    const error = invalidOf(patch);
    expect(error.key, JSON.stringify(patch)).toBe("quietHours");
    expect(error.hint, JSON.stringify(patch)).toContain("allowKinds");
  }

  const legal: SettingsPatch = {
    quietHours: { enabled: true, windows: [win], allowKinds: ["error"] },
  };
  expect(validateSettings(legal)).toEqual({ ok: true });
}

function validateTest20() {
  const error = invalidOf({
    quietHours: {
      enabled: true,
      windows: [
        { start: "22:00", end: "08:00" },
        { start: "9:30", end: "xx" },
      ],
    },
  });
  expect(error.key).toBe("quietHours");
  expect(error.hint).toContain("windows[1].start");
}

function validateTest21() {
  const win = { start: "22:00", end: "08:00" };
  const over: SettingsPatch = {
    quietHours: { enabled: true, windows: [win, win, win, win, win, win] },
  };
  const error = invalidOf(over);
  expect(error.key).toBe("quietHours");
  expect(error.hint).toContain("5");
  // 上限本身与空数组（未命中）都是合法提交。
  expect(
    validateSettings({ quietHours: { enabled: true, windows: [win, win, win, win, win] } }),
  ).toEqual({ ok: true });
  expect(validateSettings({ quietHours: { enabled: true, windows: [] } })).toEqual({
    ok: true,
  });
}

function validateTest24() {
  expect(validateSettings({ historyMaxAgeDays: 0 })).toEqual({ ok: true });
  expect(validateSettings({ historyMaxAgeDays: 3_650 })).toEqual({ ok: true });
  const full: SettingsPatch = {
    notifyAsk: false,
    notifyQuestion: true,
    notifyTaskDone: true,
    notifySubagentDone: true,
    notifyTaskError: false,
    notifyTurnEnd: true,
    quietHours: {
      enabled: true,
      windows: [{ start: "23:00", end: "07:00" }],
      allowKinds: ["error"],
    },
    channels: [
      ...BUILTINS,
      { ...BARK, enabled: true, level: "critical", levels: { error: "critical" } },
      { ...WEBHOOK, enabled: false, auth: "header", preset: "gotify", headerName: "X-Token" },
    ],
    kindRoutes: { error: ["bark:phone"] },
    allowKinds: ["demo:report"],
    historyMaxAgeDays: 7,
  };
  expect(validateSettings(full)).toEqual({ ok: true });
}

function channelTypeRows(): ReadonlyArray<readonly [SettingsPatch, string, string]> {
  return [
    // channels：每条拒绝都挂在同一个键上，能分辨出是哪一条拦下的只有提示。逐项校验各自独立
    // ——前面那条合法不替后面那条担保。
    [{ channels: {} }, "channels", "需要数组"],
    [{ channels: ["x"] }, "channels", "需要对象"],
    [{ channels: [{ type: "bark", baseUrl: "https://x", deviceKey: "k" }] }, "channels", "缺少 id"],
    [
      { channels: [{ type: "bark", id: "", baseUrl: "https://x", deviceKey: "k" }] },
      "channels",
      "缺少 id",
    ],
    [{ channels: [{ type: "bark", id: "bark:a", baseUrl: "https://x" }] }, "channels", "deviceKey"],
    [{ channels: [{ type: "bark", id: "bark:a", deviceKey: "k" }] }, "channels", "baseUrl"],
    [
      { channels: [{ type: "bark", id: "bark:a", baseUrl: "", deviceKey: "k" }] },
      "channels",
      "baseUrl",
    ],
    [
      { channels: [{ type: "bark", id: "bark:a", baseUrl: "https://x", deviceKey: "" }] },
      "channels",
      "deviceKey",
    ],
    [
      {
        channels: [
          { type: "bark", id: "bark:a", baseUrl: "https://x", deviceKey: "k", level: "urgent" },
        ],
      },
      "channels",
      "level",
    ],
    [
      { channels: [{ type: "webhook", id: "webhook:a", auth: "none", preset: "custom" }] },
      "channels",
      "url",
    ],
    [
      { channels: [{ type: "webhook", id: "webhook:a", url: "", auth: "none" }] },
      "channels",
      "url",
    ],
    [
      {
        channels: [
          {
            type: "webhook",
            id: "webhook:a",
            url: "https://x",
            auth: "oauth",
            preset: "custom",
          },
        ],
      },
      "channels",
      "auth",
    ],
    [
      {
        channels: [
          { type: "webhook", id: "webhook:a", url: "https://x", auth: "none", preset: "slack" },
        ],
      },
      "channels",
      "preset",
    ],
    [{ channels: [{ type: "mail", id: "mail:a" }] }, "channels", "type 需要"],
    [
      {
        channels: [
          { type: "mail", id: "mail:a", url: "https://x", auth: "none", preset: "custom" },
        ],
      },
      "channels",
      "type 需要",
    ],
    [{ channels: [BARK, { type: "mail", id: "mail:a" }] }, "channels", "type 需要"],
  ];
}

function kindRouteRowsTable(): ReadonlyArray<readonly [SettingsPatch, string, string]> {
  return [
    // kindRoutes：`every` 与 `some` 的分别只在这个混合数组上看得出来。
    [{ kindRoutes: [] }, "kindRoutes", "需要对象"],
    [{ kindRoutes: { done: "bark:a" } }, "kindRoutes", "字符串数组"],
    [{ kindRoutes: { done: ["bark:a", 1] } }, "kindRoutes", "字符串数组"],
  ];
}
