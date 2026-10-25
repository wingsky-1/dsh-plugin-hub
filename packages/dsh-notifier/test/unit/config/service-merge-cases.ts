/** 写面按字段合并自然块；入口负责临时 home、动态导入与生命周期。 */
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import type { RawSettingValue, SettingsPatch } from "../../../src/server/config/impl/model/type.ts";
import { BARK_LEVELS_LIMIT, WEBHOOK_TEMPLATE_MAX_CHARS } from "../../../src/shared/interface.ts";
import {
  BARK,
  BUILTINS,
  channelById,
  channelOfType,
  channelsOf,
  diskOf,
  HOOK,
  invalidOf,
  MASK,
  type ServiceApi,
} from "./service-test-support.ts";

const TEMPLATE_OVER_LIMIT = WEBHOOK_TEMPLATE_MAX_CHARS + 1;
const TEMPLATE_OVER_LIMIT_EDITED = WEBHOOK_TEMPLATE_MAX_CHARS + 101;
const LEVELS_OVER_LIMIT = BARK_LEVELS_LIMIT + 6;
const LEVELS_UNDER_LIMIT = BARK_LEVELS_LIMIT - 4;

export type ServiceMergeContext = ServiceApi & {
  readonly assemble: () => void;
  readonly configFile: string;
  readonly onDisk: () => Record<string, RawSettingValue>;
  readonly writeConfigFile: (text: string) => void;
};

export function registerFieldMerge(context: ServiceMergeContext): void {
  registerTokenDeletionCases(context);
  registerExistingLimitCases(context);
  registerRequiredAndUnknownFieldCases(context);
  registerMaskedReplacementCases(context);
  registerMergeFoundationCases(context);
}

function registerTokenDeletionCases(context: ServiceMergeContext): void {
  const { assemble, onDisk, writeConfigFile, readSettingsView, writeConfig } = context;

  function diskChannels(): Array<Record<string, RawSettingValue>> {
    return (onDisk().channels ?? []) as Array<Record<string, RawSettingValue>>;
  }

  function submitOf(
    part: (channel: Record<string, RawSettingValue>) => Record<string, RawSettingValue>,
    type = "webhook",
  ): Array<Record<string, RawSettingValue>> {
    return channelsOf(readSettingsView().effective).map((channel) =>
      channel.type === type ? part(channel) : channel,
    );
  }

  // 改坏方向：客户端清空改回「删键」→ 提交里没有这个键 → 合并判「不动」→ 旧凭据留在磁盘上继续
  // 被投递，而界面显示空。那是本次重构里唯一一条会造成「看起来删了、其实还在用」的面。
  it("判据 #1：清空 token 落盘后磁盘上没有 token 键（不是空串，也不是原样留着）", async () => {
    writeConfigFile(diskOf({ ...HOOK, auth: "bearer", token: "REAL" }));
    assemble();
    expect(channelOfType(diskChannels(), "webhook").token).toBe("REAL");

    // 草稿里 token 是掩码，用户清空 → 客户端写 null（显式删除）。
    const submitted = submitOf((channel) => ({ ...channel, token: null }));
    const result = await writeConfig({ channels: submitted }, readSettingsView().revision);

    expect(result.ok).toBe(true);
    const stored = channelOfType(diskChannels(), "webhook");
    expect("token" in stored).toBe(false);
    expect(stored.token).toBeUndefined();
  });

  // 判据 #2：存量本来就没有这个键时，一次无关保存不该「追责存量」——更不该凭空造一个出来。
  it("判据 #2：磁盘本就无 token、只改 name，落盘后仍无 token 键", async () => {
    writeConfigFile(diskOf(HOOK));
    assemble();
    expect("token" in channelOfType(diskChannels(), "webhook")).toBe(false);

    const submitted = submitOf((channel) => ({ ...channel, name: "群机器人" }));
    const result = await writeConfig({ channels: submitted }, readSettingsView().revision);

    expect(result.ok).toBe(true);
    const stored = channelOfType(diskChannels(), "webhook");
    expect(stored.name).toBe("群机器人");
    expect("token" in stored).toBe(false);
  });
}

function registerExistingLimitCases(context: ServiceMergeContext): void {
  const { assemble, configFile, onDisk, writeConfigFile, readSettingsView, writeConfig } = context;

  function diskChannels(): Array<Record<string, RawSettingValue>> {
    return (onDisk().channels ?? []) as Array<Record<string, RawSettingValue>>;
  }

  function submitOf(
    part: (channel: Record<string, RawSettingValue>) => Record<string, RawSettingValue>,
    type = "webhook",
  ): Array<Record<string, RawSettingValue>> {
    return channelsOf(readSettingsView().effective).map((channel) =>
      channel.type === type ? part(channel) : channel,
    );
  }

  // 判据 #3：存量 template 恰超上界一字符。只改 name 必须**放行**——「拒新增、不动存量」的
  // 双轨。放行的理由是那条 template 与磁盘逐字相同：客户端把它原样带回来了，而「原样带回」
  // 不是本次改动。上界取自共享 schema（见 TEMPLATE_OVER_LIMIT），故本判据在上限值变化后仍然
  // 判的是同一条语义，而不是「恰好没变的那个数字」。
  it("判据 #3：存量 template 恰超上界 + 只改 name → 放行（不动存量）", async () => {
    const long = "x".repeat(TEMPLATE_OVER_LIMIT);
    writeConfigFile(diskOf({ ...HOOK, template: long }));
    assemble();
    expect(channelOfType(diskChannels(), "webhook").template).toBe(long);

    const submitted = submitOf((channel) => ({ ...channel, name: "群机器人" }));
    // 前提事实：客户端确实把那条超界 template 原样带回来了（不是「没带」才躲过判据）。
    expect(channelOfType(submitted, "webhook").template).toBe(long);

    const result = await writeConfig({ channels: submitted }, readSettingsView().revision);
    expect(result.ok).toBe(true);
    expect(channelOfType(diskChannels(), "webhook").template).toBe(long);
    expect(channelOfType(diskChannels(), "webhook").name).toBe("群机器人");
  });

  // 判据 #4：同一份存量，本次把它改成另一个更长的值即 400。#3/#4 的分界就是「本次动没动过
  // 这个值」，不是「它超没超上界」。
  it("判据 #4：存量 template 恰超上界 → 本次改成更长的另一个值 → 400 且不落盘", async () => {
    writeConfigFile(diskOf({ ...HOOK, template: "x".repeat(TEMPLATE_OVER_LIMIT) }));
    assemble();
    const before = readFileSync(configFile, "utf8");

    const submitted = submitOf((channel) => ({
      ...channel,
      template: "y".repeat(TEMPLATE_OVER_LIMIT_EDITED),
    }));
    const result = await writeConfig({ channels: submitted }, readSettingsView().revision);

    const error = invalidOf(result);
    expect(error.key).toBe("channels");
    expect(error.hint).toContain("template");
    // 话术里的上界取自共享 schema：改上界不必改这条断言，而话术忘了跟上共享值会被这条打红。
    expect(error.hint).toContain(String(WEBHOOK_TEMPLATE_MAX_CHARS));
    expect(readFileSync(configFile, "utf8")).toBe(before);
  });

  // 判据 #5：存量 levels 恰超上界若干项，只改**另一条**频道的名字，不得连坐。
  // 连坐的机制：客户端整组提交，于是这条的越界项数也进了提交面；它之所以不被拒，是因为它与
  // 磁盘逐字相同（沿用存量），不是「客户端没带」。
  it("判据 #5：存量 levels 恰超上界 + 只改另一条 bark 的 name → 放行（不连坐）", async () => {
    const levels: Record<string, string> = {};
    for (let i = 0; i < LEVELS_OVER_LIMIT; i += 1) levels[`kind-${i}`] = "active";
    writeConfigFile(diskOf({ ...BARK, levels }, { ...BARK, id: "bark:pad", name: "B" }));
    assemble();

    const submitted = submitOf(
      (channel) => (channel.id === "bark:pad" ? { ...channel, name: "平板" } : channel),
      "bark",
    );
    // 前提事实：越界项数确实进了提交面（整组提交），且与磁盘逐字相同。
    expect(Object.keys(channelById(submitted, "bark:phone").levels as object)).toHaveLength(
      LEVELS_OVER_LIMIT,
    );

    const result = await writeConfig({ channels: submitted }, readSettingsView().revision);
    expect(result.ok).toBe(true);
    // 一项不少（沿用存量），被改的是**另一条**频道的名字。
    expect(Object.keys(channelById(diskChannels(), "bark:phone").levels as object)).toHaveLength(
      LEVELS_OVER_LIMIT,
    );
    expect(channelById(diskChannels(), "bark:phone").name).toBe("A");
    expect(channelById(diskChannels(), "bark:pad").name).toBe("平板");
  });

  // 判据 #6：改小是修复动作。超上界 → 删到界内判「本次改动」，但界内在上界内故放行，且落盘确实变小。
  it("判据 #6：存量 levels 恰超上界 → 本次删到界内 → 放行且落盘真的变小", async () => {
    const levels: Record<string, string> = {};
    for (let i = 0; i < LEVELS_OVER_LIMIT; i += 1) levels[`kind-${i}`] = "active";
    writeConfigFile(diskOf({ ...BARK, levels }));
    assemble();

    const trimmed: Record<string, string> = {};
    for (let i = 0; i < LEVELS_UNDER_LIMIT; i += 1) trimmed[`kind-${i}`] = "active";
    const submitted = submitOf((channel) => ({ ...channel, levels: trimmed }), "bark");
    const result = await writeConfig({ channels: submitted }, readSettingsView().revision);

    expect(result.ok).toBe(true);
    expect(Object.keys(channelById(diskChannels(), "bark:phone").levels as object)).toHaveLength(
      LEVELS_UNDER_LIMIT,
    );
  });
}

function registerRequiredAndUnknownFieldCases(context: ServiceMergeContext): void {
  const { assemble, configFile, onDisk, writeConfigFile, readSettingsView, writeConfig } = context;

  function diskChannels(): Array<Record<string, RawSettingValue>> {
    return (onDisk().channels ?? []) as Array<Record<string, RawSettingValue>>;
  }

  function submitOf(
    part: (channel: Record<string, RawSettingValue>) => Record<string, RawSettingValue>,
    type = "webhook",
  ): Array<Record<string, RawSettingValue>> {
    return channelsOf(readSettingsView().effective).map((channel) =>
      channel.type === type ? part(channel) : channel,
    );
  }

  // 判据 #7：必填键的两种删除手势都 400，话术指向「必填键，不能删除」——与「没交」分开。
  //
  // id / type / url / auth 在这里两种手势都试；baseUrl / deviceKey 只试 null（空串那一支客户端已经剥掉了，见下方注释）。
  // `auth` 是**取值域类**必填键（判据是「值在不在 WEBHOOK_AUTHS 里」而不是「键在不在」），与在场必填键
  // 不可删这一点同形：它同样列在 shared 的 VALUE_DOMAIN_REQUIRED_KEYS 里，两种手势都走「必填键，不能删除」。
  // 它**刻意不在客户端空串剥除清单**（shared/channel-compare.ts），所以空串那一支也能真实抵达写面。
  it("判据 #7：必填键传 null 或空串一律 400，话术点名该键且说的是「不能删除」", async () => {
    writeConfigFile(diskOf({ ...HOOK, auth: "bearer", token: "REAL" }, BARK));
    assemble();
    const before = readFileSync(configFile, "utf8");

    // 身份键（id / type）与投递必需键（webhook 的 url、以及取值域类的 auth）同样不可删：
    // 删了它条目就不是同一条了；删 `auth` 造出的那条频道还会被输入闸门以「auth 非法」拒收，
    // 写面对缺席与非法共用一句话，于是同一个手势的两种落点给出两句话（见 roundtrip 的同名判据组）。
    for (const [key, value] of [
      ["url", null],
      ["url", ""],
      ["auth", null],
      ["auth", ""],
      ["type", null],
      ["type", ""],
    ] as ReadonlyArray<readonly [string, RawSettingValue]>) {
      const submitted = submitOf((channel) => ({ ...channel, [key]: value }));
      const error = invalidOf(await writeConfig({ channels: submitted }));
      expect(error.key, key).toBe("channels");
      expect(error.hint, key).toContain(key);
      expect(error.hint, key).toContain("必填键");
      expect(error.hint, key).toContain("不能删除");
    }
    // baseUrl / deviceKey 只剩 null 这一支：#1016 P2-1 之后客户端**不再**把它们以空串提交——空串在客户端的
    // 空串剥除清单里（跨类型并集：bark 的 url / webhook 的 baseUrl 同理），提交前就变成键缺席，落在
    // preexisting 的放行路径上。真实客户端表达「清空」用的是 assignChannelFields 写的 null，那一支照旧 400。
    // 走真实客户端链的那一对在 test/integration/config-merge-roundtrip.test.ts（判据五 / 判据六）。
    for (const key of ["baseUrl", "deviceKey"]) {
      const submitted = submitOf((channel) => ({ ...channel, [key]: null }), "bark");
      const error = invalidOf(await writeConfig({ channels: submitted }));
      expect(error.hint, key).toContain(key + " 是必填键，不能删除");
    }
    expect(readFileSync(configFile, "utf8")).toBe(before);
  });

  // 判据 #8 的后一半（顶层那一半见上面「写面：合并与凭据」块）。
  it("判据 #8：频道条目内的陌生键 400，存量条目上已有的陌生键不连坐", async () => {
    writeConfigFile(diskOf({ ...HOOK, myCustom: "kept" }));
    assemble();
    const before = readFileSync(configFile, "utf8");

    const submitted = submitOf((channel) => ({ ...channel, myCustom: "submitted" }));
    const error = invalidOf(await writeConfig({ channels: submitted }));
    expect(error.key).toBe("channels");
    expect(error.hint).toContain("myCustom");
    expect(error.hint).toContain("不是已知键");
    expect(readFileSync(configFile, "utf8")).toBe(before);

    // 前提事实：只改 name 时那条陌生键不在提交面里，落盘后原样还在（#1016 缺陷 B 的正解）。

    const ok = await writeConfig({
      channels: submitOf((channel) => ({ ...channel, name: "改名" })),
    });
    expect(ok.ok).toBe(true);
    expect(channelOfType(diskChannels(), "webhook").myCustom).toBe("kept");
  });
}

function registerMaskedReplacementCases(context: ServiceMergeContext): void {
  const { assemble, onDisk, writeConfigFile, readSettingsView, writeConfig } = context;

  function diskChannels(): Array<Record<string, RawSettingValue>> {
    return (onDisk().channels ?? []) as Array<Record<string, RawSettingValue>>;
  }

  function submitOf(
    part: (channel: Record<string, RawSettingValue>) => Record<string, RawSettingValue>,
    type = "webhook",
  ): Array<Record<string, RawSettingValue>> {
    return channelsOf(readSettingsView().effective).map((channel) =>
      channel.type === type ? part(channel) : channel,
    );
  }

  // 判据 #9：掩码通道没被破坏。掩码在合并里解（五态之一），落盘的必须是真实值而不是占位符。
  it("判据 #9：提交掩码占位 → 落盘还原成存量原值（不是占位符本身）", async () => {
    writeConfigFile(diskOf({ ...HOOK, auth: "bearer", token: "REAL" }));
    assemble();
    expect(channelOfType(channelsOf(readSettingsView().effective), "webhook").token).toBe(MASK);

    const submitted = submitOf((channel) => ({ ...channel, name: "群机器人" }));
    expect(channelOfType(submitted, "webhook").token).toBe(MASK);
    const result = await writeConfig({ channels: submitted }, readSettingsView().revision);

    expect(result.ok).toBe(true);
    expect(channelOfType(diskChannels(), "webhook").token).toBe("REAL");
  });

  // 判据 #9 的另一半（**安全**）：掩码**没有原值可还原**时必须 400，而不是把它当普通值写进磁盘。
  // 换型残留的跨 type 掩码是活生生的一例：存量那条 webhook 的 id 被改成 bark，于是同 id 却换了
  // 一条，bark 的 deviceKey 在存量里没有对应原值——而客户端草稿里它就是占位（读出口按类型掩码，
  // 类型一变该键的凭据来源就断了）。落盘即报废：磁盘上从此是 `********`，投递必然失败，而用户
  // 界面上看着「已填写」。新频道带掩码（上一条）走同一个出口、同一句话——两条链路不许两个答案。
  it("判据 #9b：存量条目换 type 后带掩码（无原值可还原）→ 400，磁盘上占位符与换型结果都没有", async () => {
    writeConfigFile(diskOf({ ...HOOK, auth: "bearer", token: "REAL" }));
    assemble();
    expect(channelOfType(diskChannels(), "webhook").token).toBe("REAL");

    // 同一个 id 换成 bark：换型 = 换了一条（字段集随 type 变），deviceKey 在存量里没有原值。
    const submitted = submitOf(
      (channel) =>
        channel.type === "webhook"
          ? { id: "hook:1", type: "bark", baseUrl: "https://api.day.app", deviceKey: MASK }
          : channel,
      "webhook",
    );
    const error = invalidOf(
      await writeConfig({ channels: submitted }, readSettingsView().revision),
    );

    expect(error.key).toBe("channels");
    expect(error.hint).toContain("不能提交掩码占位");
    // 拒绝发生在落盘之前：存量那条 webhook 原封不动，磁盘上既没有占位符、也没有换型结果。
    const stored = channelOfType(diskChannels(), "webhook");
    expect(stored.token).toBe("REAL");
    expect(stored.type).toBe("webhook");
    expect(JSON.stringify(diskChannels())).not.toContain(MASK);
  });
}

function registerMergeFoundationCases(context: ServiceMergeContext): void {
  const { assemble, onDisk, writeConfigFile, writeConfig } = context;

  function diskChannels(): Array<Record<string, RawSettingValue>> {
    return (onDisk().channels ?? []) as Array<Record<string, RawSettingValue>>;
  }

  // 判据 #10：顶层键仍是整值替换——`kindRoutes` 不参与按键合并，删条目就是「这张表里没有它」。
  it("判据 #10：清掉一个 kindRoutes 条目 → 200 且落盘没有该键（顶层是整值替换，不是 null）", async () => {
    writeConfigFile(
      JSON.stringify({ kindRoutes: { done: ["webhook:hook"], error: ["webhook:hook"] } }),
    );
    assemble();
    expect(onDisk().kindRoutes).toEqual({ done: ["webhook:hook"], error: ["webhook:hook"] });

    const result = await writeConfig({ kindRoutes: { done: ["webhook:hook"] } });
    expect(result.ok).toBe(true);
    expect(onDisk().kindRoutes).toEqual({ done: ["webhook:hook"] });

    // 反例钉住方向：写 null 会被顶层值域拒（每项必须是 string[]）——顶层没有「显式删除」这一说。
    const rejected = invalidOf(
      await writeConfig({ kindRoutes: { done: null } as unknown as SettingsPatch }),
    );
    expect(rejected.key).toBe("kindRoutes");
  });

  // 这一条是整段重构的地基：提交**只带一个键**时，存量其余的键必须原样留下。
  // 旧语义（整组替换）下这条会红：落盘只剩 id/type/name，baseUrl 与 deviceKey 一起消失，
  // 频道当场变成一个打不通的空壳。
  it("地基：提交只带 id/type/name 时，存量的其余字段逐字留下（整组替换会把它洗成空壳）", async () => {
    writeConfigFile(diskOf({ ...BARK, name: "旧名", group: "家人", sound: "ding", icon: "i" }));
    assemble();

    const result = await writeConfig({
      channels: [...BUILTINS, { type: "bark", id: "bark:phone", name: "新名" }],
    });
    expect(result.ok).toBe(true);
    expect(channelOfType(diskChannels(), "bark")).toEqual({
      type: "bark",
      id: "bark:phone",
      name: "新名",
      baseUrl: "https://api.day.app",
      deviceKey: "key-1",
      level: "active",
      group: "家人",
      sound: "ding",
      icon: "i",
    });
  });

  // 换型 = 换了一条：字段集随 type 变，按字段继承会把 bark 的 baseUrl 带进 webhook（变陌生键 → 400）。
  it("换型不继承：同 id 改成另一种 type 时，存量那批键不带过去", async () => {
    writeConfigFile(diskOf({ ...BARK, group: "家人" }));
    assemble();

    const result = await writeConfig({ channels: [...BUILTINS, { ...HOOK, id: "bark:phone" }] });
    expect(result.ok).toBe(true);
    const stored = channelOfType(diskChannels(), "webhook");
    expect(stored.baseUrl).toBeUndefined();
    expect(stored.group).toBeUndefined();
    expect(stored.url).toBe("https://example.test/hook");
  });
}
