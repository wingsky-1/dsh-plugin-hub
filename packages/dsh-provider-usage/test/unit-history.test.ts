// @ts-nocheck
/**
 * dsh-provider-usage — unit：历史数据纯函数与 opencode-go 解析辅助。
 *
 * 覆盖：parseJsonl（坏行跳过/校验）、startOfDay（时区/闰年/边界）、
 * legacySampleToData（裸值列/缺列/空值）、pickWindow（防御式解析）。
 */
import { assert } from "./helpers.ts";
import {
  parseJsonl,
  startOfDay,
  legacySampleToData,
  pickWindow,
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