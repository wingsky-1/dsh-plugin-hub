// @ts-nocheck
/**
 * dsh-provider-usage — unit：历史数据纯函数与 opencode-go 解析辅助。
 *
 * 覆盖：parseJsonl（坏行跳过/校验）、startOfDay（时区/闰年/边界）、
 * legacySampleToData（裸值列/缺列/空值）、pickWindow（防御式解析）、
 * HistoryStore.exportAll（#82 批次 3）。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
console.error("EVAL-ORDER-TAG: HISTORY");
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import {
  parseJsonl,
  startOfDay,
  legacySampleToData,
  pickWindow,
  HistoryStore,
} from "../../../src/apply/index.ts";

describe("parseJsonl", () => {
  it("空字符串返回空数组", () => {
    expect(parseJsonl("")).toEqual([]);
  });

  it("仅换行返回空数组", () => {
    expect(parseJsonl("\n\n")).toEqual([]);
  });

  it("两行 JSONL 解析", () => {
    expect(parseJsonl('{"time":1,"data":{}}\n{"time":2,"data":{}}')).toEqual([
      { time: 1, data: {} },
      { time: 2, data: {} },
    ]);
  });

  it("坏行跳过", () => {
    expect(parseJsonl('{"time":1,"data":{}}\nbroken\n{"time":3,"data":{}}')).toEqual([
      { time: 1, data: {} },
      { time: 3, data: {} },
    ]);
  });

  it("time 非数字行跳过", () => {
    expect(parseJsonl('{"time":1,"data":{}}\n{"time":"bad","data":{}}\n{"time":3,"data":{}}')).toEqual([
      { time: 1, data: {} },
      { time: 3, data: {} },
    ]);
  });

  it("data 为 null 的行跳过", () => {
    expect(parseJsonl('{"time":1,"data":null}')).toEqual([]);
  });

  it("缺 data 字段的行跳过", () => {
    expect(parseJsonl('{"time":1}')).toEqual([]);
  });

  it("尾部换行不产生空条目", () => {
    expect(parseJsonl('{"time":1,"data":{}}\n{"time":2,"data":{}}\n')).toEqual([
      { time: 1, data: {} },
      { time: 2, data: {} },
    ]);
  });
});

// startOfDay 是本地时区操作（setHours 在本地时区归零），epoch 0 在当地时区
// 的 00:00:00 对应 UTC 偏移量，此处仅断言结果可被一天整除
// startOfDay 是本地时区操作（setHours 在本地时区归零），此处断言日期分量归零。
describe("startOfDay", () => {
  describe("普通日期（本地时区）", () => {
    let s;

    beforeAll(() => {
      const d = new Date(2026, 5, 15, 13, 45, 30);
      s = new Date(startOfDay(d.getTime()));
    });

    it("年不变", () => {
      expect(s.getFullYear()).toBe(2026);
    });

    it("月不变（6月）", () => {
      expect(s.getMonth()).toBe(5);
    });

    it("日不变", () => {
      expect(s.getDate()).toBe(15);
    });

    it("小时归零", () => {
      expect(s.getHours()).toBe(0);
    });

    it("分钟归零", () => {
      expect(s.getMinutes()).toBe(0);
    });
  });

  describe("闰年 2 月 29 日", () => {
    let s;

    beforeAll(() => {
      const d = new Date(2024, 1, 29, 10, 0);
      s = new Date(startOfDay(d.getTime()));
    });

    it("闰年 2/29 当天零点", () => {
      expect(s.getDate()).toBe(29);
    });

    it("闰年 2 月不变", () => {
      expect(s.getMonth()).toBe(1);
    });
  });

  describe("DST 切换日（春季调快，夏季时间）", () => {
    let s;

    beforeAll(() => {
      const d = new Date(2026, 2, 8, 12, 0); // 2026-03-08（美国 DST 生效日）
      s = new Date(startOfDay(d.getTime()));
    });

    it("DST 切换日当天零点", () => {
      expect(s.getDate()).toBe(8);
    });

    it("DST 切换日小时归零", () => {
      expect(s.getHours()).toBe(0);
    });
  });
});

describe("legacySampleToData", () => {
  it("balance 裸值列", () => {
    expect(legacySampleToData(
      [{ key: "balance", name: "余额" }],
      [1787000000000, 10.1365],
    )).toEqual({ balance: 10.1365 });
  });

  // 三窗口列
  it("三窗口 percent 列", () => {
    expect(legacySampleToData(
      [{ key: "rolling" }, { key: "weekly" }, { key: "monthly" }],
      [1787000000000, 2, 1, 0],
    )).toEqual({ rolling: { percent: 2 }, weekly: { percent: 1 }, monthly: { percent: 0 } });
  });

  // null 值在 percent 列 → null
  it("null 值 percent 列保持 null", () => {
    expect(legacySampleToData(
      [{ key: "rolling" }],
      [1787000000000, null],
    )).toEqual({ rolling: { percent: null } });
  });

  // null 值在裸值列 → null
  it("null 值裸值列保持 null", () => {
    expect(legacySampleToData(
      [{ key: "balance", name: "余额" }],
      [1787000000000, null],
    )).toEqual({ balance: null });
  });

  // 无列声明 → colNN 通用装配
  it("无列声明 colNN", () => {
    expect(legacySampleToData(undefined, [1787000000000, 5, 6])).toEqual({ col1: 5, col2: 6 });
  });

  // 列数少于采样值 → 多余值用 colNN 通用装配
  it("列数少于采样值，多余列用 colNN 装配", () => {
    expect(legacySampleToData([{ key: "a" }], [1787000000000, 1, 2, 3]))
      .toEqual({ a: { percent: 1 }, col2: 2, col3: 3 });
  });

  // 列数多于采样值 → 缺的跳过
  it("列数多于采样值，缺列跳过", () => {
    expect(legacySampleToData(
      [{ key: "a" }, { key: "b" }, { key: "c" }],
      [1787000000000, 1],
    )).toEqual({ a: { percent: 1 } });
  });
});

describe("pickWindow（防御式窗口解析）", () => {
  it("合法窗口完整解析", () => {
    const w = pickWindow({ percent: 5, raw: "5000", resetsAt: "2026-08-01T00:00:00Z" }, "rolling", "5h 滚动", 12);
    expect(w !== null && w.key === "rolling" && w.percent === 5 && w.raw === "5000" && w.resetsAt === "2026-08-01T00:00:00Z").toBeTruthy();
  });

  it("null 输入返回 null", () => {
    expect(pickWindow(null, "r", "n", 10)).toBe(null);
  });

  it("非对象输入返回 null", () => {
    expect(pickWindow("not-object", "r", "n", 10)).toBe(null);
  });

  it("非法 percent 字符串返回 null", () => {
    expect(pickWindow({ percent: "abc" }, "r", "n", 10)?.percent).toBe(null);
  });

  it("NaN percent 返回 null", () => {
    expect(pickWindow({ percent: NaN }, "r", "n", 10)?.percent).toBe(null);
  });

  it("无 raw 字段返回 undefined", () => {
    expect(pickWindow({ percent: 5 }, "r", "n", 10)?.raw).toBe(undefined);
  });

  it("resetsAt 非字符串丢弃", () => {
    expect(pickWindow({ percent: 5, resetsAt: 123 }, "r", "n", 10)?.resetsAt).toBe(undefined);
  });
});

describe("HistoryStore.exportAll", () => {
  describe("写入两条后可全量读出", () => {
    let all;

    beforeAll(async () => {
      const root = mkdtempSync(join(tmpdir(), "dou-hist-export-"));
      const store = new HistoryStore({ root });
      const now = Date.now();
      // 写入几条数据（时间用当前时刻，避免 maybePrune 依据日文件名把历史日文件删掉）
      await store.append("p1", "n1", { time: now - 1000, data: { a: 1 } });
      await store.append("p1", "n1", { time: now, data: { a: 2 } });
      all = await store.exportAll("p1", "n1");
    });

    it("exportAll 返回两条", () => {
      expect(all.length).toBe(2);
    });

    it("exportAll 第一条 data", () => {
      expect(all[0].data.a).toBe(1);
    });

    it("exportAll 第二条 data", () => {
      expect(all[1].data.a).toBe(2);
    });
  });

  // exportAll：空目录返回 []
  describe("exportAll：空目录返回 []", () => {
    let all;

    beforeAll(async () => {
      const root = mkdtempSync(join(tmpdir(), "dou-hist-export2-"));
      const store = new HistoryStore({ root });
      all = await store.exportAll("absent", "nope");
    });

    it("exportAll 无数据返回 []", () => {
      expect(all).toEqual([]);
    });
  });

  // exportAll：目录不存在返回 []
  describe("exportAll：目录不存在返回 []", () => {
    let all;

    beforeAll(async () => {
      const root = mkdtempSync(join(tmpdir(), "dou-hist-export3-"));
      const store = new HistoryStore({ root });
      all = await store.exportAll("no-such", "never");
    });

    it("exportAll 目录不存在返回 []", () => {
      expect(all).toEqual([]);
    });
  });
});

// ================================================================ #150 二阶段：HistoryStore 深度分支

import { readdirSync, existsSync } from "node:fs";
import { rename as renameAsync } from "node:fs/promises";
import { listAdapters, migrateLegacyV3 } from "../../../src/apply/index.ts";

describe("构造缺省值", () => {
  let store;

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), "dou-hist-defaults-"));
    store = new HistoryStore({ root });
  });

  it("maxAgeMs 缺省 30 天", () => {
    expect((store as unknown as { maxAgeMs: number }).maxAgeMs).toBe(30 * 86400000);
  });

  it("maxSizeBytes 缺省 20MB", () => {
    expect((store as unknown as { maxSizeBytes: number }).maxSizeBytes).toBe(20 * 1024 * 1024);
  });
});

describe("readDay / query", () => {
  let day1, emptyDay, q, all, d2;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-hist-query-"));
    const store = new HistoryStore({ root });
    // 相对当前的两天锚点（昨天/今天中午）：避免绝对日期触发 maybePrune 过期清理
    d2 = new Date().setHours(12, 0, 0, 0);
    const d1 = d2 - 86400000;
    await store.append("p", "n", { time: d1, data: { v: 1 } });
    await store.append("p", "n", { time: d2, data: { v: 2 } });
    await store.append("p", "n", { time: d2 + 3600000, data: { v: 3 } });

    // 单天读取
    day1 = await store.readDay("p", "n", d1);
    // 文件不存在返回空
    emptyDay = await store.readDay("p", "n", d1 - 40 * 86400000);

    // range 过滤：只含 d2 当天两条
    q = await store.query("p", "n", { start: startOfDay(d2), end: d2 + 7200000 });
    // 跨天全量
    all = await store.query("p", "n", { start: startOfDay(d1), end: d2 + 7200000 });
  });

  it("readDay 单天一条", () => {
    expect(day1.length).toBe(1);
  });

  it("readDay 无文件返回空", () => {
    expect(emptyDay).toEqual([]);
  });

  it("query 只含 range 内条目", () => {
    expect(q.entries.length).toBe(2);
  });

  it("query 下界过滤", () => {
    expect(q.entries.every((e) => e.time >= startOfDay(d2))).toBeTruthy();
  });

  // 乱序写入后稳定升序
  it("query 结果升序", () => {
    expect(q.entries[0].time <= q.entries[1].time).toBeTruthy();
  });

  it("query 跨天全量", () => {
    expect(all.entries.length).toBe(3);
  });
});

describe("last()", () => {
  let lastAbsent, lastEntry, lastAfterTailBadLines, lastAllBad, lastNonJsonl;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-hist-last-"));
    const store = new HistoryStore({ root });
    lastAbsent = await store.last("p", "n");

    // 锚点取今天中午（本地时区）：若用 Date.now()，跨午夜瞬间运行时 now-5000
    // 与 now 会落进两个日文件，使「单文件回退链」前提漂移产生 ±5s 的 flake 窗口
    const now = new Date().setHours(12, 0, 0, 0);
    await store.append("p", "n", { time: now - 5000, data: { v: 1 } });
    await store.append("p", "n", { time: now, data: { v: 2 } });
    lastEntry = await store.last("p", "n");

    // 最新文件内混入坏行：JSON.parse 失败行与校验不过行都被跳过
    const dir = join(root, "p", "n");
    const todayName = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().pop() as string;
    {
      const { readFile, writeFile } = await import("node:fs/promises");
      const raw = await readFile(join(dir, todayName), "utf8");
      await writeFile(join(dir, todayName), raw + "broken-line\n" + '{"time":"nan","data":{}}\n' + '{"time":999}\n', "utf8");
      // 追加的坏行之后无有效条目 → 回退到文件内前面的有效条目（v=2 仍在前面）
      lastAfterTailBadLines = await store.last("p", "n");

      // 整个最新文件只有坏行 → 该文件耗尽后回退更旧文件
      await writeFile(join(dir, todayName), "broken\n", "utf8");
      lastAllBad = await store.last("p", "n");
    }

    // 目录存在但只有非 jsonl 文件 → null
    const root2 = mkdtempSync(join(tmpdir(), "dou-hist-last2-"));
    mkdirSync(join(root2, "x", "y"), { recursive: true });
    writeFileSync(join(root2, "x", "y", "keep.txt"), "x", "utf8");
    const s2 = new HistoryStore({ root: root2 });
    lastNonJsonl = await s2.last("x", "y");
  });

  it("last 目录不存在返回 null", () => {
    expect(lastAbsent).toBe(null);
  });

  it("last 取最新条目", () => {
    expect(lastEntry !== null && lastEntry.data.v === 2).toBeTruthy();
  });

  it("last 尾部坏行跳过取前面有效条目", () => {
    expect(lastAfterTailBadLines !== null && lastAfterTailBadLines.data.v === 2).toBeTruthy();
  });

  // 更旧文件不存在时最终 null；此处仅一个文件 → null
  it("last 全坏文件且无更旧文件返回 null", () => {
    expect(lastAllBad).toBe(null);
  });

  it("last 仅非 jsonl 文件返回 null", () => {
    expect(lastNonJsonl).toBe(null);
  });
});

describe("maybePrune", () => {
  // 过期日文件按文件名日期删除
  describe("过期日文件按文件名日期删除", () => {
    let oldExists, futureExists;

    beforeAll(async () => {
      const root = mkdtempSync(join(tmpdir(), "dou-prune-age-"));
      const store = new HistoryStore({ root, maxAgeMs: 86400000 }); // 保留 1 天
      const dir = join(root, "p", "n");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "2020-01-01.jsonl"), '{"time":1,"data":{}}\n', "utf8"); // 远过期
      writeFileSync(join(dir, "2999-01-01.jsonl"), '{"time":2,"data":{}}\n', "utf8"); // 未来
      await store.maybePrune("p", "n");
      oldExists = existsSync(join(dir, "2020-01-01.jsonl"));
      futureExists = existsSync(join(dir, "2999-01-01.jsonl"));
    });

    it("过期日文件被删除", () => {
      expect(!oldExists).toBeTruthy();
    });

    it("未过期日文件保留", () => {
      expect(futureExists).toBeTruthy();
    });
  });

  // 总大小超限：从最旧逐个删，保留最后 1 个
  describe("总大小超限：从最旧逐个删，保留最后 1 个", () => {
    let oldestExists, newestExists;

    beforeAll(async () => {
      const root = mkdtempSync(join(tmpdir(), "dou-prune-size-"));
      const store = new HistoryStore({ root, maxSizeBytes: 30 });
      const dir = join(root, "p", "n");
      mkdirSync(dir, { recursive: true });
      const line = '{"time":1,"data":{}}\n'; // 约 22 字节
      writeFileSync(join(dir, "2998-01-01.jsonl"), line, "utf8");
      writeFileSync(join(dir, "2999-01-01.jsonl"), line, "utf8");
      await store.maybePrune("p", "n");
      oldestExists = existsSync(join(dir, "2998-01-01.jsonl"));
      newestExists = existsSync(join(dir, "2999-01-01.jsonl"));
    });

    it("超限最旧文件被删", () => {
      expect(!oldestExists).toBeTruthy();
    });

    it("最后一个文件保底不清零", () => {
      expect(newestExists).toBeTruthy();
    });
  });

  // 目录缺失静默返回
  describe("目录缺失静默返回", () => {
    let threw = false;

    beforeAll(async () => {
      const root = mkdtempSync(join(tmpdir(), "dou-prune-absent-"));
      const store = new HistoryStore({ root });
      try {
        await store.maybePrune("nope", "none"); // 不抛错即通过
      } catch {
        threw = true;
      }
    });

    it("maybePrune 目录缺失不抛错", () => {
      expect(threw).toBe(false);
    });
  });
});

describe("writeDirect", () => {
  let providerDirExistsAfterEmptyWrite, entries, day;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-wdirect-"));
    const store = new HistoryStore({ root });
    // 空 entries 直接返回（连目录都不建）
    await store.writeDirect("p", "n", Date.now(), []);
    providerDirExistsAfterEmptyWrite = existsSync(join(root, "p"));
    // 正常写入 + 同天多条一次写（writeDirect 不触发 prune，锚点可用任意值）
    day = new Date().setHours(12, 0, 0, 0);
    await store.writeDirect("p", "n", day, [
      { time: day, data: { v: 1 } },
      { time: day + 1, data: { v: 2 } },
    ]);
    entries = await store.readDay("p", "n", day);
  });

  it("空 entries 不落盘不建目录", () => {
    expect(!providerDirExistsAfterEmptyWrite).toBeTruthy();
  });

  it("writeDirect 两行写入可回读", () => {
    expect(entries).toEqual([
      { time: day, data: { v: 1 } },
      { time: day + 1, data: { v: 2 } },
    ]);
  });
});

describe("listAdapters", () => {
  let empty, found;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-listadp-"));
    empty = await listAdapters(root);
    mkdirSync(join(root, "pv1", "adapter-a"), { recursive: true });
    mkdirSync(join(root, "pv2", "adapter-b"), { recursive: true });
    found = await listAdapters(root);
  });

  it("listAdapters 根目录缺失返回空数组", () => {
    expect(empty).toEqual([]);
  });

  it("listAdapters 枚举两对 provider/name", () => {
    expect(found.length).toBe(2);
  });

  it("provider 集合正确", () => {
    expect(new Set(found.map((f) => f.provider))).toEqual(new Set(["pv1", "pv2"]));
  });
});

describe("migrateLegacyV3", () => {
  let noHistoryDir, migrated, entries, bakExists, originalExists, secondRun, badMigrated, badOriginalKept;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-mig-"));
    const store = new HistoryStore({ root });
    // 无旧目录 → 0
    noHistoryDir = await migrateLegacyV3(root, store);

    const histDir = join(root, "history");
    const pdir = join(histDir, "opencode-go");
    mkdirSync(pdir, { recursive: true });

    // 正常桶：两条采样（同一天）+ 一条坏采样
    const ts = new Date(2026, 5, 15, 12).getTime();
    writeFileSync(join(pdir, "opencode-go-builtin.json"), JSON.stringify({
      provider: "opencode-go",
      adapterId: "opencode-go-builtin",
      columns: [{ key: "rolling", name: "5h" }],
      samples: [[ts, 5], [ts + 60000, 6], ["not-array"], [ts], [NaN]],
    }), "utf8");
    // .bak 跳过
    writeFileSync(join(pdir, "old.v3.bak"), JSON.stringify({ samples: [[ts, 1]] }), "utf8");
    // 非 .json 跳过
    writeFileSync(join(pdir, "notes.txt"), "hello", "utf8");
    // 坏 JSON 跳过
    writeFileSync(join(pdir, "broken.json"), "{oops", "utf8");
    // samples 空数组跳过
    writeFileSync(join(pdir, "empty-samples.json"), JSON.stringify({ samples: [] }), "utf8");
    // samples 缺失跳过
    writeFileSync(join(pdir, "no-samples.json"), "{}", "utf8");

    migrated = await migrateLegacyV3(root, store);
    entries = await store.exportAll("opencode-go", "opencode-go-builtin");
    bakExists = existsSync(join(pdir, "opencode-go-builtin.json.v3.bak"));
    originalExists = existsSync(join(pdir, "opencode-go-builtin.json"));

    // 幂等：.bak 不再扫描，二次运行为 0
    secondRun = await migrateLegacyV3(root, store);

    // writeDirect 失败（root 是普通文件）→ 桶保留原文件不计入迁移数
    const rootBad = mkdtempSync(join(tmpdir(), "dou-mig-bad-"));
    writeFileSync(join(rootBad, "blocker"), "not a dir", "utf8");
    const badHist = join(rootBad, "history", "pv");
    mkdirSync(badHist, { recursive: true });
    writeFileSync(join(badHist, "b.json"), JSON.stringify({ samples: [[ts, 1]] }), "utf8");
    const badStore = new HistoryStore({ root: join(rootBad, "blocker") });
    badMigrated = await migrateLegacyV3(rootBad, badStore);
    badOriginalKept = existsSync(join(badHist, "b.json"));
  });

  it("无 history 目录返回 0", () => {
    expect(noHistoryDir).toBe(0);
  });

  it("仅合法桶的两条采样被迁移", () => {
    expect(migrated).toBe(2);
  });

  it("迁移后新格式可读出两条", () => {
    expect(entries.length).toBe(2);
  });

  it("迁移数据列装配正确", () => {
    expect(entries[0].data).toEqual({ rolling: { percent: 5 } });
  });

  it("迁移成功后原文件重命名 .bak", () => {
    expect(bakExists).toBeTruthy();
  });

  it("原 json 不再保留", () => {
    expect(!originalExists).toBeTruthy();
  });

  it("二次迁移幂等返回 0", () => {
    expect(secondRun).toBe(0);
  });

  it("写盘失败桶不计入迁移数", () => {
    expect(badMigrated).toBe(0);
  });

  it("写盘失败原文件保留待重试", () => {
    expect(badOriginalKept).toBeTruthy();
  });
});

// ---------------------------------------------------------------- #105② 历史存储卫生

// readDay：文件不存在返回 []（ENOENT 容错，不再依赖 existsSync 预检）
describe("#105② readDay 文件不存在返回 []", () => {
  let entries;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-hist-readday-"));
    const store = new HistoryStore({ root });
    entries = await store.readDay("p1", "n1", Date.now());
  });

  it("readDay 文件不存在返回 []", () => {
    expect(entries).toEqual([]);
  });
});

// readDay：prune 并发删文件竞态容错——文件在读取前被删不抛异常
describe("#105② readDay prune 并发删文件竞态容错", () => {
  let entries;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-hist-race-"));
    const store = new HistoryStore({ root });
    const now = Date.now();
    await store.append("p1", "n1", { time: now, data: { a: 1 } });
    const dayFile = join(root, "p1", "n1", `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, "0")}-${String(new Date(now).getDate()).padStart(2, "0")}.jsonl`);
    await import("node:fs/promises").then((m) => m.rm(dayFile, { force: true }));
    entries = await store.readDay("p1", "n1", now);
  });

  it("文件被并发删除后 readDay 返回 [] 而非抛异常", () => {
    expect(entries).toEqual([]);
  });
});

// append 不再内联 prune：追加后目录内文件数不变（prune 已移出热路径）
describe("#105② append 不再内联 prune", () => {
  let files;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-hist-noprune-"));
    const store = new HistoryStore({ root, maxAgeMs: 0, maxSizeBytes: 0 });
    const now = Date.now();
    await store.append("p1", "n1", { time: now, data: { a: 1 } });
    await store.append("p1", "n1", { time: now, data: { a: 2 } });
    // maxAgeMs=0 / maxSizeBytes=0 下若 append 仍内联 prune，文件会立即被删；
    // 现在 append 是纯 O(1) 追加，文件必须还在。
    const { readdir } = await import("node:fs/promises");
    files = await readdir(join(root, "p1", "n1"));
  });

  it("append 不再触发 prune，文件保留", () => {
    expect(files.length).toBe(1);
  });
});

// pruneAll：过期日文件被清理 + 停用适配器目录数据保留（语义锁死）
describe("#105② pruneAll：过期清理 + 停用目录数据保留", () => {
  let p1Files, p2Files, p2Today, oldFile;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-hist-pruneall-"));
    const store = new HistoryStore({ root, maxAgeMs: 30 * 86400000, maxSizeBytes: 20 * 1024 * 1024 });
    const now = Date.now();
    // 两个 provider：p1（启用）与 p2-disabled（停用孤儿目录）
    await store.append("p1", "n1", { time: now, data: { a: 1 } });
    await store.append("p2-disabled", "n1", { time: now, data: { b: 2 } });
    // 写入一个 40 天前的过期文件（模拟历史残留）
    const oldDay = new Date(now - 40 * 86400000);
    oldFile = `${oldDay.getFullYear()}-${String(oldDay.getMonth() + 1).padStart(2, "0")}-${String(oldDay.getDate()).padStart(2, "0")}.jsonl`;
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "p1", "n1"), { recursive: true });
    await mkdir(join(root, "p2-disabled", "n1"), { recursive: true });
    await writeFile(join(root, "p1", "n1", oldFile), '{"time":1,"data":{}}\n', "utf8");
    await writeFile(join(root, "p2-disabled", "n1", oldFile), '{"time":1,"data":{}}\n', "utf8");

    await store.pruneAll();

    const { readdir, readFile } = await import("node:fs/promises");
    p1Files = await readdir(join(root, "p1", "n1"));
    // 停用目录的过期文件同样受 retention 清理
    p2Files = await readdir(join(root, "p2-disabled", "n1"));
    // 但停用目录的当日数据文件保留（不回删数据）
    p2Today = await readFile(join(root, "p2-disabled", "n1", p2Files[0]), "utf8");
  });

  it("p1 过期日文件被清理", () => {
    expect(!p1Files.includes(oldFile)).toBeTruthy();
  });

  it("p1 仅剩当日文件", () => {
    expect(p1Files.length).toBe(1);
  });

  it("停用目录过期文件同样被清理", () => {
    expect(!p2Files.includes(oldFile)).toBeTruthy();
  });

  it("停用目录当日数据保留，用户回切可读", () => {
    expect(p2Today.includes('"b":2')).toBeTruthy();
  });
});
