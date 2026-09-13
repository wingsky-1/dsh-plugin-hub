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
  normalizeConfig,
  parseJsonObject,
  sanitizeSettings,
  validateSettings,
} from "../../../src/server/config/impl/input/index.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type {
  BarkChannelConfig,
  ChannelConfig,
  NotifyConfig,
  RawSettingValue,
  SettingInvalid,
  SettingsPatch,
  WebhookChannelConfig,
} from "../../../src/server/config/impl/model/type.ts";

/** 绕过类型构造运行时真实存在、类型层却排除掉的脏值（`null` 不在 `RawSettingValue` 里）。 */
function raw(value: unknown): RawSettingValue {
  return value as RawSettingValue;
}

/** 取校验失败载荷；放行即当场失败（否则断言会落在一个不存在的事实上）。 */
function invalidOf(patch: SettingsPatch): SettingInvalid {
  const verdict = validateSettings(patch);
  if (verdict.ok) throw new Error(`期望判非法，实际放行：${JSON.stringify(patch)}`);
  return verdict.error;
}

/** 取归一化后的第一个频道并收窄到 bark（判别键在归一化里就分好了支，收窄失败即夹具写错）。 */
function barkOf(channels: readonly ChannelConfig[]): BarkChannelConfig {
  const channel = channels[0];
  if (channel?.type !== "bark") throw new Error("期望归一化出一个 bark 频道");
  return channel;
}

/** 取归一化后的第一个频道并收窄到 webhook。 */
function webhookOf(channels: readonly ChannelConfig[]): WebhookChannelConfig {
  const channel = channels[0];
  if (channel?.type !== "webhook") throw new Error("期望归一化出一个 webhook 频道");
  return channel;
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
      ["systemNotify", "off"],
      ["browserNotify", raw(null)],
      ["notifyWhenVisible", "true"],
      ["notifySound", 0],
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
      expect(
        normalizeConfig({ browserSound: input }).browserSound,
        `browserSound=${String(input)}`,
      ).toEqual(expected);
      expect(
        normalizeConfig({ systemSound: input }).systemSound,
        `systemSound=${String(input)}`,
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

  it("channels 逐项丢弃认不出的项（没有投递目标的空壳会在投递时制造一次必然失败的尝试）", () => {
    const channels = normalizeConfig({
      channels: [
        BARK,
        WEBHOOK,
        { type: "bark", id: "bark:no-key", baseUrl: "https://x" },
        { type: "webhook", id: "webhook:no-url" },
        { type: "bark", baseUrl: "https://x", deviceKey: "k" },
        { type: "mail", id: "mail:a", url: "https://x" },
        "not-a-channel",
      ],
    }).channels;
    expect(channels.map((channel) => channel.id)).toEqual(["bark:phone", "webhook:hook"]);
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

  it("bark 频道缺省不启用：出站授权须用户显式授予", () => {
    expect(normalizeConfig({ channels: [BARK] }).channels[0].enabled).toBe(false);
    expect(normalizeConfig({ channels: [{ ...BARK, enabled: true }] }).channels[0].enabled).toBe(
      true,
    );
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
  });

  it("逐键类型闸门：每个非法值都指向它自己那个键", () => {
    const rows: ReadonlyArray<readonly [SettingsPatch, string]> = [
      [{ notifyAsk: "false" }, "notifyAsk"],
      [{ systemNotify: 1 }, "systemNotify"],
      [{ historyMaxAgeDays: -1 }, "historyMaxAgeDays"],
      [{ historyMaxAgeDays: 3_651 }, "historyMaxAgeDays"],
      [{ maxConnections: 1.5 }, "maxConnections"],
      [{ maxConnections: "8" }, "maxConnections"],
      [{ browserSound: "mp3" }, "browserSound"],
      [{ systemSound: 3 }, "systemSound"],
      [{ allowKinds: "error" }, "allowKinds"],
      [{ allowKinds: ["a", 1] }, "allowKinds"],
      [{ quietHours: "22:00" }, "quietHours"],
      [{ quietHours: { enabled: true } }, "quietHours"],
      [{ quietHours: { enabled: true, start: "9:30", end: "08:00" } }, "quietHours"],
      [{ quietHours: { enabled: true, start: "22:00", end: "24:00" } }, "quietHours"],
      [
        { quietHours: { enabled: true, start: "22:00", end: "08:00", allowKinds: "error" } },
        "quietHours",
      ],
      [{ channels: {} }, "channels"],
      [{ channels: [{ type: "bark", id: "bark:a", baseUrl: "https://x" }] }, "channels"],
      [{ channels: [{ type: "bark", id: "bark:a", deviceKey: "k" }] }, "channels"],
      [
        {
          channels: [
            { type: "bark", id: "bark:a", baseUrl: "https://x", deviceKey: "k", level: "urgent" },
          ],
        },
        "channels",
      ],
      [
        { channels: [{ type: "webhook", id: "webhook:a", auth: "none", preset: "custom" }] },
        "channels",
      ],
      [
        {
          channels: [
            { type: "webhook", id: "webhook:a", url: "https://x", auth: "oauth", preset: "custom" },
          ],
        },
        "channels",
      ],
      [
        {
          channels: [
            { type: "webhook", id: "webhook:a", url: "https://x", auth: "none", preset: "slack" },
          ],
        },
        "channels",
      ],
      [{ channels: [{ type: "mail", id: "mail:a" }] }, "channels"],
      [{ channels: [{ baseUrl: "https://x" }] }, "channels"],
      [{ kindRoutes: [] }, "kindRoutes"],
      [{ kindRoutes: { done: "bark:a" } }, "kindRoutes"],
    ];
    for (const [patch, key] of rows) {
      expect(invalidOf(patch).key, JSON.stringify(patch)).toBe(key);
    }
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
      systemNotify: true,
      browserNotify: false,
      notifyWhenVisible: true,
      notifySound: false,
      browserSound: "chime",
      systemSound: false,
      quietHours: { enabled: true, start: "23:00", end: "07:00", allowKinds: ["error"] },
      channels: [
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

  it("一个认识的键都没有时得到空设置（「都不认识」与「没有键」对调用方是同一件事）", () => {
    expect(sanitizeSettings({ a: 1, b: [2] })).toEqual({});
  });
});
