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
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * 在存储目录只读（0o555）的条件下跑一次写，并**必定**把写位还回去。
 *
 * 为什么需要它：把历史文件的位置占成目录只能造出「写不进去」，同时那份文件也读不出来——
 * 于是「写失败但读面照旧」这一条无从证明。只读目录把两件事分开：读得动、建不了新文件，
 * 而原子写必须先在同目录落一个临时名，故必然 EACCES。
 *
 * 还权限走 finally：目录保持只读时，下一条用例的 beforeEach 清不掉文件，临时名也会留在里面。
 */
async function withReadOnlyStorageDir<T>(task: () => Promise<T>): Promise<T> {
  const dir = dirname(historyFile);
  chmodSync(dir, 0o555);
  try {
    return await task();
  } finally {
    chmodSync(dir, 0o700);
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
    expect(await clearHistory()).toEqual({ ok: true, removed: 0 });
  });

  it("append → read 往返：可选字段随行落盘并读回（字段丢了界面上就少一列）", async () => {
    const logger = assemble();
    const written = entry({
      kind: "demo:report",
      suppressed: "quiet",
      channels: [
        {
          channelId: "bark:phone",
          status: "failed",
          reason: { code: "reasonBarkRequestFailed", detail: "timeout" },
        },
      ],
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
    expect(records[0].channels?.[0]?.reason).toEqual({
      code: "reasonBarkRequestFailed",
      detail: "timeout",
    });
  });

  // 升级前的行存的是散文。读面必须把它收编成结构化理由，否则客户端要为「同一字段两种形态」
  // 各写一遍渲染，而任何一处漏判都会让界面显示 undefined。
  it("旧行（reason 是散文）读回时收编成 reasonLegacy + detail：客户端只认一种形态", async () => {
    assemble();
    writeHistoryFile(
      `${JSON.stringify({
        ts: Date.now(),
        kind: "done",
        title: "旧",
        message: "正文",
        channels: [{ channelId: "bark:phone", status: "failed", reason: "timeout" }],
      })}\n`,
    );

    const records = await readHistory();
    expect(records).toHaveLength(1);
    expect(records[0].channels?.[0]?.reason).toEqual({
      code: "reasonLegacy",
      detail: "timeout",
    });
  });

  // 值域校验分两层：`status` 是判据，值域外整条丢；`reason` 只是解释，读不出就只丢解释，
  // 明细本身仍然如实交出去（把一条真发生过的失败整条抹掉，比少一句解释糟得多）。
  it("读面校验值域：陌生 status 整条丢，读不出 code 的理由只丢理由", async () => {
    assemble();
    writeHistoryFile(
      `${JSON.stringify({
        ts: Date.now(),
        kind: "done",
        title: "旧",
        message: "正文",
        channels: [
          { channelId: "bark:phone", status: "unknown" },
          { channelId: "bark:other", status: "failed", reason: { noCode: true } },
          { channelId: "bark:ok", status: "ok" },
        ],
      })}\n`,
    );

    const records = await readHistory();
    expect(records[0].channels).toEqual([
      { channelId: "bark:other", status: "failed" },
      { channelId: "bark:ok", status: "ok" },
    ]);
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

  it("clearHistory 回 `{ok, removed}` 并让读面变空（清空是不可逆动作，条数要能对上）", async () => {
    const logger = assemble();
    writeHistoryFile(
      `${[JSON.stringify(entry({ title: "a" })), JSON.stringify(entry({ title: "b" }))].join("\n")}\n`,
    );
    expect(await clearHistory()).toEqual({ ok: true, removed: 2 });
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

  // 落盘失败必须让调用方**看得见**：返回裸条数时端点只能答 200，界面提示「已清空 N 条」而文件
  // 纹丝未动，刷新后旧记录全在（#1016 残留 1）。返回值与告警是两个出口，这条只钉前者、下面那条只钉后者。
  it("清空落盘失败回 `unavailable` 而不是条数：端点据此答 503，界面不提示假成功", async () => {
    const logger = assemble();
    mkdirSync(historyFile, { recursive: true });

    expect(await clearHistory()).toEqual({ ok: false, reason: "unavailable" });
    await pollUntil(
      () => logger.warns.some((text) => text.includes("清空历史失败")),
      "清空落盘失败告警",
    );
    expect(logger.warns.join("\n")).toContain("清空历史失败");
  });

  // 「写不进去」与「读不出来」必须能分开制造，否则上面那条只能证明「目录占位时写失败」，
  // 证明不了「写失败时读面照旧」。只读目录（0o555）正是这个形状：读得动、建不了新文件，
  // 而原子写要先在同目录建临时名 → EACCES。Windows 的 chmod 不约束写入，故跳过。
  it.skipIf(process.platform === "win32")(
    "清空写失败时磁盘上的旧记录一条不少、读面照旧（写没成就不该毁数据）",
    async () => {
      assemble();
      const stored = `${[JSON.stringify(entry({ title: "a" })), JSON.stringify(entry({ title: "b" }))].join("\n")}\n`;
      writeHistoryFile(stored);

      expect(await withReadOnlyStorageDir(clearHistory)).toEqual({
        ok: false,
        reason: "unavailable",
      });

      expect(readFileSync(historyFile, "utf8")).toBe(stored);
      expect((await readHistory()).map((record) => record.title)).toEqual(["a", "b"]);
    },
  );

  // 失败态**不带原因**：`written.reason` 是 Node 的错误消息，形态是「EACCES: permission denied,
  // open '/…/history.jsonl.tmp-…'」，端点一旦带出去就等于把宿主绝对路径交给浏览器。诊断走日志出口，
  // 返回值只回答「成没成」。用只读目录排故障：那里才真的有一条带路径的错误消息可漏。
  it.skipIf(process.platform === "win32")(
    "清空写失败的返回值里没有 errno 与绝对路径（原因只许进日志出口）",
    async () => {
      const logger = assemble();
      writeHistoryFile(`${JSON.stringify(entry({ title: "a" }))}\n`);

      const outcome = await withReadOnlyStorageDir(clearHistory);

      // 前提：这条用例排的故障真的产出了一条带路径的错误消息，否则下面的断言是恒真。
      expect(logger.warns.join("\n")).toContain(dirname(historyFile));
      // 逐键 + 逐字符双钉：多带一个字段、或把错误消息塞进 reason/hint，这条都红。
      expect(Object.keys(outcome).sort()).toEqual(["ok", "reason"]);
      expect(JSON.stringify(outcome)).not.toContain("/");
      expect(JSON.stringify(outcome)).not.toContain("EACCES");
    },
  );
});

/**
 * 写队列的次序（#1016 残留 1）。append 与 clear 共用一条队列，故「谁先谁后」由入队次序决定、
 * 与 fs 调度无关：清空排在队列外时它会与在飞的 append 抢同一个文件，那一次 append 拿它读到的旧行
 * 把整段旧记录原样写回，用户刷新后记录全在。这一组钉的就是「次序由入队决定」这件事。
 */
describe("写队列的次序", () => {
  // 钉的是**终态**而不是某一次内部调用的顺序：终态在正确实现下与调度无关（队列里次序唯一），
  // 反而在「清空不进队列」的实现下随 rename 先后漂移——那样的实现压根给不出稳定答案。
  it("append → clear → append 的次序确定：清空前那条不复活，清空后那条活下来", async () => {
    assemble();
    appendHistory(entry({ title: "清空前" }));
    const clearing = clearHistory();
    appendHistory(entry({ title: "清空后" }));

    // 条数是 1 而不是 0：清空跑在第一次追加**之后**，它数到的正是刚落盘的那条。
    expect(await clearing).toEqual({ ok: true, removed: 1 });
    await pollUntil(() => lines().length === 1, "清空后的那条落盘");

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("清空后");
    expect((await readHistory()).map((record) => record.title)).toEqual(["清空后"]);
  });

  // 并发的两次清空：后一条排在队尾，所以它是「最后一次动作」。钉终态（磁盘空 + 读面空）而不是
  // 两次调用的条数——条数只说明各自数到了什么，终态才说明「复活」这件事有没有发生。
  it("两次清空之间夹的追加不会被后一条清空复活：后一条的终态是磁盘空", async () => {
    assemble();
    appendHistory(entry({ title: "夹在中间" }));
    const first = clearHistory();
    appendHistory(entry({ title: "第一次清空后" }));
    const second = clearHistory();

    expect(await first).toEqual({ ok: true, removed: 1 });
    expect(await second).toEqual({ ok: true, removed: 1 });
    // 第二次的 promise 落地即它的 rename 落地（写队列在它内部 await 过），故这里不需要轮询。
    expect(lines()).toEqual([]);
    expect(await readHistory()).toEqual([]);
  });

  // 队列护栏（`enqueue` 的第 2 点）：让**兜底之外**的那次抛出真的发生一次，再断紧随其后的 append
  // 仍然落盘——判据落在「队列有没有被这次 rejection 污染」上，而不是落在「抛没抛」上。
  // 告警出口是 `clearTask` 里唯一能抛的现实路径（读侧包着 try/catch，原子写返回 `{ok,reason}`），
  // 故用它注入：写失败 → 走到 `deps.logger.warn` → 该行抛出。
  //
  // 夹具的排法讲究顺序：先占成目录让清空写失败，等那次清空**真的抛完**再把位置腾出来；反过来的话
  // 下面的 append 也会写不成功，判据就退化成「写失败时不写」。
  it("清空的 task 抛错后，紧随其后的 append 仍然落盘（队列不被这次 rejection 污染）", async () => {
    const warns: string[] = [];
    let armed = true;
    installStores({
      logger: {
        warn: (message: string) => {
          warns.push(message);
          if (armed) {
            armed = false;
            throw new Error("注入的告警出口故障");
          }
        },
      },
      config: { readConfig: () => ({ ...DEFAULT_CONFIG, historyMaxAgeDays: keepDays }) },
    });
    mkdirSync(historyFile, { recursive: true });

    // 前提：排的故障真的走到了告警出口（`armed` 已 disarm 且告警真的发出来了），否则「抛错」是排出来的假象。
    await expect(clearHistory()).rejects.toThrow("注入的告警出口故障");
    expect(armed).toBe(false);
    expect(warns.join("\n")).toContain("清空历史失败");

    rmSync(historyFile, { recursive: true, force: true });
    appendHistory(entry({ title: "清空抛错之后" }));
    await pollUntil(() => lines().length === 1, "清空抛错之后的追加落盘");
    expect(lines()[0]).toContain("清空抛错之后");
  });
});
