/** 凭据与半坏存量自然块；入口负责临时 home、动态导入与生命周期。 */
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import type { RawSettingValue } from "../../../src/server/config/impl/model/type.ts";
import { stripChannelEmpties } from "../../../src/shared/interface.ts";
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

export type ServiceCredentialContext = ServiceApi & {
  readonly assemble: () => void;
  readonly configFile: string;
  readonly onDisk: () => Record<string, RawSettingValue>;
  readonly revisionOfFile: (text: string) => number;
  readonly writeConfigFile: (text: string) => void;
};

export function registerWriteBaseline(context: ServiceCredentialContext): void {
  const {
    assemble,
    configFile,
    onDisk,
    readConfig,
    readSettingsView,
    writeConfig,
    writeConfigFile,
  } = context;
  void onDisk;

  function diskChannels(): Array<Record<string, RawSettingValue>> {
    return (context.onDisk().channels ?? []) as Array<Record<string, RawSettingValue>>;
  }

  // ---------------------------------------------------------------- 写面范围（#1016 批次 B 使能面）
  //
  // 本块从写入口径验两件机制层的事：① 还原与校验取到的存量必须是**队列内那一刻**的
  // （基线漂移会让「原样带回」判成「本次改动」）；② 机制本身**不新增任何拒绝**——
  // 存量里非法的值原样带回时仍按今天的判据走，本次改动触碰的字段也仍走今天的判据。

  // 机制的地基用例：并发的两次写里，后一次必须拿前一次**落盘后**的存量去还原掩码。
  // 还原在队列外做的话，后一次会用前一次落盘前的 deviceKey 覆盖回去——前一次的改动被吃掉，
  // 而界面上看不出任何异常。
  it("并发两次写：后一次在队列内取基线，不会把前一次刚落盘的凭据用旧值盖回去", async () => {
    assemble();
    expect((await writeConfig({ channels: [...BUILTINS, BARK] })).ok).toBe(true);

    // 两次写都不带 expectedRevision：乐观并发不参与，这里只看基线取的时刻。
    const results = await Promise.all([
      // 第一次：把 deviceKey 换成新值。
      writeConfig({ channels: [...BUILTINS, { ...BARK, deviceKey: "key-2" }] }),
      // 第二次：凭据原样带回（掩码），别的字段改一个无关的。
      writeConfig({ channels: [...BUILTINS, { ...BARK, deviceKey: MASK, name: "改名" }] }),
    ]);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(true);

    // 关键断言：后一次的「原样带回」必须还原成前一次刚落盘的 key-2，而不是最初的 key-1。
    // 还原在队列外做时这里会是 key-1 —— 前一次的改动被静默吃掉。
    expect(channelOfType(diskChannels(), "bark").deviceKey).toBe("key-2");
    expect(channelOfType(diskChannels(), "bark").name).toBe("改名");
  });

  // 回归护栏：一条**非法**的提交，带不带存量基线，判据结论都必须与今天逐字相同。
  //
  // 提交体是手拼的（照抄视图里的原样存储形态）：真实客户端不会产出这种 payload——它的草稿
  // 来自归一化视图，半坏条目压根不在草稿里（真实往返链的形态见
  // test/integration/config-merge-roundtrip.test.ts）。这里要断的是**判据结论不变**，
  // 而不是某一类客户端会不会这么发。
  it("手拼的非法提交（半坏条目 baseUrl 为空）：仍按今天的判据 400——机制不放行也不加拒", async () => {
    // 手写配置文件造出半坏条目：baseUrl 为空但 deviceKey 在。
    writeConfigFile(
      JSON.stringify({
        channels: [...BUILTINS, { type: "bark", id: "bark:half", baseUrl: "", deviceKey: "key-1" }],
      }),
    );
    assemble();

    // 前提事实：这条频道在生效设置里不存在（归一化丢弃），但在存储视图里看得见。
    expect(readConfig().channels.some((c) => c.id === "bark:half")).toBe(false);
    const view = readSettingsView();
    expect(channelsOf(view.user).some((c) => c.id === "bark:half")).toBe(true);

    // 原样提交（凭据是掩码，其余逐字照抄视图）。
    const before = readFileSync(configFile, "utf8");
    const result = await writeConfig({ channels: channelsOf(view.user) });

    // 结论：仍然按今天的判据 400（本 PR 不加也不减任何判据）。
    // 后续的边界 PR 才是把这一条放行的那一方——它会查 scope 而不是查值。
    expect(invalidOf(result).key).toBe("channels");
    expect(readFileSync(configFile, "utf8")).toBe(before);
  });

  // 回归护栏：本次改动触碰的字段仍走现有判据。机制在这里必须**没有**任何话语权。
  it("本次改动触碰的非法字段仍被现有判据拒（机制不放行任何东西）", async () => {
    assemble();
    expect((await writeConfig({ channels: [...BUILTINS, BARK] })).ok).toBe(true);
    const before = readFileSync(configFile, "utf8");

    // level 非法：当前就会 400，本次改动与否都该 400。
    const result = await writeConfig({
      channels: [...BUILTINS, { ...BARK, level: "urgent" }],
    });
    expect(invalidOf(result).hint).toContain("level");
    expect(readFileSync(configFile, "utf8")).toBe(before);

    // 顶层的非法值同理：机制只管频道字段，但结论必须一个字都没变。
    const topLevel = await writeConfig({ historyMaxAgeDays: -1 });
    expect(invalidOf(topLevel).key).toBe("historyMaxAgeDays");
    expect(readFileSync(configFile, "utf8")).toBe(before);
  });

  // 合法保存照常成功：机制不是「多一个拒绝口」。这条守住「不得引入任何新的拒绝行为」。
  it("合法保存照常成功：既有的凭据往返与掩码还原行为一字未变", async () => {
    assemble();
    expect((await writeConfig({ channels: [...BUILTINS, BARK] })).ok).toBe(true);
    const view = readSettingsView();

    const submitted = channelsOf(view.user).map((channel) => ({ ...channel, name: "手机" }));
    const result = await writeConfig({ channels: submitted }, view.revision);

    expect(result.ok).toBe(true);
    expect(channelOfType(diskChannels(), "bark").name).toBe("手机");
    // 未编辑的凭据仍是原值（掩码还原路径没被本 PR 动过）。
    expect(channelOfType(diskChannels(), "bark").deviceKey).toBe("key-1");
  });
}

export function registerEmptyCredentials(context: ServiceCredentialContext): void {
  const { assemble, onDisk, writeConfigFile, readSettingsView, writeConfig } = context;

  function diskChannels(): Array<Record<string, RawSettingValue>> {
    return (onDisk().channels ?? []) as Array<Record<string, RawSettingValue>>;
  }

  // 也掩成占位（`typeof "" === "string"`）→ ③ 客户端剥空串剥不掉占位（值不是空串），原样带回
  // → ④ 写面 unmaskChannels 按 id 取回的 `original.channel[field]` 是 undefined，
  // `typeof value !== "string"` → 整批被拒，400「新增频道不能提交掩码占位」。
  //
  // 真实用户路径：设置页新建一条 webhook（落盘只有 url/auth/timeoutSec/enabled，三个密钥键全无）
  // → 第一次保存成功 → **只切一下 enabled 开关就再也存不下去**。死锁的是整份配置，不是那一条频道。

  // 提交体一律过 stripChannelEmpties：那是客户端 diff.ts 提交前对每个频道实例做的那一步，
  // 直接用共享面同一份实现（客户端提交、服务端写面基线、比较规范形是同一处），不在测试里另写
  // 一份剥除逻辑——手写副本会让这条用例在客户端真的不再剥空串时继续绿。
  it("磁盘上缺席的凭据：客户端只改 enabled 也能存下去，且磁盘上仍无这三个键（不是被写成空串）", async () => {
    // 磁盘形态：设置页新建的 webhook 存下来就是这样——三个凭据键一个都没有。
    // 两条内置条目照真实文件那样在场：#1016 S3 之后「内置恒在场」由 upgrade 域的形态清理保证，
    // 读面不再物化它们，而写面仍会对缺内置的提交 400（内置渠道不能删除）。
    writeConfigFile(
      JSON.stringify({
        channels: [
          ...BUILTINS,
          {
            type: "webhook",
            id: "webhook:hook",
            url: "https://example.test/hook",
            auth: "none",
            enabled: true,
          },
        ],
      }),
    );
    assemble();

    // #1016 S3：视图不再补默认值，磁盘上缺席的键在视图里就**缺席**（不再是空串）。
    // 两种形态对客户端等价（输入框里 undefined 与空串同显空，剥空串对两者是同一条判据），
    // 而「缺席」让写面在合并时把它读成「不动」——这正是本用例要的落盘结果。
    const view = readSettingsView();
    const shown = channelOfType(channelsOf(view.effective), "webhook");
    expect("token" in shown).toBe(false);
    expect("password" in shown).toBe(false);
    expect("headerValue" in shown).toBe(false);

    // 用户手势只有切 enabled；整组 channels 照常提交，每项先过共享面的空串剥除。
    const submitted = channelsOf(view.effective).map(
      (channel) =>
        stripChannelEmpties(
          channel.type === "webhook" ? { ...channel, enabled: false } : channel,
        ) as Record<string, RawSettingValue>,
    );
    const result = await writeConfig({ channels: submitted }, view.revision);

    // 空串原样透出 → 客户端剥空串剥掉了这三个键 → 写面看不到占位，还原不触发，整批不拒。
    // 空串被掩码时这里拿到的是 400「新增频道不能提交掩码占位，请填写真实凭据」。
    expect(result.ok).toBe(true);
    const stored = channelOfType(diskChannels(), "webhook");
    expect(stored.enabled).toBe(false);
    // 落盘后仍是**键缺席**，不是被补成空串：空串与缺席在读面同形，写面却要保住这个区别。
    expect("token" in stored).toBe(false);
    expect("password" in stored).toBe(false);
    expect("headerValue" in stored).toBe(false);
  });

  // 反例钉住：把掩码通道整条关掉（另一种同样像样的「修法」）会让这一条变红。
  // 非空的真凭据在读面必须是占位、原样带回必须还原成真实值——这次改动只放宽空串那一侧。
  it("反例：磁盘上有真凭据时掩码通道照旧工作——读面出占位、原样带回还原成真实值", async () => {
    writeConfigFile(
      JSON.stringify({
        channels: [
          ...BUILTINS,
          {
            type: "webhook",
            id: "webhook:hook",
            url: "https://example.test/hook",
            auth: "bearer",
            enabled: true,
            token: "REAL",
          },
        ],
      }),
    );
    assemble();

    const view = readSettingsView();
    // 脱敏没开口子：非空的 token 仍然只出占位。
    expect(channelOfType(channelsOf(view.effective), "webhook").token).toBe(MASK);

    // 用户只改显示名。占位不是空串，剥不掉它，原样带回走还原路径。
    const submitted = channelsOf(view.effective).map(
      (channel) =>
        stripChannelEmpties(
          channel.type === "webhook" ? { ...channel, name: "改名" } : channel,
        ) as Record<string, RawSettingValue>,
    );
    const result = await writeConfig({ channels: submitted }, view.revision);

    expect(result.ok).toBe(true);
    const stored = channelOfType(diskChannels(), "webhook");
    expect(stored.name).toBe("改名");
    // 还原回真实值，而不是把占位字面量写进文件（那等于凭据从此报废）。
    expect(stored.token).toBe("REAL");
  });
}

export function registerHalfBrokenStorage(context: ServiceCredentialContext): void {
  const { onDisk, revisionOfFile, readSettingsView, writeConfig } = context;

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

  /**
   * 半坏条目不许把用户锁死在设置页外（#1016 S3 的回归修复，端到端经写面本身）。
   *
   * 上一组走的是纯函数链（磁盘 → 视图 → 客户端 → 合并 → 判据），这一组补上**真落盘**那一段：
   * 用户在设置页上点保存，`writeConfig` 会不会 400。前一段全对而这里 400，用户体感仍然是「设置页坏了」。
   *
   * 半坏条目来自**升级之后手改文件**：0.2.9 的形态清理只在刻度推进时跑一次，救不了这条路
   * （该步的职责见 upgrade/impl/steps/canonical-keys.ts）。
   */
  /** 磁盘上的一条半坏 bark：缺 baseUrl——用户在升级之后手改文件造出来的那种形态。 */
  const HALF_BARK = { type: "bark", id: "bark:half", deviceKey: "key-half" } as const;
  /** 磁盘：两条内置 + 一条合法 webhook + 那条半坏 bark。 */
  const HALF_DISK = diskOf(HOOK, HALF_BARK);

  it("改**另一条**频道的名字即保存成功；半坏条目在磁盘上逐字未变（不补 baseUrl、不删键、凭据不回退成掩码）", async () => {
    revisionOfFile(HALF_DISK);
    // 用户改的是那条**合法 webhook** 的名字，与半坏 bark 毫无关系。客户端保存频道域时把整个
    // channels 整组带上（diffSettingsPayload 的 channels 整组语义），那条半坏条目于是也进了提交面
    // ——锁死正是在这一步发生的。只改顶层键反而不触发：提交里没有 channels，判据压根不重判它。
    const submitted = submitOf((channel) => ({ ...channel, name: "群机器人" }), "webhook");
    const result = await writeConfig({ channels: submitted }, readSettingsView().revision);

    expect(result.ok).toBe(true);
    // 半坏条目：存量有的键一条不少、值一字未改，**且没有凭空多出 baseUrl**（写面不猜值）。
    expect(channelById(diskChannels(), "bark:half")).toEqual(HALF_BARK);
    expect("baseUrl" in channelById(diskChannels(), "bark:half")).toBe(false);
    // 前提事实：同一次保存里那条合法 webhook 的改名**确实落盘了**——否则这条可能在测「什么都没发生」。
    expect(channelById(diskChannels(), HOOK.id).name).toBe("群机器人");
  });

  it("视图里看得见那条半坏条目（读面不丢弃），且补上 baseUrl 之后它自此合法", async () => {
    revisionOfFile(HALF_DISK);
    // 前提事实：客户端能看见它——「用户看不见」与「用户改不动」是同一种锁死。
    const shown = channelById(channelsOf(readSettingsView().effective), "bark:half");
    expect(shown.baseUrl).toBeUndefined();
    expect(shown.deviceKey).toBe(MASK);

    // 出路一：把它补全再保存（同一 id 同 type，合并按 id 认这条），不必重启、不必手改文件。
    const submitted = submitOf(
      (channel) =>
        channel.type === "bark" ? { ...channel, baseUrl: "https://api.day.app" } : channel,
      "bark",
    );
    const fixed = await writeConfig({ channels: submitted }, readSettingsView().revision);

    expect(fixed.ok).toBe(true);
    expect(channelById(diskChannels(), "bark:half").baseUrl).toBe("https://api.day.app");
  });

  it("显式删除半坏条目的必填键仍 400（放行的是「存量本就残缺」，不是「删必填键」）", async () => {
    revisionOfFile(HALF_DISK);
    const submitted = submitOf(
      (channel) => (channel.type === "bark" ? { ...channel, baseUrl: null } : channel),
      "bark",
    );
    const error = invalidOf(
      await writeConfig({ channels: submitted }, readSettingsView().revision),
    );
    expect(error.hint).toContain("baseUrl 是必填键，不能删除");
    // 拒绝发生在落盘之前：半坏条目原封不动。
    expect(channelById(diskChannels(), "bark:half")).toEqual(HALF_BARK);
  });

  it("只改顶层键的那次保存不重判 channels —— 这不是「半坏豁免」，是 channels 压根没进提交面", async () => {
    // 记下这条事实是为了不误读上一条：锁死只在**提交面带着 channels** 时才发生（频道域保存 / 全部保存）。
    // 少了它，下一个读代码的人会以为半坏豁免覆盖了「任何一次保存」，而那不是判据的形状。
    revisionOfFile(HALF_DISK);
    const result = await writeConfig({ notifyTaskDone: false }, readSettingsView().revision);

    expect(result.ok).toBe(true);
    expect(channelById(diskChannels(), "bark:half")).toEqual(HALF_BARK);
  });
}
