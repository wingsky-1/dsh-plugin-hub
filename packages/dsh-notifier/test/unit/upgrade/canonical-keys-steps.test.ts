/**
 * dsh-notifier upgrade 域 steps 块 —— 0.2.8 → 0.2.9 配置形态清理。
 *
 * 判据面与执行机制完整迁移自原 steps.test.ts 的 canonical-keys 自然块；隔离根与清理时序保持不变。
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  BARK_KNOWN_KEYS,
  BARK_LEVELS_LIMIT,
  REQUIRED_KEYS,
  WEBHOOK_KNOWN_KEYS,
  WEBHOOK_TEMPLATE_MAX_CHARS,
} from "../../../src/shared/interface.ts";
import { normalizeConfig } from "../../../src/server/config/impl/input/index.ts";
import type {
  RawSettingValue,
  StoredSettings,
} from "../../../src/server/config/impl/model/type.ts";
import { projectForView } from "../../../src/server/config/impl/service/view.ts";
import {
  CONFIG_FILE_NAME,
  notifierFile,
  writeTextAtomicSync,
} from "../../../src/server/shared/interface.ts";
import { migrateCanonicalKeys } from "../../../src/server/upgrade/impl/steps/canonical-keys.ts";
import {
  BARK,
  BROWSER,
  HOOK,
  SYSTEM,
  channelsOnDisk,
  clean,
  cleanups,
  isolatedHome,
} from "./upgrade-steps-support.ts";

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});

/** 任意一份设置（视图投影）里的频道数组；存储层形状不受契约约束，按原始值看。 */
function channelsOf(config: unknown): Array<Record<string, RawSettingValue>> {
  const picked = (config as { channels?: RawSettingValue }).channels;
  return (picked ?? []) as Array<Record<string, RawSettingValue>>;
}

/** 磁盘原文（跑之前），用于「一个字不写」的逐字比对。 */
function seedRaw(text: string): void {
  isolatedHome();
  writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), text);
}

describe("配置形态清理（canonical-keys）", describeCanonicalKeysMigrations);
function describeCanonicalKeysMigrations() {
  it(
    "判据 #1：顶层不在已知键集内的键删除（0.2.3 的旧顶层渠道键、退役的 maxConnections、手写的未来键）",
    canonicalTest1,
  );
  it("判据 #2：频道条目内不在该 type 字段名集合内的键删除（含凭据别名保留键）", canonicalTest2);
  it(
    "判据 #2 的反向格：别的 type 的已知键挂在条目上同样删除（按 type 取表，不是取并集）",
    canonicalTest3,
  );
  it(
    "判据 #3：类型不符的标量删键不夹值（notifyAsk 写成字符串、allowKinds 写成数字）",
    canonicalTest4,
  );
  it(
    "判据 #4：越界与非法枚举删键不夹值（timeoutSec / timeoutMs / level / preset / historyMaxAgeDays）",
    canonicalTest5,
  );
  it(
    "判据 #4 的另一面：界内取值**不动**（timeoutSec: 60 / timeoutMs: 0 / historyMaxAgeDays: 3650）",
    canonicalTest6,
  );
  it(
    "判据 #5：非必填键值形态不符只删该键（凭据字段的空串**不动**——它表达的是「未设置」）",
    canonicalTest7,
  );
  it("判据 #5 第二格：必填键值形态不符 → 删整条（本步不造残缺条目）", canonicalTest8);
  it("判别力 #1：必填键值形态不符的条目，清理后磁盘上不存在「少一个必填键」的条目", canonicalTest9);
  it("判别力 #2：非必填键值形态不符只删该键，条目连其余字段逐字保留", canonicalTest10);
  it(
    "判据 #5 第三格：取值域必填键（auth）值不在白名单 → 删整条，不是只删 auth 键",
    canonicalTest11,
  );
  it(
    "判据 #5 第三格的边界：auth 键缺席或空串逐字保留（判据 #6 对取值域必填键同样生效）",
    canonicalTest12,
  );
  it(
    "判据 #6：半坏条目（必填键空串或缺席）整条保留、逐字不动 —— 反转自 #1016 P1-2 的「删整条」；deviceKey 空串的 bark 连 name 一起留着",
    canonicalTest13,
  );
  it(
    "判别力 #3：手改出来的残缺条目（必填键缺席）原样保留，与形态不符的处置分界清晰",
    canonicalTest14,
  );
  it("判别力 #3 续：必填键空串逐字保留（空串是合法形态，不是形态不符）", canonicalTest15);
  it("判据 #7：重复身份的条目原样保留（迁移不得静默取首项）", canonicalTest16);
  it("判据 #7：重复身份的那一条仍照常清陌生键（去重去掉 ≠ 跳过逐条清理）", canonicalTest17);
  it("判据 #8 的第二格：内置条目在场但字段残缺 → 补缺席字段，值取内置默认表", canonicalTest18);
  it("补字段不覆盖显式值：enabled:false / popup:false 的内置条目升级后仍是 false", canonicalTest19);
  it("判别力 #1：残缺的内置条目清理后，视图与投递投影对两条内置逐字段一致", canonicalTest20);
  it("判据 #8：两条内置缺哪补哪，且恒排在最前", canonicalTest21);
  it(
    "合法但非默认的取值**不清理**：满配的 levels / 贴上界的 template / 过头名 / 凭据空串",
    canonicalTest22,
  );
  it("判别力 #4：干净形态返回 null、一个字不写（连缩进都不变）", canonicalTest23);
  it("判别力 #4：同一份输入连跑两次，第二次不写盘（幂等）", canonicalTest24);
  it("没有配置文件：不凭空建一份（默认值被读成「用户改过」是另一条语义的反面）", canonicalTest25);
  it("空配置：一个键都没有的文件逐字不动", canonicalTest26);
  it("坏 JSON：不抛，文件逐字不动（一份读不动的文件不该让启动失败）", canonicalTest27);
}

function canonicalTest1() {
  const out = clean({
    channels: [BROWSER, SYSTEM, BARK],
    notifySound: false,
    maxConnections: 64,
    futureFlag: true,
  });
  expect(Object.keys(out)).toEqual(["channels"]);
}

function canonicalTest2() {
  const out = clean({
    channels: [
      BROWSER,
      SYSTEM,
      { ...BARK, volume: 5, device_key: "别名" },
      { ...HOOK, retries: 2, auth_token: "别名" },
    ],
  });
  expect(out.channels).toEqual([BROWSER, SYSTEM, BARK, HOOK]);
}

function canonicalTest3() {
  const out = clean({
    channels: [
      BROWSER,
      SYSTEM,
      { ...HOOK, deviceKey: "跨类型残留", baseUrl: "https://x", levels: { done: "passive" } },
      { ...BARK, token: "跨类型残留", headerValue: "跨类型残留", timeoutSec: 30 },
    ],
  });
  expect(out.channels).toEqual([BROWSER, SYSTEM, HOOK, BARK]);
  // 前提事实：这些键确实在**另一张**已知键表里（否则这条就只是在测「陌生键删除」，与 #2 同义）。
  expect(BARK_KNOWN_KEYS).toContain("deviceKey");
  expect(BARK_KNOWN_KEYS).toContain("baseUrl");
  expect(BARK_KNOWN_KEYS).toContain("levels");
  expect(WEBHOOK_KNOWN_KEYS).toContain("token");
  expect(WEBHOOK_KNOWN_KEYS).toContain("headerValue");
  expect(WEBHOOK_KNOWN_KEYS).toContain("timeoutSec");
}

function canonicalTest4() {
  const out = clean({
    channels: [BROWSER, SYSTEM],
    notifyAsk: "yes",
    allowKinds: 3,
  });
  expect("notifyAsk" in out).toBe(false);
  expect("allowKinds" in out).toBe(false);
}

function canonicalTest5() {
  // auth 刻意不在这条用例里：它是**取值域必填键**，白名单外删的是整条而不是键（判据 #5 第三格）。
  const out = clean({
    channels: [
      BROWSER,
      SYSTEM,
      { ...BARK, timeoutMs: 999_999, level: "urgent" },
      { ...HOOK, timeoutSec: 99_999, preset: "nope" },
    ],
    historyMaxAgeDays: 4000,
  });
  expect(out.channels).toEqual([BROWSER, SYSTEM, BARK, HOOK]);
  expect("historyMaxAgeDays" in out).toBe(false);
}

function canonicalTest6() {
  const out = clean({
    channels: [
      BROWSER,
      SYSTEM,
      { ...BARK, timeoutMs: 0, level: "critical" },
      { ...HOOK, timeoutSec: 60, preset: "ntfy", auth: "bearer" },
    ],
    historyMaxAgeDays: 3650,
  });
  expect(out.channels).toEqual([
    BROWSER,
    SYSTEM,
    { ...BARK, timeoutMs: 0, level: "critical" },
    { ...HOOK, timeoutSec: 60, preset: "ntfy", auth: "bearer" },
  ]);
  expect(out.historyMaxAgeDays).toBe(3650);
}

function canonicalTest7() {
  const hook = { ...HOOK, token: null, password: "", headerValue: 7, name: "钩子" };
  const out = clean({ channels: [BROWSER, SYSTEM, BARK, hook] });
  // token / headerValue 两个键消失（值形态不对），password 是空串（留），条目与 name 一起留着。
  expect(out.channels).toEqual([
    BROWSER,
    SYSTEM,
    BARK,
    { type: "webhook", id: "hook:1", url: "https://y", password: "", name: "钩子" },
  ]);
}

// 判据 #5 的第二格（#1016 单一事实源收口）：**必填键**值形态不符 → **删整条**。
//
// 为什么不是「只删键」：删掉 baseUrl 就是本步当场造出一条残缺条目。磁盘上原本只有这一个字段不对
// （用户手滑打成了数字），清理之后整条都投递不了，而 S3 自己修通的三条路（视图可见 / 写面
// preexisting 放行 / 投递投影丢弃）会把这条半坏条目永久接住——代价由用户承担，原因是升级。
//
// 与判据 #6 的边界是**「键在不在」**，不是「这条条目完整不完整」：缺席 / 空串是用户手改出来的残缺，
// 原样保留；形态不符是本步造出来的，不能留。这条用例与下一条（判据 #6）合起来才是完整边界。
function canonicalTest8() {
  const badBaseUrl = { ...BARK, baseUrl: 12345, name: "地址写成数字" };
  const badDeviceKey = {
    type: "bark",
    id: "bark:2",
    baseUrl: "https://x",
    deviceKey: null,
    name: "凭据写成 null",
  };
  const badUrl = { type: "webhook", id: "hook:2", url: 7, name: "地址写成数字" };
  const kept = { ...HOOK, name: "完好" };
  const out = clean({ channels: [BROWSER, SYSTEM, badBaseUrl, badDeviceKey, badUrl, kept] });
  // 三条全没了，完好那条与它的 name 一起留着——判据从「删键」升级成「删整条」时，删的必须是整条。
  expect(out.channels).toEqual([BROWSER, SYSTEM, kept]);
}

// 判别力（#1016 单一事实源，硬要求 #1）：清理步遇必填键值形态不符时**不产生**残缺条目。
//
// 这一条与上一条不是同一件事：上一条断言「整条消失」，这一条断言「磁盘上不留任何半成品」——
// 改坏方向是「删键但条目留着」，那种实现下上一条会红吗？会（多出一条），这一条则给出正面证据：
// 跑完之后**逐条**检查没有任何一条少了必填键。
function canonicalTest9() {
  const out = clean({
    channels: [
      BROWSER,
      SYSTEM,
      { ...BARK, baseUrl: 12345 },
      { ...BARK, id: "bark:2", deviceKey: { nested: true } },
      { type: "webhook", id: "hook:2", url: 7 },
      { type: "webhook", id: "hook:3", url: null },
    ],
  });
  for (const channel of channelsOnDisk(out)) {
    const type = channel.type as string;
    for (const key of REQUIRED_KEYS[type] ?? []) {
      // 「键不在」与「键在但是空串」是**用户手改出来的**残缺，判据 #6 明确保留——
      // 判别力只针对「本步会不会新造出半成品」，故只钉「本该存在的必填键一个都不许被本步删掉」。
      expect(Object.hasOwn(channel, key), type + "." + key).toBe(true);
    }
  }
}

function canonicalTest10() {
  const hook = {
    type: "webhook",
    id: "h:1",
    url: "https://y",
    name: "我的钩子",
    enabled: true,
    token: 42,
    timeoutSec: 30,
  };
  expect(clean({ channels: [BROWSER, SYSTEM, hook] }).channels).toEqual([
    BROWSER,
    SYSTEM,
    {
      type: "webhook",
      id: "h:1",
      url: "https://y",
      name: "我的钩子",
      enabled: true,
      timeoutSec: 30,
    },
  ]);
}

// 判据 #5 的第三格（取值域类必填键，webhook 的 `auth`）：值不在 WEBHOOK_AUTHS 里 → **删整条**。
//
// 与第二格同形，区别只在判据用哪个谓词：`auth` 不在 REQUIRED_KEYS 里是因为它的判据是取值域而不是「在场」，
// 不因为处置可以更轻。**删键的后果是本步自己造出残缺**：写面 `validateWebhookChannel` 对「auth 缺席」与
// 「auth 非法」是同一句拒收，于是磁盘上剩下那条「url 齐全、只是没有 auth」的频道，此后每一次无关保存
// 都被 400 拒收——与 baseUrl 被删时的症状逐字相同，而罪魁同样是升级本身。
//
// 改坏方向（退回「只删 auth 键」）：磁盘上多出一条此后永远存不下的频道，本条立刻红（多出一个条目）。
function canonicalTest11() {
  const badNumber = {
    type: "webhook",
    id: "hook:number",
    url: "https://y",
    auth: 123,
    name: "认证写成数字",
  };
  const badString = {
    type: "webhook",
    id: "hook:string",
    url: "https://y",
    auth: "magic",
    name: "白名单外的串",
  };
  const badNull = {
    type: "webhook",
    id: "hook:null",
    url: "https://y",
    auth: null,
    name: "空值",
  };
  const kept = { ...HOOK, auth: "bearer", name: "完好" };
  const out = clean({ channels: [BROWSER, SYSTEM, badNumber, badString, badNull, kept] });
  // 三条全没了（连 name 一起），白名单内的 auth 那条逐字留着——处置与在场必填键一字不差。
  expect(out.channels).toEqual([BROWSER, SYSTEM, kept]);
}

// 第三格与判据 #6 的边界仍是「键在不在 + 空串」：键缺席、值为空串都是**用户手改**出来的「没填」，
// 不是形态不符。
function canonicalTest12() {
  const absent = { type: "webhook", id: "h:absent", url: "https://y", name: "缺 auth" };
  const empty = { type: "webhook", id: "h:empty", url: "https://y", auth: "", name: "auth 空串" };
  expect(clean({ channels: [BROWSER, SYSTEM, HOOK, absent, empty] }).channels).toEqual([
    BROWSER,
    SYSTEM,
    HOOK,
    absent,
    empty,
  ]);
}

// 判据 #6：半坏条目（必填键空串或缺席）整条保留、逐字不动 —— 反转自 #1016 P1-2 的「删整条」；
// deviceKey 空串的 bark 连 name 一起留着。
function canonicalTest13() {
  const emptyDeviceKey = {
    type: "bark",
    id: "bark:empty-key",
    baseUrl: "https://x",
    deviceKey: "",
    name: "凭据空串",
  };
  const emptyBaseUrl = {
    type: "bark",
    id: "bark:empty",
    baseUrl: "",
    deviceKey: "k",
    name: "地址空串",
  };
  const absentBaseUrl = { type: "bark", id: "bark:no-url", deviceKey: "k", name: "缺地址" };
  const absentUrl = { type: "webhook", id: "hook:no-url", name: "缺 url" };
  const out = clean({
    channels: [BROWSER, SYSTEM, BARK, emptyDeviceKey, emptyBaseUrl, absentBaseUrl, absentUrl],
  });
  expect(out.channels).toEqual([
    BROWSER,
    SYSTEM,
    BARK,
    emptyDeviceKey,
    emptyBaseUrl,
    absentBaseUrl,
    absentUrl,
  ]);
}

function canonicalTest14() {
  const absent = [
    { type: "bark", id: "bark:no-url", deviceKey: "k", name: "缺 baseUrl" },
    { type: "bark", id: "bark:no-key", baseUrl: "https://x", name: "缺 deviceKey" },
    { type: "webhook", id: "h:no-url", name: "缺 url" },
  ];
  const out = clean({ channels: [BROWSER, SYSTEM, BARK, ...absent] });
  // 三条半坏条目逐字留着（BARK 是完好的对照），一条都没少。
  expect(out.channels).toEqual([BROWSER, SYSTEM, BARK, ...absent]);
}

// 判别力 #3 续：必填键空串逐字保留（空串是合法形态，不是形态不符）。
function canonicalTest15() {
  const empties = [
    { type: "bark", id: "bark:e1", baseUrl: "", deviceKey: "k", name: "地址空串" },
    { type: "bark", id: "bark:e2", baseUrl: "https://x", deviceKey: "", name: "凭据空串" },
    { type: "webhook", id: "h:e1", url: "", name: "钩子地址空串" },
  ];
  expect(clean({ channels: [BROWSER, SYSTEM, BARK, ...empties] }).channels).toEqual([
    BROWSER,
    SYSTEM,
    BARK,
    ...empties,
  ]);
}

// 判据 #7：重复身份的条目原样保留（迁移不得静默取首项）。
function canonicalTest16() {
  const out = clean({
    channels: [
      BROWSER,
      SYSTEM,
      { ...BARK, name: "首条" },
      { ...BARK, name: "次条" },
      { type: "webhook", id: "hook:1", url: "https://a" },
      { type: "webhook", id: "hook:1", url: "https://b" },
    ],
  });
  // 逐条都在，且次序不变：包括那两条凭据不同的 webhook（url 就是它们的凭据面）。
  expect(out.channels).toEqual([
    BROWSER,
    SYSTEM,
    { ...BARK, name: "首条" },
    { ...BARK, name: "次条" },
    { type: "webhook", id: "hook:1", url: "https://a" },
    { type: "webhook", id: "hook:1", url: "https://b" },
  ]);
}

function canonicalTest17() {
  const out = clean({
    channels: [BROWSER, SYSTEM, BARK, { ...BARK, name: "次条", 陌生键: 1 }],
  });
  expect(out.channels).toEqual([BROWSER, SYSTEM, BARK, { ...BARK, name: "次条" }]);
}

function canonicalTest18() {
  const out = clean({ channels: [{ type: "system", id: "system" }, BARK] });
  expect(channelsOnDisk(out)[0]).toEqual(BROWSER);
  expect(channelsOnDisk(out)[1]).toEqual(SYSTEM);
}

// 补字段只补「键不在」，不覆盖显式值：用户把内置显式关掉是在表态，抹回默认 true 是静默改写用户的输入。
// 改坏方向（把判据写成「值不等于默认就补」）：用户关掉的系统通知在升级后自己又开了，且没有任何提示。
function canonicalTest19() {
  const off = { type: "system", id: "system", enabled: false, popup: false };
  const out = clean({ channels: [off, BARK] });
  expect(channelsOnDisk(out)[0]).toEqual(BROWSER);
  expect(channelsOnDisk(out)[1]).toEqual({ ...off, sound: true });
}

// 判别力 #1（#1016 P1-1 的正脸）：**视图与投递投影对两条内置逐字段一致**。
//
// 这条之所以不是「补齐了就算完」：读面自 S3 起有两条通道——视图逐字外发、投递投影按默认表物化。补齐只
// 保证磁盘上是完整形态，而「用户看到的开关」与「实际发不发」是两条通道各自的解释；它们在残缺形态上会
// 给出相反的答案（视图全关 / 投递照发），补齐之后必须同形。
function canonicalTest20() {
  const stored = clean({
    channels: [BARK, { type: "browser", id: "browser" }, { type: "system", id: "system" }],
  }) as StoredSettings;
  const shown = channelsOf(projectForView(stored));
  // 投递投影按已知键物化成 `ChannelConfig` 联合；本用例只比**字段值**，故按原始记录读（两侧口径相同）。
  const sent = normalizeConfig(stored).channels as unknown as Array<
    Record<string, RawSettingValue>
  >;
  for (const type of ["browser", "system"]) {
    const one = shown.find((channel) => channel.type === type);
    const other = sent.find((channel) => channel.type === type);
    expect(one, type).toBeDefined();
    expect(other, type).toBeDefined();
    for (const field of ["enabled", "popup", "sound", "whenVisible"] as const) {
      // 两边都没有这个键时跳过（system 本来就没有 whenVisible——「都不给」仍是一致的）。
      if (one?.[field] === undefined && other?.[field] === undefined) continue;
      expect(one?.[field], type + "." + field).toBe(other?.[field]);
    }
  }
}
function canonicalTest21() {
  const onlySystem = clean({ channels: [SYSTEM, BARK] });
  expect(channelsOnDisk(onlySystem)[0]).toEqual({
    type: "browser",
    id: "browser",
    enabled: true,
    popup: true,
    sound: true,
    whenVisible: false,
  });
  const none = clean({ channels: [BARK] });
  expect(channelsOnDisk(none).slice(0, 2)).toEqual([
    {
      type: "browser",
      id: "browser",
      enabled: true,
      popup: true,
      sound: true,
      whenVisible: false,
    },
    { type: "system", id: "system", enabled: true, popup: true, sound: true },
  ]);
}

function canonicalTest22() {
  const levels = Object.fromEntries(
    Array.from({ length: BARK_LEVELS_LIMIT }, (_unused, index) => [`kind-${index}`, "passive"]),
  );
  const bark = { ...BARK, levels };
  const hook = {
    ...HOOK,
    template: "x".repeat(WEBHOOK_TEMPLATE_MAX_CHARS),
    headerName: "X-Very-Long-Custom-Header-Name",
    password: "",
  };
  const out = clean({ channels: [BROWSER, SYSTEM, bark, hook] });
  expect(out.channels).toEqual([BROWSER, SYSTEM, bark, hook]);
}

// 判别力 #4：干净形态重跑一个字不写。这里用**压缩格式**种文件——重新序列化必然带缩进，
// 于是「白写一次」会以字节差异暴露，而不是以「内容一样」蒙过去。
function canonicalTest23() {
  const before = JSON.stringify({
    channels: [
      {
        type: "browser",
        id: "browser",
        enabled: true,
        popup: true,
        sound: true,
        whenVisible: false,
      },
      { type: "system", id: "system", enabled: true, popup: true, sound: true },
      BARK,
      HOOK,
    ],
    notifyAsk: true,
    historyMaxAgeDays: 30,
    quietHours: { enabled: true, windows: [{ start: "22:00", end: "08:00" }] },
  });
  seedRaw(before);

  migrateCanonicalKeys();

  expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(before);
}

function canonicalTest24() {
  isolatedHome();
  writeTextAtomicSync(
    notifierFile(CONFIG_FILE_NAME),
    `${JSON.stringify({ channels: [SYSTEM, { ...BARK, level: "urgent", volume: 5 }] }, null, 2)}\n`,
  );

  migrateCanonicalKeys();
  const afterFirst = readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8");

  migrateCanonicalKeys();

  expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(afterFirst);
}

function canonicalTest25() {
  isolatedHome();

  migrateCanonicalKeys();

  expect(existsSync(notifierFile(CONFIG_FILE_NAME))).toBe(false);
}

function canonicalTest26() {
  seedRaw("{}\n");

  migrateCanonicalKeys();

  expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe("{}\n");
}

function canonicalTest27() {
  seedRaw("{ 坏掉的\n");

  expect(() => migrateCanonicalKeys()).not.toThrow();
  expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe("{ 坏掉的\n");
}
