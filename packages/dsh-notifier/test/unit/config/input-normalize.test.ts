import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../../../src/server/config/impl/input/index.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type {
  NotifyConfig,
  RawSettingValue,
  SettingsPatch,
} from "../../../src/server/config/impl/model/type.ts";
import {
  BARK,
  BUILTINS,
  WEBHOOK,
  barkOf,
  browserOf,
  builtinWithSound,
  invalidOf,
  raw,
  systemOf,
  webhookOf,
} from "./input-input-support.ts";

function registernormalize() {
  describe(
    "normalizeConfig：永不失败（读面在脏文件下也必须交出一份完整可用的设置）",
    describeNormalizeConfig,
  );
  return;
  function describeNormalizeConfig() {
    it("标量键：类型不符或越界一律回落默认值，越界不截断", normalizeTest1);

    it(
      "计数键：闭区间 [0, 上界] 内的整数原样保留（0 与上界都是有意义的取值，不该被当成越界让给默认值）",
      normalizeTest2,
    );

    it(
      "声音三态：false 是显式静音、四个内置音色名保留、白名单外的字符串回落（音色名是跨端约定，不是自由文本）",
      normalizeTest3,
    );

    // 投递投影取**首项**（#1016 残留 2）。写面已绝对拒重复身份，故能从磁盘读到重复的只有手改文件与
    // 0.2.9 之前的存量；此时两条都投 = 一次通知发两遍，而掩码还原（findById）与合并（indexById /
    // sameKindBase）那两侧本就只认首条——取首项让四处同一口径，投递面不再自成一套。
    it("重复身份的条目在投递投影里只取首条：不会一次通知发两遍", normalizeTest4);

    // 身份口径**不看 type**，所以「谁占着 browser 这个身份」由数组里的先后决定：本例内置在前，于是那条
    // bark 被去重掉。这与 builtinRaw（同类型取首条）、findById（裸 id 取首条）是同一把尺——三处若有一处
    // 按 type 各算各的，就会指向不同对象。写面已绝对拒这种配置，故它只可能来自手改文件。
    it("跨类型同 id：身份归先到的那条（内置在前 → bark 被去重，不多投一个出口）", normalizeTest5);
    it(
      "quietHours 逐项独立回落：一个窗口脏不该连带丢掉整组（用户填对的那段要留住）",
      normalizeTest6,
    );

    it(
      "quietHours 不是对象时整块回落默认；windows 缺席一律给空，显式空数组保持空（读侧容忍半截对象，写侧的整块校验是另一道关）",
      normalizeTest7,
    );

    it(
      "quietHours 是「类型闸门 + 逐项格式」两道关：能强转成合法时间的数组不算时间（JSON 提交里数组是合法形状，`test()` 却会做字符串强转）",
      normalizeTest8,
    );

    it(
      "整块回落交出的是深副本：调用方就地改写它不该污染全局默认表（默认值被改过之后，此后每个读者拿到的都不是默认）",
      normalizeTest9,
    );

    it("字符串数组剔除非字符串项而保留其余（一项脏值不该连累整份名单）", normalizeTest10);

    it(
      "kindRoutes 值不是数组的键退化成空路由、键本身保留（脏项只影响它自己那条路由，否则整张表消失）",
      normalizeTest11,
    );

    it(
      "channels 逐项丢弃认不出的项（缺 id / 缺凭据 / 空地址 / 非对象项都不带回值——没有投递目标的空壳会在投递时制造一次必然失败的尝试）",
      normalizeTest12,
    );

    it(
      "bark 频道：level 非法即缺字段而不是兜成 active（兜底会让 error 通知永远发不出 timeSensitive）",
      normalizeTest13,
    );

    it("bark 频道：badge 为 0 时保留（0 是有意义的取值，不是「没设置」）", normalizeTest14);

    // 归一化是**按已知键逐个物化**的（#1016 S2 删掉了 extras 概念）：磁盘上躺着的陌生键不进入
    // 生效设置——既不会被带进投递面，也不会被回显给客户端去撞写面的陌生键判据。
    it("频道条目里的陌生键不进入生效设置：不再有 extras 子对象可透传", normalizeTest15);

    // 归一化读的是**磁盘上的内容**，手改过的文件不经过写入口径：一条手写的 device_key 若被收进
    // 生效设置，就能绕开「凭据只能走已知字段」的收口进到投递面。逐键物化让这条路没有承载物。
    it("保留键（凭据别名）同样不进入生效设置：手改过的文件绕不开收口", normalizeTest16);

    // #1016 S3：读面删除历史兼容。0.2.3 的顶层渠道键（`notifySound` / `browserSound` /
    // `systemSound` 那一批）与更早的全局声音键一律**不再被读面消费**——它们由 upgrade 域 0.2.4 的
    // 配置形态割接在装配期搬进条目并删除。读面再兜一次，两处实现对「只搬了一半的文件」迟早给出不同
    // 答案，而那时已经没有任何用户能看出来是哪一处错了。
    it(
      "旧顶层渠道键不再被读面消费：磁盘上还在的 notifySound / browserSound 读成默认形态（判别力 #7）",
      normalizeTest17,
    );

    it(
      "频道缺省不启用：出站授权须用户显式授予（两类频道同一口径——webhook 只是把同样的授权换成一次外发请求）",
      normalizeTest18,
    );

    it(
      "bark 的 levels 稀疏映射剔除非白名单值（按 kind 的紧急度命中优先于 level）",
      normalizeTest19,
    );

    it("webhook 频道：auth / preset 非法回落 none / custom，凭据字段形状全量写出", normalizeTest20);

    it(
      "webhook 自定义 headers：只留字符串值、非对象即空表（头值上线前必须是字符串，数字与嵌套对象拼不进请求头）",
      normalizeTest21,
    );
  }
}

registernormalize();

function normalizeTest1() {
  const dirty: ReadonlyArray<readonly [keyof NotifyConfig, RawSettingValue]> = [
    ["notifyAsk", "yes"],
    ["notifyQuestion", "false"],
    ["notifyTaskDone", 1],
    ["notifySubagentDone", raw(null)],
    ["notifyTaskError", []],
    ["notifyTurnEnd", {}],
    ["quietHours", "22:00"],
    ["channels", {}],
    ["kindRoutes", []],
    ["allowKinds", "error"],
    ["historyMaxAgeDays", -1],
    ["historyMaxAgeDays", 3_651],
    ["historyMaxAgeDays", 1.5],
    ["historyMaxAgeDays", 4_096],
  ];
  for (const [key, value] of dirty) {
    expect(normalizeConfig({ [key]: value })[key], `${key}=${JSON.stringify(value)}`).toEqual(
      DEFAULT_CONFIG[key],
    );
  }
}

function normalizeTest2() {
  const kept = normalizeConfig({ historyMaxAgeDays: 30 });
  expect(kept.historyMaxAgeDays).toBe(30);

  const bounds = normalizeConfig({ historyMaxAgeDays: 3_650 });
  expect(bounds.historyMaxAgeDays).toBe(3_650);

  const zero = normalizeConfig({ historyMaxAgeDays: 0 });
  expect(zero.historyMaxAgeDays).toBe(0);
}

function normalizeTest3() {
  const rows: ReadonlyArray<readonly [RawSettingValue, boolean | string]> = [
    [false, false],
    ["ding", "ding"],
    ["pop", "pop"],
    ["mp3", true],
    ["", true],
    [3, true],
  ];
  for (const [input, expected] of rows) {
    // 权威形态在条目字段上：两条内置频道各自的 `sound` 是三态语义的唯一入口，投影键由它派生。
    expect(
      browserOf(normalizeConfig({ channels: [builtinWithSound("browser", input)] }).channels).sound,
      `browser sound=${String(input)}`,
    ).toEqual(expected);
    expect(
      systemOf(normalizeConfig({ channels: [builtinWithSound("system", input)] }).channels).sound,
      `system sound=${String(input)}`,
    ).toEqual(expected);
  }
}

function normalizeTest4() {
  const channels = normalizeConfig({
    channels: [...BUILTINS, BARK, { ...BARK, deviceKey: "key-2" }],
  }).channels;
  const barks = channels.filter((item) => item.type === "bark");
  expect(barks).toHaveLength(1);
  // 取的是**首条**（key-1）：与 findById / indexById 的取首条口径一致，取末条会让两侧指向不同对象。
  expect(barkOf(channels).deviceKey).toBe("key-1");
}

function normalizeTest5() {
  const channels = normalizeConfig({
    channels: [BUILTINS[0], BUILTINS[1], { ...BARK, id: "browser" }],
  }).channels;
  // 出站侧一条不剩：bark 抢的身份已被内置 browser 占着。
  expect(channels.filter((item) => item.type === "bark")).toHaveLength(0);
  // 内置 browser 照常在场——去重不伤真正该在的那条。
  expect(browserOf(channels).type).toBe("browser");
}

function normalizeTest6() {
  const quiet = normalizeConfig({
    quietHours: {
      enabled: true,
      windows: [
        { start: "25:00", end: "08:00" },
        { start: "12:00", end: "13:00" },
        { start: "22:00", end: "22:00" },
      ],
      allowKinds: ["error", 3],
    },
  }).quietHours;
  expect(quiet.enabled).toBe(true);
  // 格式错与零长各废一项，合法项原样保留。
  expect(quiet.windows).toEqual([{ start: "12:00", end: "13:00" }]);
  expect(quiet.allowKinds).toEqual(["error"]);
}

function normalizeTest7() {
  // `allowKinds` 在这一支上随默认表走（表上本就没有该键，缺省语义由裁决层定义），故不在此断言。
  for (const input of ["22:00", [], 7, raw(null)]) {
    const quiet = normalizeConfig({ quietHours: input }).quietHours;
    expect(quiet.enabled, JSON.stringify(input)).toBe(false);
    expect(quiet.windows, JSON.stringify(input)).toEqual([{ start: "22:00", end: "08:00" }]);
  }
  // 半截对象走的是另一支：逐子键拼装，于是可选的 allowKinds 会被补成空数组（全量输出）。
  const partial = normalizeConfig({ quietHours: { enabled: true } }).quietHours;
  expect(partial.enabled).toBe(true);
  // #1016 S3 删掉了读面的旧 start/end 回落：`windows` 缺席就是「一条时段都不命中」，
  // 回落默认表等于替用户编一个他没配过的深夜窗口。旧形由 0.2.6 的割接在装配期搬进 windows[0]。
  expect(partial.windows).toEqual([]);
  expect(partial.allowKinds).toEqual([]);
  // 旧形 start/end 读面**不再认**（形态演进是 upgrade 域的职责，读面不认历史）。
  const legacy = normalizeConfig({
    quietHours: { enabled: true, start: "23:00", end: "07:00" },
  }).quietHours;
  expect(legacy.enabled).toBe(true);
  expect(legacy.windows).toEqual([]);
  // 显式空数组保持空：它表达的是「一个都不命中」，不是「缺了要补默认」。
  const empty = normalizeConfig({ quietHours: { enabled: true, windows: [] } }).quietHours;
  expect(empty.windows).toEqual([]);
}

function normalizeTest8() {
  const badStart: SettingsPatch = {
    quietHours: { enabled: true, windows: [{ start: ["22:00"], end: "08:00" }] },
  };
  expect(invalidOf(badStart).hint).toContain("windows[0].start");
  const badEnd: SettingsPatch = {
    quietHours: { enabled: true, windows: [{ start: "22:00", end: ["08:00"] }] },
  };
  expect(invalidOf(badEnd).hint).toContain("windows[0].end");

  // 归一化侧同一口径：非字符串的项一律丢弃，不把数组当时间存进设置；全废则等于未命中。
  const quiet = normalizeConfig({
    quietHours: { enabled: true, windows: [{ start: ["22:00"], end: ["08:00"] }] },
  }).quietHours;
  expect(quiet.windows).toEqual([]);
}

function normalizeTest9() {
  const pristine = {
    ...DEFAULT_CONFIG.quietHours,
    windows: DEFAULT_CONFIG.quietHours.windows.map((w) => ({ ...w })),
  };
  const fallback = normalizeConfig({ quietHours: "22:00" }).quietHours;
  try {
    fallback.enabled = true;
    fallback.windows[0]!.start = "00:00";

    const again = normalizeConfig({ quietHours: "22:00" }).quietHours;
    expect(again.enabled).toBe(pristine.enabled);
    expect(again.windows).toEqual(pristine.windows);
  } finally {
    // 修复前这一改动落在默认表本体上：还原它，同文件后面的用例才不会继承一个被改过的默认值。
    Object.assign(DEFAULT_CONFIG.quietHours, pristine);
  }
}

function normalizeTest10() {
  expect(
    normalizeConfig({ allowKinds: ["demo:a", 3, raw(null), "demo:b", {}] }).allowKinds,
  ).toEqual(["demo:a", "demo:b"]);
}

function normalizeTest11() {
  const routes = normalizeConfig({
    kindRoutes: { done: ["bark:a"], error: "bark:b", ask: [1, "webhook:c"] },
  }).kindRoutes;
  expect(routes.done).toEqual(["bark:a"]);
  expect(routes.error).toEqual([]);
  expect(routes.ask).toEqual(["webhook:c"]);
}

function normalizeTest12() {
  const channels = normalizeConfig({
    channels: [
      BARK,
      WEBHOOK,
      { type: "bark", id: "bark:no-key", baseUrl: "https://x" },
      { type: "webhook", id: "webhook:no-url" },
      { type: "bark", baseUrl: "https://x", deviceKey: "k" },
      { type: "bark", id: "bark:empty-base", baseUrl: "", deviceKey: "k" },
      { type: "mail", id: "mail:a", url: "https://x" },
      "not-a-channel",
      raw(null),
    ],
  }).channels;
  expect(channels.map((channel) => channel.id)).toEqual([
    "browser",
    "system",
    "bark:phone",
    "webhook:hook",
  ]);
}

function normalizeTest13() {
  const dirty = barkOf(normalizeConfig({ channels: [{ ...BARK, level: "urgent" }] }).channels);
  expect("level" in dirty).toBe(false);
  const valid = barkOf(
    normalizeConfig({ channels: [{ ...BARK, level: "timeSensitive" }] }).channels,
  );
  expect(valid.level).toBe("timeSensitive");
}

function normalizeTest14() {
  expect(barkOf(normalizeConfig({ channels: [{ ...BARK, badge: 0 }] }).channels).badge).toBe(0);
  const dirty = barkOf(normalizeConfig({ channels: [{ ...BARK, badge: "3" }] }).channels);
  expect("badge" in dirty).toBe(false);
}

function normalizeTest15() {
  const channel = barkOf(
    normalizeConfig({
      channels: [{ ...BARK, volume: 5, call: "1", nested: { a: 1 }, flag: true }],
    }).channels,
  );
  expect("extras" in channel).toBe(false);
  expect("volume" in channel).toBe(false);
  expect("call" in channel).toBe(false);
  const hook = webhookOf(
    normalizeConfig({ channels: [{ ...WEBHOOK, futureKey: "v", retries: 2 }] }).channels,
  );
  expect("extras" in hook).toBe(false);
  expect("futureKey" in hook).toBe(false);
}

function normalizeTest16() {
  // 保留键清单按频道类型分（bark 的别名与 webhook 的别名不是同一批），这里只用 bark 自己的。
  const channel = barkOf(
    normalizeConfig({
      channels: [{ ...BARK, device_key: "leak", ciphertext: "leak2" }],
    }).channels,
  );
  expect(JSON.stringify(channel)).not.toContain("leak");
  expect("device_key" in channel).toBe(false);
}

function normalizeTest17() {
  const quiet = normalizeConfig({
    notifySound: false,
    browserSound: "ding",
    systemSound: "chime",
  });
  // 回落方向是默认表，不是旧键的值：静音设置不会被一个读面已经不再认识的键改写。
  expect(browserOf(quiet.channels).sound).toBe(true);
  expect(systemOf(quiet.channels).sound).toBe(true);
  // 条目里显式写下的字段照旧生效——丢的是「旧键」这条输入，不是「条目字段」这条输入。
  const explicit = normalizeConfig({
    notifySound: false,
    channels: [builtinWithSound("browser", "ding"), { type: "system", id: "system" }],
  });
  expect(browserOf(explicit.channels).sound).toBe("ding");
  expect(systemOf(explicit.channels).sound).toBe(true);
}

function normalizeTest18() {
  expect(barkOf(normalizeConfig({ channels: [BARK] }).channels).enabled).toBe(false);
  expect(barkOf(normalizeConfig({ channels: [{ ...BARK, enabled: true }] }).channels).enabled).toBe(
    true,
  );
  expect(webhookOf(normalizeConfig({ channels: [WEBHOOK] }).channels).enabled).toBe(false);
}

function normalizeTest19() {
  const bark = barkOf(
    normalizeConfig({
      channels: [{ ...BARK, levels: { done: "critical", error: "nope", ask: 3 } }],
    }).channels,
  );
  expect(Object.keys(bark.levels ?? {})).toEqual(["done"]);
  expect(bark.levels?.done).toBe("critical");
}

function normalizeTest20() {
  const fallback = webhookOf(
    normalizeConfig({ channels: [{ ...WEBHOOK, auth: "oauth", preset: "slack" }] }).channels,
  );
  expect(fallback.auth).toBe("none");
  expect(fallback.preset).toBe("custom");
  expect(fallback.token).toBe("");
  expect(fallback.password).toBe("");

  const kept = webhookOf(
    normalizeConfig({
      channels: [{ ...WEBHOOK, auth: "bearer", preset: "ntfy", token: "t-1" }],
    }).channels,
  );
  expect(kept.auth).toBe("bearer");
  expect(kept.preset).toBe("ntfy");
  expect(kept.token).toBe("t-1");
  expect(kept.headerValue).toBe("");
}

function normalizeTest21() {
  const kept = webhookOf(
    normalizeConfig({
      channels: [{ ...WEBHOOK, headers: { "x-a": "1", "x-b": 2, "x-c": raw(null), "x-d": {} } }],
    }).channels,
  );
  expect(kept.headers).toEqual({ "x-a": "1" });

  for (const headers of ["oops", ["x-a"], raw(null), 3]) {
    const empty = webhookOf(normalizeConfig({ channels: [{ ...WEBHOOK, headers }] }).channels);
    expect(empty.headers, JSON.stringify(headers)).toEqual({});
  }
}
