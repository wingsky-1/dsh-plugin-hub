/**
 * dsh-notifier stores 域 history 块 —— 通知历史（jsonl）的读写面。
 *
 * 面口径：只经 `stores/interface.ts` 的 `installStores` / `releaseStores` / `appendHistory` /
 * `readHistory` / `clearHistory`，只伪 `stores/deps.ts` 声明的两个端口（`logger` 与 `config`）。
 * 保留天数由伪端口给，且**每次调用现取**——真实装配里它来自 config 域的读面，装配期取快照会让
 * 用户改设置后不生效（症状是「历史清理不按设置来」）。
 *
 * 导入顺序与时间纪律见下两处注释：前者关系到落盘是否进隔离目录，后者关系到用例失败时是干净红
 * 还是 60s 超时。
 *
 * 写队列纪律：写队列是**模块级实例字段**，跨用例存活且 `releaseStores()` 不清它。故每个写入类
 * 用例都必须在结束前等到自己的写在磁盘上可见——判据要选「只可能由这一次写产生」的那个，否则
 * 在飞的写会与下一个用例的 `beforeEach` 清文件抢同一个路径（症状是下一个用例读到多出来的行）。
 *
 * 时间纪律：**不钉系统时钟**。两条 cutoff 的两侧都相对 `Date.now()` 取刻（读侧基准是「现在」、
 * 写侧基准是本次写入的 `ts`），用例一律留一小时以上的余量，于是不需要伪造时钟；反过来更要紧
 * ——`pollUntil` 的 deadline 读 `Date.now()`，钉住时钟会让它永不超时，失败用例会从「断言红」
 * 退化成「60s 挂死」。需要精确期望值的读侧用例另走 `vi.setSystemTime`，且它不轮询。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import { HISTORY_FILE_NAME, notifierFile } from "../../../src/server/shared/interface.ts";
import type { HistoryEntry } from "../../../src/server/stores/impl/history/type.ts";
import { makeLogger, pollUntil, tempDshHome } from "../../helpers.ts";

// DSH_HOME 必须先于被测模块导入：历史存储是模块级单例，落盘路径在构造时定下，而静态 import
// 会在任何语句之前求值——顺序反了，本节全部落盘就写进真实 `~/.dsh`（正在跑的 dsh web 的 home）。
const home = tempDshHome();
const historyFile = notifierFile(HISTORY_FILE_NAME);
const { installStores, releaseStores, appendHistory, readHistory, clearHistory } =
  await import("../../../src/server/stores/interface.ts");

/** 一天的毫秒数：源码与用例各写一份（抄源码就等于恒真）。 */
const DAY_MS = 86_400_000;

/** 保留天数：用例中途改它，验证读侧与写侧都是「现取」。 */
let keepDays = 0;

/** 装配一次：保留天数走伪 config 端口，日志走夹具。 */
function assemble() {
  const logger = makeLogger();
  installStores({
    logger,
    config: { readConfig: () => ({ ...DEFAULT_CONFIG, historyMaxAgeDays: keepDays }) },
  });
  return logger;
}

/** 造一条记录：`over` 只覆盖本次关心的字段。 */
function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return { ts: Date.now(), kind: "done", title: "标题", message: "正文", ...over };
}

/** 手写历史文件：模拟上一次运行留下的、或被人改过的 jsonl。 */
function writeHistoryFile(text: string): void {
  mkdirSync(dirname(historyFile), { recursive: true });
  writeFileSync(historyFile, text);
}

/** 文件里的非空行：写侧清理与滚动截断只能从磁盘上看出来。 */
function lines(): string[] {
  try {
    return readFileSync(historyFile, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

beforeEach(() => {
  keepDays = 0;
  rmSync(historyFile, { force: true });
});

afterEach(() => {
  vi.useRealTimers();
  releaseStores();
});

afterAll(() => {
  home.dispose();
});

describe("读取语义", () => {
  it("无历史文件：读面给空数组、清空给 0 条（「没有文件」与「没有记录」是同一件事，不是错误）", async () => {
    assemble();
    expect(await readHistory()).toEqual([]);
    expect(await clearHistory()).toBe(0);
  });

  it("append → read 往返：可选字段随行落盘并读回（字段丢了界面上就少一列）", async () => {
    assemble();
    const written = entry({
      kind: "demo:report",
      suppressed: "quiet",
      channels: [{ channelId: "bark:phone", status: "failed", reason: "timeout" }],
    });
    appendHistory(written);
    await pollUntil(() => lines().some((line) => line.includes("demo:report")), "历史记录落盘");

    const records = await readHistory();
    expect(records).toHaveLength(1);
    expect(records[0].ts).toBe(written.ts);
    expect(records[0].kind).toBe("demo:report");
    expect(records[0].title).toBe("标题");
    expect(records[0].message).toBe("正文");
    expect(records[0].suppressed).toBe("quiet");
    expect(records[0].channels?.[0]?.channelId).toBe("bark:phone");
    expect(records[0].channels?.[0]?.reason).toBe("timeout");
  });

  it("连续 append 不互相覆盖、顺序保持（写队列串行化的唯一理由：并发「读-改-写」会丢记录）", async () => {
    assemble();
    // 三次调用之间不 await：append 本就是 fire-and-forget，靠队列串行。
    appendHistory(entry({ title: "第一条" }));
    appendHistory(entry({ title: "第二条" }));
    appendHistory(entry({ title: "第三条" }));
    await pollUntil(() => lines().length === 3, "三条记录落盘");

    expect((await readHistory()).map((record) => record.title)).toEqual([
      "第一条",
      "第二条",
      "第三条",
    ]);
  });

  it("损坏行跳过而不是整份读取失败（坏行是常态：一行坏掉不该让历史整页空白）", async () => {
    writeHistoryFile(
      [
        JSON.stringify(entry({ title: "好的-1" })),
        "{oops",
        '"just a string"',
        "123",
        "null",
        "",
        JSON.stringify(entry({ title: "好的-2" })),
      ].join("\n"),
    );
    assemble();
    expect((await readHistory()).map((record) => record.title)).toEqual(["好的-1", "好的-2"]);
  });

  it("读侧只交出最近 200 条（手改文件绕过写侧时，上限仍由读面兜住）", async () => {
    writeHistoryFile(
      Array.from({ length: 250 }, (_, index) =>
        JSON.stringify(entry({ ts: index + 1, title: `第${index + 1}条` })),
      ).join("\n"),
    );
    assemble();
    const records = await readHistory();
    expect(records).toHaveLength(200);
    expect(records[0].title).toBe("第51条");
    expect(records[199].title).toBe("第250条");
  });

  it("读侧按天过滤以「现在」为基准：调小保留天数后旧记录立刻不可见（不必等下一次写入顺手清理）", async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
    const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
    keepDays = 1;
    writeHistoryFile(
      [
        JSON.stringify(entry({ ts: now - 3 * DAY_MS, title: "三天前" })),
        JSON.stringify(entry({ ts: now - 3_600_000, title: "一小时前" })),
        JSON.stringify({ kind: "done", title: "无 ts", message: "正文" }),
      ].join("\n"),
    );
    assemble();

    expect((await readHistory()).map((record) => record.title)).toEqual(["一小时前", "无 ts"]);
    // 保留天数每次现取：改成 0（只按行数滚动）后同一批记录立刻全部可见。
    keepDays = 0;
    expect(await readHistory()).toHaveLength(3);
  });
});

describe("写入侧的清理与截断", () => {
  it("按天清理以本次写入的 ts 为基准：过期行删除、坏行保守保留（「读不出来」不等于「过期」）", async () => {
    keepDays = 1;
    const now = Date.now();
    writeHistoryFile(
      [
        JSON.stringify(entry({ ts: now - 3 * DAY_MS, title: "三天前" })),
        "{oops",
        JSON.stringify(entry({ ts: now - 3_600_000, title: "一小时前" })),
      ].join("\n"),
    );
    assemble();
    appendHistory(entry({ ts: now, title: "刚写的" }));
    // 判据必须**只可能由这一次写产生**：写队列是模块级实例字段、跨用例存活，等到「没有过期的」
    // 才说明在飞的那次写落了盘；等一个旧文件也满足的条件，会把在飞的写留给下一个用例。
    await pollUntil(() => {
      const text = lines().join("\n");
      return text.includes("刚写的") && !text.includes("三天前");
    }, "写侧清理与追加落盘");

    expect(lines()).toHaveLength(3);
    expect(lines()).toContain("{oops");
    expect((await readHistory()).map((record) => record.title)).toEqual(["一小时前", "刚写的"]);
  });

  it("行数超过两倍上限时只留最近 200 条（写是唯一能减少行数的时机）", async () => {
    writeHistoryFile(
      Array.from({ length: 500 }, (_, index) =>
        JSON.stringify(entry({ ts: index + 1, title: `第${index + 1}条` })),
      ).join("\n"),
    );
    assemble();
    appendHistory(entry({ ts: 9_999, title: "最新" }));
    await pollUntil(
      () => lines().length === 200 && (lines().at(-1) ?? "").includes("最新"),
      "写侧截断到 200 行",
    );

    const records = await readHistory();
    expect(records).toHaveLength(200);
    expect(records[0].title).toBe("第302条");
    expect(records[199].title).toBe("最新");
  });

  it("clearHistory 返回被清空条数并让读面变空（清空是不可逆动作，条数要能对上）", async () => {
    writeHistoryFile(
      [JSON.stringify(entry({ title: "a" })), JSON.stringify(entry({ title: "b" }))].join("\n"),
    );
    assemble();
    expect(await clearHistory()).toBe(2);
    expect(await readHistory()).toEqual([]);
    expect(readFileSync(historyFile, "utf8")).toBe("");
  });
});
