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
import { makeLogger, tempDshHome } from "../../helpers.ts";

const home = tempDshHome();
const configFile = notifierFile(CONFIG_FILE_NAME);
const { installConfig, releaseConfig, readConfig, readSettingsView, writeConfig } =
  await import("../../../src/server/config/interface.ts");

/** 掩码占位：设置页把用户没改动的凭据原样提交回来，两侧字面量必须一致。 */
const MASK = "********";

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

  it("装配期同步读完文件：读面与用户层都已是文件里的值（旧形 start/end 经 legacy 回落读成 windows[0]）", () => {
    writeConfigFile(
      '{"notifyAsk":false,"quietHours":{"enabled":true,"start":"23:00","end":"07:00"}}',
    );
    assemble();
    expect(readConfig().notifyAsk).toBe(false);
    expect(readConfig().quietHours.enabled).toBe(true);
    expect(readConfig().quietHours.windows).toEqual([{ start: "23:00", end: "07:00" }]);
    expect(readSettingsView().user.notifyAsk).toBe(false);
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

  it("新增频道提交掩码占位：判非法并指向 channels（掩码只表达「未修改」，新实例没有原值）", async () => {
    assemble();
    const error = invalidOf(
      await writeConfig({
        channels: [{ type: "bark", id: "bark:new", baseUrl: "https://x", deviceKey: MASK }],
      }),
    );
    expect(error.key).toBe("channels");
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

  it("提交里契约不认识的键原样写回文件（抹掉它们属于静默破坏）", async () => {
    assemble();
    const result = await writeConfig({ futureFlag: true } as unknown as SettingsPatch);
    expect(result.ok).toBe(true);
    expect(onDisk().futureFlag).toBe(true);
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
