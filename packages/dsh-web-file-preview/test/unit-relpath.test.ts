// @ts-nocheck
/**
 * dsh-web-file-preview — unit：Markdown 相对引用路径展开（relpath）。
 *
 * 覆盖：resolveRelativePath 全部语义分支——同目录、./、../、query/fragment 丢弃、
 * %20 解码、绝对路径/协议相对/外域/data URI 不展开、/api/ 幂等保持、空/非法引用；
 * issue #45 新增：resolveAbsolutePath 绝对路径规范化分支与
 * splitReferenceFragment fragment 剥离分支。
 */
import { assert } from "./helpers.ts";
import { resolveRelativePath, resolveAbsolutePath, splitReferenceFragment } from "../src/index.ts";

const BASE = "/home/u/work/src/a.md";

// 正常展开
assert.equal(resolveRelativePath(BASE, "img.png"), "/home/u/work/src/img.png", "同目录");
assert.equal(resolveRelativePath(BASE, "./img.png"), "/home/u/work/src/img.png", "./ 相对引用");
assert.equal(resolveRelativePath(BASE, "../b.md"), "/home/u/work/b.md", "../ 上级目录");
assert.equal(resolveRelativePath(BASE, "docs/../c.md"), "/home/u/work/src/c.md", ".. 规范化");
assert.equal(resolveRelativePath(BASE, "sub/d.md"), "/home/u/work/src/sub/d.md", "子目录");

// query / fragment 丢弃
assert.equal(resolveRelativePath(BASE, "a.md?x=1"), "/home/u/work/src/a.md", "query 丢弃");
assert.equal(resolveRelativePath(BASE, "a.md#sec"), "/home/u/work/src/a.md", "fragment 丢弃");
assert.equal(resolveRelativePath(BASE, "a.md?x=1#sec"), "/home/u/work/src/a.md", "query+fragment 丢弃");

// 编码解码
assert.equal(resolveRelativePath(BASE, "%E4%B8%AD.md"), "/home/u/work/src/中.md", "UTF-8 编码解码");
assert.equal(resolveRelativePath(BASE, "file%20name.md"), "/home/u/work/src/file name.md", "空格编码解码");
assert.equal(resolveRelativePath(BASE, "%25encoded.md"), "/home/u/work/src/%encoded.md", "%25 双层层解码为 %（URL 解析 + decodeURIComponent 各一次）");

// 不展开分支
assert.equal(resolveRelativePath(BASE, "/etc/passwd"), null, "绝对路径 / 不展开");
assert.equal(resolveRelativePath(BASE, "https://x/a.md"), null, "http 链接不展开");
assert.equal(resolveRelativePath(BASE, "//cdn/x.png"), null, "协议相对不展开");
assert.equal(resolveRelativePath(BASE, "data:image/png;base64,AA=="), null, "data URI 不展开");
assert.equal(resolveRelativePath(BASE, "#sec"), null, "纯锚点不展开");
assert.equal(resolveRelativePath(BASE, "mailto:test@example.com"), null, "mailto 不展开");
assert.equal(resolveRelativePath(BASE, "file:///etc/passwd"), null, "file:// 协议不展开");

// 幂等：/api/ 前缀
assert.equal(resolveRelativePath(BASE, "/api/dsh-file-preview/file?path=/x"), null, "/api/ 前缀幂等保持");

// 空/非法
assert.equal(resolveRelativePath(BASE, ""), null, "空字符串返回 null");
assert.equal(resolveRelativePath(BASE, undefined), null, "undefined 返回 null");
assert.equal(resolveRelativePath(BASE, null), null, "null 返回 null");

// Windows 风格路径
assert.equal(resolveRelativePath("C:\\Users\\me\\doc.md", "img.png"), "/C:/Users/me/img.png", "Windows 基路径反斜杠转正斜杠（带前导 /，跟随实现）");

// 深层嵌套
assert.equal(resolveRelativePath(BASE, "../../other/file.md"), "/home/u/other/file.md", "../../ 两级上跳");

// baseFile 不含目录（裸文件名）→ URL 构造异常，返回 null
assert.equal(resolveRelativePath("readme.md", "img.png"), null, "裸文件名基路径无法解析，返回 null");

// ------------------------------------------------------------ issue #45：绝对路径展开（resolveAbsolutePath）

assert.equal(resolveAbsolutePath("/home/u/proj/docs/design.md"), "/home/u/proj/docs/design.md", "绝对路径原样保留");
assert.equal(resolveAbsolutePath("/home/u/proj/docs/../docs/design.md"), "/home/u/proj/docs/design.md", ".. 规范化");
assert.equal(resolveAbsolutePath("/a/b/./c.md"), "/a/b/c.md", ". 规范化");
assert.equal(resolveAbsolutePath("/x/%E4%B8%AD%E6%96%87.md"), "/x/中文.md", "UTF-8 编码解码");
assert.equal(resolveAbsolutePath("/x/my file.md"), "/x/my file.md", "含空格路径原样");
assert.equal(resolveAbsolutePath("//cdn/x.png"), null, "// 协议相对形态拒绝");
assert.equal(resolveAbsolutePath("rel/a.md"), null, "非 / 开头拒绝");
assert.equal(resolveAbsolutePath(""), null, "空字符串拒绝");
assert.equal(resolveAbsolutePath(undefined), null, "undefined 拒绝");
assert.equal(resolveAbsolutePath(null), null, "null 拒绝");

// ------------------------------------------------------------ issue #45：fragment 剥离（splitReferenceFragment）

assert.deepEqual(splitReferenceFragment("./f.md#g"), { ref: "./f.md", fragment: "g" }, "相对引用带锚点拆分");
assert.deepEqual(splitReferenceFragment("b.md"), { ref: "b.md", fragment: null }, "无锚点 fragment 为 null");
assert.deepEqual(splitReferenceFragment("#section"), { ref: "", fragment: "section" }, "纯锚点 ref 为空串");
assert.deepEqual(splitReferenceFragment("a.md?x=1#sec"), { ref: "a.md?x=1", fragment: "sec" }, "query+锚点拆分");
assert.deepEqual(splitReferenceFragment("a.md#"), { ref: "a.md", fragment: null }, "空锚点视为无 fragment");
assert.deepEqual(splitReferenceFragment("a.md#%E4%B8%AD"), { ref: "a.md", fragment: "中" }, "锚点 %XX 解码一次");
assert.deepEqual(splitReferenceFragment("a.md#%zz"), { ref: "a.md", fragment: "%zz" }, "非法编码锚点原样保留");