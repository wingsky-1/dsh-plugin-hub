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
  ERROR_CODES,
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

// ---------------------------------------------------------------- ERROR_CODES 全量清单（#150 分片 2）

assert.deepEqual(ERROR_CODES, [
  "no-provider",
  "no-adapter",
  "no-enabled-adapter",
  "no-api-key",
  "unauthorized",
  "timeout",
  "network",
  "bad-data",
  "bad-json",
  "adapter-load-failed",
  "adapter-crash",
  "adapter-timeout",
], "错误码清单逐项锁定（顺序与内容均不可变）");

// ---------------------------------------------------------------- isUsageStatsAdapter 补充边界（#150 分片 2）

{
  // String 包装对象：typeof 非 string，但 .length 与 regex.test 均可通过，
  // 用于区分「typeof name 恒真」类变异（后续检查全部放行的伪装类型）
  const a = validAdapter();
  a.name = new String("abc");
  assert.equal(isUsageStatsAdapter(a), false, "name 为 String 包装对象拒绝（严格 typeof）");
}
{
  // 元素为非字符串但带 length 的值：every 回调 typeof 恒真变异下会放行
  const a = validAdapter();
  a.providers = [[1, 2]];
  assert.equal(isUsageStatsAdapter(a), false, "providers 元素为数组（length>0 非字符串）拒绝");
}

// ---------------------------------------------------------------- describeUsageStatsAdapterShape 补充边界（#150 分片 2）

{
  // 头部非法尾部合法：regex 去 ^ 锚变异后不再报 name 缺失
  const a = validAdapter();
  a.name = "!!ab";
  assert.ok(describeUsageStatsAdapterShape(a)?.includes("name（") === true,
    "name 头部白名单外仍报缺失（锚点 ^ 必需）");
}
{
  // 头部合法尾部非法：regex 去 $ 锚变异后不再报 name 缺失
  const a = validAdapter();
  a.name = "ab!!";
  assert.ok(describeUsageStatsAdapterShape(a)?.includes("name（") === true,
    "name 尾部白名单外仍报缺失（锚点 $ 必需）");
}
{
  // 其余字段全合法、仅 providers 空数组：length===0 判定不可移除
  const d = describeUsageStatsAdapterShape({
    version: ADAPTER_CONTRACT_VERSION,
    name: "ok-name",
    providers: [],
    fetchData: () => {},
    formatCapsule: () => {},
    formatPanel: () => {},
  });
  assert.ok(d !== null && d.includes("providers（非空字符串数组）"),
    "空 providers 在其余字段合法时单独报缺失");
}
// ================================================================ #150 二阶段：registry 全分支矩阵

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeAdapterRegistry, sanitizeHtml, safeFetchData, safeFormat, fetchWithTimeout,
  runV2Pipeline, runV2PanelPipeline, capsuleHtmlFromHistory, HistoryStore,
  HotReloadableAdapter, readStamp, stampEqual, miniChartSvgMarkup,
  OPENCODE_GO_PROVIDER } from "../lib/index.js";

/** 构造合法 v2 适配器（可覆写字段）。 */
function mkAdapter(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: ADAPTER_CONTRACT_VERSION,
    name: "adapter-a",
    label: "Adapter A",
    providers: ["prov-x"],
    fetchData: async () => ({}),
    formatCapsule: () => "<span>a</span>",
    formatPanel: () => "<p>a</p>",
    ...over,
  };
}

// register：契约失败分支（带 file / 无 file 两种诊断路径）
{
  const reg = makeAdapterRegistry();
  assert.equal(reg.register({ version: 1 }, "builtin"), false, "契约不满足拒绝注册");
  const withFile = makeAdapterRegistry();
  assert.equal(withFile.register({ foo: 1 }, "user-file", "/tmp/x.mjs"), false, "用户文件契约失败返回 false");
}

// register：name 重复拒绝 + registeredNames 隔离
{
  const reg = makeAdapterRegistry();
  assert.equal(reg.register(mkAdapter(), "builtin"), true);
  assert.equal(reg.hasName("adapter-a"), true, "hasName 注册后为真");
  // 同 name 不同 provider 的第二个适配器仍被拒（name 全局唯一）
  assert.equal(reg.register(mkAdapter({ providers: ["prov-y"] }), "builtin"), false, "同 name 跨 provider 也拒");
  assert.equal(reg.getEntry("prov-y"), undefined, "被拒者未进入候选");
}

// register：enabledHint=false 只入候选不启用
{
  const reg = makeAdapterRegistry();
  assert.equal(reg.register(mkAdapter(), "user-file", "/f.mjs", false), true, "enabledHint=false 注册成功");
  assert.equal(reg.getEntry("prov-x"), undefined, "未成为启用条目");
  assert.equal(reg.hasCandidates("prov-x"), true, "候选仍在");
  assert.equal(reg.isEnabled("prov-x", "adapter-a"), false, "isEnabled false");
  assert.equal(reg.select("prov-x", "adapter-a"), true, "手动切换成功");
  assert.equal(reg.isEnabled("prov-x", "adapter-a"), true, "切换后启用");
}

// select：清空幂等 / 未知名 false / get 与 getEntry 一致性
{
  const reg = makeAdapterRegistry();
  assert.equal(reg.select("nope", null), true, "清空恒成功（幂等）");
  assert.equal(reg.select("nope", "ghost"), false, "未知 provider+name 返回 false");
  reg.register(mkAdapter(), "builtin");
  assert.equal(reg.get("prov-x") !== undefined, true, "get 返回适配器本体");
  reg.select("prov-x", null);
  assert.equal(reg.get("prov-x"), undefined, "清空后 get undefined");
  assert.deepEqual(reg.enabledProviders(), [], "清空后 enabledProviders 为空");
}

// snapshot：多 provider 认领去重（同一条目按 name/provider 去重）+ errors 列表
{
  const reg = makeAdapterRegistry();
  reg.register(mkAdapter({ providers: ["px", "py"] }), "builtin");
  reg.recordError("k1", "load", "加载失败消息");
  reg.recordError("k2", "exec", "执行超时消息");
  const snap = reg.snapshot();
  assert.equal(snap.infos.length, 2, "双 provider 认领产生两个 info 行");
  assert.deepEqual(snap.enabled, { px: "adapter-a", py: "adapter-a" }, "enabled 映射完整");
  assert.ok(snap.infos.every((i) => i.enabled === true), "默认全部启用标记");
  assert.equal(snap.errors.find((e) => e.key === "k1")?.kind, "load", "errors kind=load");
  assert.equal(snap.errors.find((e) => e.key === "k2")?.kind, "exec", "errors kind=exec");
  assert.deepEqual(snap.enabledProviders.sort(), ["px", "py"], "snapshot.enabledProviders 完整");
}

// recordError 同 key 覆盖（只保留最近一次）
{
  const reg = makeAdapterRegistry();
  reg.recordError("dup", "load", "第一次");
  reg.recordError("dup", "exec", "第二次");
  const snap = reg.snapshot();
  const dupErrors = snap.errors.filter((e) => e.key === "dup");
  assert.equal(dupErrors.length, 1, "同 key 仅保留最近一次");
  assert.equal(dupErrors[0].message, "第二次", "覆盖为新消息");
}

// removeByFile：计数 + registeredNames/enabled 引用清理
{
  const reg = makeAdapterRegistry();
  reg.register(mkAdapter({ name: "f-one" }), "user-file", "/a.mjs");   // prov-x 启用 f-one
  reg.register(mkAdapter({ name: "f-two", providers: ["pz"] }), "user-file", "/b.mjs");
  const removed = reg.removeByFile("/a.mjs");
  assert.equal(removed, 1, "removeByFile 移除计数");
  assert.equal(reg.hasName("f-one"), false, "registeredNames 清理 f-one");
  assert.equal(reg.hasName("f-two"), true, "f-two 不受影响");
  assert.equal(reg.getEntry("prov-x"), undefined, "f-one 的 enabled 引用清理");
  assert.notEqual(reg.getEntry("pz"), undefined, "f-two 启用不受影响");
  // 全移除后 enabledProviders 空
  reg.removeByFile("/b.mjs");
  assert.deepEqual(reg.enabledProviders(), [], "全部移除后无启用 provider");
  // 不存在的 file → 0
  assert.equal(reg.removeByFile("/ghost.mjs"), 0, "移除不存在文件计 0");
}

// ================================================================ #150 二阶段：sanitizeHtml 白名单矩阵

assert.equal(sanitizeHtml(""), "", "空串直通");
assert.equal(sanitizeHtml("<p>plain</p>"), "<p>plain</p>", "无害 HTML 原样");

// 元素级移除（含成对标签与自闭合形态）
assert.equal(sanitizeHtml('<script>alert(1)</script>ok'), "ok", "script 成对移除");
assert.equal(sanitizeHtml('<iframe src="x"></iframe>ok'), "ok", "iframe 移除");
assert.equal(sanitizeHtml('<frame src="x"></frame>ok'), "ok", "frame 移除");
assert.equal(sanitizeHtml('<object data="x"></object>ok'), "ok", "object 移除");
assert.equal(sanitizeHtml('<embed src="x"></embed>ok'), "ok", "embed 成对移除（正则要求闭合标签，自闭合形态不在净化范围——现状行为）");
assert.equal(sanitizeHtml('<meta charset="utf-8">ok'), "ok", "meta 移除");
assert.equal(sanitizeHtml('<link rel="stylesheet" href="x">ok'), "ok", "link 移除");
assert.equal(sanitizeHtml('<base href="x">ok'), "ok", "base 移除");
assert.equal(sanitizeHtml("<div>keep</div><SCRIPT>x</SCRIPT>tail"), "<div>keep</div>tail", "大写 SCRIPT 大小写不敏感");

// on* 事件属性三种引号形态
assert.equal(sanitizeHtml('<img src="a.png" onclick="evil()">'), '<img src="a.png">', "onclick 双引号移除");
assert.equal(sanitizeHtml("<img src='a.png' onload='evil()'>"), "<img src='a.png'>", "onload 单引号移除");
assert.equal(sanitizeHtml("<img src=a.png onerror=evil()>"), "<img src=a.png>", "onerror 无引号移除");

// 危险协议与 CSS 表达式
assert.equal(sanitizeHtml('<a href="javascript:alert(1)">c</a>'), '<a href="alert(1)">c</a>', "javascript: 协议剥除");
assert.equal(sanitizeHtml('<a href="JaVaScRiPt:x">c</a>'), '<a href="x">c</a>', "协议大小写变体剥除");
assert.equal(sanitizeHtml('<a href="data:text/html;base64,x">c</a>'), '<a href=";base64,x">c</a>', "data:text/html 剥除");
assert.equal(sanitizeHtml('<div style="width: expression(alert(1))">x</div>'), '<div style="width: alert(1))">x</div>', "expression( 剥除");

// ================================================================ #150 二阶段：guards 边界

// safeFetchData：序列化校验（数组/标量/null 拒绝）
{
  const arr = await safeFetchData(async () => [1, 2]);
  assert.match(arr.error as string, /必须返回对象/, "数组返回被拒");

  const nul = await safeFetchData(async () => null);
  assert.match(nul.error as string, /必须返回对象/, "null 返回被拒");

  const str = await safeFetchData(async () => "text");
  assert.match(str.error as string, /必须返回对象/, "字符串返回被拒");

  const ok = await safeFetchData(async () => ({ v: 1 }));
  assert.deepEqual(ok.data, { v: 1 }, "对象正常透传");

  const thrown = await safeFetchData(async () => { throw new Error("boom"); });
  assert.equal(thrown.error, "boom", "fetchData 抛错隔离为 error 字段");

  const thrownStr = await safeFetchData(async () => { throw "raw-str"; });
  assert.equal(thrownStr.error, "raw-str", "非 Error 抛出物 String() 化");

  // 超时：timeoutMs 最小化 + 永不 resolve 的 promise
  const slow = await safeFetchData(() => new Promise(() => {}), 30);
  assert.match(slow.error as string, /超时/, "慢 fetchData 超时中断");
}

// safeFormat：非字符串返回 / 抛错 / 超时
{
  const badType = await safeFormat(() => 42 as unknown as string, "formatCapsule");
  assert.match(badType.error as string, /必须返回字符串/, "非字符串 HTML 拒绝");

  const thrown = await safeFormat(() => { throw new Error("fmt-boom"); }, "formatCapsule");
  assert.equal(thrown.error, "fmt-boom", "format 抛错隔离");

  const slow = await safeFormat(() => new Promise<string>(() => {}) as unknown as string, "formatPanel", 30);
  assert.match(slow.error as string, /formatPanel 超时/, "异步 format 超时带函数名");

  const ok = await safeFormat(() => "<b>hi</b>", "formatCapsule");
  assert.equal(ok.html, "<b>hi</b>", "同步 format 正常返回");
}

// ================================================================ #150 二阶段：pipeline v2 分支

function mkV2Adapter(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: ADAPTER_CONTRACT_VERSION,
    name: "pipe-a",
    providers: ["pv"],
    fetchData: async () => ({ used: 1 }),
    formatCapsule: () => "<span>capsule</span>",
    formatPanel: () => "<p>panel</p>",
    ...over,
  };
}

{
  // 成功路径：fresh + rawData + capsule 净化
  const r = await runV2Pipeline({
    adapter: mkV2Adapter() as never,
    provider: "pv",
    config: { apiEndpoint: "http://127.0.0.1:9", apiKey: "sk" },
    staticPath: "",
    timeoutMs: 1000,
  });
  assert.equal(r.ok, true, "管道成功 ok");
  assert.equal(r.status, "fresh", "管道状态 fresh");
  assert.deepEqual(r.rawData, { used: 1 }, "rawData 透传");
  assert.equal(r.capsuleHtml, "<span>capsule</span>", "胶囊经净化输出");
}
{
  // fetchData 失败 → fetch-failed stale
  const r = await runV2Pipeline({
    adapter: mkV2Adapter({ fetchData: async () => { throw new Error("net-down"); } }) as never,
    provider: "pv",
    config: {},
    staticPath: "",
    timeoutMs: 500,
  });
  assert.equal(r.ok, false, "fetch 失败 ok=false");
  assert.equal(r.reason, "fetch-failed", "reason=fetch-failed");
  assert.equal(r.error, "net-down", "错误信息透传");
  assert.equal(r.status, "stale", "fetch 失败状态 stale");
}
{
  // formatCapsule 注入脚本 → 净化兜底
  const r = await runV2Pipeline({
    adapter: mkV2Adapter({ formatCapsule: () => '<span onclick="x()">t</span>' }) as never,
    provider: "pv",
    config: {},
    staticPath: "",
    timeoutMs: 500,
  });
  assert.equal(r.capsuleHtml, "<span>t</span>", "胶囊 XSS 属性被净化");
}

{
  // 面板管道：正常 / formatPanel 抛错
  const store = new HistoryStore({ root: mkdtempSync(join(tmpdir(), "dou-pipe-")) });
  const day = new Date().setHours(12, 0, 0, 0);
  await store.append("pv", "pipe-a", { time: day, data: { v: 1 } });

  const okP = await runV2PanelPipeline({
    adapter: mkV2Adapter() as never,
    provider: "pv",
    history: store,
    range: { start: day - 1000, end: day + 1000 },
  });
  assert.equal(okP.panelHtml, "<p>panel</p>", "面板 HTML 输出");

  const badP = await runV2PanelPipeline({
    adapter: mkV2Adapter({ formatPanel: () => { throw new Error("panel-boom"); } }) as never,
    provider: "pv",
    history: store,
    range: { start: day - 1000, end: day + 1000 },
  });
  assert.match(badP.error as string, /panel-boom/, "formatPanel 抛错进 error 字段");

  // 空历史 → entries 空，formatPanel 收到空列表
  const emptyP = await runV2PanelPipeline({
    adapter: mkV2Adapter({ formatPanel: (i: { entries: unknown[] }) => `n=${i.entries.length}` }) as never,
    provider: "zz",
    history: store,
    range: { start: day - 1000, end: day + 1000 },
  });
  assert.equal(emptyP.panelHtml, "n=0", "空历史 entries 为 0");

  // capsuleHtmlFromHistory：有历史回退文本、无历史 undefined
  const capOk = await capsuleHtmlFromHistory(store, "pv", "pipe-a", "fallback-text");
  assert.equal(capOk, "<span>fallback-text</span>", "历史回退胶囊文本");
  const capMiss = await capsuleHtmlFromHistory(store, "ghost", "none", "fb");
  assert.equal(capMiss, undefined, "无历史返回 undefined");
}

// ================================================================ #150 二阶段：hotreload 纯函数与轮询

{
  // stampEqual 四象限
  assert.equal(stampEqual(null, null), true, "双 null 相等");
  assert.equal(stampEqual(null, { mtimeMs: 1, size: 1 }), false, "null vs 值不等");
  assert.equal(stampEqual({ mtimeMs: 1, size: 1 }, null), false, "值 vs null 不等");
  assert.equal(stampEqual({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 3 }), false, "size 差异不等");
  assert.equal(stampEqual({ mtimeMs: 5, size: 5 }, { mtimeMs: 5, size: 5 }), true, "全等通过");

  // readStamp：不存在 null、存在取值
  assert.equal(await readStamp("/nonexistent/path/x"), null, "readStamp 缺失返回 null");
  const tmpF = join(mkdtempSync(join(tmpdir(), "dou-hr-stamp-")), "f.mjs");
  writeFileSync(tmpF, "x", "utf8");
  const st = await readStamp(tmpF);
  assert.ok(st !== null && typeof st.mtimeMs === "number" && st.size === 1, "readStamp 取到 mtime+size");
}

{
  // HotReloadableAdapter：start 文件缺失失败回调；pollOnce 文件删除保留 current
  const dir = mkdtempSync(join(tmpdir(), "dou-hr-cls-"));
  const missing = join(dir, "missing.mjs");
  const events: Array<{ ok: boolean; error?: string }> = [];
  const hrMissing = new HotReloadableAdapter(missing, 60000, (i) => events.push(i));
  const started = await hrMissing.start();
  assert.equal(started.ok, false, "start 文件缺失失败");
  assert.match(started.error as string, /不存在或不可读/, "start 错误信息");
  assert.equal(events.length, 1, "onReload 收到失败事件");

  // 合法文件启动 + 变更后 pollOnce 原子切换 + 删除后保留旧版
  const good = join(dir, "good.mjs");
  writeFileSync(good, `
export const version = ${ADAPTER_CONTRACT_VERSION};
export const name = "hr-unit";
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>v1</span>"; }
export function formatPanel() { return "<p>v1</p>"; }
`, "utf8");
  const hr = new HotReloadableAdapter(good, 60000);
  const startedOk = await hr.start();
  assert.equal(startedOk.ok, true, "合法文件启动成功");
  assert.notEqual(hr.current, null, "current 已装载");
  hr.stop(); // 停表后手动 poll

  // 内容变更（mtime 变化）→ 重载
  const { utimesSync } = await import("node:fs");
  writeFileSync(good, `
export const version = ${ADAPTER_CONTRACT_VERSION};
export const name = "hr-unit";
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return { v: 2 }; }
export function formatCapsule() { return "<span>v2</span>"; }
export function formatPanel() { return "<p>v2</p>"; }
`, "utf8");
  const future = new Date(Date.now() + 5000);
  utimesSync(good, future, future);
  const polled = await hr.pollOnce();
  assert.equal(polled.ok, true, "变更后 poll 成功");
  assert.notEqual(hr.current, null, "变更后 current 保持装载");

  // 校验失败的替换内容 → reload 报错且 current 不动
  writeFileSync(good, 'export const version = 1; export const name = "bad";', "utf8");
  utimesSync(good, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
  const badReload = await hr.pollOnce();
  assert.equal(badReload.ok, false, "非法新版本 poll 失败");
  assert.match(badReload.error as string, /契约校验失败/, "reload 错误信息");

  // 文件删除 → 保留当前适配器不切换
  const { unlinkSync } = await import("node:fs");
  unlinkSync(good);
  const delPoll = await hr.pollOnce();
  assert.equal(delPoll.ok, true, "删除场景 poll 恒 ok");
  assert.notEqual(hr.current, null, "删除后 current 保留旧版");
}

// ================================================================ #150 二阶段：图表纯函数结构断言（miniChartSvgMarkup）

// 样本不足 2 点 → 空 SVG
assert.equal(miniChartSvgMarkup({
  samples: [{ x: 1, y: 50 }],
  color: "#fff", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
}), "", "样本 <2 返回空串");

// 基本结构：svg 包裹 + 平滑曲线 + 终点圆点 + 网格线
{
  const t0 = Date.UTC(2026, 0, 1, 0, 0);
  const svg = miniChartSvgMarkup({
    samples: [
      { x: t0, y: 10 },
      { x: t0 + 3600000, y: 40 },
      { x: t0 + 7200000, y: 70 },
    ],
    color: "#123456", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(svg.startsWith("<svg"), "SVG 开头");
  assert.ok(svg.includes('viewBox="0 0 320 100"'), "视口尺寸固定");
  assert.ok(svg.includes("stroke:#123456"), "曲线使用传入色");
  assert.ok(svg.includes("<circle"), "终点圆点存在");
  assert.ok(svg.includes('stroke-dasharray:"3 3"') || svg.includes("dasharray"), "网格虚线存在");
  assert.ok(svg.includes("100%"), "lo=0/hi=100 满足 lo<=100<=hi 且域宽>0.01 → 参考线存在");
}
{
  // domain 含 100% 参考线：hi=80 时 100% 线不可见；hi<100 且 dmax>=90 强制抬到 100 的行为经 niceDomain 间接生效
  const t0 = Date.UTC(2026, 0, 1, 0, 0);
  const noRefLine = miniChartSvgMarkup({
    samples: [{ x: t0, y: 10 }, { x: t0 + 60000, y: 60 }],
    color: "#000", lo: 0, hi: 50, resetsAt: undefined, resetPeriodMs: 0, dateOnly: true,
  });
  assert.ok(noRefLine.includes("100%") === false, "hi=50 < 100 时无 100% 参考线");
  const withRefLine = miniChartSvgMarkup({
    samples: [{ x: t0, y: 10 }, { x: t0 + 60000, y: 95 }],
    color: "#000", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: true,
  });
  assert.ok(withRefLine.includes("100%"), "hi=100 且域宽 >0.01 时有 100% 参考线");
}
{
  // 重置标记线：resetsAt 落在窗口内 → title「窗口重置点」出现；周期外推的历史点也在
  const t0 = Date.UTC(2026, 0, 1, 0, 0);
  const resetAt = new Date(t0 + 3600000).toISOString();
  const svg = miniChartSvgMarkup({
    samples: [{ x: t0, y: 10 }, { x: t0 + 7200000, y: 30 }],
    color: "#000", lo: 0, hi: 100,
    resetsAt: resetAt, resetPeriodMs: 3600000, dateOnly: false,
  });
  const marks = svg.split("窗口重置点").length - 1;
  assert.ok(marks >= 2, `重置点标记含当期与外推历史（实际 ${marks} 个）`);
}
{
  // resetsAt 无效值 → 无标记
  const t0 = Date.UTC(2026, 0, 1, 0, 0);
  const svgNone = miniChartSvgMarkup({
    samples: [{ x: t0, y: 10 }, { x: t0 + 60000, y: 20 }],
    color: "#000", lo: 0, hi: 100, resetsAt: "garbage", resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(!svgNone.includes("窗口重置点"), "非法 resetsAt 无标记");
}

// downsample：>300 点降采样后仍 ≤301 点且保留末点
{
  const t0 = Date.UTC(2026, 0, 1, 0, 0);
  const many = Array.from({ length: 700 }, (_, i) => ({ x: t0 + i * 1000, y: i % 97 }));
  const svg = miniChartSvgMarkup({
    samples: many, color: "#000", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: true,
  });
  const circles = svg.split("<circle").length - 1;
  assert.equal(circles, 1, "降采样后仍只有一个终点圆点（渲染未崩）");
  assert.ok(svg.length < 100000, "降采样控制了输出体积");
}

// smoothPath：单点返回空串（pts<2 分支）
// （smoothPath 未导出，经由 samples<2 已覆盖；此处补两点的 path 形状断言）
{
  const t0 = Date.UTC(2026, 0, 1, 0, 0);
  const svg = miniChartSvgMarkup({
    samples: [{ x: t0, y: 0 }, { x: t0 + 60000, y: 100 }],
    color: "#000", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
  });
  assert.ok(svg.includes("C "), "两点曲线走三次贝塞尔（平滑）");
  assert.ok(svg.includes("fill-opacity:.13"), "面积图填充透明度存在");
}
