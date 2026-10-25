/** 读面与装配自然块；入口负责临时 home、动态导入与生命周期。 */
import { expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type { NotifyConfig, RawSettingValue } from "../../../src/server/config/impl/model/type.ts";
import { MASK, type ServiceApi } from "./service-test-support.ts";

export type ServiceReadContext = ServiceApi & {
  readonly assemble: () => void;
  readonly configFile: string;
  readonly onDisk: () => Record<string, RawSettingValue>;
  readonly writeConfigFile: (text: string) => void;
};

export function registerAssemblyAndRead(context: ServiceReadContext): void {
  const {
    assemble,
    onDisk,
    writeConfigFile,
    readConfig,
    readSettingsView,
    releaseConfig,
    writeConfig,
  } = context;

  it("无文件装配：install 返回时读面已是完整默认设置（异步读会开一个「拿到半份对象」的窗口）", () => {
    assemble();
    const config = readConfig();
    for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof NotifyConfig>) {
      expect(config[key], key).toEqual(DEFAULT_CONFIG[key]);
    }
    const view = readSettingsView();
    expect(view.user).toEqual({});
    expect(view.writable).toBe(true);
  });

  it("装配期同步读完文件：读面与用户层都已是文件里的值（旧形 start/end 不再被读面认——#1016 S3）", () => {
    writeConfigFile(
      '{"notifyAsk":false,"quietHours":{"enabled":true,"start":"23:00","end":"07:00"}}',
    );
    assemble();
    expect(readConfig().notifyAsk).toBe(false);
    expect(readConfig().quietHours.enabled).toBe(true);
    // 读面只认 windows：旧 start/end 由 upgrade 域 0.2.6 的割接在装配期搬进 windows[0]。
    expect(readConfig().quietHours.windows).toEqual([]);
    // `user` 是存储原样，那两个旧键仍看得见——视图不显示就等于「文件里有、界面里没有」两套事实。
    expect(readSettingsView().user.notifyAsk).toBe(false);
    expect(
      (readSettingsView().user.quietHours as unknown as Record<string, RawSettingValue>).start,
    ).toBe("23:00");
  });

  it("配置文件坏掉时回落默认而不是让装配失败，写一次即修好", async () => {
    writeConfigFile("{ 半截");
    assemble();
    expect(readConfig().notifyAsk).toBe(DEFAULT_CONFIG.notifyAsk);
    const result = await writeConfig({ notifyAsk: false });
    expect(result.ok).toBe(true);
    expect(onDisk().notifyAsk).toBe(false);
  });

  it("releaseConfig 后读面回落默认（下一个装配者不该继承上一个的用户层快照）", async () => {
    assemble();
    await writeConfig({ notifyAsk: false });
    releaseConfig();
    for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof NotifyConfig>) {
      expect(readConfig()[key], key).toEqual(DEFAULT_CONFIG[key]);
    }
    expect(readSettingsView().user).toEqual({});
  });

  it("重复装配当场抛错、release 幂等且之后可再装配（单例语义，重复调用是编程错误）", () => {
    assemble();
    expect(() => assemble()).toThrow(/只能装配一次/u);
    releaseConfig();
    expect(() => releaseConfig()).not.toThrow();
    assemble();
    expect(readConfig().notifyAsk).toBe(DEFAULT_CONFIG.notifyAsk);
  });
}

export function registerDeliveryAndView(context: ServiceReadContext): void {
  const { assemble, writeConfigFile, readConfig, readSettingsView } = context;

  /** 视图 / 读面里的频道条目：存储层形状不受契约约束，按原始值看。 */
  type RawChannel = Record<string, RawSettingValue>;

  /** 某份设置（视图或读面）里的频道数组，按原始值看。 */
  function rawChannelsOf(config: unknown): RawChannel[] {
    return (config as Record<string, RawSettingValue>).channels as RawChannel[];
  }
  // 判别力 #1：磁盘上只有 channels 键时，视图的键集恰好是 11 个已知顶层键（channels 是其中之一），
  // 且缺的那些键取默认表的值——**不是 undefined**。设置页要渲染全部 11 个控件，缺一个就是一处空白，
  // 而客户端不替顶层补值（它只对 channels 做比较规范形），所以这一步一旦没有，界面上就是一片未定义。
  it("判别力 #1：磁盘只有 channels 键时，视图键集恰好 11 个顶层键、缺键取默认表的值，channels 原样", () => {
    writeConfigFile(
      JSON.stringify({
        channels: [
          { type: "bark", id: "bark:1", baseUrl: "https://api.day.app", deviceKey: "key-1" },
        ],
      }),
    );
    assemble();

    const effective = readSettingsView().effective as unknown as Record<string, RawSettingValue>;
    // 键集**恰好**是默认表的 11 个键：不多（顶层陌生键不进视图）也不少（缺键被补上）。
    expect(Object.keys(effective).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
    for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof NotifyConfig>) {
      if (key === "channels") continue;
      expect(effective[key], key).toEqual(DEFAULT_CONFIG[key]);
    }
    // channels **原样**（凭据位按掩码往返的口径出占位）：视图不物化两条内置、也不给条目补字段——
    // 补值归投递投影，形态清理归 upgrade 域。
    expect(effective.channels).toEqual([
      { type: "bark", id: "bark:1", baseUrl: "https://api.day.app", deviceKey: MASK },
    ]);
  });

  // 判别力 #2：投递侧零回归。current() / readConfig() 仍是 normalizeConfig 的结果——补默认值、物化两条
  // 内置、钳越界。pipeline / sdk / stores / dry-run 全靠它，它一行都没改。
  it("判别力 #2：current() / readConfig() 仍是投递投影（补默认值 + 物化内置 + 钳越界），与视图是两份数据", () => {
    writeConfigFile(
      JSON.stringify({
        historyMaxAgeDays: 99_999,
        channels: [
          { type: "bark", id: "bark:1", baseUrl: "https://api.day.app", deviceKey: "key-1" },
        ],
      }),
    );
    assemble();

    const delivery = readConfig();
    const view = readSettingsView().effective as unknown as Record<string, RawSettingValue>;
    // 投递投影：越界被钳回默认、两条内置恒在场且在最前、出站条目被全量物化。
    expect(delivery.historyMaxAgeDays).toBe(DEFAULT_CONFIG.historyMaxAgeDays);
    expect(rawChannelsOf(delivery).map((item) => String(item.id))).toEqual([
      "browser",
      "system",
      "bark:1",
    ]);
    expect("enabled" in rawChannelsOf(delivery)[2]!).toBe(true);
    // 视图：越界值原样交给客户端（它会原样带回，落盘因此保持磁盘原值），内置不物化。
    expect(view.historyMaxAgeDays).toBe(99_999);
    expect(rawChannelsOf(view).map((item) => String(item.id))).toEqual(["bark:1"]);
    // current() 与视图渠道互不串味：同一份磁盘，两个出口给出两份**逐字不同**的答案。
    expect(JSON.stringify(delivery)).not.toBe(JSON.stringify(readSettingsView().effective));
  });

  // 连带项 A 的服务端一侧：越界值在视图里原样外发。客户端原样带回 → 合并判「原样带回」进 inherited →
  // 判据不重判值域 → 落盘保持磁盘原值。断的是「视图不许把越界值改掉」这一格。
  it("连带项 A：磁盘上的越界值在视图里原样外发（判它原样保留，不替用户改）", () => {
    writeConfigFile(
      JSON.stringify({
        channels: [
          { type: "bark", id: "bark:1", baseUrl: "https://x", deviceKey: "k", timeoutMs: 999_999 },
        ],
      }),
    );
    assemble();

    const view = readSettingsView().effective as unknown as Record<string, RawSettingValue>;
    expect(rawChannelsOf(view)[0]!.timeoutMs).toBe(999_999);
    // 投递侧照旧钳回（域内消费方要的是可用形态）：同一个值在两条通道上给两个答案，正是拆开的目的。
    expect(rawChannelsOf(readConfig()).find((item) => item.id === "bark:1")?.timeoutMs).toBe(0);
  });

  // 连带项 B 的服务端一侧：视图组装**不做任何键名映射**——磁盘上频道条目里的陌生键原样进视图。
  // 客户端原样带回后写面判它「原样带回」进 inherited，因而不重判值域（这条的端到端形态在
  // integration/config-merge-roundtrip 的形态六）。断的是「视图顺手把陌生键清掉」这一格。
  it("连带项 B：视图对条目内的陌生键原样放行（客户端不投影，它是靠 merge 判「原样带回」才不撞 400）", () => {
    writeConfigFile(
      JSON.stringify({
        channels: [
          { type: "bark", id: "bark:1", baseUrl: "https://x", deviceKey: "k", myCustom: "x" },
        ],
      }),
    );
    assemble();

    const view = readSettingsView().effective as unknown as Record<string, RawSettingValue>;
    expect(rawChannelsOf(view)[0]!.myCustom).toBe("x");
    // 而投递侧照旧按已知键逐个物化：陌生键不进生效设置（它没有投递语义，也不该进日志与出口）。
    const delivered = rawChannelsOf(readConfig()).find((item) => item.id === "bark:1");
    expect("myCustom" in (delivered ?? {})).toBe(false);
  });

  // 视图的顶层只取已知键：磁盘上的顶层陌生键不进视图。理由不是洁癖——写面对未知顶层键一律 400
  // （verdictOf 的 CONFIG_KEYS 判据），把它交给客户端只会被原样带回并当场被拒。
  it("顶层陌生键不进视图（视图给一份「提交必然 400」的数据，用户改个名字都存不下去）", () => {
    writeConfigFile(JSON.stringify({ futureFlag: true, notifyAsk: false }));
    assemble();

    const view = readSettingsView().effective as unknown as Record<string, RawSettingValue>;
    expect("futureFlag" in view).toBe(false);
    expect(view.notifyAsk).toBe(false);
    // `user` 刻意仍带它：视图不显示就等于「文件里有、界面里没有」两套事实（见上面那条用例）。
    expect((readSettingsView().user as unknown as Record<string, RawSettingValue>).futureFlag).toBe(
      true,
    );
  });
}
