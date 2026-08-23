// @ts-nocheck
/**
 * dsh-provider-usage — unit：契约辅助纯函数。
 *
 * 覆盖：safeSegment（路径安全段）、sseData（SSE 序列化）、
 * parseUserAdapters（防御式解析）、summarizeTextFromWindows /
 * levelFromWindows（v1 废弃但保留的辅助函数）。
 */
import { assert } from "./helpers.ts";
import {
  safeSegment,
  sseData,
  parseUserAdapters,
  summarizeTextFromWindows,
  levelFromWindows,
} from "../lib/index.js";

// ---------------------------------------------------------------- safeSegment

assert.equal(safeSegment("hello-world"), "hello-world", "字母数字连字符原样保留");
assert.equal(safeSegment("a.b_c"), "a.b_c", "点和下划线保留");
assert.equal(safeSegment("a/b\\c"), "a_b_c", "路径分隔符替换为下划线");
assert.equal(safeSegment("a b\tc"), "a_b_c", "空白字符替换为下划线");
assert.equal(safeSegment("中文/测试"), "_____", "非 ASCII 字符与路径分隔符全替换为下划线");
assert.equal(safeSegment(""), "unknown", "空字符串回退 unknown");
assert.equal(safeSegment("!@#$%^"), "______", "全部特殊字符替换为下划线");

// ---------------------------------------------------------------- sseData

assert.equal(sseData({ a: 1 }), "data: {\"a\":1}\n\n", "JSON SSE 序列化");
assert.equal(sseData("hello"), "data: \"hello\"\n\n", "字符串 SSE 带转义");
assert.equal(sseData([1, 2, 3]), "data: [1,2,3]\n\n", "数组 SSE 序列化");
assert.equal(sseData(null), "data: null\n\n", "null SSE 序列化");

// ---------------------------------------------------------------- parseUserAdapters

assert.deepEqual(parseUserAdapters(undefined), [], "undefined 返回空数组");
assert.deepEqual(parseUserAdapters(""), [], "空字符串返回空数组");
assert.deepEqual(parseUserAdapters("not json"), [], "非法 JSON 返回空数组");
assert.deepEqual(parseUserAdapters("[]"), [], "裸数组（非对象）返回空数组");
assert.deepEqual(parseUserAdapters('{"adapters": "not array"}'), [], "adapters 非数组返回空数组");
assert.deepEqual(parseUserAdapters('{"adapters": [{"id":"a","providers":["p1"],"file":"/x.mjs"}]}'), [
  { id: "a", label: "a", providers: ["p1"], file: "/x.mjs" },
], "合法条目解析");
assert.deepEqual(parseUserAdapters('{"adapters": [{"id":"","providers":["p1"],"file":"/x.mjs"}]}'), [],
  "空 id 条目丢弃");
assert.deepEqual(parseUserAdapters('{"adapters": [{"id":"a","providers":[],"file":"/x.mjs"}]}'), [],
  "空 providers 条目丢弃");
assert.deepEqual(parseUserAdapters('{"adapters": [{"id":"a","providers":["p1"],"file":""}]}'), [],
  "空 file 条目丢弃");
assert.deepEqual(parseUserAdapters('{"adapters": [{"id":"a","providers":["p1"],"file":"/x.mjs","label":"My Adp"}]}'), [
  { id: "a", label: "My Adp", providers: ["p1"], file: "/x.mjs" },
], "label 保留");
assert.deepEqual(parseUserAdapters('{"adapters": [{"id":"a","providers":["p1",""],"file":"/x.mjs"}]}'), [
  { id: "a", label: "a", providers: ["p1"], file: "/x.mjs" },
], "空 provider 字符串过滤");

// ---------------------------------------------------------------- summarizeTextFromWindows (deprecated)

assert.equal(summarizeTextFromWindows(undefined), "", "undefined 窗口返回空");
assert.equal(summarizeTextFromWindows([]), "", "空数组返回空");
assert.equal(summarizeTextFromWindows([{ key: "5h", name: "5h 滚动", percent: 5 }]), "5h 滚动 5%",
  "单窗口百分比展示");
assert.equal(summarizeTextFromWindows([{ key: "w", name: "每周", percent: 80 }]), "每周 80%",
  "整百分比无小数");
assert.equal(summarizeTextFromWindows([{ key: "r", name: "5h 滚动", percent: 5 }, { key: "w", name: "每周", percent: null }]),
  "5h 滚动 5% · 每周 --", "null 百分比显示 --");

// ---------------------------------------------------------------- levelFromWindows (deprecated)

assert.equal(levelFromWindows(undefined), "off", "undefined 窗口返回 off");
assert.equal(levelFromWindows([]), "off", "空数组返回 off");
assert.equal(levelFromWindows([{ key: "r", percent: 10 }]), "ok", "10% → ok");
assert.equal(levelFromWindows([{ key: "r", percent: 80 }]), "warn", "80% → warn");
assert.equal(levelFromWindows([{ key: "r", percent: 95 }]), "err", "95% → err");
assert.equal(levelFromWindows([{ key: "r", percent: 100 }]), "err", "100% → err");
assert.equal(levelFromWindows([{ key: "r", percent: null }]), "off", "null 百分比 → off");
assert.equal(levelFromWindows([{ key: "r", percent: 10 }, { key: "w", percent: 90 }]), "warn",
  "多窗口取最差（90 → warn，≥80 即为 warn）");