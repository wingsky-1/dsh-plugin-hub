// @ts-nocheck
/**
 * dsh-web-file-preview — unit：文件链接识别纯逻辑（link-resolver）。
 *
 * 覆盖：basenameOf（归一化比较）、decideGate（点击闸门）、
 * resolveFileLink（凭证优先级/文本后备/芯片旁路/文件夹语义）。
 *
 * 测试全部使用 ResolverNode DTO（最小节点投影），无 DOM 依赖。
 */
import { assert } from "./helpers.ts";
import { basenameOf, decideGate, resolveFileLink } from "../lib/index.js";

/** 构造最小节点投影。 */
function n(text, tag, attrs, parent) {
  return { text, tag, attrs: attrs || {}, parent: parent || null };
}

// ---------------------------------------------------------------- basenameOf

assert.equal(basenameOf("/a/b/c.ts"), "c.ts", "Unix 路径 basename");
assert.equal(basenameOf("C:\\Users\\doc.md"), "doc.md", "Windows 路径 basename");
assert.equal(basenameOf("a/b/c.ts"), "c.ts", "相对路径 basename");
assert.equal(basenameOf("c.ts"), "c.ts", "裸文件名 basename");
assert.equal(basenameOf(""), "", "空字符串返回空");
assert.equal(basenameOf("a/b\\c.ts"), "c.ts", "混合分隔符取最后一段");
assert.equal(basenameOf("  /a/b.ts  "), "b.ts", "首尾空白 trim");
assert.equal(basenameOf("a/b.TS"), "b.ts", "小写归一化");

// ---------------------------------------------------------------- decideGate

function probe(sel) {
  return { matches: (s) => s === sel };
}

assert.equal(decideGate(probe("[data-dsh-no-preview]"), ["[data-chat-flow]"]), "pass", "豁免属性优先放行");
assert.equal(decideGate(probe("[data-chat-flow]"), ["[data-chat-flow]"]), "inspect", "作用域匹配进入解析");
assert.equal(decideGate(probe("[data-chat-anchor-key]"), ["[data-chat-flow]", "[data-chat-anchor-key]"]), "inspect", "多作用域之一匹配");
assert.equal(decideGate(probe("unknown"), ["[data-chat-flow]"]), "pass", "无匹配放行");
assert.equal(decideGate(probe("[data-dsh-no-preview]"), []), "pass", "豁免属性无需作用域即放行");
assert.equal(decideGate(probe("unknown"), []), "pass", "无作用域无豁免放行");

// ---------------------------------------------------------------- resolveFileLink

// 凭证优先：data-ref-chip="file" 的 title 立即返回
assert.deepEqual(resolveFileLink(n("", "SPAN", { "data-ref-chip": "file", title: "@/abs/path.ts" })),
  { path: "/abs/path.ts", kind: "file" }, "chip file 权威凭证");

// chip folder 返回 folder 语义
assert.deepEqual(resolveFileLink(n("", "SPAN", { "data-ref-chip": "folder", title: "@/a/dir/" })),
  { path: null, kind: "folder" }, "chip folder 提示语义");

// chip session/skill 跳过本节点
assert.equal(resolveFileLink(n("", "SPAN", { "data-ref-chip": "session" })), null, "chip session 跳过返回 null");

// A[href] 凭证
assert.deepEqual(
  resolveFileLink(n("", "A", { href: "/abs/path.ts" })),
  { path: "/abs/path.ts", kind: "file" },
  "A[href] 凭证",
);

// title 凭证
assert.deepEqual(
  resolveFileLink(n("", "SPAN", { title: "/abs/path.ts" })),
  { path: "/abs/path.ts", kind: "file" },
  "title 凭证",
);

// 文本后备：无凭证时回退文本命中
assert.deepEqual(
  resolveFileLink(n("src/a.ts", "CODE", {}, null)),
  { path: "src/a.ts", kind: "file" },
  "CODE 文本回退",
);

// 凭证与文本命中 basename 一致 → 采信凭证
assert.deepEqual(
  resolveFileLink(n("a.ts", "SPAN", {}, n("", "SPAN", { title: "/abs/path/a.ts" }, null))),
  { path: "/abs/path/a.ts", kind: "file" },
  "凭证与文本 basename 一致则采信凭证完整路径",
);

// 凭证与文本命中 basename 不一致 → 跳过凭证继续向上
assert.deepEqual(
  resolveFileLink(n("b.ts", "SPAN", {}, n("", "SPAN", { title: "/abs/path/a.ts" }, null))),
  { path: "b.ts", kind: "file" },
  "凭证与文本 basename 不一致则跳过凭证，回退文本",
);

// 纯文本路径 > 1024 字符不命中
assert.deepEqual(
  resolveFileLink(n("a".repeat(1025), "CODE", {}, null)),
  null,
  "超长文本不命中",
);

// 非 path-like 文本不命中
assert.equal(resolveFileLink(n("a.xyz", "CODE", {}, null)), null, "不可预览后缀文本不命中");

// 无 title / href / chip 的非 CODE/SPAN/A/BUTTON 标签不提取文本
assert.equal(resolveFileLink(n("a.ts", "DIV", {}, null)), null, "DIV 文本不命中");

// 多层嵌套：session chip 跳过本层祖先，但祖先 title 凭证仍需与文本 basename 一致
assert.deepEqual(
  resolveFileLink(n("a.ts", "SPAN", {}, n("", "SPAN", { "data-ref-chip": "session" }, n("", "SPAN", { title: "/abs/path/a.ts" }, null)))),
  { path: "/abs/path/a.ts", kind: "file" },
  "session chip 跳过本层，祖先 title 凭证与文本 basename 一致则采信",
);

// 祖先 title 凭证与文本 basename 不一致 → 回退文本命中
assert.deepEqual(
  resolveFileLink(n("a.ts", "SPAN", {}, n("", "SPAN", { "data-ref-chip": "session" }, n("", "SPAN", { title: "/abs/other/b.ts" }, null)))),
  { path: "a.ts", kind: "file" },
  "祖先 title 凭证 basename 不一致则跳过，回退文本命中",
);