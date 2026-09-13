/**
 * dsh-notifier stores 域 status 块 —— 频道投递状态（内存镜像 + debounce 落盘）。
 *
 * 面口径：只经 `stores/interface.ts` 的 `installStores` / `releaseStores` / `recordStatus` /
 * `readStatus`，只伪 `stores/deps.ts` 声明的两个端口；状态存储不读设置（`installStores` 只把
 * `logger` 交给它），故 config 端口给一份默认设置即可。唯一的例外是状态存储自己的重复装配把关：
 * 共用入口先撞上的是历史存储的把关（`installStores` 先装历史），那一条只能直连 impl 的单例。
 *
 * 导入顺序：状态存储是模块级单例，落盘路径在构造时定下，而静态 import 会在任何语句之前求值
 * ——顺序反了，本节全部落盘就写进真实 `~/.dsh`（正在跑的 dsh web 的 home）。impl 单例同样走
 * `await import`，且必须在 `tempDshHome()` 之后。
 *
 * 时间纪律：**需要轮询的用例不钉时钟**。`pollUntil` 的 deadline 读 `Date.now()`，钉住它会让
 * 轮询永不超时，失败用例从「断言红」退化成「60s 挂死」；这类用例改用「记录前后的真实时刻窗口」
 * 断言。断言精确 `lastTs` 的用例只钉时钟读数（`vi.setSystemTime`，不启假定时器）。反过来，
 * 要观测「debounce 窗口走完仍该没写」的用例必须把窗口真走完：它们启假定时器（`toFake` 含
 * `setTimeout`/`clearTimeout`/`Date`，与本仓样本同口径），且不能用 `pollUntil`（它的 `setTimeout`
 * 也被假掉）。
 *
 * 否定判据纪律：假时钟下「有没有调度落盘」用 `vi.getTimerCount()` 判——定时器计数是精确事实，
 * 而「等一小会儿再看文件在不在」在负载下会假绿（写本来就没落地，等多久都看不到，判据却以
 * 「看不到」为通过）。真实 sleep 不作否定判据。
 *
 * 另一个纪律同 history：写队列与 debounce 定时器都挂在模块级实例上，跨用例存活，故每个写入类
 * 用例都要在结束前等到自己的写在磁盘上可见（判据只可能由这一次写产生）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import { STATUS_FILE_NAME, notifierFile } from "../../../src/server/shared/interface.ts";
import type { ChannelStatusEntry } from "../../../src/server/stores/impl/status/type.ts";
import { makeLogger, pollUntil, tempDshHome } from "../../helpers.ts";

const home = tempDshHome();
const statusFile = notifierFile(STATUS_FILE_NAME);
const { installStores, releaseStores, recordStatus, readStatus } =
  await import("../../../src/server/stores/interface.ts");
const { statusStore } = await import("../../../src/server/stores/impl/status/index.ts");

/** 装配一次（状态存储只要日志出口）。 */
function assemble() {
  const logger = makeLogger();
  installStores({ logger, config: { readConfig: () => ({ ...DEFAULT_CONFIG }) } });
  return logger;
}

/** 手写状态文件：模拟上一次运行留下的、或被人改过的那一份。 */
function writeStatusFile(text: string): void {
  mkdirSync(dirname(statusFile), { recursive: true });
  writeFileSync(statusFile, text);
}

/** 磁盘上的状态表；文件不存在或半截时给 undefined（用例只关心「写到了什么」）。 */
function onDisk(): Record<string, ChannelStatusEntry> | undefined {
  try {
    return JSON.parse(readFileSync(statusFile, "utf8")) as Record<string, ChannelStatusEntry>;
  } catch {
    return undefined;
  }
}

beforeEach(() => {
  // recursive：失败面用例会把目标位置占成目录，非递归的 rm 在它上面会直接抛。
  rmSync(statusFile, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
  releaseStores();
});

afterAll(() => {
  home.dispose();
});

describe("内存镜像的读写", () => {
  it("无状态文件：读面给空对象且不落盘（没有文件与没有状态是同一件事）", async () => {
    // 判据是「有没有调度落盘」：定时器计数为 0 是精确事实，而「等一会儿再看文件」在负载下会
    // 假绿（写本来就没落地，等多久都看不到，判据却以「看不到」为通过）。读面若顺带调度或执行
    // 了写，计数与文件两条都会现形。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    assemble();
    expect(await readStatus()).toEqual({});

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(onDisk()).toBeUndefined();
  });

  it("record('ok') → readStatus 往返：lastTs 是投递时刻，成功记录不带 lastError", async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
    assemble();
    recordStatus("bark:phone", "ok");

    const entries = await readStatus();
    expect(Object.keys(entries)).toEqual(["bark:phone"]);
    expect(entries["bark:phone"].lastTs).toBe(new Date(2026, 0, 15, 12, 0, 0).getTime());
    expect(entries["bark:phone"].lastStatus).toBe("ok");
    expect(entries["bark:phone"].failStreak).toBe(0);
    expect("lastError" in entries["bark:phone"]).toBe(false);
  });

  it("同一频道连续记录：失败累加、成功清零并清掉 lastError（条目是覆盖而不是追加，键只有一个）", async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
    assemble();
    recordStatus("bark:phone", "failed", "第一次");
    recordStatus("bark:phone", "failed", "第二次");
    const failed = (await readStatus())["bark:phone"];
    expect(failed.failStreak).toBe(2);
    expect(failed.lastError).toBe("第二次");
    expect(failed.lastStatus).toBe("failed");

    vi.setSystemTime(new Date(2026, 0, 15, 12, 5, 0));
    recordStatus("bark:phone", "ok");
    const entries = await readStatus();
    expect(Object.keys(entries)).toEqual(["bark:phone"]);
    expect(entries["bark:phone"].lastTs).toBe(new Date(2026, 0, 15, 12, 5, 0).getTime());
    expect(entries["bark:phone"].lastStatus).toBe("ok");
    expect(entries["bark:phone"].failStreak).toBe(0);
    expect("lastError" in entries["bark:phone"]).toBe(false);
  });

  it("readStatus 给的是快照：之后再 record 不改动已读到的那一份（调用方拿到的是「读到的那一刻」）", async () => {
    assemble();
    recordStatus("bark:phone", "ok");
    const first = await readStatus();
    recordStatus("bark:phone", "failed");
    expect(first["bark:phone"].lastStatus).toBe("ok");
    expect((await readStatus())["bark:phone"].lastStatus).toBe("failed");
  });

  it("错误摘要截断到 300 字符、空错误不落 lastError（摘要会随 GET /status 出到设置页）", async () => {
    assemble();
    recordStatus("bark:phone", "failed", "x".repeat(400));
    recordStatus("webhook:hook", "failed", "");

    const entries = await readStatus();
    expect(entries["bark:phone"].lastError).toHaveLength(300);
    expect("lastError" in entries["webhook:hook"]).toBe(false);
  });

  it("状态条目上限 64：超出时最旧先出（防已删频道残留键无限累积）", async () => {
    assemble();
    for (let index = 1; index <= 65; index += 1) recordStatus(`bark:${index}`, "ok");

    const entries = await readStatus();
    expect(Object.keys(entries)).toHaveLength(64);
    expect("bark:1" in entries).toBe(false);
    expect("bark:65" in entries).toBe(true);
  });

  // 镜像键序即最近使用序，靠「删了再插」把重记录的键移到表尾。少了这一条，覆盖写与移动写
  // 不可区分——每个键只记一次时两者一模一样，而差别要 64 满员后才显形：常用频道先被淘汰。
  it("重记录把该频道移到最近使用位：淘汰的是最久未记录的", async () => {
    assemble();
    recordStatus("bark:active", "ok");
    for (let index = 1; index <= 63; index += 1) recordStatus(`bark:${index}`, "ok");
    recordStatus("bark:active", "ok");
    recordStatus("bark:1", "ok");
    recordStatus("bark:new", "ok");

    const entries = await readStatus();
    expect(Object.keys(entries)).toHaveLength(64);
    // 重记录救活了 active，最久未记录的 bark:2 顶出去；bark:1 因为刚记过也留了下来。
    expect("bark:active" in entries).toBe(true);
    expect("bark:1" in entries).toBe(true);
    expect("bark:new" in entries).toBe(true);
    expect("bark:2" in entries).toBe(false);
  });

  // `lastError` 是失败那一支的字段：成功记录即使被喂了错误文本也不能带它（它会随 GET /status
  // 出到设置页，变成「上次成功」旁边挂着一条陈旧报错）。
  it("成功记录即使带上错误文本也不落 lastError", async () => {
    assemble();
    recordStatus("bark:phone", "ok", "这条文本不该落盘");

    const entries = await readStatus();
    expect(entries["bark:phone"].lastStatus).toBe("ok");
    expect("lastError" in entries["bark:phone"]).toBe(false);
  });
});

describe("落盘与冷启动", () => {
  it("落盘延后合并但最终一致：文件里是该条目的完整 JSON（设置页重启后仍显示上次投递结果）", async () => {
    const logger = assemble();
    const before = Date.now();
    recordStatus("bark:phone", "failed", "连接超时");
    const after = Date.now();

    await pollUntil(() => onDisk()?.["bark:phone"] !== undefined, "投递状态落盘");
    const stored = onDisk() ?? {};
    expect(Object.keys(stored)).toEqual(["bark:phone"]);
    expect(stored["bark:phone"].lastStatus).toBe("failed");
    expect(stored["bark:phone"].lastError).toBe("连接超时");
    expect(stored["bark:phone"].failStreak).toBe(1);
    expect(stored["bark:phone"].lastTs).toBeGreaterThanOrEqual(before);
    expect(stored["bark:phone"].lastTs).toBeLessThanOrEqual(after);
    // 写成了就不许出声：只看「写坏了要告警」的话，告警写成恒真也绿。
    expect(logger.warns).toEqual([]);
  });

  // debounce 窗口走完后必须把「有待写」放回否，否则调度器被第一次落盘永久卡住：后续投递
  // 一条都写不出去，而界面上的内存镜像照常更新。
  it("第一次落盘不卡住调度器：第二次投递照样落盘", async () => {
    assemble();
    recordStatus("bark:phone", "ok");
    await pollUntil(() => onDisk()?.["bark:phone"] !== undefined, "第一次落盘");

    recordStatus("bark:webhook", "failed", "第二次");
    await pollUntil(() => onDisk()?.["bark:webhook"] !== undefined, "第二次落盘");

    expect(Object.keys(onDisk() ?? {})).toEqual(["bark:phone", "bark:webhook"]);
  });

  it("落盘失败经日志出口告警（record 是 fire-and-forget，没有别的失败出口）", async () => {
    const logger = assemble();
    // 目标位置被目录占住：临时文件写得进去，rename 覆盖不了它。
    mkdirSync(statusFile, { recursive: true });

    recordStatus("bark:phone", "ok");

    await pollUntil(
      () => logger.warns.some((text) => text.includes("投递状态写入失败")),
      "投递状态落盘失败告警",
    );
    expect(logger.warns.join("\n")).toContain("投递状态写入失败");
  });

  it("冷启动从文件同步加载：连续失败计数跨重启延续（异步加载会与 fire-and-forget 的 record 抢跑）", async () => {
    assemble();
    recordStatus("bark:phone", "failed", "连接超时");
    await pollUntil(() => onDisk()?.["bark:phone"] !== undefined, "投递状态落盘");

    releaseStores();
    assemble();
    const loaded = (await readStatus())["bark:phone"];
    expect(loaded.lastStatus).toBe("failed");
    expect(loaded.failStreak).toBe(1);

    recordStatus("bark:phone", "failed");
    expect((await readStatus())["bark:phone"].failStreak).toBe(2);
  });

  // 加载必须由 record 自己发起：只挂在 read 上的话，「重启后没先读一次就直接记失败」会把
  // 计数从 1 退回 1——跨重启延续失效，而外部表现只是「连续失败次数比实际少」。
  it("record 自己先冷启动加载：重启后没读过一次也不丢连续失败计数", async () => {
    assemble();
    recordStatus("bark:phone", "failed", "第一次");
    await pollUntil(() => onDisk()?.["bark:phone"] !== undefined, "投递状态落盘");

    releaseStores();
    assemble();
    recordStatus("bark:phone", "failed");

    expect((await readStatus())["bark:phone"].failStreak).toBe(2);
  });

  it("状态文件坏掉：读面给空对象而不是抛（半截 JSON 由下一次落盘覆盖修好）", async () => {
    writeStatusFile("{ 半截");
    assemble();
    expect(await readStatus()).toEqual({});
  });

  it("只收看起来像状态条目的项：陌生形态与半截值丢掉、其余照读（磁盘内容不受契约约束）", async () => {
    writeStatusFile(
      JSON.stringify({
        good: { lastTs: 1, lastStatus: "ok", failStreak: 0 },
        noTs: { lastStatus: "ok", failStreak: 0 },
        scalar: "oops",
        nullish: null,
      }),
    );
    assemble();
    expect(Object.keys(await readStatus())).toEqual(["good"]);
  });

  // null 排在前面时，`entry !== null` 一旦写反成恒真就成了「读到 null 当场抛」——整份状态被
  // 半截吃掉，而 good 排在后面时这个错法完全看不出来（前面已经装进镜像，抛在 catch 里被吞）。
  it("陌生条目丢掉但后面的照读：null 排在前面时不得把整份状态吃掉", async () => {
    writeStatusFile(
      JSON.stringify({
        nullish: null,
        scalar: "oops",
        good: { lastTs: 1, lastStatus: "ok", failStreak: 0 },
      }),
    );
    assemble();
    expect(Object.keys(await readStatus())).toEqual(["good"]);
  });

  it("releaseStores 丢掉内存镜像与待写定时器：没落盘的状态不会被下一次装配继承", async () => {
    // 「定时器被丢掉了」用计数判：record 之后计数必须是 1，release 之后必须是 0——只看
    // 「等一会文件还没出现」的话，写本来就没落地时也绿（判据被弱化成与实现无关）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    assemble();
    recordStatus("bark:phone", "ok");
    // 窗口内第二次投递仍只有一个待写定时器：debounce 的「合并成一次整文件写」就是这一点。
    recordStatus("bark:webhook", "failed");
    expect(vi.getTimerCount()).toBe(1);

    releaseStores();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(600);
    expect(onDisk()).toBeUndefined();

    assemble();
    expect(await readStatus()).toEqual({});
  });

  // 共用装配面先装历史存储，重复装配时先撞上的是它的把关；状态存储自己的那一条只能直连单例。
  it("状态存储自己拦截重复装配并说清身份", () => {
    const deps = { logger: makeLogger() };
    statusStore.install(deps);

    expect(() => statusStore.install(deps)).toThrow("dsh-notifier: 投递状态只能装配一次");
  });

  it("重复装配当场抛错、release 幂等且之后可再装配（两个存储都是单例，重复调用是编程错误）", () => {
    assemble();
    expect(() => assemble()).toThrow(/只能装配一次/u);
    releaseStores();
    expect(() => releaseStores()).not.toThrow();
    assemble();
  });
});
