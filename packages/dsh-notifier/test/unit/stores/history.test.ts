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
 *
 * 失败出口纪律：写入是 fire-and-forget，没有 Promise 的接收方，日志出口是**唯一**能观测失败的地方。
 * 故「写坏了要出声」与「写成了不许出声」两条都要有：只判前者，把 `!written.ok` 写反成恒真也绿。
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
  // recursive：下面的失败面用例会把目标位置占成目录，非递归的 rm 在它上面会直接抛。
  rmSync(historyFile, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
  releaseStores();
});

afterAll(() => {
  home.dispose();
});

describe("装配的哨兵", () => {
  // 两个存储共用 `installStores` 一个入口，宽判据（/只能装配一次/）在历史这一侧被整段短路时也会绿。
  it("重复装配当场抛错并说清是哪个存储拒绝的", () => {
    assemble();
    expect(() => assemble()).toThrow("dsh-notifier: 历史存储只能装配一次");
  });

  // 占位不是「默认设置」：未装配时读历史必须当场暴露，静默按默认天数清理会让用户改过的设置失效。
  it("未装配就读历史：当场抛错而不是静默回落默认值", async () => {
    writeHistoryFile('{"ts":1,"kind":"done","title":"旧","message":"正文"}');
    releaseStores();

    await expect(readHistory()).rejects.toThrow("dsh-notifier: 历史存储尚未装配");
  });
});

describe("读取语义", () => {
  it("无历史文件：读面给空数组、清空给 0 条（「没有文件」与「没有记录」是同一件事，不是错误）", async () => {
    assemble();
    expect(await readHistory()).toEqual([]);
    expect(await clearHistory()).toBe(0);
  });

  it("append → read 往返：可选字段随行落盘并读回（字段丢了界面上就少一列）", async () => {
    const logger = assemble();
    const written = entry({
      kind: "demo:report",
      suppressed: "quiet",
      channels: [{ channelId: "bark:phone", status: "failed", reason: "timeout" }],
    });
    appendHistory(written);
    await pollUntil(() => lines().some((line) => line.includes("demo:report")), "历史记录落盘");

    // 写成了就不许出声：只看「写坏了要告警」的话，告警写成恒真也绿。
    expect(logger.warns).toEqual([]);
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

  // 判据是「读不出来不等于过期」：非数值 ts 一律不过滤。少了这一条，把 `typeof ts === "number"`
  // 短路成 true（或把前两个 `&&` 写反）都绿——因为现有脏行用例里的 ts 恰好是 undefined。
  it("非数值 ts 的脏行不过滤：字符串时刻按「读不出来」放行", async () => {
    const now = Date.now();
    keepDays = 1;
    writeHistoryFile(
      [
        '{"ts":"0","kind":"done","title":"字符串时刻","message":"正文"}',
        JSON.stringify(entry({ ts: now - 3 * DAY_MS, title: "三天前" })),
      ].join("\n"),
    );
    assemble();

    expect((await readHistory()).map((record) => record.title)).toEqual(["字符串时刻"]);
  });

  it("保留天数为 0 时读侧不按 ts 过滤：时间戳为负的脏行也原样交出（0 是「不按天清理」而不是「全清」）", async () => {
    writeHistoryFile('{"ts":-1,"kind":"done","title":"负时刻","message":"正文"}');
    assemble();

    expect((await readHistory()).map((record) => record.title)).toEqual(["负时刻"]);
  });

  it("恰好落在保留期边界上的记录保留（过滤是「早于截止点」而不是「早于等于」）", async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
    const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
    keepDays = 1;
    writeHistoryFile(
      [
        JSON.stringify(entry({ ts: now - DAY_MS, title: "恰好在边界" })),
        JSON.stringify(entry({ ts: now - DAY_MS - 1, title: "早一毫秒" })),
      ].join("\n"),
    );
    assemble();

    expect((await readHistory()).map((record) => record.title)).toEqual(["恰好在边界"]);
  });

  // 解析量必须有上界：整个文件都解析一遍的代价随文件无限增长，窗口就是它的上界。
  it("读侧的解析窗口是尾部 400 行：窗口之外的行即使有效也不参与", async () => {
    const now = Date.now();
    keepDays = 1;
    const expired = JSON.stringify(entry({ ts: now - 3 * DAY_MS, title: "三天前" }));
    writeHistoryFile(
      [
        JSON.stringify(entry({ ts: now - 3_600_000, title: "一小时前" })),
        ...Array.from({ length: 400 }, () => expired),
      ].join("\n"),
    );
    assemble();

    expect(await readHistory()).toEqual([]);
  });

  // 手改文件留下的空行同样占窗口：空行不剔除时，一串空行能把有效记录整段挤出窗口。
  it("空行不占读侧窗口：一串空行不会把有效记录挤出去", async () => {
    const now = Date.now();
    const fresh = Array.from({ length: 200 }, (_, index) =>
      JSON.stringify(entry({ ts: now - index, title: `第${index + 1}条` })),
    );
    writeHistoryFile(`${fresh.join("\n")}\n${"\n".repeat(400)}`);
    assemble();

    const records = await readHistory();
    expect(records).toHaveLength(200);
    expect(records[0]?.title).toBe("第1条");
    expect(records.at(-1)?.title).toBe("第200条");
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
    const logger = assemble();
    writeHistoryFile(
      `${[JSON.stringify(entry({ title: "a" })), JSON.stringify(entry({ title: "b" }))].join("\n")}\n`,
    );
    expect(await clearHistory()).toBe(2);
    expect(await readHistory()).toEqual([]);
    expect(readFileSync(historyFile, "utf8")).toBe("");
    // 文件末尾那个换行不是一条记录；写成了也不许出声。
    expect(logger.warns).toEqual([]);
  });

  // 截断阈值是两倍上限（400 行）而不是上限本身：判据落在「不到两倍时一个字都不动」上，
  // `> 400` 写成 `>= 400`、写成 `* 2` 的一半、写成恒真，三种都在这里现形。
  it("写侧截断的阈值是 400 行：不到两倍上限时一个字都不动", async () => {
    writeHistoryFile(
      `${Array.from({ length: 399 }, (_, index) =>
        JSON.stringify(entry({ ts: index + 1, title: `第${index + 1}条` })),
      ).join("\n")}\n`,
    );
    assemble();
    appendHistory(entry({ ts: 9_999, title: "最新" }));
    await pollUntil(() => (lines().at(-1) ?? "").includes("最新"), "第 400 行落盘");

    expect(lines()).toHaveLength(400);
    expect(lines()[0]).toContain("第1条");
  });

  // 写侧与读侧必须用同一个边界：边界写成 `>`（含端点变不含）只差一条记录，而它是用户
  // 「保留一天」时正好活到第 24 小时的那条。非数值 ts 则一律按「读不出来」清掉。
  it("写侧清理的保留期含端点，且非数值 ts 不算在期内（两侧同一刻度）", async () => {
    keepDays = 1;
    const now = Date.now();
    writeHistoryFile(
      [
        JSON.stringify(entry({ ts: now - DAY_MS, title: "恰好在边界" })),
        '{"ts":"99999999999999","kind":"done","title":"字符串时刻","message":"正文"}',
        JSON.stringify(entry({ ts: now - 3 * DAY_MS, title: "三天前" })),
      ].join("\n"),
    );
    assemble();
    appendHistory(entry({ ts: now, title: "刚写的" }));
    await pollUntil(() => {
      const text = lines().join("\n");
      return text.includes("刚写的") && !text.includes("三天前");
    }, "写侧清理落盘");

    const text = lines().join("\n");
    expect(text).toContain("恰好在边界");
    expect(text).not.toContain("字符串时刻");
    expect(lines()).toHaveLength(2);
  });

  // 追加不能改写已有行的形态：旧文件以换行结尾时再追加，中间多出一个空行就是「写坏了」。
  it("追加保留旧文件的末尾形态：以换行结尾的文件不写进空行", async () => {
    const first = entry({ ts: 1, title: "旧" });
    const second = entry({ ts: 2, title: "新" });
    writeHistoryFile(`${JSON.stringify(first)}\n`);
    assemble();
    appendHistory(second);
    await pollUntil(() => lines().length === 2, "追加落盘");

    expect(readFileSync(historyFile, "utf8")).toBe(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
    );
  });
});

describe("写入失败的唯一出口", () => {
  it("历史落盘失败经日志出口告警（append 是 fire-and-forget，没有 Promise 的接收方）", async () => {
    const logger = assemble();
    // 目标位置被目录占住：临时文件写得进去，rename 覆盖不了它。
    mkdirSync(historyFile, { recursive: true });

    appendHistory(entry({ title: "写不进去" }));

    await pollUntil(
      () => logger.warns.some((text) => text.includes("历史记录写入失败")),
      "历史落盘失败告警",
    );
    expect(logger.warns.join("\n")).toContain("历史记录写入失败");
  });

  it("写入链路的异常也经同一个出口报出并带上原因（这条链上没有别的地方能接住它）", async () => {
    const logger = makeLogger();
    installStores({
      logger,
      config: {
        readConfig: () => {
          throw new Error("设置读不出来");
        },
      },
    });

    appendHistory(entry({ title: "写不进去" }));

    await pollUntil(
      () => logger.warns.some((text) => text.includes("历史记录写入失败")),
      "写入链路异常告警",
    );
    expect(logger.warns.join("\n")).toContain("设置读不出来");
  });

  it("清空落盘失败经日志出口告警，条数照常返回（失败的是落盘，不是清空动作本身）", async () => {
    const logger = assemble();
    mkdirSync(historyFile, { recursive: true });

    expect(await clearHistory()).toBe(0);
    await pollUntil(
      () => logger.warns.some((text) => text.includes("清空历史失败")),
      "清空落盘失败告警",
    );
    expect(logger.warns.join("\n")).toContain("清空历史失败");
  });
});
