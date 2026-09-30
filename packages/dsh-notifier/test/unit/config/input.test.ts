/**
 * dsh-notifier config 域 input 块 —— 外部输入进入设置模型的唯一闸门。
 *
 * 为什么逐条守：三个来源（磁盘配置文件、组合层入口、HTTP 提交）都**不受信**，而闸门的三道工序
 * 语义不同，混用会静默改写用户输入——归一化**永不失败**（读面不能因为一份脏文件而崩）、校验
 * **只审显式提交**（缺键不是错误）、净化**只留认识的键**（但不顺手归一化）。故用例按工序分组，
 * 各组断言互不重叠：同一分支在两处出现即视为冗余。
 *
 * 本块是 L1 纯函数块，直引 `impl/input/index.ts`（门禁 verify-dir-imports 只扫 `src/`）。
 */
import { describe, expect, it } from "vitest";

import {
  BARK_RESERVED_KEYS,
  RETIRED_KEYS,
  UNSAFE_KEYS,
  WEBHOOK_RESERVED_KEYS,
  normalizeConfig,
  parseJsonObject,
  sanitizeSettings,
  validateSettings,
  validateSettingsWithMerge,
} from "../../../src/server/config/impl/input/index.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import { BARK_LEVELS_LIMIT, WEBHOOK_TEMPLATE_MAX_CHARS } from "../../../src/shared/interface.ts";
import type {
  BarkChannelConfig,
  BrowserChannelConfig,
  ChannelConfig,
  NotifyConfig,
  RawSettingValue,
  SettingInvalid,
  SettingsPatch,
  StoredSettings,
  SystemChannelConfig,
  WebhookChannelConfig,
} from "../../../src/server/config/impl/model/type.ts";

/** 绕过类型构造运行时真实存在、类型层却排除掉的脏值。 */
function raw(value: unknown): RawSettingValue {
  return value as RawSettingValue;
}

/** 同上，用于净化面：那里的入参类型是 `StoredSettings`，标量与空值同样落不进去。 */
function stored(value: unknown): StoredSettings {
  return value as StoredSettings;
}

/** 取校验失败载荷；放行即当场失败（否则断言会落在一个不存在的事实上）。 */
function invalidOf(patch: SettingsPatch): SettingInvalid {
  const verdict = validateSettings(patch);
  if (verdict.ok) throw new Error(`期望判非法，实际放行：${JSON.stringify(patch)}`);
  return verdict.error;
}

/** 取归一化后的第一个出站频道并收窄到 bark（内置两条恒在最前，故按类型找而不是按下标）。 */
function barkOf(channels: readonly ChannelConfig[]): BarkChannelConfig {
  const channel = channels.find((item) => item.type === "bark");
  if (channel?.type !== "bark") throw new Error("期望归一化出一个 bark 频道");
  return channel;
}

/** 取归一化后的第一个出站频道并收窄到 webhook。 */
function webhookOf(channels: readonly ChannelConfig[]): WebhookChannelConfig {
  const channel = channels.find((item) => item.type === "webhook");
  if (channel?.type !== "webhook") throw new Error("期望归一化出一个 webhook 频道");
  return channel;
}

/** 取归一化后的浏览器内置条目。 */
function browserOf(channels: readonly ChannelConfig[]): BrowserChannelConfig {
  const channel = channels.find((item) => item.type === "browser");
  if (channel?.type !== "browser") throw new Error("期望归一化出一个浏览器内置条目");
  return channel;
}

/** 取归一化后的系统内置条目。 */
function systemOf(channels: readonly ChannelConfig[]): SystemChannelConfig {
  const channel = channels.find((item) => item.type === "system");
  if (channel?.type !== "system") throw new Error("期望归一化出一个系统内置条目");
  return channel;
}

/** 内置两条的合法提交形态：写面要求显式提交的 `channels` 仍然带着它们。 */
const BUILTINS = [
  { type: "browser", id: "browser", enabled: true, popup: true, sound: false, whenVisible: false },
  { type: "system", id: "system", enabled: false, popup: false, sound: false },
] as const;

/** 出站频道提交体补上两条内置条目：内置不能删除，缺了它们提交会先被那条规则拦下。 */
function withBuiltins(list: readonly Record<string, unknown>[]): RawSettingValue[] {
  return [...BUILTINS, ...list] as unknown as RawSettingValue[];
}

/** 一条内置条目，只带被测字段：缺的字段由归一化沿「存量别名 → 默认表」补齐。 */
function builtinWithSound(
  type: "browser" | "system",
  sound: RawSettingValue,
): Record<string, RawSettingValue> {
  return { type, id: type, sound };
}

/** 合法 bark 频道：单项守卫用例以它为基底，只改被测字段。 */
const BARK = {
  type: "bark",
  id: "bark:phone",
  baseUrl: "https://api.day.app",
  deviceKey: "key-1",
};

/** 合法 webhook 频道。 */
const WEBHOOK = {
  type: "webhook",
  id: "webhook:hook",
  url: "https://example.test/hook",
};

describe("parseJsonObject：坏内容一律当空设置", () => {
  it("坏 JSON 与非对象文本一律得到空设置（配置文件被手改坏时读面回落默认，而不是让整个插件装配失败）", () => {
    for (const text of ["", "{", "[]", "12", '"x"', "null", "true", "[{}]"]) {
      expect(parseJsonObject(text), `text=${JSON.stringify(text)}`).toEqual({});
    }
  });

  it("合法对象原样读出，嵌套与陌生键都不在这里处理（净化与归一化是后面的工序）", () => {
    expect(parseJsonObject('{"notifyAsk":false,"future":{"a":[1,2]}}')).toEqual({
      notifyAsk: false,
      future: { a: [1, 2] },
    });
  });
});

describe("normalizeConfig：永不失败（读面在脏文件下也必须交出一份完整可用的设置）", () => {
  it("标量键：类型不符或越界一律回落默认值，越界不截断", () => {
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
  });

  it("计数键：闭区间 [0, 上界] 内的整数原样保留（0 与上界都是有意义的取值，不该被当成越界让给默认值）", () => {
    const kept = normalizeConfig({ historyMaxAgeDays: 30 });
    expect(kept.historyMaxAgeDays).toBe(30);

    const bounds = normalizeConfig({ historyMaxAgeDays: 3_650 });
    expect(bounds.historyMaxAgeDays).toBe(3_650);

    const zero = normalizeConfig({ historyMaxAgeDays: 0 });
    expect(zero.historyMaxAgeDays).toBe(0);
  });

  it("声音三态：false 是显式静音、四个内置音色名保留、白名单外的字符串回落（音色名是跨端约定，不是自由文本）", () => {
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
        browserOf(normalizeConfig({ channels: [builtinWithSound("browser", input)] }).channels)
          .sound,
        `browser sound=${String(input)}`,
      ).toEqual(expected);
      expect(
        systemOf(normalizeConfig({ channels: [builtinWithSound("system", input)] }).channels).sound,
        `system sound=${String(input)}`,
      ).toEqual(expected);
    }
  });

  // 投递投影取**首项**（#1016 残留 2）。写面已绝对拒重复身份，故能从磁盘读到重复的只有手改文件与
  // 0.2.9 之前的存量；此时两条都投 = 一次通知发两遍，而掩码还原（findById）与合并（indexById /
  // sameKindBase）那两侧本就只认首条——取首项让四处同一口径，投递面不再自成一套。
  it("重复身份的条目在投递投影里只取首条：不会一次通知发两遍", () => {
    const channels = normalizeConfig({
      channels: [...BUILTINS, BARK, { ...BARK, deviceKey: "key-2" }],
    }).channels;
    const barks = channels.filter((item) => item.type === "bark");
    expect(barks).toHaveLength(1);
    // 取的是**首条**（key-1）：与 findById / indexById 的取首条口径一致，取末条会让两侧指向不同对象。
    expect(barkOf(channels).deviceKey).toBe("key-1");
  });

  // 身份口径**不看 type**，所以「谁占着 browser 这个身份」由数组里的先后决定：本例内置在前，于是那条
  // bark 被去重掉。这与 builtinRaw（同类型取首条）、findById（裸 id 取首条）是同一把尺——三处若有一处
  // 按 type 各算各的，就会指向不同对象。写面已绝对拒这种配置，故它只可能来自手改文件。
  it("跨类型同 id：身份归先到的那条（内置在前 → bark 被去重，不多投一个出口）", () => {
    const channels = normalizeConfig({
      channels: [BUILTINS[0], BUILTINS[1], { ...BARK, id: "browser" }],
    }).channels;
    // 出站侧一条不剩：bark 抢的身份已被内置 browser 占着。
    expect(channels.filter((item) => item.type === "bark")).toHaveLength(0);
    // 内置 browser 照常在场——去重不伤真正该在的那条。
    expect(browserOf(channels).type).toBe("browser");
  });
  it("quietHours 逐项独立回落：一个窗口脏不该连带丢掉整组（用户填对的那段要留住）", () => {
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
  });

  it("quietHours 不是对象时整块回落默认；windows 缺席一律给空，显式空数组保持空（读侧容忍半截对象，写侧的整块校验是另一道关）", () => {
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
  });

  it("quietHours 是「类型闸门 + 逐项格式」两道关：能强转成合法时间的数组不算时间（JSON 提交里数组是合法形状，`test()` 却会做字符串强转）", () => {
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
  });

  it("整块回落交出的是深副本：调用方就地改写它不该污染全局默认表（默认值被改过之后，此后每个读者拿到的都不是默认）", () => {
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
  });

  it("字符串数组剔除非字符串项而保留其余（一项脏值不该连累整份名单）", () => {
    expect(
      normalizeConfig({ allowKinds: ["demo:a", 3, raw(null), "demo:b", {}] }).allowKinds,
    ).toEqual(["demo:a", "demo:b"]);
  });

  it("kindRoutes 值不是数组的键退化成空路由、键本身保留（脏项只影响它自己那条路由，否则整张表消失）", () => {
    const routes = normalizeConfig({
      kindRoutes: { done: ["bark:a"], error: "bark:b", ask: [1, "webhook:c"] },
    }).kindRoutes;
    expect(routes.done).toEqual(["bark:a"]);
    expect(routes.error).toEqual([]);
    expect(routes.ask).toEqual(["webhook:c"]);
  });

  it("channels 逐项丢弃认不出的项（缺 id / 缺凭据 / 空地址 / 非对象项都不带回值——没有投递目标的空壳会在投递时制造一次必然失败的尝试）", () => {
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
  });

  it("bark 频道：level 非法即缺字段而不是兜成 active（兜底会让 error 通知永远发不出 timeSensitive）", () => {
    const dirty = barkOf(normalizeConfig({ channels: [{ ...BARK, level: "urgent" }] }).channels);
    expect("level" in dirty).toBe(false);
    const valid = barkOf(
      normalizeConfig({ channels: [{ ...BARK, level: "timeSensitive" }] }).channels,
    );
    expect(valid.level).toBe("timeSensitive");
  });

  it("bark 频道：badge 为 0 时保留（0 是有意义的取值，不是「没设置」）", () => {
    expect(barkOf(normalizeConfig({ channels: [{ ...BARK, badge: 0 }] }).channels).badge).toBe(0);
    const dirty = barkOf(normalizeConfig({ channels: [{ ...BARK, badge: "3" }] }).channels);
    expect("badge" in dirty).toBe(false);
  });

  // 归一化是**按已知键逐个物化**的（#1016 S2 删掉了 extras 概念）：磁盘上躺着的陌生键不进入
  // 生效设置——既不会被带进投递面，也不会被回显给客户端去撞写面的陌生键判据。
  it("频道条目里的陌生键不进入生效设置：不再有 extras 子对象可透传", () => {
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
  });

  // 归一化读的是**磁盘上的内容**，手改过的文件不经过写入口径：一条手写的 device_key 若被收进
  // 生效设置，就能绕开「凭据只能走已知字段」的收口进到投递面。逐键物化让这条路没有承载物。
  it("保留键（凭据别名）同样不进入生效设置：手改过的文件绕不开收口", () => {
    // 保留键清单按频道类型分（bark 的别名与 webhook 的别名不是同一批），这里只用 bark 自己的。
    const channel = barkOf(
      normalizeConfig({
        channels: [{ ...BARK, device_key: "leak", ciphertext: "leak2" }],
      }).channels,
    );
    expect(JSON.stringify(channel)).not.toContain("leak");
    expect("device_key" in channel).toBe(false);
  });

  // #1016 S3：读面删除历史兼容。0.2.3 的顶层渠道键（`notifySound` / `browserSound` /
  // `systemSound` 那一批）与更早的全局声音键一律**不再被读面消费**——它们由 upgrade 域 0.2.4 的
  // 配置形态割接在装配期搬进条目并删除。读面再兜一次，两处实现对「只搬了一半的文件」迟早给出不同
  // 答案，而那时已经没有任何用户能看出来是哪一处错了。
  it("旧顶层渠道键不再被读面消费：磁盘上还在的 notifySound / browserSound 读成默认形态（判别力 #7）", () => {
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
  });

  it("频道缺省不启用：出站授权须用户显式授予（两类频道同一口径——webhook 只是把同样的授权换成一次外发请求）", () => {
    expect(barkOf(normalizeConfig({ channels: [BARK] }).channels).enabled).toBe(false);
    expect(
      barkOf(normalizeConfig({ channels: [{ ...BARK, enabled: true }] }).channels).enabled,
    ).toBe(true);
    expect(webhookOf(normalizeConfig({ channels: [WEBHOOK] }).channels).enabled).toBe(false);
  });

  it("bark 的 levels 稀疏映射剔除非白名单值（按 kind 的紧急度命中优先于 level）", () => {
    const bark = barkOf(
      normalizeConfig({
        channels: [{ ...BARK, levels: { done: "critical", error: "nope", ask: 3 } }],
      }).channels,
    );
    expect(Object.keys(bark.levels ?? {})).toEqual(["done"]);
    expect(bark.levels?.done).toBe("critical");
  });

  it("webhook 频道：auth / preset 非法回落 none / custom，凭据字段形状全量写出", () => {
    const fallback = webhookOf(
      normalizeConfig({ channels: [{ ...WEBHOOK, auth: "oauth", preset: "slack" }] }).channels,
    );
    expect(fallback.auth).toBe("none");
    expect(fallback.preset).toBe("custom");
    expect(fallback.token).toBe("");
    expect(fallback.password).toBe("");

    const kept = webhookOf(
      normalizeConfig({ channels: [{ ...WEBHOOK, auth: "bearer", preset: "ntfy", token: "t-1" }] })
        .channels,
    );
    expect(kept.auth).toBe("bearer");
    expect(kept.preset).toBe("ntfy");
    expect(kept.token).toBe("t-1");
    expect(kept.headerValue).toBe("");
  });

  it("webhook 自定义 headers：只留字符串值、非对象即空表（头值上线前必须是字符串，数字与嵌套对象拼不进请求头）", () => {
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
  });
});

describe("validateSettings：只审显式提交（缺键不是错误）", () => {
  it("空提交与 undefined 值放行（设置页整份提交时，未改动的字段可能带 undefined）", () => {
    expect(validateSettings({})).toEqual({ ok: true });
    expect(validateSettings({ notifyAsk: undefined, channels: undefined })).toEqual({ ok: true });
  });

  it("首个非法键即返回并带上界提示（一次只报一个：设置页的定位光标只能落在一个字段上）", () => {
    expect(invalidOf({ historyMaxAgeDays: -1, notifyAsk: "yes" }).key).toBe("historyMaxAgeDays");
    expect(invalidOf({ historyMaxAgeDays: -1, notifyAsk: "yes" }).hint).toContain("3650");
    expect(invalidOf({ notifyAsk: "yes", historyMaxAgeDays: -1 }).key).toBe("notifyAsk");
    // 合法值不是出口：扫到它必须继续往下看，否则「合法键 + 非法键」的整份提交会被整体放行。
    expect(invalidOf({ notifyAsk: true, historyMaxAgeDays: -1 }).key).toBe("historyMaxAgeDays");
  });

  it("保留键写拒：凭据别名键命中即 400 且提示点名该键（静默剔除会让用户以为设置生效了）", () => {
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
  });

  // 陌生键一律 400（#1016 S2）：透传面要求读面把陌生键收进 `extras` 子对象再原样交回客户端，
  // 而写面只放行 string/number——`extras` 这个**对象**自己撞上那条判据，该频道所在配置从此
  // 再也保存不了（#1016 缺陷 B）。收窄到「本版本认识的键」把那条自撞的口子关掉。
  // 值是什么（对象/布尔/数组/字符串）不再影响结论：只有「认不认识」这一件事。
  it("频道条目里的陌生键一律 400：值是字符串、数字、对象、布尔、数组都不放行", () => {
    for (const extra of [5, "1", { a: 1 }, true, [1]] as unknown[]) {
      const invalid = invalidOf({ channels: withBuiltins([{ ...BARK, extraKey: extra }]) });
      expect(invalid.key, JSON.stringify(extra)).toBe("channels");
      expect(invalid.hint, JSON.stringify(extra)).toContain("extraKey");
      expect(invalid.hint, JSON.stringify(extra)).toContain("不是已知键");
    }
  });

  it("内置渠道不能删除：显式提交的 channels 少一条内置条目即 400，提示点名缺的那一条（其余一律按普通条目处理）", () => {
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
  });

  // 内置身份由 type 唯一确定：id 只是回显，写了别的值说明提交方在自造身份（归一化会强制改写它，
  // 写面必须当场拒，否则用户以为改掉了而实际没有）。
  it("内置条目的 id 必须与 type 一致：写了别的 id 一律 400", () => {
    const wrongId = invalidOf({ channels: [{ ...BUILTINS[0], id: "chrome" }, BUILTINS[1]] });
    expect(wrongId.key).toBe("channels");
    expect(wrongId.hint).toContain("id 只能是");
  });
  // ── 频道身份唯一（#1016 残留 2）──────────────────────────────────────────
  //
  // 重复身份是**凭据销毁**而不是显示重复：设置页对 channels 整组提交，合并的 sameKindBase 按裸 id
  // 取首条、KEEP 又让其余键沿用首条的值，于是第二条的真实密钥被第一条覆盖，每次保存毁一条。
  // 掩码还原的 findById 同样按裸 id 查找，故**跨类型同 id 也撞**。
  it("同类型重复 id 一律 400：两条 bark 用同一个 id 即拒（每次保存都会毁掉第二条的 deviceKey）", () => {
    const invalid = invalidOf({
      channels: [...BUILTINS, BARK, { ...BARK, deviceKey: "key-2" }],
    });
    expect(invalid.key).toBe("channels");
    // 提示必须点名那个身份：用户看得到两条 bark 卡片，却改不了它们的 id（客户端没有 id 编辑器）。
    expect(invalid.hint).toContain("bark:phone");
  });

  it('跨类型重复 id 也 400：掩码还原按裸 id 查找，bark 写 id="browser" 会命中内置条目', () => {
    const invalid = invalidOf({ channels: [BUILTINS[0], BUILTINS[1], { ...BARK, id: "browser" }] });
    expect(invalid.key).toBe("channels");
    expect(invalid.hint).toContain("browser");
  });

  // 提示要给**下标**与**可自救的动作**：用户改不了 id，只说「重复」等于堵死。文案按 1 起数（界面上的第几条），
  // 所以落盘数组的下标要 +1——这条专门钉那个换算，写成 0 起数时用户会数错条目。
  it("重复身份的提示带 1 起的下标，并明说删掉其中一条（用户改不了 id，文案必须给出路）", () => {
    const invalid = invalidOf({ channels: [...BUILTINS, BARK, { ...BARK, deviceKey: "key-2" }] });
    // BUILTINS 占前两条，故冲突发生在第 3 条与第 4 条。
    expect(invalid.hint).toContain("第 3 条");
    expect(invalid.hint).toContain("第 4 条");
    expect(invalid.hint).toContain("删掉其中一条");
  });

  // 零误伤是这条判据的另一半：内置条目的 id **可以缺席**（0.2.4 割接在用户没设过旧键时写出的就是
  // `{type,id}`，而更早的形态连 id 键都没有），身份此时回落 type。口径写错成「id 必填」就会让每一次
  // 无关保存都被拒，用户还看不出是哪一条。
  it("内置条目缺席 id 不误伤：身份回落 type（0.2.4 割接写出的就是没有 id 键的形态）", () => {
    expect(validateSettings({ channels: [{ type: "browser" }, { type: "system" }, BARK] })).toEqual(
      {
        ok: true,
      },
    );
  });

  // 两条内置的 id 都缺席时身份分别是 browser / system，仍然互不相同——若口径写成「一律空串」或
  // 「一律 type 常量」，这条会当场撞车并把合法的内置配置拒掉。
  it("两条内置同时缺席 id 仍互不相同（口径不是把所有缺席 id 折成同一个身份）", () => {
    expect(validateSettings({ channels: [{ type: "browser" }, { type: "system" }, BARK] })).toEqual(
      {
        ok: true,
      },
    );
    // 同一类型重复出现（两条 browser）仍要拒：内置重复是「用户提交了两张一样的卡」，不是合法配置。
    const dup = invalidOf({
      channels: [{ type: "browser" }, { type: "browser" }, { type: "system" }, BARK],
    });
    expect(dup.key).toBe("channels");
    expect(dup.hint).toContain("browser");
  });

  // 内置 id 写错仍由既有的「id 只能是 type」判据拒，本组不与之分叉：那条判据更早、话术更贴切。
  it("内置 id 写错仍由既有判据拒（不因新增的数组级判据而改口）", () => {
    const wrongId = invalidOf({ channels: [{ ...BUILTINS[0], id: "chrome" }, BUILTINS[1]] });
    expect(wrongId.hint).toContain("id 只能是");
  });

  // 绝对 400：不给 preexisting 放行。放行是「存量残缺不该让无关保存被拒」，而重复身份是存量**自相矛盾**
  //（同一个身份挂两套凭据）——放行等于把「每次保存毁一条凭据」合法化。走合并入口逐条钉。
  it("存量里就有重复身份时，本次无关保存照样 400（不给 preexisting 放行）", () => {
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
  });

  // 这一批键已经没有值语义。当陌生键放行会让停在升级前页面上的旧客户端以为存上了
  // （200 + 什么都不发生），所以写面必须拒——提示里给出出路（刷新），用户知道下一步做什么。
  // 期望话术逐键字面写出而不是引用 RETIRED_KEYS 的值：断言若从被测事实源取值，话术改错也照样绿。
  it("退役键写拒：每个退役键提交一律 400，提示是该键自己的话术（与值无关）", () => {
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
  });

  // maxConnections 与 0.2.3 那批同属「曾经存在、值语义已消失」，但拒收原因不同：不是搬了家，
  // 是 0.2.5 把连接上限机制整体移除。共用 0.2.4 那句话会把用户引到错误的原因上，故它必须有自己那句。
  it("maxConnections 写拒：按退役键拒收，且不套用渠道键那句话术（原因不同，话术不能共用）", () => {
    const verdict = validateSettings({ maxConnections: 64 } as SettingsPatch);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.key).toBe("maxConnections");
    expect(verdict.ok ? "" : verdict.error.hint).toContain("0.2.5");
    expect(verdict.ok ? "" : verdict.error.hint).not.toContain("已移入渠道条目");
  });

  // 顶层陌生键同样 400（#1016 S2）：写面不再「透传保留」它们。存量里已有的陌生键不受影响——
  // 它们不在提交里，按字段合并时原样沿用（服务端那一半见 service.test.ts）。
  it("本版本不认识的顶层键写拒：与频道条目里的陌生键同一条口径", () => {
    const invalid = invalidOf({ futureKey: 1 } as unknown as SettingsPatch);
    expect(invalid.key).toBe("futureKey");
    expect(invalid.hint).toContain("不是已知配置键");
    // 归一化本来就不认它，值得不到生效位——400 只是让「你以为存上了」这件事当场暴露。
    expect("futureKey" in normalizeConfig({ futureKey: 1 })).toBe(false);
  });

  // 原型链危险键是**另一类**：它们在落盘前被整条剔除（writableEntries），原型改写已经被挡下，
  // 再报「陌生键」只会把一次安全的写变成 400。
  it("原型链危险键不进判据：它们由写面剔除，不按陌生键拒收", () => {
    for (const key of UNSAFE_KEYS) {
      expect(validateSettings({ [key]: { pwned: true } } as unknown as SettingsPatch), key).toEqual(
        {
          ok: true,
        },
      );
    }
  });

  it("逐键类型闸门：每个非法值都指向它自己那个键，且提示指向真正拦下它的那条分支（键对了、提示指向别处，等于把用户引到另一个字段）", () => {
    const rows: ReadonlyArray<readonly [SettingsPatch, string, string]> = [
      [{ notifyAsk: "false" }, "notifyAsk", "true 或 false"],
      [{ historyMaxAgeDays: -1 }, "historyMaxAgeDays", "0 到 3650"],
      [{ historyMaxAgeDays: 3_651 }, "historyMaxAgeDays", "0 到 3650"],
      [{ historyMaxAgeDays: 1.5 }, "historyMaxAgeDays", "0 到 3650"],
      [{ historyMaxAgeDays: "8" }, "historyMaxAgeDays", "0 到 3650"],
      [{ allowKinds: "error" }, "allowKinds", "字符串数组"],
      [{ allowKinds: ["a", 1] }, "allowKinds", "字符串数组"],
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
      // channels：每条拒绝都挂在同一个键上，能分辨出是哪一条拦下的只有提示。逐项校验各自独立
      // ——前面那条合法不替后面那条担保。
      [{ channels: {} }, "channels", "需要数组"],
      [{ channels: ["x"] }, "channels", "需要对象"],
      [
        { channels: [{ type: "bark", baseUrl: "https://x", deviceKey: "k" }] },
        "channels",
        "缺少 id",
      ],
      [
        { channels: [{ type: "bark", id: "", baseUrl: "https://x", deviceKey: "k" }] },
        "channels",
        "缺少 id",
      ],
      [
        { channels: [{ type: "bark", id: "bark:a", baseUrl: "https://x" }] },
        "channels",
        "deviceKey",
      ],
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
            { type: "webhook", id: "webhook:a", url: "https://x", auth: "oauth", preset: "custom" },
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
      // kindRoutes：`every` 与 `some` 的分别只在这个混合数组上看得出来。
      [{ kindRoutes: [] }, "kindRoutes", "需要对象"],
      [{ kindRoutes: { done: "bark:a" } }, "kindRoutes", "字符串数组"],
      [{ kindRoutes: { done: ["bark:a", 1] } }, "kindRoutes", "字符串数组"],
    ];
    for (const [patch, key, hint] of rows) {
      const error = invalidOf(patch);
      expect(error.key, JSON.stringify(patch)).toBe(key);
      expect(error.hint, JSON.stringify(patch)).toContain(hint);
    }
  });

  it("quietHours.allowKinds 的元素类型与顶层同一口径：错位元素与混合数组都判非法，合法名单放行", () => {
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
  });

  it("quietHours 一次只报首错：首个非法窗口的下标进 hint，后面的错不展开（设置页光标只能落一处）", () => {
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
  });

  it("quietHours.windows 超限 400、上限与空数组放行（静默截断会让用户以为配好的时段生效了）", () => {
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
  });

  it("边界值与整份合法提交放行（闸门把用户正常保存拦住，比放过一个非法值更糟）", () => {
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
  });
});

describe("sanitizeSettings：只留认识的键，且不归一化", () => {
  it("陌生键被剔除而不是拒绝（配置文件与别的工具共享，但它不该被带进用户层再写回去）", () => {
    const kept = sanitizeSettings({ notifyAsk: false, futureKey: { a: 1 }, another: "x" });
    expect(Object.keys(kept)).toEqual(["notifyAsk"]);
    expect(kept.notifyAsk).toBe(false);
  });

  it("值原样带出，不在这里归一化（顺手归一化会让写路径把用户的原始提交偷偷改写掉）", () => {
    const kept = sanitizeSettings({ notifyAsk: "yes", historyMaxAgeDays: -5 });
    expect(kept.notifyAsk).toBe("yes");
    expect(kept.historyMaxAgeDays).toBe(-5);
  });

  it("没有可认识的键时得到空设置：陌生键被剔除、输入根本不是对象（空值走到索引取值会直接抛），两条路对调用方是同一件事", () => {
    expect(sanitizeSettings({ a: 1, b: [2] })).toEqual({});
    for (const value of [null, undefined, [], "notifyAsk", 3, true]) {
      expect(sanitizeSettings(stored(value)), String(value)).toEqual({});
    }
  });
});

// ---------------------------------------------------------------- #1016 S2：判据对象 = 合并后的条目
//
// 写面把 channels 改成按字段合并之后，判据问的问题也换了：不再是「提交上来的这条合不合法」，
// 而是「**这次写真正要落盘的那条**合不合法」。两者在存量有非法值时给出相反的结论，而后者才是
// 用户要的——磁盘上一份越界的旧配置不该让他此后改个名字都存不下去。
//
// 判据据此多收一个面：inherited（该条目里哪些字段的值原样来自存量）。清单里的字段不重判值域，
// 但**形状**判据（必填键、内置在场）一条都不让——删掉一个必填键的后果与它是不是本次改动无关。
// 服务端那一半（端到端、含真实落盘）在 test/unit/config/service.test.ts 的「按字段合并」块。

describe("validateSettingsWithMerge：判据对象是合并后的条目（#1016 S2）", () => {
  /** 一条 webhook 的合并结果 + 它的 inherited 清单 + 两条内置（内置在场是形状判据，别让它盖住要断的那条）。 */
  function webhookMerge(extra: Record<string, RawSettingValue>, inherited: string[]) {
    const entry = { ...WEBHOOK, auth: "none", ...extra };
    return {
      channels: [...BUILTINS, entry] as RawSettingValue[],
      inherited: [new Set<string>(), new Set<string>(), new Set(inherited)],
    };
  }

  // 「不动存量」的方向：磁盘上那份 9000 字符的 template 原样带回来，不重新判它超没超上限。
  it("inherited 里的字段不重判值域：存量越界值不因一次无关保存被拒", () => {
    const long = { template: "x".repeat(9000) };
    // 不带 inherited（= 草稿路径的老行为）：照样 400——本次提交就要为这个值负责。
    const bare = validateSettingsWithMerge({ channels: webhookMerge(long, []).channels });
    expect(bare.ok).toBe(false);
    expect(bare.ok ? "" : bare.error.hint).toContain("template");
    // 声明它沿用存量：放行。
    const kept = validateSettingsWithMerge(
      { channels: webhookMerge(long, []).channels },
      webhookMerge(long, ["template"]),
    );
    expect(kept.ok).toBe(true);
  });

  // 同一个字段、同样的值，只要**本次真的改了**它（不在 inherited 里）就重新判——
  // 「不动存量」不是「不看值」。
  it("同一个越界值不在 inherited 里时照样 400（不动存量 ≠ 不看值）", () => {
    const long = { template: "x".repeat(9000) };
    const checked = validateSettingsWithMerge(
      { channels: webhookMerge(long, []).channels },
      webhookMerge(long, []),
    );
    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.error.hint).toContain("template");
  });

  // 陌生键同理：存量条目上已有的陌生键由合并沿用，不该被一次无关保存追责；本次新交的拒。
  it("inherited 里的陌生键放行：存量条目上那个键一次无关保存不追责", () => {
    const extra = { myCustom: "kept" };
    const kept = validateSettingsWithMerge(
      { channels: webhookMerge(extra, []).channels },
      webhookMerge(extra, ["myCustom"]),
    );
    expect(kept.ok).toBe(true);
    // 不在 inherited 里 = 本次新交的：400。
    const fresh = validateSettingsWithMerge(
      { channels: webhookMerge(extra, []).channels },
      webhookMerge(extra, []),
    );
    expect(fresh.ok).toBe(false);
    expect(fresh.ok ? "" : fresh.error.hint).toContain("myCustom");
  });

  // 形状判据不让：必填键在合并后为空一律 400，哪怕那条键沿用自存量。
  it("形状判据不看 inherited：必填键在合并结果里为空就 400", () => {
    const entry = { type: "bark", id: "bark:1", baseUrl: "", deviceKey: "" };
    const checked = validateSettingsWithMerge(
      { channels: [...BUILTINS, entry] as RawSettingValue[] },
      {
        channels: [...BUILTINS, entry],
        inherited: [new Set<string>(), new Set<string>(), new Set(["baseUrl", "deviceKey"])],
      },
    );
    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.error.hint).toContain("baseUrl");
  });

  // 两条入口的**结论**逐字相同：合并面多收的那张 inherited 清单一个字都没多判，判定与不带它
  // 时完全一致（合法与非法都试）。这正是「删掉 scope 面之后仍是同一套判据」的证据面。
  it("多收 inherited 清单不改变判定结论：合法与非法都试", () => {
    const cases = [
      { channels: [{ ...BARK, name: "手机" }] },
      { channels: [{ ...BARK, level: "urgent" }] },
      { historyMaxAgeDays: -1 },
    ];
    for (const patch of cases) {
      const label = JSON.stringify(patch);
      // 不给 merged：退回「按草稿判」的旧行为。
      expect(validateSettingsWithMerge(patch), label).toEqual(validateSettings(patch));
      // 真实写面交的那一份：合并结果与草稿**同形**、inherited 全空（每个键都算本次提交）。
      // 两侧审的必须是同一份内容，否则比的不是「多收一张清单有没有多判」。
      const channels = (patch.channels ?? []) as RawSettingValue[];
      const sameShape = { channels, inherited: channels.map(() => new Set<string>()) };
      expect(validateSettingsWithMerge({ ...patch, channels }, sameShape), label).toEqual(
        validateSettings(patch),
      );
    }
  });

  // 提交体里带 null（客户端「显式删除」手势的线上形态）在**判据**这一侧由合并先消费掉。
  // 直调判据时它落进条目：必填键与陌生键都读得出拒绝，而**已知可选键**上的 null 判据不拦——
  // 那一格的责任在合并（它把 null 变成删键），判据不必也不该替它再判一遍。
  it("条目里带 null：必填键与陌生键都拒；已知可选键交给合并消费", () => {
    const required = validateSettings({ channels: withBuiltins([{ ...WEBHOOK, url: null }]) });
    expect(required.ok).toBe(false);
    expect(required.ok ? "" : required.error.hint).toContain("缺少 url");

    const unknown = validateSettings({ channels: withBuiltins([{ ...BARK, myCustom: null }]) });
    expect(unknown.ok).toBe(false);
    expect(unknown.ok ? "" : unknown.error.hint).toContain("myCustom");

    // 已知可选键上的 null：判据放行不是漏洞——写面上它早在合并那一步就被删掉了，
    // 落盘的是「键不存在」而不是 null。
    expect(validateSettings({ channels: withBuiltins([{ ...BARK, group: null }]) }).ok).toBe(true);
  });
});
// ---------------------------------------------------------------- 尺寸上界的事实源

/**
 * 尺寸判据的上界来自 src/shared/config-schema.ts（两端共享面），本块断言**分界线正好落在那个数上**。
 *
 * 为什么值得单列一块（service.test.ts 已经从写面端到端判过同一件事）：那边判的是「存量的越界值
 * 放行、本次改的越界值 400」这条**双轨**，夹具只需落在上界的某一侧；一旦 impl/input 里重新长出
 * 一个与共享值不同的就地字面量，双轨的两侧可能**同时**判对而整条分界线已经挪了——两侧恰好都落在
 * 上界的同一侧时看不出来。故这里把边界钉死在共享值上：
 *   - 就地字面量比共享值**小** → 「恰好等于共享值」本该放行却被打红；
 *   - 就地字面量比共享值**大** → 「共享值 +1」本该打红却被放行。
 * 两个方向都打红，故这块抓的是「写面与共享面各说一个上界」而不是只抓一半。
 *
 * 上界取自共享值本身而不是抄一份数字：上界一改，判据跟着改，判的仍是「分界线落在共享值上」这条语义。
 */
describe("尺寸判据：分界线落在 shared 的上界上（#1016 第二事实源收口）", () => {
  it("webhook template：恰好等于共享上界放行，多一字符 400 且话术点名共享上界", () => {
    // `auth` 必带且要合法，否则这条会先栽在取值域判据上——那不是本块要判的那一条。
    const atLimit = validateSettings({
      channels: withBuiltins([
        { ...WEBHOOK, auth: "none", template: "x".repeat(WEBHOOK_TEMPLATE_MAX_CHARS) },
      ]),
    });
    expect(atLimit.ok).toBe(true);

    const verdict = validateSettings({
      channels: withBuiltins([
        { ...WEBHOOK, auth: "none", template: "x".repeat(WEBHOOK_TEMPLATE_MAX_CHARS + 1) },
      ]),
    });
    expect(verdict.ok).toBe(false);
    // 话术里的上界取自共享值：写面若忘了跟上共享 schema（或反过来自己另抄一份），这条打红。
    expect(verdict.ok ? "" : verdict.error.hint).toContain(String(WEBHOOK_TEMPLATE_MAX_CHARS));
  });

  it("bark levels：恰好等于共享上界放行，多一项 400 且话术点名共享上界", () => {
    const atLimit = Object.fromEntries(
      Array.from({ length: BARK_LEVELS_LIMIT }, (_unused, index) => [`kind-${index}`, "active"]),
    );
    expect(validateSettings({ channels: withBuiltins([{ ...BARK, levels: atLimit }]) }).ok).toBe(
      true,
    );

    const verdict = validateSettings({
      channels: withBuiltins([{ ...BARK, levels: { ...atLimit, "kind-extra": "active" } }]),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.hint).toContain(String(BARK_LEVELS_LIMIT));
  });

  // 「拒新增、不动存量」在判据这一侧的那一笔账：不带 inherited 时每个键都算本次提交，故上面两条
  // 越界的值必拒。带上 inherited 把这两个字段标成沿用存量，它们就不再重判值域——同一份越界值，
  // 判定的分叉只由「这次动没动过」决定，与尺寸上界从哪读无关。
  it("inherited 面把这两个字段标成沿用存量后，同一份越界值不再重判（双轨在判据这一侧）", () => {
    const outbound = [
      { ...WEBHOOK, auth: "none", template: "x".repeat(WEBHOOK_TEMPLATE_MAX_CHARS + 1) },
      { ...BARK, id: "bark:pad", levels: { "kind-extra": "active" } },
    ];
    const channels = withBuiltins(outbound);
    const merged = {
      channels,
      // 前两条是内置（无尺寸判据），第三条 webhook、第四条 bark 各自认一个 inherited 字段。
      inherited: [new Set<string>(), new Set<string>(), new Set(["template"]), new Set(["levels"])],
    };
    expect(validateSettingsWithMerge({ channels }, merged).ok).toBe(true);
  });
});
