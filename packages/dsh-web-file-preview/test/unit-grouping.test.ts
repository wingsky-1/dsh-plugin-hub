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
  shouldIntercept,
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

// issue #630：Godot 文本族进 code 组
assert.equal(groupOfExt("gd"), "code", "GDScript → code");
assert.equal(groupOfExt("tscn"), "code", "Godot 场景 → code");
assert.equal(groupOfExt("escn"), "code", "Blender 导出场景 → code");
assert.equal(groupOfExt("tres"), "code", "文本资源 → code");
assert.equal(groupOfExt("gdns"), "code", "GDNative 声明 → code");
assert.equal(groupOfExt("gdnlib"), "code", "GDNative 库声明 → code");
assert.equal(groupOfExt("gdextension"), "code", "GDExtension 声明 → code");
assert.equal(groupOfExt("gdshader"), "code", "着色器 → code");
assert.equal(groupOfExt("gdshaderinc"), "code", "着色器 include → code");
assert.equal(groupOfPath("project.godot").group, "code", "project.godot 按 godot 后缀入 code");
assert.equal(groupOfPath("scenes/pong.tscn").group, "code", "带目录的场景路径");
assert.equal(groupOfPath("paddle.png.import").group, "code", "导入元数据按 import 后缀入 code");
// 二进制 Godot 资源仍留 other（宿主嗅探兜底，issue #630 改动 B）
assert.equal(groupOfExt("res"), "other", "二进制资源 .res 不进白名单");
assert.equal(groupOfExt("scn"), "other", "二进制场景 .scn 不进白名单");
assert.equal(groupOfExt("ctex"), "other", "压缩纹理 .ctex 不进白名单");

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

// ---------------------------------------------------------------- shouldIntercept（issue #630）

// 宽松层：other 组也接管（宿主嗅探兜底裁决），结构排除与 isLikelySingleFilePath 一致
assert.equal(shouldIntercept("a/b.zip"), true, "other 组带分隔符路径 → 接管");
assert.equal(shouldIntercept("a.xyz"), true, "未知后缀单段词 → 接管");
assert.equal(shouldIntercept(".env"), true, "dot 文件裸名 → 接管");
assert.equal(shouldIntercept("Makefile"), true, "无后缀文件名 → 接管");
assert.equal(shouldIntercept("a.md"), true, "白名单内路径 → 接管（严格层同样 true）");
// 结构排除规则与严格层一致
assert.equal(shouldIntercept("https://x/a.md"), false, "http 排除");
assert.equal(shouldIntercept("#anchor"), false, "锚点排除");
assert.equal(shouldIntercept("mailto:a@b.com"), false, "mailto 排除");
assert.equal(shouldIntercept("a.md,b.md"), false, "逗号拼接排除");
assert.equal(shouldIntercept("a.md\nb.md"), false, "换行拼接排除");
assert.equal(shouldIntercept("a.md  b.md"), false, "多空格拼接排除");
assert.equal(shouldIntercept("a/b.md c/d.md"), false, "单空格+分隔符多段拼接排除（评审 U5）");
assert.equal(shouldIntercept(undefined), false, "undefined 返回 false");
assert.equal(shouldIntercept(null), false, "null 返回 false");
// 分级纪律：严格层对 other 后缀仍 false（非权威文本嗅探不得放宽）
assert.equal(isLikelySingleFilePath("a/b.zip"), false, "严格层 other 组不识别（分级纪律锚）");
assert.equal(isLikelySingleFilePath("Makefile"), false, "严格层无后缀不识别");

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

// ---------------------------------------------------------------- 占位卡纯函数（issue #630）

import { formatBytes, downloadUrlOf } from "../lib/index.js";
assert.equal(formatBytes(0), "0 B", "0 字节");
assert.equal(formatBytes(512), "512 B", "字节段");
assert.equal(formatBytes(2048), "2.0 KB", "KB 段");
assert.equal(formatBytes(20 * 1024 * 1024), "20.0 MB", "MB 段");
assert.equal(formatBytes(-1), "", "负数回退空串");
assert.equal(formatBytes(NaN), "", "NaN 回退空串");
assert.equal(downloadUrlOf("/api/x/file?cwd=%2Fa&path=b"), "/api/x/file?cwd=%2Fa&path=b&dl=1", "含 query 用 & 追加");
assert.equal(downloadUrlOf("/plain"), "/plain?dl=1", "无 query 用 ? 追加");