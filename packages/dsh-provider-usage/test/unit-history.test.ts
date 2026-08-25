// @ts-nocheck
/**
 * dsh-provider-usage — unit：历史数据纯函数与 opencode-go 解析辅助。
 *
 * 覆盖：parseJsonl（坏行跳过/校验）、startOfDay（时区/闰年/边界）、
 * legacySampleToData（裸值列/缺列/空值）、pickWindow（防御式解析）、
 * HistoryStore.exportAll（#82 批次 3）。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assert } from "./helpers.ts";
import {
  parseJsonl,
  startOfDay,
  legacySampleToData,
  pickWindow,
  HistoryStore,
} from "../lib/index.js";

// ---------------------------------------------------------------- parseJsonl

assert.deepEqual(parseJsonl(""), [], "空字符串返回空数组");
assert.deepEqual(parseJsonl("\n\n"), [], "仅换行返回空数组");
assert.deepEqual(parseJsonl('{"time":1,"data":{}}\n{"time":2,"data":{}}'), [
  { time: 1, data: {} },
  { time: 2, data: {} },
], "两行 JSONL 解析");
assert.deepEqual(parseJsonl('{"time":1,"data":{}}\nbroken\n{"time":3,"data":{}}'), [
  { time: 1, data: {} },
  { time: 3, data: {} },
], "坏行跳过");
assert.deepEqual(parseJsonl('{"time":1,"data":{}}\n{"time":"bad","data":{}}\n{"time":3,"data":{}}'), [
  { time: 1, data: {} },
  { time: 3, data: {} },
], "time 非数字行跳过");
assert.deepEqual(parseJsonl('{"time":1,"data":null}'), [], "data 为 null 的行跳过");
assert.deepEqual(parseJsonl('{"time":1}'), [], "缺 data 字段的行跳过");
assert.deepEqual(parseJsonl('{"time":1,"data":{}}\n{"time":2,"data":{}}\n'), [
  { time: 1, data: {} },
  { time: 2, data: {} },
], "尾部换行不产生空条目");

// ---------------------------------------------------------------- startOfDay

// startOfDay 是本地时区操作（setHours 在本地时区归零），epoch 0 在当地时区
// 的 00:00:00 对应 UTC 偏移量，此处仅断言结果可被一天整除
// startOfDay 是本地时区操作（setHours 在本地时区归零），此处断言日期分量归零。
{
  const d = new Date(2026, 5, 15, 13, 45, 30);
  const s = new Date(startOfDay(d.getTime()));
  assert.equal(s.getFullYear(), 2026, "年不变");
  assert.equal(s.getMonth(), 5, "月不变（6月）");
  assert.equal(s.getDate(), 15, "日不变");
  assert.equal(s.getHours(), 0, "小时归零");
  assert.equal(s.getMinutes(), 0, "分钟归零");
}
// 闰年 2 月 29 日
{
  const d = new Date(2024, 1, 29, 10, 0);
  const s = new Date(startOfDay(d.getTime()));
  assert.equal(s.getDate(), 29, "闰年 2/29 当天零点");
  assert.equal(s.getMonth(), 1, "闰年 2 月不变");
}
// DST 切换日（春季调快，夏季时间）
{
  const d = new Date(2026, 2, 8, 12, 0); // 2026-03-08（美国 DST 生效日）
  const s = new Date(startOfDay(d.getTime()));
  assert.equal(s.getDate(), 8, "DST 切换日当天零点");
  assert.equal(s.getHours(), 0, "DST 切换日小时归零");
}

// ---------------------------------------------------------------- legacySampleToData

assert.deepEqual(legacySampleToData(
  [{ key: "balance", name: "余额" }],
  [1787000000000, 10.1365],
), { balance: 10.1365 }, "balance 裸值列");

// 三窗口列
assert.deepEqual(legacySampleToData(
  [{ key: "rolling" }, { key: "weekly" }, { key: "monthly" }],
  [1787000000000, 2, 1, 0],
), { rolling: { percent: 2 }, weekly: { percent: 1 }, monthly: { percent: 0 } }, "三窗口 percent 列");

// null 值在 percent 列 → null
assert.deepEqual(legacySampleToData(
  [{ key: "rolling" }],
  [1787000000000, null],
), { rolling: { percent: null } }, "null 值 percent 列保持 null");

// null 值在裸值列 → null
assert.deepEqual(legacySampleToData(
  [{ key: "balance", name: "余额" }],
  [1787000000000, null],
), { balance: null }, "null 值裸值列保持 null");

// 无列声明 → colNN 通用装配
assert.deepEqual(legacySampleToData(undefined, [1787000000000, 5, 6]), { col1: 5, col2: 6 }, "无列声明 colNN");

// 列数少于采样值 → 多余值用 colNN 通用装配
assert.deepEqual(legacySampleToData([{ key: "a" }], [1787000000000, 1, 2, 3]),
  { a: { percent: 1 }, col2: 2, col3: 3 }, "列数少于采样值，多余列用 colNN 装配");

// 列数多于采样值 → 缺的跳过
assert.deepEqual(legacySampleToData(
  [{ key: "a" }, { key: "b" }, { key: "c" }],
  [1787000000000, 1],
), { a: { percent: 1 } }, "列数多于采样值，缺列跳过");

// ---------------------------------------------------------------- pickWindow（防御式窗口解析）

const w = pickWindow({ percent: 5, raw: "5000", resetsAt: "2026-08-01T00:00:00Z" }, "rolling", "5h 滚动", 12);
assert.ok(w !== null && w.key === "rolling" && w.percent === 5 && w.raw === "5000" && w.resetsAt === "2026-08-01T00:00:00Z",
  "合法窗口完整解析");

assert.equal(pickWindow(null, "r", "n", 10), null, "null 输入返回 null");
assert.equal(pickWindow("not-object", "r", "n", 10), null, "非对象输入返回 null");
assert.equal(pickWindow({ percent: "abc" }, "r", "n", 10)?.percent, null, "非法 percent 字符串返回 null");
assert.equal(pickWindow({ percent: NaN }, "r", "n", 10)?.percent, null, "NaN percent 返回 null");
assert.equal(pickWindow({ percent: 5 }, "r", "n", 10)?.raw, undefined, "无 raw 字段返回 undefined");
assert.equal(pickWindow({ percent: 5, resetsAt: 123 }, "r", "n", 10)?.resetsAt, undefined, "resetsAt 非字符串丢弃");

// ---------------------------------------------------------------- HistoryStore.exportAll

{
  const root = mkdtempSync(join(tmpdir(), "dou-hist-export-"));
  const store = new HistoryStore({ root });
  const now = Date.now();
  // 写入几条数据（时间用当前时刻，避免 maybePrune 依据日文件名把历史日文件删掉）
  await store.append("p1", "n1", { time: now - 1000, data: { a: 1 } });
  await store.append("p1", "n1", { time: now, data: { a: 2 } });
  const all = await store.exportAll("p1", "n1");
  assert.equal(all.length, 2, "exportAll 返回两条");
  assert.equal(all[0].data.a, 1, "exportAll 第一条 data");
  assert.equal(all[1].data.a, 2, "exportAll 第二条 data");
}

// exportAll：空目录返回 []
{
  const root = mkdtempSync(join(tmpdir(), "dou-hist-export2-"));
  const store = new HistoryStore({ root });
  const all = await store.exportAll("absent", "nope");
  assert.deepEqual(all, [], "exportAll 无数据返回 []");
}

// exportAll：目录不存在返回 []
{
  const root = mkdtempSync(join(tmpdir(), "dou-hist-export3-"));
  const store = new HistoryStore({ root });
  const all = await store.exportAll("no-such", "never");
  assert.deepEqual(all, [], "exportAll 目录不存在返回 []");
}
// ================================================================ #150 二阶段：HistoryStore 深度分支

import { readdirSync, existsSync } from "node:fs";
import { rename as renameAsync } from "node:fs/promises";
import { listAdapters, migrateLegacyV3 } from "../lib/index.js";

// ---------------------------------------------------------------- 构造缺省值

{
  const root = mkdtempSync(join(tmpdir(), "dou-hist-defaults-"));
  const store = new HistoryStore({ root });
  assert.equal((store as unknown as { maxAgeMs: number }).maxAgeMs, 30 * 86400000, "maxAgeMs 缺省 30 天");
  assert.equal((store as unknown as { maxSizeBytes: number }).maxSizeBytes, 20 * 1024 * 1024, "maxSizeBytes 缺省 20MB");
}

// ---------------------------------------------------------------- readDay / query

{
  const root = mkdtempSync(join(tmpdir(), "dou-hist-query-"));
  const store = new HistoryStore({ root });
  // 相对当前的两天锚点（昨天/今天中午）：避免绝对日期触发 maybePrune 过期清理
  const d2 = new Date().setHours(12, 0, 0, 0);
  const d1 = d2 - 86400000;
  await store.append("p", "n", { time: d1, data: { v: 1 } });
  await store.append("p", "n", { time: d2, data: { v: 2 } });
  await store.append("p", "n", { time: d2 + 3600000, data: { v: 3 } });

  // 单天读取
  const day1 = await store.readDay("p", "n", d1);
  assert.equal(day1.length, 1, "readDay 单天一条");
  // 文件不存在返回空
  assert.deepEqual(await store.readDay("p", "n", d1 - 40 * 86400000), [], "readDay 无文件返回空");

  // range 过滤：只含 d2 当天两条
  const q = await store.query("p", "n", { start: startOfDay(d2), end: d2 + 7200000 });
  assert.equal(q.entries.length, 2, "query 只含 range 内条目");
  assert.ok(q.entries.every((e) => e.time >= startOfDay(d2)), "query 下界过滤");
  // 乱序写入后稳定升序
  assert.ok(q.entries[0].time <= q.entries[1].time, "query 结果升序");
  // 跨天全量
  const all = await store.query("p", "n", { start: startOfDay(d1), end: d2 + 7200000 });
  assert.equal(all.entries.length, 3, "query 跨天全量");
}

// ---------------------------------------------------------------- last()

{
  const root = mkdtempSync(join(tmpdir(), "dou-hist-last-"));
  const store = new HistoryStore({ root });
  assert.equal(await store.last("p", "n"), null, "last 目录不存在返回 null");

  const now = Date.now();
  await store.append("p", "n", { time: now - 5000, data: { v: 1 } });
  await store.append("p", "n", { time: now, data: { v: 2 } });
  const lastEntry = await store.last("p", "n");
  assert.ok(lastEntry !== null && lastEntry.data.v === 2, "last 取最新条目");

  // 最新文件内混入坏行：JSON.parse 失败行与校验不过行都被跳过
  const dir = join(root, "p", "n");
  const todayName = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().pop() as string;
  {
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = await readFile(join(dir, todayName), "utf8");
    await writeFile(join(dir, todayName), raw + "broken-line\n" + '{"time":"nan","data":{}}\n' + '{"time":999}\n', "utf8");
    // 追加的坏行之后无有效条目 → 回退到文件内前面的有效条目（v=2 仍在前面）
    const l2 = await store.last("p", "n");
    assert.ok(l2 !== null && l2.data.v === 2, "last 尾部坏行跳过取前面有效条目");

    // 整个最新文件只有坏行 → 该文件耗尽后回退更旧文件
    await writeFile(join(dir, todayName), "broken\n", "utf8");
    const l3 = await store.last("p", "n");
    // 更旧文件不存在时最终 null；此处仅一个文件 → null
    assert.equal(l3, null, "last 全坏文件且无更旧文件返回 null");
  }

  // 目录存在但只有非 jsonl 文件 → null
  const root2 = mkdtempSync(join(tmpdir(), "dou-hist-last2-"));
  mkdirSync(join(root2, "x", "y"), { recursive: true });
  writeFileSync(join(root2, "x", "y", "keep.txt"), "x", "utf8");
  const s2 = new HistoryStore({ root: root2 });
  assert.equal(await s2.last("x", "y"), null, "last 仅非 jsonl 文件返回 null");
}

// ---------------------------------------------------------------- maybePrune

// 过期日文件按文件名日期删除
{
  const root = mkdtempSync(join(tmpdir(), "dou-prune-age-"));
  const store = new HistoryStore({ root, maxAgeMs: 86400000 }); // 保留 1 天
  const dir = join(root, "p", "n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2020-01-01.jsonl"), '{"time":1,"data":{}}\n', "utf8"); // 远过期
  writeFileSync(join(dir, "2999-01-01.jsonl"), '{"time":2,"data":{}}\n', "utf8"); // 未来
  await store.maybePrune("p", "n");
  assert.ok(!existsSync(join(dir, "2020-01-01.jsonl")), "过期日文件被删除");
  assert.ok(existsSync(join(dir, "2999-01-01.jsonl")), "未过期日文件保留");
}

// 总大小超限：从最旧逐个删，保留最后 1 个
{
  const root = mkdtempSync(join(tmpdir(), "dou-prune-size-"));
  const store = new HistoryStore({ root, maxSizeBytes: 30 });
  const dir = join(root, "p", "n");
  mkdirSync(dir, { recursive: true });
  const line = '{"time":1,"data":{}}\n'; // 约 22 字节
  writeFileSync(join(dir, "2998-01-01.jsonl"), line, "utf8");
  writeFileSync(join(dir, "2999-01-01.jsonl"), line, "utf8");
  await store.maybePrune("p", "n");
  assert.ok(!existsSync(join(dir, "2998-01-01.jsonl")), "超限最旧文件被删");
  assert.ok(existsSync(join(dir, "2999-01-01.jsonl")), "最后一个文件保底不清零");
}

// 目录缺失静默返回
{
  const root = mkdtempSync(join(tmpdir(), "dou-prune-absent-"));
  const store = new HistoryStore({ root });
  await store.maybePrune("nope", "none"); // 不抛错即通过
  assert.ok(true, "maybePrune 目录缺失不抛错");
}

// ---------------------------------------------------------------- writeDirect

{
  const root = mkdtempSync(join(tmpdir(), "dou-wdirect-"));
  const store = new HistoryStore({ root });
  // 空 entries 直接返回（连目录都不建）
  await store.writeDirect("p", "n", Date.now(), []);
  assert.ok(!existsSync(join(root, "p")), "空 entries 不落盘不建目录");
  // 正常写入 + 同天多条一次写（writeDirect 不触发 prune，锚点可用任意值）
  const day = new Date().setHours(12, 0, 0, 0);
  await store.writeDirect("p", "n", day, [
    { time: day, data: { v: 1 } },
    { time: day + 1, data: { v: 2 } },
  ]);
  const entries = await store.readDay("p", "n", day);
  assert.deepEqual(entries, [
    { time: day, data: { v: 1 } },
    { time: day + 1, data: { v: 2 } },
  ], "writeDirect 两行写入可回读");
}

// ---------------------------------------------------------------- listAdapters

{
  const root = mkdtempSync(join(tmpdir(), "dou-listadp-"));
  assert.deepEqual(await listAdapters(root), [], "listAdapters 根目录缺失返回空数组");
  mkdirSync(join(root, "pv1", "adapter-a"), { recursive: true });
  mkdirSync(join(root, "pv2", "adapter-b"), { recursive: true });
  const found = await listAdapters(root);
  assert.equal(found.length, 2, "listAdapters 枚举两对 provider/name");
  assert.deepEqual(new Set(found.map((f) => f.provider)), new Set(["pv1", "pv2"]), "provider 集合正确");
}

// ---------------------------------------------------------------- migrateLegacyV3

{
  const root = mkdtempSync(join(tmpdir(), "dou-mig-"));
  const store = new HistoryStore({ root });
  // 无旧目录 → 0
  assert.equal(await migrateLegacyV3(root, store), 0, "无 history 目录返回 0");

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

  const migrated = await migrateLegacyV3(root, store);
  assert.equal(migrated, 2, "仅合法桶的两条采样被迁移");
  const entries = await store.exportAll("opencode-go", "opencode-go-builtin");
  assert.equal(entries.length, 2, "迁移后新格式可读出两条");
  assert.deepEqual(entries[0].data, { rolling: { percent: 5 } }, "迁移数据列装配正确");
  assert.ok(existsSync(join(pdir, "opencode-go-builtin.json.v3.bak")), "迁移成功后原文件重命名 .bak");
  assert.ok(!existsSync(join(pdir, "opencode-go-builtin.json")), "原 json 不再保留");

  // 幂等：.bak 不再扫描，二次运行为 0
  assert.equal(await migrateLegacyV3(root, store), 0, "二次迁移幂等返回 0");

  // writeDirect 失败（root 是普通文件）→ 桶保留原文件不计入迁移数
  const rootBad = mkdtempSync(join(tmpdir(), "dou-mig-bad-"));
  writeFileSync(join(rootBad, "blocker"), "not a dir", "utf8");
  const badHist = join(rootBad, "history", "pv");
  mkdirSync(badHist, { recursive: true });
  writeFileSync(join(badHist, "b.json"), JSON.stringify({ samples: [[ts, 1]] }), "utf8");
  const badStore = new HistoryStore({ root: join(rootBad, "blocker") });
  assert.equal(await migrateLegacyV3(rootBad, badStore), 0, "写盘失败桶不计入迁移数");
  assert.ok(existsSync(join(badHist, "b.json")), "写盘失败原文件保留待重试");
}
