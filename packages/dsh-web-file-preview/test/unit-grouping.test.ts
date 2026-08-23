// @ts-nocheck
/**
 * dsh-web-file-preview — unit：预览分组单一事实源（grouping）。
 *
 * 覆盖：extOf（扩展名提取）、groupOfExt / groupOfPath（分组判定）、
 * isPreviewablePath（可预览性）、isLikelySingleFilePath（单文件路径判定）、
 * cleanRefChipPath（@-mention chip 还原）、normalizeConfig（配置归一化）。
 */
import { assert } from "./helpers.ts";
import {
  extOf,
  groupOfExt,
  groupOfPath,
  isPreviewablePath,
  isLikelySingleFilePath,
  cleanRefChipPath,
  normalizeConfig,
  DEFAULT_CONFIG,
} from "../lib/index.js";

// ---------------------------------------------------------------- extOf

assert.equal(extOf("a.txt"), "txt", "普通扩展名");
assert.equal(extOf("dir/file.md"), "md", "带目录的扩展名");
assert.equal(extOf("a.TXT"), "txt", "大写归一化小写");
assert.equal(extOf("a.tar.gz"), "gz", "复合扩展名取最后一段");
assert.equal(extOf("a."), "", "尾点无扩展名返回空");
assert.equal(extOf(".gitignore"), "", "点文件（.gitignore）无扩展名（dot=0 时返回空）");
assert.equal(extOf("Makefile"), "", "无扩展名返回空");
assert.equal(extOf("noext"), "", "无点返回空");
assert.equal(extOf(""), "", "空字符串返回空");
assert.equal(extOf("a/b/c"), "", "有目录无扩展名返回空");
assert.equal(extOf("a/b/.hidden"), "", "隐藏文件无扩展名");

// ---------------------------------------------------------------- groupOfExt

assert.equal(groupOfExt("png"), "image", "png → image");
assert.equal(groupOfExt("jpg"), "image", "jpg → image");
assert.equal(groupOfExt("svg"), "image", "svg → image");
assert.equal(groupOfExt("md"), "md", "md → md");
assert.equal(groupOfExt("markdown"), "md", "markdown → md");
assert.equal(groupOfExt("ts"), "code", "ts → code");
assert.equal(groupOfExt("js"), "code", "js → code");
assert.equal(groupOfExt("py"), "code", "py → code");
assert.equal(groupOfExt("txt"), "text", "txt → text");
assert.equal(groupOfExt("log"), "text", "log → text");
assert.equal(groupOfExt("zip"), "other", "zip → other");
assert.equal(groupOfExt("exe"), "other", "exe → other");
assert.equal(groupOfExt(""), "other", "空扩展名 → other");

// ---------------------------------------------------------------- groupOfPath

assert.equal(groupOfPath("a.png").group, "image", "图片路径分组");
assert.equal(groupOfPath("a.png").ext, "png", "图片路径扩展名回传");
assert.equal(groupOfPath("dir/a.MD").group, "md", "大写 MD 扩展名");
assert.equal(groupOfPath("dir/a.MD").ext, "md", "大写 MD 归一化小写");

// ---------------------------------------------------------------- isPreviewablePath

assert.equal(isPreviewablePath("a.png"), true, "图片可预览");
assert.equal(isPreviewablePath("a.md"), true, "Markdown 可预览");
assert.equal(isPreviewablePath("a.ts"), true, "代码可预览");
assert.equal(isPreviewablePath("a.txt"), true, "文本可预览");
assert.equal(isPreviewablePath("a.zip"), false, "zip 不可预览");
assert.equal(isPreviewablePath("a"), false, "无扩展名不可预览");

// ---------------------------------------------------------------- isLikelySingleFilePath

assert.equal(isLikelySingleFilePath("a/b.ts"), true, "子目录路径可识别");
assert.equal(isLikelySingleFilePath("a b.ts"), false, "文件名含单一空格（无目录分隔符）不识别（U5 语义）");
assert.equal(isLikelySingleFilePath("a/b.ts c/d.ts"), false, "双段含分隔符的拼接非单路径（评审 U5）");
assert.equal(isLikelySingleFilePath("/abs/path.md"), true, "绝对路径可识别");
assert.equal(isLikelySingleFilePath("a.md,b.md"), false, "逗号拼接非单路径");
assert.equal(isLikelySingleFilePath("https://x/a.md"), false, "http 链接排除");
assert.equal(isLikelySingleFilePath("#anchor"), false, "锚点排除");
assert.equal(isLikelySingleFilePath("mailto:a@b.com"), false, "mailto 排除");
assert.equal(isLikelySingleFilePath("a.md\nb.md"), false, "换行拼接排除");
assert.equal(isLikelySingleFilePath("a.md  b.md"), false, "多空格拼接排除");
assert.equal(isLikelySingleFilePath("a.xyz"), false, "不可预览后缀排除");
assert.equal(isLikelySingleFilePath(undefined), false, "undefined 返回 false");
assert.equal(isLikelySingleFilePath(null), false, "null 返回 false");

// ---------------------------------------------------------------- cleanRefChipPath

assert.equal(cleanRefChipPath("@/abs/path.ts", "file"), "/abs/path.ts", "去前导 @ 绝对路径");
assert.equal(cleanRefChipPath('@"a b.ts"', "file"), "a b.ts", "去引号含空格路径");
assert.equal(cleanRefChipPath("node_modules/@scope/x.ts", "file"), "node_modules/@scope/x.ts", "内含 @ 只去一个前导");
assert.equal(cleanRefChipPath("@/a/dir/", "folder"), "/a/dir/", "folder 保留尾 /");
assert.equal(cleanRefChipPath("", "file"), null, "空字符串 → null");
assert.equal(cleanRefChipPath("@", "file"), null, "仅 @ → null");
assert.equal(cleanRefChipPath("@label", "session"), null, "session → null");
assert.equal(cleanRefChipPath("@cmd", "skill"), null, "skill → null");
assert.equal(cleanRefChipPath("@label", "file"), "label", "file 形态只去前导 @");
assert.equal(cleanRefChipPath(undefined, "file"), null, "undefined → null");

// ---------------------------------------------------------------- normalizeConfig

assert.equal(normalizeConfig(undefined).enabled, true, "默认启用");
assert.equal(normalizeConfig(undefined).maxTextBytes, DEFAULT_CONFIG.maxTextBytes, "默认文本上限");
assert.equal(normalizeConfig({ enabled: false }).enabled, false, "enabled 可关闭");
assert.equal(normalizeConfig({ maxTextBytes: 1234 }).maxTextBytes, 1234, "maxTextBytes 合法透传");
assert.equal(normalizeConfig({ maxTextBytes: -1 }).maxTextBytes, DEFAULT_CONFIG.maxTextBytes, "负数丢弃回默认");
assert.equal(normalizeConfig({ maxTextBytes: 0 }).maxTextBytes, DEFAULT_CONFIG.maxTextBytes, "0 丢弃回默认（非正数）");
assert.equal(normalizeConfig({ maxTextBytes: "x" }).maxTextBytes, DEFAULT_CONFIG.maxTextBytes, "非数字丢弃");
assert.equal(normalizeConfig({ enabled: "yes" }).enabled, DEFAULT_CONFIG.enabled, "非布尔 enabled 丢弃回默认");