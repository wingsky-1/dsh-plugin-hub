/**
 * dsh-notifier config 域 service 块 —— 装配面（读写设置）。
 *
 * 面口径：只经 `config/interface.ts` 的 `installConfig` / `releaseConfig` / `readConfig` /
 * `readSettingsView` / `writeConfig`，只伪 `config/deps.ts` 声明的 `logger`。
 *
 * 导入顺序是硬性的：`configStore` 是模块级单例，落盘路径在**构造时**由 `notifierFile()` 定下，
 * 而静态 import 会在任何语句之前求值——顺序反了，本节全部落盘就写进真实 `~/.dsh`（正在跑的
 * `dsh web` 的 home）。故顶部先建临时 home，再动态导入被测模块；每个用例开跑前清掉配置文件，
 * 让「装配」始终相当于一次冷启动。
 *
 * 掩码字面量独立写出（不从源码导入）：它是与设置页共享的跨端契约。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type {
  NotifyConfig,
  RawSettingValue,
  SettingInvalid,
  SettingsPatch,
} from "../../../src/server/config/impl/model/type.ts";
import type { WriteResult } from "../../../src/server/config/impl/service/type.ts";
import { CONFIG_FILE_NAME, notifierFile } from "../../../src/server/shared/interface.ts";
import {
  BARK_LEVELS_LIMIT,
  stripChannelEmpties,
  WEBHOOK_TEMPLATE_MAX_CHARS,
} from "../../../src/shared/interface.ts";
import { makeLogger, tempDshHome } from "../../helpers.ts";

const home = tempDshHome();
const configFile = notifierFile(CONFIG_FILE_NAME);
const { installConfig, releaseConfig, readConfig, readSettingsView, writeConfig } =
  await import("../../../src/server/config/interface.ts");

/** 掩码占位：设置页把用户没改动的凭据原样提交回来，两侧字面量必须一致。 */
const MASK = "********";

/**
 * 尺寸夹具从上界**派生**而不是另抄一份数字：这些判据量的是「本次提交的值落在上界的哪一侧」，
 * 上界（src/shared/config-schema.ts 的共享事实源）一改，夹具自动跟着走，判据仍是同一条语义。
 * 抄一份数字就等于测试里又开一处第二事实源——上界改了而夹具没改，测试会从「判语义」退化成
 * 「判某个恰好没变的常量」。
 */
const TEMPLATE_OVER_LIMIT = WEBHOOK_TEMPLATE_MAX_CHARS + 1;
const TEMPLATE_OVER_LIMIT_EDITED = WEBHOOK_TEMPLATE_MAX_CHARS + 101;
const LEVELS_OVER_LIMIT = BARK_LEVELS_LIMIT + 6;
const LEVELS_UNDER_LIMIT = BARK_LEVELS_LIMIT - 4;

/** 合法 bark 频道：写面要求 id / baseUrl / deviceKey 非空且 level 合法。 */
const BARK = {
  type: "bark",
  id: "bark:phone",
  name: "A",
  baseUrl: "https://api.day.app",
  deviceKey: "key-1",
  level: "active",
};

/** 两条内置条目：显式提交 `channels` 时必须带着它们（内置渠道不能删除）。 */
const BUILTINS = [
  { type: "browser", id: "browser", enabled: true, popup: true, sound: false, whenVisible: false },
  { type: "system", id: "system", enabled: false, popup: false, sound: false },
] as const;

/** 按类型取条目：内置两条恒在最前，按下标取到的就不再是出站频道。 */
function channelOfType(
  list: Array<Record<string, RawSettingValue>>,
  type: string,
): Record<string, RawSettingValue> {
  const channel = list.find((item) => item.type === type);
  if (channel === undefined) throw new Error(`期望配置里有一个 ${type} 频道`);
  return channel;
}

/** 装配一次并交出日志出口（DSH_HOME 已在模块顶部指向临时目录）。 */
function assemble() {
  const logger = makeLogger();
  installConfig({ logger });
  return logger;
}

/** 取「非法」失败的载荷；不是 invalid（或竟然成功）即当场失败。 */
function invalidOf(result: WriteResult): SettingInvalid {
  if (result.ok || result.reason !== "invalid") {
    throw new Error(`期望 invalid，实际 ${JSON.stringify(result)}`);
  }
  return result.error;
}

/** 取一份配置里的频道数组；存储层形状不受契约约束，故按原始值看。 */
function channelsOf(config: Partial<NotifyConfig>): Array<Record<string, RawSettingValue>> {
  return (config.channels ?? []) as unknown as Array<Record<string, RawSettingValue>>;
}

/** 手写配置文件：模拟用户或别的工具改过磁盘上那一份（目录可能还不存在）。 */
function writeConfigFile(text: string): void {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, text);
}

/** 磁盘上的 JSON（写面必须落成可重新解析的完整文件）。 */
function onDisk(): Record<string, RawSettingValue> {
  return JSON.parse(readFileSync(configFile, "utf8"));
}

/** 磁盘上的频道数组；存储层形状不受契约约束，故按原始值看。 */
function diskChannels(): Array<Record<string, RawSettingValue>> {
  return (onDisk().channels ?? []) as Array<Record<string, RawSettingValue>>;
}

/** 装配一次并取该文件的修订号；先释放再写文件，避免把上一个快照带进来。 */
function revisionOfFile(text: string): number {
  releaseConfig();
  rmSync(configFile, { force: true });
  writeConfigFile(text);
  assemble();
  return readSettingsView().revision;
}

beforeEach(() => {
  // 冷启动：配置文件不存在与内容为空对读面是同一件事，这里统一成前者。
  rmSync(configFile, { recursive: true, force: true });
});

afterEach(() => {
  releaseConfig();
});

afterAll(() => {
  home.dispose();
});

describe("装配与读面", () => {
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
});

describe("读面两条通道：投递投影 vs 外发视图（#1016 S3）", () => {
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
});

describe("写面：落盘、校验、版本", () => {
  it("写一次即落盘：文件可被重新解析、目录里不留临时文件（半截 JSON 会被下一次装配当空设置）", async () => {
    assemble();
    const result = await writeConfig({ notifyTaskDone: false, historyMaxAgeDays: 32 });
    expect(result.ok).toBe(true);
    expect(onDisk().notifyTaskDone).toBe(false);
    expect(onDisk().historyMaxAgeDays).toBe(32);
    expect(readdirSync(dirname(configFile)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("写后再装配（进程重启）用户层从文件恢复：设置不丢", async () => {
    assemble();
    expect((await writeConfig({ notifyAsk: false })).ok).toBe(true);
    releaseConfig();
    assemble();
    expect(readConfig().notifyAsk).toBe(false);
  });

  it("校验失败：不落盘、不改内存快照，并带上首个非法键（非法值先写进文件就没救了）", async () => {
    assemble();
    await writeConfig({ notifyAsk: false });
    const before = readFileSync(configFile, "utf8");
    const error = invalidOf(await writeConfig({ historyMaxAgeDays: -1, notifyAsk: "yes" }));
    expect(error.key).toBe("historyMaxAgeDays");
    expect(readFileSync(configFile, "utf8")).toBe(before);
    expect(readConfig().historyMaxAgeDays).toBe(DEFAULT_CONFIG.historyMaxAgeDays);
  });

  // **安全**。掩码只表达「用户没改它」，因此必须有原值可还原；没有原值时它什么也不是，
  // 放行就等于把 `********` 当凭据写进磁盘（那条凭据从此报废，而用户以为自己填过）。
  // 载荷带上两条内置，否则这条会被「内置渠道不能删除」先拒掉、根本走不到掩码判据（那样断言
  // 只查 error.key === "channels"，钉不住任何东西）。
  it("新增频道提交掩码占位：400 且话术指向掩码（带内置，钉得住掩码判据本身）", async () => {
    assemble();
    const error = invalidOf(
      await writeConfig({
        channels: [
          ...BUILTINS,
          { type: "bark", id: "bark:new", baseUrl: "https://x", deviceKey: MASK },
        ],
      }),
    );
    expect(error.key).toBe("channels");
    expect(error.hint).toContain("不能提交掩码占位");
    // 占位符一个字都不许进磁盘。
    expect(existsSync(configFile)).toBe(false);
  });

  it("expectedRevision 过期即冲突且不落盘；用当前修订号重试成功（乐观并发的意义就在这里）", async () => {
    assemble();
    const stale = readSettingsView().revision;
    await writeConfig({ notifyAsk: false });
    const before = readFileSync(configFile, "utf8");

    const conflicted = await writeConfig({ notifyTaskDone: false }, stale);
    if (conflicted.ok) throw new Error("应当冲突");
    expect(conflicted.reason).toBe("conflict");
    expect(readFileSync(configFile, "utf8")).toBe(before);

    const retried = await writeConfig({ notifyTaskDone: false }, readSettingsView().revision);
    expect(retried.ok).toBe(true);
    expect(readConfig().notifyTaskDone).toBe(false);
  });

  it("同一修订号并发两次写：恰好一个成功、一个冲突（比对与写入之间被插入，乐观并发就形同虚设）", async () => {
    assemble();
    const revision = readSettingsView().revision;
    const results = await Promise.all([
      writeConfig({ notifyAsk: false }, revision),
      writeConfig({ notifyTaskDone: false }, revision),
    ]);
    // 写队列 FIFO：先入队的那次赢，后一次看到的已是新修订号。
    expect(results[0].ok).toBe(true);
    expect(results[1].ok ? "ok" : results[1].reason).toBe("conflict");
    expect(Object.keys(onDisk())).toEqual(["notifyAsk"]);
  });

  it("写失败经失败出口报告（unavailable + 日志），而不是静默成功", async () => {
    const logger = assemble();
    // 目标路径上放一个非空目录：原子写的 rename 必然失败。
    mkdirSync(configFile, { recursive: true });
    writeFileSync(join(configFile, "blocker"), "x");

    const result = await writeConfig({ notifyAsk: false });
    if (result.ok) throw new Error("应当写失败");
    expect(result.reason).toBe("unavailable");
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain("配置写入失败");
    expect(readConfig().notifyAsk).toBe(DEFAULT_CONFIG.notifyAsk);
  });

  it("提交里值为 undefined 的键是「没提交」：不该把文件里已有的值抹掉（设置页整份提交时未改动的字段可能带 undefined）", async () => {
    assemble();
    expect((await writeConfig({ notifyAsk: false })).ok).toBe(true);

    const result = await writeConfig({ notifyAsk: undefined, notifyTaskDone: false });
    expect(result.ok).toBe(true);
    expect(onDisk().notifyAsk).toBe(false);
    expect(readConfig().notifyAsk).toBe(false);
    expect(readConfig().notifyTaskDone).toBe(false);
  });

  it("修订号是用户层内容摘要：键序无关、内容不同则号不同（含嵌套——号不稳定会让每次保存都凭空冲突）", () => {
    const first = revisionOfFile(
      '{"notifyAsk":false,"quietHours":{"start":"22:00","enabled":true,"end":"08:00"}}',
    );
    // 同样的内容、顶层与嵌套键序都不同：不该算改动。
    const reordered = revisionOfFile(
      '{"quietHours":{"end":"08:00","enabled":true,"start":"22:00"},"notifyAsk":false}',
    );
    expect(reordered).toBe(first);
    // 只改嵌套里的一个值：必须算改动，否则版本冲突漏判。
    const nestedChanged = revisionOfFile(
      '{"notifyAsk":false,"quietHours":{"start":"22:00","enabled":true,"end":"07:00"}}',
    );
    expect(nestedChanged).not.toBe(first);
    // 数组里的对象同样按键排序：数组走的是另一条序列化支路，漏了它等于频道键序一变就凭空冲突。
    const channelKeysOrdered = revisionOfFile(
      '{"channels":[{"id":"bark:a","type":"bark","deviceKey":"k"}]}',
    );
    const channelKeysSwapped = revisionOfFile(
      '{"channels":[{"type":"bark","id":"bark:a","deviceKey":"k"}]}',
    );
    expect(channelKeysSwapped).toBe(channelKeysOrdered);
    // 标量值参与摘要：把 true / false 摘要成同一个号，两次内容不同的设置会被判成同一版本。
    expect(revisionOfFile('{"notifyAsk":true}')).not.toBe(revisionOfFile('{"notifyAsk":false}'));
    // 手改过的文件里可能有 null 值：摘要必须对它照样可算——装配期同步算号，抛出去整个插件装不上。
    expect(typeof revisionOfFile('{"notifyAsk":null}')).toBe("number");
  });

  it("数组顺序是内容：调换频道顺序必须改号（排数组会把「用户调序」读成没改动）", () => {
    const pad = { ...BARK, id: "bark:pad", name: "B" };
    const forward = revisionOfFile(JSON.stringify({ channels: [BARK, pad] }));
    const swapped = revisionOfFile(JSON.stringify({ channels: [pad, BARK] }));
    // 排序数组会让两份内容不同的设置算出同一个号：用户调序后提交不再判冲突，静默覆盖别人的改动。
    expect(swapped).not.toBe(forward);
  });
});

describe("写面的合并与凭据", () => {
  it("合并语义：未提及的顶层键保留、嵌套对象整体替换（不做深合并）、陌生键不被一次保存抹掉", async () => {
    writeConfigFile('{"futureKey":{"mode":"x"},"notifyAsk":false}');
    assemble();
    await writeConfig({
      quietHours: {
        enabled: true,
        windows: [{ start: "22:00", end: "08:00" }],
        allowKinds: ["error"],
      },
    });
    await writeConfig({ notifyTaskDone: false });

    expect(onDisk().notifyAsk).toBe(false);
    expect(onDisk().futureKey).toEqual({ mode: "x" });
    expect(readConfig().notifyTaskDone).toBe(false);
    expect(readConfig().quietHours.allowKinds).toEqual(["error"]);

    await writeConfig({
      quietHours: { enabled: false, windows: [{ start: "23:00", end: "07:00" }] },
    });
    expect(readConfig().quietHours.enabled).toBe(false);
    expect(readConfig().quietHours.allowKinds).toEqual([]);
  });

  // 顶层陌生键改 400（#1016 S2）：写面不再透传保留。**存量里已有的**陌生键仍然安全——它不在
  // 提交里，`commit` 的基底（this.stored）原样把它带进下一次落盘，一次保存抹不掉。判据 #8 的前一半。
  it("提交里契约不认识的顶层键 400 且不落盘；存量里的同名键照旧保留", async () => {
    writeConfigFile(JSON.stringify({ futureFlag: "stored" }));
    assemble();
    const before = readFileSync(configFile, "utf8");

    const error = invalidOf(
      await writeConfig({ futureFlag: "submitted" } as unknown as SettingsPatch),
    );
    expect(error.key).toBe("futureFlag");
    expect(error.hint).toContain("不是已知配置键");
    expect(readFileSync(configFile, "utf8")).toBe(before);

    // 前提事实：只提交认识的键时，存量那份陌生键原样留在文件里（视图也仍看得见它）。
    expect((await writeConfig({ notifyAsk: false })).ok).toBe(true);
    expect(onDisk().futureFlag).toBe("stored");
  });

  it("视图的 user 是存储原样（只掩码）：陌生键在界面上也要看得见，同时凭据仍然掩码", () => {
    writeConfigFile(JSON.stringify({ futureFlag: true, futureChannelKey: "v", channels: [BARK] }));
    assemble();
    const user = readSettingsView().user as unknown as Record<string, RawSettingValue>;
    expect(user.futureFlag).toBe(true);
    expect(user.futureChannelKey).toBe("v");
    // 净化后的用户层里没有陌生键，视图一旦改回用它，上面两条就会读到 undefined。
    expect(channelsOf(readSettingsView().user)[0].deviceKey).toBe(MASK);
  });

  it("原型链危险键不写回文件（`__proto__` 等自有键经 JSON 提交是可能的，展开进设置对象就会改写原型）", async () => {
    assemble();
    const patch = JSON.parse(
      '{"__proto__":{"pwned":true},"constructor":{"x":1},"prototype":{"y":1},"notifyAsk":false}',
    ) as SettingsPatch;
    const result = await writeConfig(patch);
    expect(result.ok).toBe(true);
    expect(Object.keys(onDisk())).toEqual(["notifyAsk"]);
  });

  it("凭据往返：视图出掩码、域内读面出明文；把掩码提交回来即保留原值（没改密码不该把密码改成 8 个星号）", async () => {
    assemble();
    expect((await writeConfig({ channels: [...BUILTINS, BARK] })).ok).toBe(true);

    const view = readSettingsView();
    expect(channelOfType(channelsOf(view.user), "bark").deviceKey).toBe(MASK);
    expect(channelOfType(channelsOf(view.effective), "bark").deviceKey).toBe(MASK);
    expect(channelOfType(channelsOf(readConfig()), "bark").deviceKey).toBe("key-1");

    // 用户只改了显示名，凭据字段原样回显提交。
    const submitted = channelsOf(view.user).map((channel) => ({ ...channel, name: "手机" }));
    const result = await writeConfig({ channels: submitted }, view.revision);
    expect(result.ok).toBe(true);
    expect(channelOfType(channelsOf(readConfig()), "bark").name).toBe("手机");
    expect(channelOfType(diskChannels(), "bark").deviceKey).toBe("key-1");
    if (!result.ok) throw new Error("应当写入成功");
    expect(channelOfType(channelsOf(result.view.user), "bark").deviceKey).toBe(MASK);
  });

  // 旧顶层键在 0.2.4 被搬进条目并删除。写面必须拒它们：当陌生键放行会让停在升级前页面上的
  // 旧客户端以为存上了（200 + 什么都不发生），而它改的其实是已经不存在的键。
  it("退役键写拒：0.2.3 的顶层渠道键提交返回 invalid 且不落盘、不改动生效设置", async () => {
    assemble();
    // 先落一次合法写入：下面「文件逐字未变」这条断言才有东西可比。
    expect((await writeConfig({ historyMaxAgeDays: 5 })).ok).toBe(true);
    const before = readFileSync(configFile, "utf8");
    const effectiveBefore = readConfig();

    const result = await writeConfig({ browserNotify: false } as unknown as SettingsPatch);

    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      error: {
        key: "browserNotify",
        hint: "该键在 0.2.4 升级时已移入渠道条目；页面停留在升级前时，刷新后重试",
      },
    });
    // 拒绝发生在落盘之前：生效设置与文件都不该有任何变化
    expect(readConfig()).toEqual(effectiveBefore);
    expect(readFileSync(configFile, "utf8")).toBe(before);
  });

  // maxConnections 走同一条退役键拒收路径，但原因是 0.2.5 把上限机制整体移除——话术不能与渠道键
  // 共用，且同样必须在落盘之前被拦下。
  it("maxConnections 写拒：0.2.5 退役的连接上限键返回 invalid 且话术是它自己的", async () => {
    assemble();
    expect((await writeConfig({ historyMaxAgeDays: 5 })).ok).toBe(true);
    const before = readFileSync(configFile, "utf8");
    const effectiveBefore = readConfig();

    const error = invalidOf(await writeConfig({ maxConnections: 64 } as unknown as SettingsPatch));

    expect(error.key).toBe("maxConnections");
    expect(error.hint).toContain("0.2.5");
    expect(error.hint).not.toContain("已移入渠道条目");
    expect(readConfig()).toEqual(effectiveBefore);
    expect(readFileSync(configFile, "utf8")).toBe(before);
  });
});

describe("写面：频道的可选键（缺省即合法，显式非法仍拦）", () => {
  it("bark 缺 level / webhook 缺 preset 的提交写入成功：落盘不带这两个键，消费方拿到可用缺省", async () => {
    assemble();
    const result = await writeConfig({
      channels: [
        ...BUILTINS,
        { type: "bark", id: "bark:phone", baseUrl: "https://api.day.app", deviceKey: "key-1" },
        { type: "webhook", id: "webhook:hook", url: "https://example.test/hook", auth: "none" },
      ],
    });
    expect(result.ok).toBe(true);

    const stored = diskChannels();
    expect(stored).toHaveLength(BUILTINS.length + 2);
    const storedBark = channelOfType(stored, "bark");
    const storedWebhook = channelOfType(stored, "webhook");
    expect(storedBark.level).toBeUndefined();
    expect(storedWebhook.preset).toBeUndefined();
    expect(storedBark.deviceKey).toBe("key-1");

    const effective = channelsOf(readConfig());
    const bark = channelOfType(effective, "bark");
    expect("level" in bark).toBe(false);
    const webhook = channelOfType(effective, "webhook");
    expect(webhook.preset).toBe("custom");
    expect(webhook.auth).toBe("none");
  });

  it("显式提交非法 level / preset 仍判非法且不落盘（缺省放行不等于不校验）", async () => {
    assemble();
    const badLevel = await writeConfig({
      channels: [
        { type: "bark", id: "bark:phone", baseUrl: "https://x", deviceKey: "k", level: "urgent" },
      ],
    });
    expect(invalidOf(badLevel).hint).toContain("level");

    const badPreset = await writeConfig({
      channels: [
        { type: "webhook", id: "webhook:hook", url: "https://x", auth: "none", preset: "slack" },
      ],
    });
    expect(invalidOf(badPreset).hint).toContain("preset");
    expect(existsSync(configFile)).toBe(false);
  });
});

// ---------------------------------------------------------------- 写面范围（#1016 批次 B 使能面）
//
// 本块从写入口径验两件机制层的事：① 还原与校验取到的存量必须是**队列内那一刻**的
// （基线漂移会让「原样带回」判成「本次改动」）；② 机制本身**不新增任何拒绝**——
// 存量里非法的值原样带回时仍按今天的判据走，本次改动触碰的字段也仍走今天的判据。

describe("写面：存量基线在写队列内取（#1016 批次 B）", () => {
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
});

// ---------------------------------------------------------------- 缺陷 A（#1016 S0）：空串被掩码
//
// 完整因果链（四步，每一步都在既有代码里）：① 读面把磁盘上**缺席**的凭据补成空串
// （input/index.ts 的 `asString(raw.token, "")` 兜底）→ ② redact/index.ts 的 maskChannel 把空串
// 也掩成占位（`typeof "" === "string"`）→ ③ 客户端剥空串剥不掉占位（值不是空串），原样带回
// → ④ 写面 unmaskChannels 按 id 取回的 `original.channel[field]` 是 undefined，
// `typeof value !== "string"` → 整批被拒，400「新增频道不能提交掩码占位」。
//
// 真实用户路径：设置页新建一条 webhook（落盘只有 url/auth/timeoutSec/enabled，三个密钥键全无）
// → 第一次保存成功 → **只切一下 enabled 开关就再也存不下去**。死锁的是整份配置，不是那一条频道。

describe("空串凭据不被掩码（#1016 缺陷 A）", () => {
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
});

// ---------------------------------------------------------------- #1016 S2：写面按字段合并
//
// 本块逐条钉住「键缺席 = 不动」这条新语义的十个面。每条都是**端到端**的（真实写面 → 真实落盘），
// 因为这条语义横跨两处代码：服务端合并（写面）与客户端手势（diff.ts / index.tsx）；只断一侧，
// 另一侧改坏时用例照样绿。客户端那一半在 test/client-unit/settings-diff.test.ts。
//
// 提交体一律照真实往返链的形态造：从 `GET /config` 的 `effective` 取草稿 → 改一个字段 → 整组
// 提交。凭空手拼的「只交一个键」的提交在真实链路上不存在，而它恰好是旧语义（整组替换）下唯一
// 不会丢字段的那种——用它写判据会把「服务端支持按键合并」这件事测成假。

/** 磁盘上的一条 webhook：url + auth，credential 键按用例再加。 */
const HOOK = {
  type: "webhook",
  id: "webhook:hook",
  url: "https://example.test/hook",
  auth: "none",
  enabled: true,
} as const;

/** 频道数组里按 id 取那一条（两条同类型时不能按类型取——那只会拿到第一条）。 */
function channelById(
  list: readonly RawSettingValue[],
  id: string,
): Record<string, RawSettingValue> {
  const found = (list as ReadonlyArray<Record<string, RawSettingValue>>).find(
    (item) => item.id === id,
  );
  if (found === undefined) throw new Error(`数组里没有 id=${id} 的频道`);
  return found;
}

/** 造一份磁盘：给 channels 的每条补上两条内置条目（真实文件里也有）。 */
function diskOf(...channels: ReadonlyArray<Record<string, RawSettingValue>>): string {
  return JSON.stringify({ channels: [...BUILTINS, ...channels] });
}

/** 提交面：从 effective 取草稿后逐条应用 part（part 里写 null = 用户清空了那个字段）。 */
function submitOf(
  part: (channel: Record<string, RawSettingValue>) => Record<string, RawSettingValue>,
  type = "webhook",
): Array<Record<string, RawSettingValue>> {
  return channelsOf(readSettingsView().effective).map((channel) =>
    channel.type === type ? part(channel) : channel,
  );
}

describe("写面按字段合并：键缺席 = 不动（#1016 S2）", () => {
  // 判据 #1（**安全**）：用户清空 token，磁盘上必须**没有** token 键。
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
});

/**
 * 半坏条目不许把用户锁死在设置页外（#1016 S3 的回归修复，端到端经写面本身）。
 *
 * 上一组走的是纯函数链（磁盘 → 视图 → 客户端 → 合并 → 判据），这一组补上**真落盘**那一段：
 * 用户在设置页上点保存，`writeConfig` 会不会 400。前一段全对而这里 400，用户体感仍然是「设置页坏了」。
 *
 * 半坏条目来自**升级之后手改文件**：0.2.8 的形态清理只在刻度推进时跑一次，救不了这条路
 * （该步的职责见 upgrade/impl/steps/canonical-keys.ts）。
 */
describe("半坏存量条目：保存不被锁死（#1016 S3 回归修复）", () => {
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
});
