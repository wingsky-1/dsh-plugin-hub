/**
 * dsh-notifier stores 域 status 块 —— 频道投递状态（内存镜像 + debounce 落盘）。
 *
 * 面口径：只经 `stores/interface.ts` 的 `installStores` / `releaseStores` / `recordStatus` /
 * `readStatus`，只伪 `stores/deps.ts` 声明的两个端口；状态存储不读设置（`installStores` 只把
 * `logger` 交给它），故 config 端口给一份默认设置即可。
 *
 * 导入顺序：状态存储是模块级单例，落盘路径在构造时定下，而静态 import 会在任何语句之前求值
 * ——顺序反了，本节全部落盘就写进真实 `~/.dsh`（正在跑的 dsh web 的 home）。
 *
 * 时间纪律：**需要轮询的用例不钉时钟**。`pollUntil` 的 deadline 读 `Date.now()`，钉住它会让
 * 轮询永不超时，失败用例从「断言红」退化成「60s 挂死」；这类用例改用「记录前后的真实时刻窗口」
 * 断言。断言精确 `lastTs` 的用例只钉时钟读数（`vi.setSystemTime`，不启假定时器）。反过来，
 * 要观测「debounce 窗口走完仍该没写」的用例必须把窗口真走完：它们启假定时器（`toFake` 只含
 * `setTimeout`/`clearTimeout`，`Date.now()` 与 `setImmediate` 仍是真实的），排水改用
 * `realSetTimeout`，且不能用 `pollUntil`（它的 `setTimeout` 也被假掉）。
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

/**
 * 模块加载时抓下的真实定时器：`vi.useFakeTimers` 只替换全局实现，这份引用不受影响。用于
 * 「假时钟下仍要等真实 I/O」——原子写是 mkdir → writeFile → rename 三次线程池往返，靠
 * `setImmediate` 数圈排水只是碰运气（负载下一圈可能瞬间跑完而写还没落地）。
 */
const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  rmSync(statusFile, { force: true });
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
    // 读面不得有落盘副作用。只看「读完之后文件在不在」抓不到排队中的写（落盘经 debounce
    // 与写队列），故把窗口也走完再断言，读面若顺带调度或执行了写就现形。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    assemble();
    expect(await readStatus()).toEqual({});

    await vi.advanceTimersByTimeAsync(600);
    await new Promise((resolve) => realSetTimeout(resolve, 100));
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
});

describe("落盘与冷启动", () => {
  it("落盘延后合并但最终一致：文件里是该条目的完整 JSON（设置页重启后仍显示上次投递结果）", async () => {
    assemble();
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

  it("releaseStores 丢掉内存镜像与待写定时器：没落盘的状态不会被下一次装配继承", async () => {
    // 落盘是 500ms debounce：record 之后立刻看文件，「现在还没写」与「定时器被丢掉了」无法
    // 区分（删掉 clearPendingFlush 也不红）。这里钉住 setTimeout 把窗口真走完，再用真实定时器
    // 等落盘队列排空；本用例因此不能用 pollUntil（它的 setTimeout 也被假掉了）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    assemble();
    recordStatus("bark:phone", "ok");
    releaseStores();

    await vi.advanceTimersByTimeAsync(600);
    await new Promise((resolve) => realSetTimeout(resolve, 100));
    expect(onDisk()).toBeUndefined();

    assemble();
    expect(await readStatus()).toEqual({});
  });

  it("重复装配当场抛错、release 幂等且之后可再装配（两个存储都是单例，重复调用是编程错误）", () => {
    assemble();
    expect(() => assemble()).toThrow(/只能装配一次/u);
    releaseStores();
    expect(() => releaseStores()).not.toThrow();
    assemble();
  });
});
