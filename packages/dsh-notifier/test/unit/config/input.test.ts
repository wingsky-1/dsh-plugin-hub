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
  WEBHOOK_RESERVED_KEYS,
  normalizeConfig,
  parseJsonObject,
  sanitizeSettings,
  validateSettings,
} from "../../../src/server/config/impl/input/index.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
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

/** 绕过类型构造运行时真实存在、类型层却排除掉的脏值（`null` 不在 `RawSettingValue` 里）。 */
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
      ["maxConnections", 1.5],
      ["maxConnections", 4_096],
    ];
    for (const [key, value] of dirty) {
      expect(normalizeConfig({ [key]: value })[key], `${key}=${JSON.stringify(value)}`).toEqual(
        DEFAULT_CONFIG[key],
      );
    }
  });

  it("计数键：闭区间 [0, 上界] 内的整数原样保留（0 与上界都是有意义的取值，不该被当成越界让给默认值）", () => {
    const kept = normalizeConfig({ historyMaxAgeDays: 30, maxConnections: 64 });
    expect(kept.historyMaxAgeDays).toBe(30);
    expect(kept.maxConnections).toBe(64);

    const bounds = normalizeConfig({ historyMaxAgeDays: 3_650, maxConnections: 1_024 });
    expect(bounds.historyMaxAgeDays).toBe(3_650);
    expect(bounds.maxConnections).toBe(1_024);

    const zero = normalizeConfig({ historyMaxAgeDays: 0, maxConnections: 0 });
    expect(zero.historyMaxAgeDays).toBe(0);
    expect(zero.maxConnections).toBe(0);
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

  it("quietHours 子键逐个独立回落：一个子键脏不该连带丢掉整块（用户填对的那半要留住）", () => {
    const quiet = normalizeConfig({
      quietHours: { enabled: true, start: "25:00", end: "07:30", allowKinds: ["error", 3] },
    }).quietHours;
    expect(quiet.enabled).toBe(true);
    expect(quiet.start).toBe("22:00");
    expect(quiet.end).toBe("07:30");
    expect(quiet.allowKinds).toEqual(["error"]);
  });

  it("quietHours 不是对象时整块回落默认；缺子键补默认（读侧容忍半截对象，写侧的整块校验是另一道关）", () => {
    // `allowKinds` 在这一支上随默认表走（表上本就没有该键，缺省语义由裁决层定义），故不在此断言。
    for (const input of ["22:00", [], 7, raw(null)]) {
      const quiet = normalizeConfig({ quietHours: input }).quietHours;
      expect(quiet.enabled, JSON.stringify(input)).toBe(false);
      expect(quiet.start, JSON.stringify(input)).toBe("22:00");
      expect(quiet.end, JSON.stringify(input)).toBe("08:00");
    }
    // 半截对象走的是另一支：逐子键拼装，于是可选的 allowKinds 会被补成空数组（全量输出）。
    const partial = normalizeConfig({ quietHours: { enabled: true } }).quietHours;
    expect(partial.enabled).toBe(true);
    expect(partial.start).toBe("22:00");
    expect(partial.end).toBe("08:00");
    expect(partial.allowKinds).toEqual([]);
  });

  it("quietHours 是「类型闸门 + 逐个格式」两道关：能强转成合法时间的数组不算时间（JSON 提交里数组是合法形状，`test()` 却会做字符串强转）", () => {
    const badStart: SettingsPatch = {
      quietHours: { enabled: true, start: ["22:00"], end: "08:00" },
    };
    expect(invalidOf(badStart).hint).toContain("start");
    const badEnd: SettingsPatch = {
      quietHours: { enabled: true, start: "22:00", end: ["08:00"] },
    };
    expect(invalidOf(badEnd).hint).toContain("end");

    // 归一化侧同一口径：非字符串一律回落，不把数组当时间存进设置。
    const quiet = normalizeConfig({
      quietHours: { enabled: true, start: ["22:00"], end: ["08:00"] },
    }).quietHours;
    expect(quiet.start).toBe("22:00");
    expect(quiet.end).toBe("08:00");
  });

  it("整块回落交出的是副本：调用方就地改写它不该污染全局默认表（默认值被改过之后，此后每个读者拿到的都不是默认）", () => {
    const pristine = { ...DEFAULT_CONFIG.quietHours };
    const fallback = normalizeConfig({ quietHours: "22:00" }).quietHours;
    try {
      fallback.enabled = true;
      fallback.start = "00:00";

      const again = normalizeConfig({ quietHours: "22:00" }).quietHours;
      expect(again.enabled).toBe(pristine.enabled);
      expect(again.start).toBe(pristine.start);
      expect(again.end).toBe(pristine.end);
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

  it("频道的未知键按 string/number 透传成 extras（README 的前向兼容承诺：bark 将来加参数，用户现在写进去要留住）", () => {
    const channel = barkOf(
      normalizeConfig({
        channels: [{ ...BARK, volume: 5, call: "1", nested: { a: 1 }, flag: true }],
      }).channels,
    );
    expect(channel.extras).toEqual({ volume: 5, call: "1" });
    const hook = webhookOf(
      normalizeConfig({ channels: [{ ...WEBHOOK, futureKey: "v", retries: 2 }] }).channels,
    );
    expect(hook.extras).toEqual({ futureKey: "v", retries: 2 });
    // 没有未知键时不该凭空多出一个空 extras（两类频道同一口径）。
    expect("extras" in webhookOf(normalizeConfig({ channels: [BARK, WEBHOOK] }).channels)).toBe(
      false,
    );
  });

  it("保留键在归一化里也剔除：手改过的配置文件不经过写入口径，一条手写的 device_key 就能绕开「凭据只走已知字段」", () => {
    // 保留键清单按频道类型分（bark 的别名与 webhook 的别名不是同一批），这里只用 bark 自己的。
    const channel = barkOf(
      normalizeConfig({
        channels: [{ ...BARK, device_key: "leak", ciphertext: "leak2" }],
      }).channels,
    );
    expect(channel.extras).toBeUndefined();
    expect(JSON.stringify(channel)).not.toContain("leak");
  });

  it("只写过旧全局键 notifySound 的存量：读面把它并进两条内置条目的 sound（当时关掉的提示音不该复活成有声）", () => {
    const quiet = normalizeConfig({ notifySound: false });
    expect(browserOf(quiet.channels).sound).toBe(false);
    expect(systemOf(quiet.channels).sound).toBe(false);
    // 显式写下的条目字段优先于旧键：回落只补缺，不覆盖用户后来的选择。
    const mixed = normalizeConfig({
      notifySound: false,
      channels: [builtinWithSound("browser", "ding"), BUILTINS[1]],
    });
    expect(browserOf(mixed.channels).sound).toBe("ding");
    expect(systemOf(mixed.channels).sound).toBe(false);
  });

  it("存量出口音效键接受完整声音域：存过的音色名不能被吞成默认值（旧全局键只认布尔）", () => {
    const toned = normalizeConfig({ browserSound: "ding", systemSound: "chime" });
    expect(browserOf(toned.channels).sound).toBe("ding");
    expect(systemOf(toned.channels).sound).toBe("chime");
    // 旧全局键当年只有开关语义：音色名这类值不该经它流进配置（回落默认，而不是把它当音色用）
    expect(browserOf(normalizeConfig({ notifySound: "ding" }).channels).sound).toBe(true);
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
    expect(invalidOf({ maxConnections: -1, notifyAsk: "yes" }).key).toBe("maxConnections");
    expect(invalidOf({ maxConnections: -1, notifyAsk: "yes" }).hint).toContain("1024");
    expect(invalidOf({ notifyAsk: "yes", maxConnections: -1 }).key).toBe("notifyAsk");
    // 合法值不是出口：扫到它必须继续往下看，否则「合法键 + 非法键」的整份提交会被整体放行。
    expect(invalidOf({ notifyAsk: true, maxConnections: -1 }).key).toBe("maxConnections");
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

  it("未知键的写入口径：只放行 string/number（对象/布尔/数组的透传值会让下游分不清「有值」与「没值」）", () => {
    expect(
      validateSettings({ channels: withBuiltins([{ ...BARK, volume: 5, call: "1" }]) }),
    ).toEqual({ ok: true });
    expect(invalidOf({ channels: withBuiltins([{ ...BARK, nested: { a: 1 } }]) }).hint).toContain(
      "nested",
    );
    expect(invalidOf({ channels: withBuiltins([{ ...BARK, flag: true }]) }).hint).toContain("flag");
    expect(invalidOf({ channels: withBuiltins([{ ...BARK, list: [1] }]) }).hint).toContain("list");
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

  // 这一批键在 0.2.4 被搬进渠道条目并删除。当陌生键放行会让停在升级前页面上的旧客户端以为存上了
  // （200 + 什么都不发生），所以写面必须拒——提示里给出出路（刷新），用户知道下一步做什么。
  it("退役键写拒：0.2.3 的顶层渠道键提交一律 400，与值无关且指名刷新", () => {
    for (const key of RETIRED_KEYS) {
      const verdict = validateSettings({ [key]: true } as SettingsPatch);
      expect(verdict.ok, key).toBe(false);
      expect(verdict.ok ? "" : verdict.error.key).toBe(key);
      expect(verdict.ok ? "" : verdict.error.hint).toContain("已移入渠道条目");
    }
    // 合法布尔值也一样拒：拒的是键本身，不是值
    expect(validateSettings({ browserNotify: true } as SettingsPatch).ok).toBe(false);
  });

  it("逐键类型闸门：每个非法值都指向它自己那个键，且提示指向真正拦下它的那条分支（键对了、提示指向别处，等于把用户引到另一个字段）", () => {
    const rows: ReadonlyArray<readonly [SettingsPatch, string, string]> = [
      [{ notifyAsk: "false" }, "notifyAsk", "true 或 false"],
      [{ historyMaxAgeDays: -1 }, "historyMaxAgeDays", "0 到 3650"],
      [{ historyMaxAgeDays: 3_651 }, "historyMaxAgeDays", "0 到 3650"],
      [{ maxConnections: 1.5 }, "maxConnections", "0 到 1024"],
      [{ maxConnections: "8" }, "maxConnections", "0 到 1024"],
      [{ allowKinds: "error" }, "allowKinds", "字符串数组"],
      [{ allowKinds: ["a", 1] }, "allowKinds", "字符串数组"],
      // quietHours：「不是对象」与「缺了哪个子键」是不同分支，提示分不开用户就改不对。
      [{ quietHours: "22:00" }, "quietHours", "需要对象"],
      [{ quietHours: { enabled: true } }, "quietHours", "start"],
      [{ quietHours: { enabled: true, start: "9:30", end: "08:00" } }, "quietHours", "start"],
      [{ quietHours: { enabled: true, start: "x22:00", end: "08:00" } }, "quietHours", "start"],
      [{ quietHours: { enabled: true, start: "22:00", end: "24:00" } }, "quietHours", "end"],
      [{ quietHours: { enabled: true, start: "22:00", end: "08:00x" } }, "quietHours", "end"],
      [{ quietHours: { enabled: "yes", start: "22:00", end: "08:00" } }, "quietHours", "enabled"],
      [
        { quietHours: { enabled: true, start: "22:00", end: "08:00", allowKinds: "error" } },
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
    const wrongElement: SettingsPatch = {
      quietHours: { enabled: true, start: "22:00", end: "08:00", allowKinds: [1] },
    };
    const mixed: SettingsPatch = {
      quietHours: { enabled: true, start: "22:00", end: "08:00", allowKinds: ["error", 3] },
    };
    for (const patch of [wrongElement, mixed]) {
      const error = invalidOf(patch);
      expect(error.key, JSON.stringify(patch)).toBe("quietHours");
      expect(error.hint, JSON.stringify(patch)).toContain("allowKinds");
    }

    const legal: SettingsPatch = {
      quietHours: { enabled: true, start: "22:00", end: "08:00", allowKinds: ["error"] },
    };
    expect(validateSettings(legal)).toEqual({ ok: true });
  });

  it("边界值与整份合法提交放行（闸门把用户正常保存拦住，比放过一个非法值更糟）", () => {
    expect(validateSettings({ historyMaxAgeDays: 0, maxConnections: 0 })).toEqual({ ok: true });
    expect(validateSettings({ historyMaxAgeDays: 3_650, maxConnections: 1_024 })).toEqual({
      ok: true,
    });
    const full: SettingsPatch = {
      notifyAsk: false,
      notifyQuestion: true,
      notifyTaskDone: true,
      notifySubagentDone: true,
      notifyTaskError: false,
      notifyTurnEnd: true,
      quietHours: { enabled: true, start: "23:00", end: "07:00", allowKinds: ["error"] },
      channels: [
        ...BUILTINS,
        { ...BARK, enabled: true, level: "critical", levels: { error: "critical" } },
        { ...WEBHOOK, enabled: false, auth: "header", preset: "gotify", headerName: "X-Token" },
      ],
      kindRoutes: { error: ["bark:phone"] },
      allowKinds: ["demo:report"],
      historyMaxAgeDays: 7,
      maxConnections: 32,
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
    const kept = sanitizeSettings({ notifyAsk: "yes", maxConnections: -5 });
    expect(kept.notifyAsk).toBe("yes");
    expect(kept.maxConnections).toBe(-5);
  });

  it("没有可认识的键时得到空设置：陌生键被剔除、输入根本不是对象（空值走到索引取值会直接抛），两条路对调用方是同一件事", () => {
    expect(sanitizeSettings({ a: 1, b: [2] })).toEqual({});
    for (const value of [null, undefined, [], "notifyAsk", 3, true]) {
      expect(sanitizeSettings(stored(value)), String(value)).toEqual({});
    }
  });
});
