// @ts-nocheck
/**
 * dsh-provider-usage — unit：契约辅助纯函数。
 *
 * 覆盖：safeSegment（路径安全段）、sseData（SSE 序列化）、
 * parseUserAdapters（防御式解析）、summarizeTextFromWindows /
 * levelFromWindows（v1 废弃但保留的辅助函数）、esc（HTML 转义）、
 * isUsageStatsAdapter / describeUsageStatsAdapterShape（v2 契约校验全分支，
 * #150 变异驱动加固）。
 */
import { assert } from "./helpers.ts";
import {
  safeSegment,
  sseData,
  parseUserAdapters,
  summarizeTextFromWindows,
  levelFromWindows,
  esc,
  isUsageStatsAdapter,
  describeUsageStatsAdapterShape,
  ADAPTER_CONTRACT_VERSION,
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
assert.equal(levelFromWindows("not array" as unknown as Parameters<typeof levelFromWindows>[0]), "off",
  "非数组输入返回 off（#150）");
assert.equal(levelFromWindows([{ key: "r", percent: 79.9 }]), "ok", "79.9 < 80 → ok 边界（#150）");
assert.equal(levelFromWindows([{ key: "r", percent: 94.9 }]), "warn", "94.9 < 95 → warn 边界（#150）");
assert.equal(levelFromWindows([{ key: "r" }]), "off", "缺 percent 字段 → off（#150）");
assert.equal(levelFromWindows([{ key: "r", percent: 30 }, { key: "w", percent: null }]), "ok",
  "null 混合窗口只计数值项（#150）");

// ---------------------------------------------------------------- esc（#150）

assert.equal(esc(null), "", "null 转义为空串");
assert.equal(esc(undefined), "", "undefined 转义为空串");
assert.equal(esc(""), "", "空字符串原样");
assert.equal(esc("plain"), "plain", "无特殊字符原样");
assert.equal(esc("<a>"), "&lt;a&gt;", "尖括号转义");
assert.equal(esc('a"b'), "a&quot;b", "双引号转义");
assert.equal(esc("a'b"), "a&#39;b", "单引号转义");
assert.equal(esc("a&b"), "a&amp;b", "与号转义");
assert.equal(esc('<script>&"\'</script>'),
  "&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;", "五类实体一次全转义");
assert.equal(esc(42), "42", "数字经 String() 后转义");
assert.equal(esc(true), "true", "布尔经 String() 后转义");

// ---------------------------------------------------------------- isUsageStatsAdapter 全条件穷举（#150）

function validAdapter(): Record<string, unknown> {
  return {
    version: ADAPTER_CONTRACT_VERSION,
    name: "my-adapter",
    providers: ["p1"],
    fetchData: () => {},
    formatCapsule: () => "",
    formatPanel: () => "",
  };
}

assert.equal(isUsageStatsAdapter(validAdapter()), true, "完整合法对象通过校验");

// 非对象侧
assert.equal(isUsageStatsAdapter(null), false, "null 拒绝");
assert.equal(isUsageStatsAdapter(undefined), false, "undefined 拒绝");
assert.equal(isUsageStatsAdapter(42), false, "数字拒绝");
assert.equal(isUsageStatsAdapter("str"), false, "字符串拒绝");
assert.equal(isUsageStatsAdapter([]), false, "数组（无 version 字段）拒绝");

// version 条件两侧
{
  const a = validAdapter();
  a.version = 1;
  assert.equal(isUsageStatsAdapter(a), false, "version=1（旧契约版本）拒绝");
}
{
  const a = validAdapter();
  a.version = "2";
  assert.equal(isUsageStatsAdapter(a), false, "version 为字符串严格比较拒绝");
}
{
  const a = validAdapter();
  delete a.version;
  assert.equal(isUsageStatsAdapter(a), false, "缺 version 拒绝");
}

// name 条件：类型 / 最短长度 / 正则白名单 / 最长长度
{
  const a = validAdapter();
  a.name = 123;
  assert.equal(isUsageStatsAdapter(a), false, "name 非字符串拒绝");
}
{
  const a = validAdapter();
  a.name = "a";
  assert.equal(isUsageStatsAdapter(a), false, "name 单字符拒绝（length>=2）");
}
{
  const a = validAdapter();
  a.name = "ab";
  assert.equal(isUsageStatsAdapter(a), true, "name 两字符通过（regex 下界）");
}
{
  const a = validAdapter();
  a.name = "a".repeat(64);
  assert.equal(isUsageStatsAdapter(a), true, "name 64 字符通过（regex 上界）");
}
{
  const a = validAdapter();
  a.name = "a".repeat(65);
  assert.equal(isUsageStatsAdapter(a), false, "name 65 字符拒绝（regex 上界外）");
}
{
  const a = validAdapter();
  a.name = "a b";
  assert.equal(isUsageStatsAdapter(a), false, "name 含空格拒绝（白名单外）");
}
{
  const a = validAdapter();
  a.name = "适配器";
  assert.equal(isUsageStatsAdapter(a), false, "name 含中文拒绝（白名单外）");
}

// providers 条件：非数组 / 空数组 / 元素类型 / 空串元素
{
  const a = validAdapter();
  a.providers = "p1";
  assert.equal(isUsageStatsAdapter(a), false, "providers 非数组拒绝");
}
{
  const a = validAdapter();
  a.providers = [];
  assert.equal(isUsageStatsAdapter(a), false, "providers 空数组拒绝");
}
{
  const a = validAdapter();
  a.providers = [1];
  assert.equal(isUsageStatsAdapter(a), false, "providers 元素非字符串拒绝");
}
{
  const a = validAdapter();
  a.providers = [""];
  assert.equal(isUsageStatsAdapter(a), false, "providers 空串元素拒绝");
}
{
  const a = validAdapter();
  a.providers = ["p1", ""];
  assert.equal(isUsageStatsAdapter(a), false, "providers 多元素含空串拒绝");
}

// 三函数条件
for (const fn of ["fetchData", "formatCapsule", "formatPanel"] as const) {
  const a = validAdapter();
  delete a[fn];
  assert.equal(isUsageStatsAdapter(a), false, `缺 ${fn} 拒绝`);
  const b = validAdapter();
  b[fn] = "not-fn";
  assert.equal(isUsageStatsAdapter(b), false, `${fn} 非函数拒绝`);
}

// ---------------------------------------------------------------- describeUsageStatsAdapterShape 全分支（#150）

assert.equal(describeUsageStatsAdapterShape(null), "导出不是对象（null）", "null 描述文案");
assert.equal(describeUsageStatsAdapterShape(undefined), "导出不是对象（undefined）", "undefined 描述文案");
assert.equal(describeUsageStatsAdapterShape(42), "导出不是对象（number）", "number 描述文案");
assert.equal(describeUsageStatsAdapterShape("s"), "导出不是对象（string）", "string 描述文案");
assert.equal(describeUsageStatsAdapterShape(validAdapter()), null, "合法形状返回 null");

assert.equal(describeUsageStatsAdapterShape({}), [
  "version 必须 === 2（实际 undefined）",
  "name（2-64 位字母数字下划线连字符）",
  "providers（非空字符串数组）",
  "fetchData（函数）",
  "formatCapsule（函数）",
  "formatPanel（函数）",
].join("、"), "全缺时六项按序合并");

{
  const a = validAdapter();
  a.version = 3;
  const detail = describeUsageStatsAdapterShape(a);
  assert.ok(detail !== null && detail.startsWith("version 必须 === 2（实际 3）"),
    "version 错误含期望值与实际值");
  assert.ok(detail !== null && !detail.includes("name"), "仅 version 缺陷时不报 name");
}
{
  const a = validAdapter();
  a.name = "x!";
  assert.ok(describeUsageStatsAdapterShape(a)?.includes("name（2-64 位字母数字下划线连字符）") === true,
    "name 白名单外的明细文案");
}