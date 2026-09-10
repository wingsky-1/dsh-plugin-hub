// @ts-nocheck
/**
 * dsh-web-file-preview — 宿主端冒烟测试（fake ctx / fake res，无网络、不登真实实例）。
 *
 * 覆盖：
 * - 路径定位：`resolve(cwd, path)`（绝对/相对；不做“逃出 cwd”拦截——任意文件
 *   访问由平台/用户负责，故 `..` 逃逸到存在的文件应能正常读到）
 * - previewKindOf：图片 → image/*；文本 → text/plain；其他 → other
 * - normalizeConfig / DEFAULT_CONFIG：默认值、非法值丢弃
 * - makeRoutes：返回 file + health 两条 exact 路由；路径与 ROUTES 一致
 * - 路由围栏：非回环 403、方法非 GET 405（走真实 handler）
 * - serveFileRoute：文本直出（UTF-8）、图片二进制直出、缺参 400、逃逸可读、
 *   文件不存在 404、不可预览类型 415、文本超限截断
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, renameSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  ROUTES, makeRoutes, serveFileRoute, previewKindOf, computeGitDiff,
  normalizeConfig, DEFAULT_CONFIG, groupOfPath, groupOfExt, isLikelySingleFilePath, resolveRelativePath,
  cleanRefChipPath, resolveAbsolutePath, splitReferenceFragment, serveTokenRoute, normalizeBasePath,
  findUniqueByBasename, bareBasenameOf, resolveFile,
} from "../lib/index.js";
import { sniffKind, bomLabelOf, decodeWithBom, contentDispositionOf } from "../lib/index.js";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";

// 结构化单元测试（#83 阶段一：对齐 notifier 的 unit-*.test.ts 样板）
import "./unit-grouping.test.ts";
import "./unit-relpath.test.ts";
import "./unit-routes.test.ts";
import "./unit-serve-tokens.test.ts";
import "./unit-basename-fallback.test.ts";
import "./unit-git.test.ts";
// issue #698：「打开文件」→ 官方侧栏预览的重定向（纯逻辑 golden + 产物级 vm 夹具）。
import "./unit-present-open.test.ts";
import "./client-present-redirect.test.ts";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

// 防 flake 纪律（DEVELOPMENT.md §5）：DSH_HOME 隔离到临时目录，杜绝向真实 ~/.dsh
// 写任何测试数据（本 smoke 以 fake ctx 直测宿主逻辑，不依赖 DSH_HOME 持久化，
// 此处显式隔离作为基准约定）。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "fwp-dshhome-"));

// ------------------------------------------------------------ 分组单一事实源（grouping）

assert.deepEqual(groupOfPath("a.md").group, "md");
assert.deepEqual(groupOfPath("b.ts").group, "code");
assert.deepEqual(groupOfPath("c.png").group, "image");
assert.deepEqual(groupOfPath("d.txt").group, "text");
assert.deepEqual(groupOfPath("e.xyz").group, "other");
assert.deepEqual(groupOfPath("dir/a.JPG").group, "image", "扩展名大小写不敏感");
// issue #73 F1：.html/.htm 从 code 组迁出，新增 html 渲染组
assert.deepEqual(groupOfPath("a.html").group, "html", "#73 .html → html 渲染组");
assert.deepEqual(groupOfPath("b.HTM").group, "html", "#73 .HTM 大小写归一 → html 渲染组");
assert.equal(groupOfPath("a.html").ext, "html", "#73 html 扩展名回传");
assert.equal(groupOfExt("css"), "code", "#73 css 仍属 code 组（未受影响）");

// previewKindOf 由 grouping 派生：md→renderedMd、code→renderedCode，双端一致。
assert.equal(previewKindOf("a.md").group === "renderedMd", groupOfPath("a.md").group === "md", "md 双端分组一致");
assert.equal(previewKindOf("a.js").group === "renderedCode", groupOfPath("a.js").group === "code", "code 双端分组一致");
assert.equal(previewKindOf("a.txt").group === "text", groupOfPath("a.txt").group === "text", "text 双端分组一致");
// issue #73 F3：html 双端一致——previewKindOf 产出新 kind renderedHtml ↔ groupOfPath html。
assert.equal(previewKindOf("a.html").group === "renderedHtml", groupOfPath("a.html").group === "html", "#73 html 双端分组一致");

// 点击识别的"单文件路径"判定（结构化拒绝多路径拼接的展示标签；bug 回归）：
// 上下文注入折叠摘要把两个文件用逗号拼成一个展示字符串（~/.dsh/AGENTS.md, AGENTS.md），
// 不能把它误判成一条路径去预览；而展开视图/正文里的单个路径应正常识别。
assert.equal(isLikelySingleFilePath("~/.dsh/AGENTS.md, AGENTS.md"), false, "逗号拼接的展示标签不是单文件路径");
assert.equal(isLikelySingleFilePath("~/.dsh/AGENTS.md"), true, "~ 开头的单文件路径可识别");
assert.equal(isLikelySingleFilePath("AGENTS.md"), true, "相对单文件路径可识别");
assert.equal(isLikelySingleFilePath("src/a.md"), true, "子目录相对路径可识别");
assert.equal(isLikelySingleFilePath("/abs/path/a.md"), true, "绝对路径可识别");
assert.equal(isLikelySingleFilePath("a.md\nb.md"), false, "换行拼接的多文件不是单文件");
assert.equal(isLikelySingleFilePath("a.md  b.md"), false, "多空白拼接的多文件不是单文件");
assert.equal(isLikelySingleFilePath("dir/a.md dir/b.md"), false, "单空格+斜杠拼接的多文件并列不是单路径（评审 U5）");
assert.equal(isLikelySingleFilePath("https://x/a.md"), false, "http 链接不是本地文件路径");
assert.equal(isLikelySingleFilePath("a.xyz"), false, "不可预览后缀不识别");

// cleanRefChipPath：@-mention chip 标签还原干净路径
assert.equal(cleanRefChipPath("@/a/b.ts", "file"), "/a/b.ts", "去前导 @ 的绝对路径");
assert.equal(cleanRefChipPath('@"a b/c.ts"', "file"), "a b/c.ts", "去引号含空格路径");
assert.equal(cleanRefChipPath("@/a/dir/", "folder"), "/a/dir/", "folder 保留尾 /");
assert.equal(cleanRefChipPath("node_modules/@scope/x.ts", "file"), "node_modules/@scope/x.ts", "路径内含 @ 仅去一个前导");
assert.equal(cleanRefChipPath("", "file"), null, "空字符串 → null");
assert.equal(cleanRefChipPath("@", "file"), null, "仅 @ 字符 → null");
assert.equal(cleanRefChipPath("@label", "session"), null, "session → null");
assert.equal(cleanRefChipPath("@cmd", "skill"), null, "skill → null");

// ------------------------------------------------------------ 相对引用展开（relpath，U8 v2）

const REL = "/home/u/work/src/a.md";
assert.equal(resolveRelativePath(REL, "img.png"), "/home/u/work/src/img.png", "同目录相对引用");
assert.equal(resolveRelativePath(REL, "./img.png"), "/home/u/work/src/img.png", "./ 相对引用");
assert.equal(resolveRelativePath(REL, "../b.md"), "/home/u/work/b.md", "../ 上级目录引用");
assert.equal(resolveRelativePath(REL, "docs/../c.md"), "/home/u/work/src/c.md", "规范化 .. / .");
assert.equal(resolveRelativePath(REL, "a.md?x=1"), "/home/u/work/src/a.md", "query 尾巴丢弃");
assert.equal(resolveRelativePath(REL, "a.md#sec"), "/home/u/work/src/a.md", "fragment 尾巴丢弃");
assert.equal(resolveRelativePath(REL, "%E4%B8%AD.md"), "/home/u/work/src/中.md", "%20/UTF-8 编码解码");
assert.equal(resolveRelativePath(REL, "/etc/passwd"), null, "绝对路径不展开（web 根语义保留）");
assert.equal(resolveRelativePath(REL, "https://x/a.md"), null, "http 链接不展开");
assert.equal(resolveRelativePath(REL, "//cdn/x.png"), null, "协议相对不展开");
assert.equal(resolveRelativePath(REL, "data:image/png;base64,AA=="), null, "data URI 不展开");
assert.equal(resolveRelativePath(REL, "#sec"), null, "纯锚点不展开");

// issue #45：绝对路径展开 + fragment 剥离（纯函数层；详细分支见 unit-relpath.test.ts）
assert.equal(resolveAbsolutePath("/home/u/proj/docs/design.md"), "/home/u/proj/docs/design.md", "#45 绝对路径规范化保留");
assert.equal(resolveAbsolutePath("//cdn/x.png"), null, "#45 协议相对拒绝");
assert.deepEqual(splitReferenceFragment("./f.md#g"), { ref: "./f.md", fragment: "g" }, "#45 fragment 剥离保留锚点");



// ------------------------------------------------------------ 纯函数

assert.equal(previewKindOf("foo.png").group, "image");
assert.equal(previewKindOf("dir/a.JPG").group, "image", "扩展名大小写不敏感");
assert.equal(previewKindOf("a.md").group, "renderedMd", "Markdown 渲染组");
assert.equal(previewKindOf("a.js").group, "renderedCode", "代码渲染组");
assert.equal(previewKindOf("a.html").group, "renderedHtml", "#73 HTML 渲染组（新 kind）");
assert.equal(previewKindOf("hello.md").contentType, "text/markdown; charset=utf-8");
assert.equal(previewKindOf("a.txt").group, "text");
assert.equal(previewKindOf("a.exe").group, "other");
// issue #73 E2：/file 对 .html/.htm 保持 text/plain（防顶层访问成为同源脚本执行通道）
assert.equal(previewKindOf("a.html").contentType, "text/plain; charset=utf-8", "#73 /file 对 html 保持 text/plain");
assert.equal(previewKindOf("a.htm").contentType, "text/plain; charset=utf-8", "#73 /file 对 htm 保持 text/plain");
// issue #12：图片组 Content-Type 改由 mime 库提供——精确值逐项断言（原自写表等价映射）。
assert.equal(previewKindOf("a.png").contentType, "image/png");
assert.equal(previewKindOf("a.webp").contentType, "image/webp");
assert.equal(previewKindOf("a.svg").contentType, "image/svg+xml");
assert.equal(previewKindOf("a.avif").contentType, "image/avif");
assert.equal(previewKindOf("dir/a.JPG").contentType, "image/jpeg", "大小写不敏感且走 mime 库");

// ------------------------------------------------------------ 嗅探纯函数（issue #630）

assert.equal(bomLabelOf(Buffer.from([0xef, 0xbb, 0xbf])), "utf-8", "UTF-8 BOM");
assert.equal(bomLabelOf(Buffer.from([0xff, 0xfe])), "utf-16le", "UTF-16LE BOM");
assert.equal(bomLabelOf(Buffer.from([0xfe, 0xff])), "utf-16be", "UTF-16BE BOM");
assert.equal(bomLabelOf(Buffer.from([0xff, 0xfe, 0x00, 0x00])), "utf-32le", "UTF-32LE BOM 优先于 UTF-16LE 前缀");
assert.equal(bomLabelOf(Buffer.from([0x00, 0x00, 0xfe, 0xff])), "utf-32be", "UTF-32BE BOM");
assert.equal(bomLabelOf(Buffer.from("hello")), undefined, "无 BOM");
assert.equal(bomLabelOf(Buffer.from([0xff])), undefined, "样本短于前缀不误判");
assert.equal(decodeWithBom(Buffer.from([0xff, 0xfe, 0x2d, 0x00, 0x31, 0x00]), "utf-16le"), "-1", "UTF-16LE BOM 转码剥除");
assert.equal(decodeWithBom(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x62]), "utf-8"), "ab", "UTF-8 BOM 剥除");
assert.equal(decodeWithBom(Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61]), "utf-32be"), "a", "UTF-32BE 手写解码");
assert.equal(decodeWithBom(Buffer.from("plain"), "unknown"), undefined, "未知标签回退 undefined");
await assert.rejects(sniffKind(join(tmpdir(), "fwp-no-such-dir-630", "gone.xyz")), (e: NodeJS.ErrnoException) => e.code === "ENOENT", "嗅探目标不存在 → ENOENT（并入 readErrorCode 语义）");
assert.equal(contentDispositionOf("中文 资源.zip"), `attachment; filename="__ __.zip"; filename*=UTF-8''${encodeURIComponent("中文 资源.zip")}`, "RFC 5987 编码 + ASCII 回退（空格属 ASCII 保留）");
assert.ok(!contentDispositionOf('bad\r\nname.bin').includes("\r"), "CRLF 编码闭合头注入面");

assert.equal(normalizeConfig(undefined).enabled, true, "默认启用");
// issue #344 A2 [硬性]：默认上限硬编码断言 20M——现有 normalizeConfig(undefined) 断言是
// 自引用（拿 DEFAULT_CONFIG 比自己），实现回退/错值不会红，这里显式钉死数值。
assert.equal(DEFAULT_CONFIG.maxTextBytes, 20 * 1024 * 1024, "#344 默认文本上限 = 20M（硬断言）");
assert.equal(DEFAULT_CONFIG.maxAssetBytes, 20 * 1024 * 1024, "#344 默认资源上限 = 20M（硬断言）");
assert.equal(normalizeConfig(undefined).maxTextBytes, DEFAULT_CONFIG.maxTextBytes, "默认文本上限");
assert.equal(normalizeConfig({ enabled: false }).enabled, false);
assert.equal(normalizeConfig({ maxTextBytes: 1234 }).maxTextBytes, 1234);
assert.equal(normalizeConfig({ maxTextBytes: -1 }).maxTextBytes, DEFAULT_CONFIG.maxTextBytes, "非法上限丢弃");
assert.equal(normalizeConfig({ maxTextBytes: "x" }).maxTextBytes, DEFAULT_CONFIG.maxTextBytes, "非数字丢弃");
// issue #73 I1：maxAssetBytes 配置键——合法正数接受、非法丢弃回默认
assert.equal(normalizeConfig(undefined).maxAssetBytes, DEFAULT_CONFIG.maxAssetBytes, "#73 默认资源上限");
assert.equal(normalizeConfig({ maxAssetBytes: 2048 }).maxAssetBytes, 2048, "#73 合法正数接受");
assert.equal(normalizeConfig({ maxAssetBytes: 0 }).maxAssetBytes, DEFAULT_CONFIG.maxAssetBytes, "#73 零丢弃");
assert.equal(normalizeConfig({ maxAssetBytes: -5 }).maxAssetBytes, DEFAULT_CONFIG.maxAssetBytes, "#73 负数丢弃");
assert.equal(normalizeConfig({ maxAssetBytes: "big" }).maxAssetBytes, DEFAULT_CONFIG.maxAssetBytes, "#73 非数字丢弃");

// ------------------------------------------------------------ ~ 波浪号展开
// 宿主端用 untildify（业界标准、零依赖、跨平台）做 ~ 展开，具体语义由第三方
// 库保证；此处仅保留最贴近原 bug 的「~/ 能读到真实家目录文件」集成回归用例
// （见下方真实文件服务节）。

const routes = makeRoutes({});
assert.equal(routes.length, 7, "file + diff + health + mermaid + alloc + serve + release 七条路由");
const routePaths = routes.map((r) => r.path);
assert.equal(routePaths.includes(ROUTES.file), true);
assert.equal(routePaths.includes(ROUTES.diff), true);
assert.equal(routePaths.includes(ROUTES.health), true);
assert.equal(routePaths.includes(ROUTES.mermaid), true, "#104 mermaid chunk 路由注册");
// issue #73 A1：serve 为 prefix 路由（/serve/<token>/ 下任意子路径均被接管）；其余 exact
assert.equal(routePaths.includes(ROUTES.serve), true, "#73 serve 路由注册");
assert.equal(routePaths.includes(ROUTES.alloc), true, "#73 alloc 路由注册");
assert.equal(routePaths.includes(ROUTES.release), true, "#73 release 路由注册");
const serveRoute = routes.find((r) => r.path === ROUTES.serve);
assert.equal(serveRoute !== undefined && serveRoute.kind, "prefix", "#73 serve 路由 kind 为 prefix（A1）");
for (const r of routes) if (r.path !== ROUTES.serve) assert.equal(r.kind, "exact");

// ------------------------------------------------------------ 围栏

function fakeReq(method, url, remoteAddress, host = "127.0.0.1", extraHeaders = {}) {
  return { method, url, headers: { host, ...extraHeaders }, socket: { remoteAddress } };
}
function fakeRes() {
  const calls = { status: 0, headers: {}, data: null };
  const listeners = {};
  return {
    _calls: calls,
    writeHead(status, headers) { calls.status = status; calls.headers = headers || {}; return this; },
    end(data) { if (data !== undefined) calls.data = data; }, // 流式 end() 无参：保留 write 累积
    // 流式直出（serve 路由）支持：write 累积 buffer，end 时拼装完整 data
    write(chunk) { calls.data = calls.data === null ? Buffer.from(chunk) : Buffer.concat([Buffer.from(calls.data), Buffer.from(chunk)]); return true; },
    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return this; },
    emit(evt, ...args) { for (const fn of listeners[evt] || []) fn(...args); return this; },
  };
}
/** 文件路由所需的最小 req（headers 可自定义）。 */
function rawReqForFiles(headers = {}) {
  return { headers };
}

/** 目录条目（serve 零落盘断言用）。 */
function readdirOf(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" });
}

const fileRoute = routes[0].handler;
const healthRoute = routes[2].handler;
const mermaidRoute = routes[3].handler;
const allocRoute = routes[4].handler;
const serveRouteHandler = routes[5].handler;
const releaseRoute = routes[6].handler;

// 非回环 → 403
{
  const res = fakeRes();
  fileRoute(fakeReq("GET", ROUTES.file + "?cwd=/tmp&path=a", "8.8.8.8"), res);
  assert.equal(res._calls.status, 403, "非回环 403");
}
// 方法非 GET → 405
{
  const res = fakeRes();
  fileRoute(fakeReq("POST", ROUTES.file + "?cwd=/tmp&path=a", "127.0.0.1"), res);
  assert.equal(res._calls.status, 405, "非 GET 405");
  // #473 批 2（B2-4）：405 body 围栏文案逐字断言（守卫收敛后锁定）
  assert.equal(JSON.parse(res._calls.data).error, "method not allowed: POST", "非 GET 405 body 文案");
}
// health 非回环 403
{
  const res = fakeRes();
  healthRoute(fakeReq("GET", ROUTES.health, "8.8.8.8"), res);
  assert.equal(res._calls.status, 403, "health 非回环 403");
}
// health 方法非 GET → 405（#473 批 2（B2-4）：405 body 围栏文案逐字断言）
{
  const res = fakeRes();
  healthRoute(fakeReq("DELETE", ROUTES.health, "127.0.0.1"), res);
  assert.equal(res._calls.status, 405, "health 非 GET 405");
  assert.equal(JSON.parse(res._calls.data).error, "method not allowed: DELETE", "health 405 body 文案");
}
// mermaid 路由围栏（issue #104）：与 file/diff 同语义
{
  const res = fakeRes();
  await mermaidRoute(fakeReq("GET", ROUTES.mermaid, "8.8.8.8"), res);
  assert.equal(res._calls.status, 403, "mermaid 非回环 403");
}
{
  const res = fakeRes();
  await mermaidRoute(fakeReq("POST", ROUTES.mermaid, "127.0.0.1"), res);
  assert.equal(res._calls.status, 405, "mermaid 非 GET 405");
}
// issue #73 A2：serve/alloc/release 路由围栏与既有路由同语义（非回环 403 / 非 GET 405）
{
  const res = fakeRes();
  await serveRouteHandler(fakeReq("GET", ROUTES.serve + "/tok/x.html", "8.8.8.8"), res);
  assert.equal(res._calls.status, 403, "#73 serve 非回环 403");
}
{
  const res = fakeRes();
  await serveRouteHandler(fakeReq("POST", ROUTES.serve + "/tok/x.html", "127.0.0.1"), res);
  assert.equal(res._calls.status, 405, "#73 serve 非 GET 405");
  // #473 批 2（B2-4）：405 body 围栏文案逐字断言（prefix 路由形态）
  assert.equal(JSON.parse(res._calls.data).error, "method not allowed: POST", "#73 serve 405 body 文案");
}
{
  const res = fakeRes();
  await allocRoute(fakeReq("GET", ROUTES.alloc + "?cwd=/tmp&path=a.html", "8.8.8.8"), res);
  assert.equal(res._calls.status, 403, "#73 alloc 非回环 403");
}
{
  const res = fakeRes();
  await allocRoute(fakeReq("POST", ROUTES.alloc + "?cwd=/tmp&path=a.html", "127.0.0.1"), res);
  assert.equal(res._calls.status, 405, "#73 alloc 非 GET 405");
}
{
  const res = fakeRes();
  releaseRoute(fakeReq("GET", ROUTES.release + "?token=x", "8.8.8.8"), res);
  assert.equal(res._calls.status, 403, "#73 release 非回环 403");
}
{
  const res = fakeRes();
  releaseRoute(fakeReq("POST", ROUTES.release + "?token=x", "127.0.0.1"), res);
  assert.equal(res._calls.status, 405, "#73 release 非 GET 405");
}

// ------------------------------------------------------------ 真实文件服务

const root = mkdtempSync(join(tmpdir(), "fwp-"));
try {
  const textPath = join(root, "hello.md");
  writeFileSync(textPath, "你好，# 标题\nline2", "utf8");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "data.json"), JSON.stringify({ a: 1 }), "utf8");
  writeFileSync(join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), "utf8");
  writeFileSync(join(root, "blob.xyz"), "opaque", "utf8");

  const urlOf = (p) => `http://127.0.0.1${ROUTES.file}?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}`;
  const urlNoCwd = `http://127.0.0.1${ROUTES.file}?path=hello.md`;

  // 文本直出（UTF-8，markdown 全文读取）
  {
    const res = fakeRes();
    await serveFileRoute(res, rawReqForFiles(), new URL(urlOf("hello.md")), {});
    assert.equal(res._calls.status, 200);
    assert.match(res._calls.headers["content-type"], /^text\/(plain|markdown)/);
    assert.equal(res._calls.data, "你好，# 标题\nline2");
  }
  // 子目录相对路径（含中文 JSON）
  {
    const res = fakeRes();
    await serveFileRoute(res, rawReqForFiles(), new URL(urlOf("sub/data.json")), {});
    assert.equal(res._calls.status, 200);
    assert.equal(res._calls.data, JSON.stringify({ a: 1 }));
  }
  // 缺 cwd → 400
  {
    const res = fakeRes();
    await serveFileRoute(res, rawReqForFiles(), new URL(urlNoCwd), {});
    assert.equal(res._calls.status, 400, "缺 cwd 参数 → 400");
  }
  // 逃逸 cwd 不再拦截：相对 `..` 逃逸到"存在的文件"应能读到（任意文件访问
  // 由平台/用户负责，本插件不做重复兜底）。
  {
    const outside = join(dirname(root), `fwp-escape-${Date.now()}.txt`);
    writeFileSync(outside, "outside content", "utf8");
    const name = basename(outside);
    const res = fakeRes();
    await serveFileRoute(res, rawReqForFiles(), new URL(urlOf(`../${name}`)), {});
    assert.equal(res._calls.status, 200, "逃逸 cwd 不再被拦截，`..` 可读到存在的文件");
    assert.equal(res._calls.data, "outside content");
    rmSync(outside, { force: true });
  }
  // 文件不存在 → 404
  {
    const res = fakeRes();
    await serveFileRoute(res, rawReqForFiles(), new URL(urlOf("nope.txt")), {});
    assert.equal(res._calls.status, 404);
  }
  // 不可预览类型 → 415 结构化占位（#630）：blob.xyz 内容是文本（"opaque"）→
  // 嗅探放行 200 直出（业界漏斗第 1 层：白名单外文本不再死胡同）；真二进制
  // fixture（含 NUL 字节）才 415 + binary/size/ext 结构化字段。
  {
    const resText = fakeRes();
    await serveFileRoute(resText, rawReqForFiles(), new URL(urlOf("blob.xyz")), {});
    assert.equal(resText._calls.status, 200, "#630 白名单外文本（.xyz 文本内容）嗅探后 200 直出");
    assert.equal(resText._calls.data, "opaque", "#630 .xyz 文本内容一致");
    assert.equal(resText._calls.headers["content-type"], "text/plain; charset=utf-8", "#630 嗅探文本 Content-Type 按 text 组");
    assert.equal(resText._calls.headers["x-content-type-options"], "nosniff", "#630 嗅探文本同样带 nosniff");
    assert.ok(resText._calls.headers["etag"] !== undefined, "#630 嗅探文本走 text 组 ETag/413 全套逻辑");
  }
  {
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x4f, 0x70, 0x61, 0x71, 0x00, 0x75, 0x65, 0x8f]), "binary");
    const resBin = fakeRes();
    await serveFileRoute(resBin, rawReqForFiles(), new URL(urlOf("blob.bin")), {});
    assert.equal(resBin._calls.status, 415, "#630 含 NUL 的二进制 → 415 结构化占位");
    const binPayload = JSON.parse(resBin._calls.data);
    assert.equal(binPayload.binary, true, "#630 415 body 带 binary:true");
    assert.equal(binPayload.ext, "bin", "#630 415 body 带后缀");
    assert.ok(typeof binPayload.size === "number" && binPayload.size > 0, "#630 415 body 带文件大小");
  }
  // 图片二进制直出
  {
    const res = fakeRes();
    await serveFileRoute(res, rawReqForFiles(), new URL(urlOf("pic.png")), {});
    assert.equal(res._calls.status, 200);
    assert.equal(res._calls.headers["content-type"], "image/png");
    assert.ok(Buffer.isBuffer(res._calls.data), "图片以 Buffer 直出");
    assert.equal(res._calls.data[0], 0x89);
  }
  // 安全响应头（评审 S2）：一律 nosniff；SVG 额外 CSP sandbox（防顶层导航执行脚本）
  {
    writeFileSync(join(root, "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
    const resPng = fakeRes();
    await serveFileRoute(resPng, rawReqForFiles(), new URL(urlOf("pic.png")), {});
    assert.equal(resPng._calls.headers["x-content-type-options"], "nosniff", "图片响应带 nosniff");
    const resSvg = fakeRes();
    await serveFileRoute(resSvg, rawReqForFiles(), new URL(urlOf("pic.svg")), {});
    assert.equal(resSvg._calls.headers["x-content-type-options"], "nosniff", "SVG 响应带 nosniff");
    assert.equal(resSvg._calls.headers["content-security-policy"], "sandbox", "SVG 响应限制脚本执行（CSP sandbox）");
    const resMd = fakeRes();
    await serveFileRoute(resMd, rawReqForFiles(), new URL(urlOf("hello.md")), {});
    assert.equal(resMd._calls.headers["x-content-type-options"], "nosniff", "文本响应带 nosniff");
  }

  // ~ 波浪号前缀：`~/<file>` 展开为家目录下真实文件（打不开 → 404 bug 回归）
  {
    const homeFile = join(homedir(), `fwp-tilde-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(homeFile, "tilde home file", "utf8");
    try {
      const name = basename(homeFile);
      const res = fakeRes();
      await serveFileRoute(res, rawReqForFiles(), new URL(urlOf(`~/${name}`)), {});
      assert.equal(res._calls.status, 200, "~/ 前缀应解析到家目录并读到");
      assert.equal(res._calls.data, "tilde home file");
    } finally {
      rmSync(homeFile, { force: true });
    }
  }

  // ETag/304：响应带 ETag，带 If-None-Match 命中 → 304 无 body
  {
    const r1 = fakeRes();
    await serveFileRoute(r1, rawReqForFiles(), new URL(urlOf("hello.md")), {});
    const etag = r1._calls.headers["etag"];
    assert.ok(typeof etag === "string" && etag.startsWith('"'), "响应含 ETag");
    assert.equal(r1._calls.headers["cache-control"], "no-cache", "no-cache 允许协商");
    const r2 = fakeRes();
    await serveFileRoute(r2, rawReqForFiles({ "if-none-match": etag }), new URL(urlOf("hello.md")), {});
    assert.equal(r2._calls.status, 304, "If-None-Match 命中 → 304");
    assert.ok(r2._calls.data === undefined || r2._calls.data === null || String(r2._calls.data).length === 0, "304 无 body");
  }

  // 绝对路径免 cwd（评审 C5）
  {
    const res = fakeRes();
    await serveFileRoute(res, rawReqForFiles(), new URL(`http://localhost${ROUTES.file}?path=${encodeURIComponent(textPath)}`), {});
    assert.equal(res._calls.status, 200, "绝对路径无需 cwd 即可预览");
  }
  // 文本超限 413（评审 C6）：maxTextBytes 真正生效；413 在 ETag 前、不缓存
  {
    writeFileSync(join(root, "big.md"), "x".repeat(40), "utf8");
    const res = fakeRes();
    await serveFileRoute(res, rawReqForFiles(), new URL(urlOf("big.md")), { maxTextBytes: 16 });
    assert.equal(res._calls.status, 413, "超限 → 413");
    assert.equal(res._calls.headers["cache-control"], "no-store", "413 不缓存");
    const payload = JSON.parse(res._calls.data);
    assert.equal(payload.truncated, true, "413 带 truncated 标记");
    assert.equal(payload.max, 16);
    // 带 If-None-Match 也不走 304（413 优先于 ETag）
    const res2 = fakeRes();
    await serveFileRoute(res2, rawReqForFiles({ "if-none-match": '"9-1"' }), new URL(urlOf("big.md")), { maxTextBytes: 16 });
    assert.equal(res2._calls.status, 413, "带 If-None-Match 的超限文件仍 413");
  }

  // git diff（F2）：有变化才 hasDiff；无变化/非仓库/未跟踪分别标记
  {
    const gitRoot = join(root, "gitrepo");
    mkdirSync(gitRoot, { recursive: true });
    const g = (args) => git(gitRoot, args);
    if (g(["init"]).status === 0) {
      g(["config", "user.email", "t@t"]);
      g(["config", "user.name", "t"]);
      writeFileSync(join(gitRoot, "a.txt"), "line1\n", "utf8");
      g(["add", "."]);
      g(["commit", "-m", "c1"]);
      assert.equal((await computeGitDiff(gitRoot, "a.txt")).reason, "no-changes", "已提交无变化 → no-changes");
      writeFileSync(join(gitRoot, "a.txt"), "line1\nline2\n", "utf8");
      const r = await computeGitDiff(gitRoot, "a.txt");
      assert.equal(r.hasDiff, true, "已修改 → hasDiff");
      assert.ok(r.diff !== undefined && r.diff.includes("+line2"), "diff 含新增行");
      // 推送前修复（P0）：git diff 必须 --no-textconv——恶意 .gitattributes+config 的
      // textconv 可让 git 以 dsh 进程身份执行任意命令。验证：配置 textconv 指向写标记
      // 文件的脚本，computeGitDiff 后标记文件不得存在（命令未被执行）。
      {
        const marker = join(gitRoot, "fwp-textconv-ran");
        writeFileSync(join(gitRoot, ".gitattributes"), "a.txt diff=fwptc\n", "utf8");
        if (g(["config", "diff.fwptc.textconv", `sh -c "touch ${marker}"`]).status === 0) {
          const r2 = await computeGitDiff(gitRoot, "a.txt");
          assert.equal(existsSync(marker), false, "textconv 不得被触发执行（--no-textconv 生效）");
          assert.equal(r2.hasDiff, true, "加固后 diff 仍正常（不回退功能）");
        } else {
          console.log("  (跳过 textconv 断言：git config 不可用)");
        }
        rmSync(join(gitRoot, ".gitattributes"), { force: true }); // 还原，防影响 untracked 断言
      }
      // 推送前修复（P1）：git 级错误（非零数字退出码，如索引损坏的 fatal 128）→ reason=error，
      // 不得误判为 no-changes（Diff「无变化」）。构造：损坏 .git/index 使 status 报错。
      {
        const idx = join(gitRoot, ".git", "index");
        const indexBackup = join(gitRoot, ".git", "index.bak");
        if (existsSync(idx) && g(["status", "--porcelain"]).status === 0) {
          renameSync(idx, indexBackup); // 移走真索引
          writeFileSync(idx, "CORRUPT", "utf8"); // 损坏索引
          try {
            const r3 = await computeGitDiff(gitRoot, "a.txt");
            assert.equal(r3.reason, "error", "git 级错误（非零码）→ error，非 no-changes");
          } finally {
            rmSync(idx, { force: true });
            renameSync(indexBackup, idx); // 还原，防影响 untracked 断言
          }
        } else {
          console.log("  (跳过 runGit 非零码断言：git status 前置检查失败)");
        }
      }
      writeFileSync(join(gitRoot, "new.txt"), "x\n", "utf8");
      assert.equal((await computeGitDiff(gitRoot, "new.txt")).untracked, true, "未跟踪新文件 → untracked");
    } else {
      console.log("  (跳过 git 断言：git init 不可用)");
    }
    assert.equal((await computeGitDiff(root, "hello.md")).reason, "not-git", "非 git 目录 → not-git");
  }

  // ---- issue #41/#486：file 404 负路径 basename 兜底搜索（通用遍历，非 git）----
  {
    const gitRoot = join(root, "bk-repo"); // git 仓目录（仅证明「git 仓内同样可用」，
    // 遍历不依赖 git 命令；gitignore 不再豁免——A1 决策：物理存在+唯一即暴露）
    mkdirSync(gitRoot, { recursive: true });
    const gb = (args) => git(gitRoot, args);
    const fileUrl = (cwd, p) =>
      `http://127.0.0.1${ROUTES.file}?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(p)}`;
    const gitOk = gb(["init"]).status === 0;
    if (gitOk) {
      gb(["config", "user.email", "t@t"]);
      gb(["config", "user.name", "t"]);
    }
    // 用例 1 — 唯一命中：裸名实际位于 assets/deep/ → 200 + X-File-Path = 真实绝对
    mkdirSync(join(gitRoot, "assets", "deep"), { recursive: true });
    writeFileSync(join(gitRoot, "assets", "deep", "solo.md"), "fallback hit", "utf8");
    if (gitOk) gb(["add", "."]);
    {
      const res = fakeRes();
      await serveFileRoute(res, rawReqForFiles(), new URL(fileUrl(gitRoot, "solo.md")), {});
      assert.equal(res._calls.status, 200, "#486 唯一裸名兜底命中 → 200");
      assert.equal(res._calls.data, "fallback hit", "#486 兜底按真实路径读出内容");
      const fp = res._calls.headers["x-file-path"];
      assert.ok(typeof fp === "string", "#486 命中响应带 X-File-Path");
      assert.equal(decodeURIComponent(fp), join(gitRoot, "assets", "deep", "solo.md"),
        "#486 X-File-Path = 真实 resolved 绝对路径（搜索纠正）");
    }
    // 主路径不受影响：直接命中零新增开销 + X-File-Path 同值
    writeFileSync(join(gitRoot, "direct.md"), "direct", "utf8");
    {
      const res = fakeRes();
      await serveFileRoute(res, rawReqForFiles(), new URL(fileUrl(gitRoot, "direct.md")), {});
      assert.equal(res._calls.status, 200, "#486 直接命中的主路径行为不变");
      assert.equal(decodeURIComponent(res._calls.headers["x-file-path"]), join(gitRoot, "direct.md"),
        "#486 直接命中 X-File-Path = resolve 结果（viaSearch=false 同值）");
    }
    // 用例 2 — 多命中 → 放弃维持 404（basename 歧义即 inert）
    mkdirSync(join(gitRoot, "d1"), { recursive: true });
    mkdirSync(join(gitRoot, "d2"), { recursive: true });
    writeFileSync(join(gitRoot, "d1", "dup.md"), "one", "utf8");
    writeFileSync(join(gitRoot, "d2", "dup.md"), "two", "utf8");
    {
      const res = fakeRes();
      await serveFileRoute(res, rawReqForFiles(), new URL(fileUrl(gitRoot, "dup.md")), {});
      assert.equal(res._calls.status, 404, "#486 ≥2 同名 → 放弃维持 404");
    }
    // 用例 5（A1 翻转）— gitignore 忽略的真实文件：物理存在+唯一 → 暴露
    //（旧 #41 语义「gitignore 隐藏」已废弃；被忽略文件本就经 /file 直读可达，
    // 兜底搜索暴露它不新增访问面——README 安全模型明示）
    writeFileSync(join(gitRoot, ".gitignore"), "secret-*.txt\n", "utf8");
    mkdirSync(join(gitRoot, "ignored"), { recursive: true });
    writeFileSync(join(gitRoot, "ignored", "secret-leak.txt"), "ignored but physical", "utf8");
    {
      const res = fakeRes();
      await serveFileRoute(res, rawReqForFiles(), new URL(fileUrl(gitRoot, "secret-leak.txt")), {});
      assert.equal(res._calls.status, 200, "#486 A1：gitignore 忽略的真实文件唯一 → 暴露（物理存在即暴露）");
      assert.equal(res._calls.data, "ignored but physical", "#486 读出的确是被忽略文件内容");
    }
    // 用例 6 — dot 目录跳过、dot 文件（裸名）可命中（决策钉死）
    mkdirSync(join(gitRoot, ".hiddendir"), { recursive: true });
    writeFileSync(join(gitRoot, ".hiddendir", "dotdir-file.txt"), "dotdir", "utf8");
    writeFileSync(join(gitRoot, ".env"), "dotfile content", "utf8");
    {
      const resDot = fakeRes();
      await serveFileRoute(resDot, rawReqForFiles(), new URL(fileUrl(gitRoot, "dotdir-file.txt")), {});
      assert.equal(resDot._calls.status, 404, "#486 dot 目录（.hiddendir）不进入遍历 → 404");
      // .env 裸名：extOf 空 → 分组 other → 嗅探文本（#630 改动 B）→ 200 直出，
      // 非 404（「找不到」）——即证明 dot 文件被兜底命中且嗅探放行（纯函数层
      // .env 命中断言见 unit-basename-fallback）。
      const resEnv = fakeRes();
      await serveFileRoute(resEnv, rawReqForFiles(), new URL(fileUrl(gitRoot, ".env")), {});
      assert.equal(resEnv._calls.status, 200, "#486 dot 文件（.env 裸名）兜底命中 → 200（#630 嗅探文本直出）");
      assert.equal(resEnv._calls.data, "dotfile content", "#630 .env 内容按文本直出");
    }
    // —— issue #630 改动 B：嗅探兜底与 ?dl=1 下载出口 ——
    // dl=1 对二进制文件 → attachment 下载（RFC 5987 filename* 编码中文/特殊字符）
    {
      const binName = "资源包.bin";
      writeFileSync(join(gitRoot, binName), Buffer.from([0x00, 0x01, 0x02, 0x00]), "binary");
      const resDl = fakeRes();
      await serveFileRoute(resDl, rawReqForFiles(), new URL(fileUrl(gitRoot, binName) + "&dl=1"), {});
      assert.equal(resDl._calls.status, 200, "#630 dl=1 二进制 → 200 下载");
      assert.equal(resDl._calls.headers["content-type"], "application/octet-stream", "#630 下载 Content-Type octet-stream");
      assert.equal(resDl._calls.headers["content-disposition"], `attachment; filename="___.bin"; filename*=UTF-8''${encodeURIComponent(binName)}`, "#630 RFC 5987 filename* + ASCII 回退（中文不炸头）");
      assert.equal(resDl._calls.headers["x-content-type-options"], "nosniff", "#630 下载带 nosniff");
      assert.ok(Buffer.isBuffer(resDl._calls.data) && resDl._calls.data.length === 4, "#630 下载内容完整直出");
      // dl=1 对文本文件不生效（仅二进制分支响应）→ 正常文本直出
      const resDlText = fakeRes();
      await serveFileRoute(resDlText, rawReqForFiles(), new URL(fileUrl(gitRoot, ".env") + "&dl=1"), {});
      assert.equal(resDlText._calls.status, 200, "#630 dl=1 对文本分支忽略 → 200 文本直出");
      assert.equal(resDlText._calls.headers["content-disposition"], undefined, "#630 文本分支不带头 attachment");
      // dl=1 对白名单内文件（md）同样忽略
      const resDlMd = fakeRes();
      await serveFileRoute(resDlMd, rawReqForFiles(), new URL(fileUrl(gitRoot, "direct.md") + "&dl=1"), {});
      assert.equal(resDlMd._calls.status, 200, "#630 dl=1 对白名单内 md 忽略 → 200");
      assert.equal(resDlMd._calls.headers["content-disposition"], undefined, "#630 白名单内不带头 attachment");
    }
    // UTF-16LE BOM 文本 → 嗅探判文本 + 转码直出（BOM 剥除，不乱码）
    {
      const u16 = Buffer.from([0xff, 0xfe, ...Buffer.from("# 标题\nline2", "utf16le")]);
      writeFileSync(join(gitRoot, "u16.xyz"), u16, "binary");
      const resU16 = fakeRes();
      await serveFileRoute(resU16, rawReqForFiles(), new URL(fileUrl(gitRoot, "u16.xyz")), {});
      assert.equal(resU16._calls.status, 200, "#630 UTF-16LE BOM 嗅探判文本");
      assert.equal(resU16._calls.data, "# 标题\nline2", "#630 UTF-16 转码直出且 BOM 剥除");
    }
    // UTF-8 BOM 文本 → 嗅探判文本 + BOM 剥除直出
    {
      writeFileSync(join(gitRoot, "u8bom.xyz"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("bom utf8", "utf8")]), "binary");
      const resU8 = fakeRes();
      await serveFileRoute(resU8, rawReqForFiles(), new URL(fileUrl(gitRoot, "u8bom.xyz")), {});
      assert.equal(resU8._calls.status, 200, "#630 UTF-8 BOM 嗅探判文本");
      assert.equal(resU8._calls.data, "bom utf8", "#630 UTF-8 BOM 剥除直出");
    }
    // 无 BOM 启发式 UTF-16（偶数位 NUL）→ isbinaryfile 判 binary → 保守 415 占位
    {
      const src = "utf16 nobom";
      const nobom = Buffer.alloc(src.length * 2);
      for (let i = 0; i < src.length; i++) nobom.writeUInt16LE(src.charCodeAt(i), i * 2);
      writeFileSync(join(gitRoot, "u16n.xyz"), nobom, "binary");
      const resN = fakeRes();
      await serveFileRoute(resN, rawReqForFiles(), new URL(fileUrl(gitRoot, "u16n.xyz")), {});
      assert.equal(resN._calls.status, 415, "#630 无 BOM 启发式 UTF-16 保守判二进制");
      assert.equal(JSON.parse(resN._calls.data).binary, true, "#630 无 BOM UTF-16 占位带 binary:true");
    }
    // 用例 7 — 绝对 path 目录写错也进搜索（三级全开）：请求带 cwd（搜索根）+ 不存在
    // 的绝对 path → ③ 按 basename 在 cwd 内唯一搜索纠正（不带 cwd 则无搜索根，不触发）
    {
      const wrongAbs = join(gitRoot, "no-such-dir", "solo.md");
      const res = fakeRes();
      await serveFileRoute(res, rawReqForFiles(), new URL(
        `http://127.0.0.1${ROUTES.file}?cwd=${encodeURIComponent(gitRoot)}&path=${encodeURIComponent(wrongAbs)}`), {});
      assert.equal(res._calls.status, 200, "#486 绝对 path 404 后也进 basename 搜索（三级全开）");
      assert.equal(decodeURIComponent(res._calls.headers["x-file-path"]), join(gitRoot, "assets", "deep", "solo.md"));
    }

    // 用例 3 — 非 git 工作区遍历命中（同一通用遍历，无 git 依赖）
    const plainDir = join(root, "plain-ws");
    mkdirSync(join(plainDir, "nested"), { recursive: true });
    writeFileSync(join(plainDir, "nested", "only.txt"), "plain walk hit", "utf8");
    {
      const res = fakeRes();
      await serveFileRoute(res, rawReqForFiles(), new URL(fileUrl(plainDir, "only.txt")), {});
      assert.equal(res._calls.status, 200, "#486 非 git 工作区唯一命中 → 200");
      assert.equal(res._calls.data, "plain walk hit");
      assert.equal(decodeURIComponent(res._calls.headers["x-file-path"]), join(plainDir, "nested", "only.txt"));
    }

    // 用例 4 — 触顶放弃（opts 注入小 walkLimit；路由层生产默认 20000 不宜构造大目录）
    assert.equal(await findUniqueByBasename(plainDir, "only.txt", { walkLimit: 0 }), null, "#486 触顶即放弃（walkLimit=0）");
    assert.equal(await findUniqueByBasename(plainDir, "only.txt"), join(plainDir, "nested", "only.txt"), "#486 对照：不限触顶时遍历找到真实绝对路径");
    assert.equal(await findUniqueByBasename(plainDir, "no-such-file.xyz"), null, "#486 零命中 → null 维持 404");
    // bareBasenameOf 单元语义：末段提取 / 尾分隔符与空值拒绝
    assert.equal(bareBasenameOf("a/b/c.png"), "c.png");
    assert.equal(bareBasenameOf("a\\b\\c.png"), "c.png", "Windows 分隔符兼容");
    assert.equal(bareBasenameOf("dir/"), null, "尾分隔符末段为空 → 不兜底");
    assert.equal(bareBasenameOf(""), null);
    assert.equal(bareBasenameOf(".."), null, ".. 无末段凭证 → 不兜底");
    // resolveFile 三级定位纯函数（#486）：命中文件 / 命中目录（不进搜索）/ 三级搜索
    writeFileSync(join(plainDir, "root.txt"), "root", "utf8");
    {
      const hit = await resolveFile(plainDir, "root.txt");
      assert.equal(hit?.kind, "file", "#486 resolveFile 相对直接命中 → file");
      assert.equal(hit?.viaSearch, false, "#486 直接命中 viaSearch=false");
      const searched = await resolveFile(plainDir, "only.txt");
      assert.equal(searched?.kind, "file", "#486 resolveFile 相对 404 → ③ 搜索命中");
      assert.equal(searched?.viaSearch, true, "#486 搜索命中 viaSearch=true");
      assert.equal(searched?.resolved, join(plainDir, "nested", "only.txt"), "#486 搜索命中 resolved=真实绝对");
      const absWrong = await resolveFile(plainDir, join(plainDir, "no-dir", "only.txt"));
      assert.equal(absWrong?.kind, "file", "#486 resolveFile 绝对 path 404 → ③ 搜索命中");
      assert.equal(absWrong?.viaSearch, true, "#486 绝对搜索命中 viaSearch=true");
      const dirHit = await resolveFile(plainDir, "nested");
      assert.equal(dirHit?.kind, "dir", "#486 resolve 命中目录 → dir（不进搜索改名换读）");
      const none = await resolveFile(plainDir, "no-such-file.xyz");
      assert.equal(none, null, "#486 resolveFile 全失败 → null");
    }
  }

  // 客户端产物契约（load id / IIFE 外壳 / apply+inject 装配 / factory 形态）
  assertClientSourceContract(pkgDir);
  assertClientProductContract(pkgDir);
  // ---- issue #73：serve token 虚拟伺服（A/B/C/D/E 组）----
  // 隔离 serve 用独立临时目录（不污染上方 root 的既有断言）。零落盘断言需要
  // 「serveRoot 的父目录无新增文件」——父目录必须是本用例专属的 mkdtemp 隔离
  // 目录（直接以 tmpdir 为父会在 pnpm -r 并行测试时被其他包的临时目录误报）。
  {
    const serveParent = mkdtempSync(join(tmpdir(), "fwp-serve-parent-"));
    const serveRoot = join(serveParent, "webroot");
    mkdirSync(serveRoot, { recursive: true });
    try {
      mkdirSync(join(serveRoot, "assets"), { recursive: true });
      writeFileSync(join(serveRoot, "index.html"), "<!doctype html><h1>hi</h1>\n", "utf8");
      writeFileSync(join(serveRoot, "assets", "app.css"), "body{color:red}\n", "utf8");
      writeFileSync(join(serveRoot, "assets", "app.js"), "console.log('x')\n", "utf8");
      writeFileSync(join(serveRoot, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), "utf8");
      writeFileSync(join(serveRoot, "blob.q7x9z"), "opaque", "utf8");
      writeFileSync(join(serveRoot, "dir.txt"), "dir content", "utf8");
      mkdirSync(join(serveRoot, "subdir"));
      writeFileSync(join(serveRoot, "subdir", "page.html"), "<p>page</p>", "utf8");
      // 越界目标：root 外真实文件（C4 对照：/file 逃逸 200，serve 越界 404）
      const outside = join(serveParent, `fwp-serve-outside-${Date.now()}.txt`);
      writeFileSync(outside, "outside", "utf8");
      const outsideName = basename(outside);

      const serveUrl = (token, rest) => `http://127.0.0.1${ROUTES.serve}/${token}/${rest}`;
      const allocOf = (p, cwd = serveRoot) =>
        `http://127.0.0.1${ROUTES.alloc}?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(p)}`;

      // A5：alloc 返回 200 + 随机 token + rest（相对 root 的 POSIX 相对路径）
      let token = "";
      {
        const res = fakeRes();
        await allocRoute(fakeReq("GET", allocOf("index.html"), "127.0.0.1"), res);
        assert.equal(res._calls.status, 200, "#73 alloc 200");
        const payload = JSON.parse(res._calls.data);
        assert.equal(payload.ok, true, "#73 alloc ok:true");
        assert.ok(typeof payload.token === "string" && /^[0-9a-f]{32}$/.test(payload.token), "#73 token 为 128-bit 随机 hex");
        assert.equal(payload.rest, "index.html", "#73 rest 为相对 root 的 POSIX 相对路径");
        assert.equal(payload.root, undefined, "#73 alloc 不返回 root（P2-3：多余信息面移除）");
        assert.equal(payload.mode, "static", "#507 缺省 alloc 响应带 mode=static");
        token = payload.token;
      }
      // issue #507：mode=interactive alloc → 独立短 TTL 交互桶（响应 mode=interactive）
      {
        const res = fakeRes();
        const interactiveAlloc = `${ROUTES.alloc}?cwd=${encodeURIComponent(serveRoot)}&path=${encodeURIComponent("index.html")}&mode=interactive`;
        await allocRoute(fakeReq("GET", interactiveAlloc, "127.0.0.1"), res);
        assert.equal(res._calls.status, 200, "#507 交互 alloc 200");
        const payload = JSON.parse(res._calls.data);
        assert.equal(payload.mode, "interactive", "#507 交互 alloc 响应 mode=interactive");
        assert.ok(typeof payload.token === "string" && /^[0-9a-f]{32}$/.test(payload.token), "#507 交互 token 128-bit");
        // 交互 token 可 serve（CSP 断言见 serve 用例区）；同时交互 token 与静态
        // token 空间独立——交互桶 token 未知于静态桶，serve 按桶判定模式。
        const resS = fakeRes();
        await serveRouteHandler(fakeReq("GET", serveUrl(payload.token, "index.html"), "127.0.0.1"), resS);
        assert.equal(resS._calls.status, 200, "#507 交互 token serve 200");
        assert.ok(String(resS._calls.headers["content-security-policy"]).includes("sandbox allow-scripts"), "#507 交互 html 响应带 allow-scripts CSP");
        assert.ok(String(resS._calls.headers["content-security-policy"]).includes("connect-src 'none'"), "#507 交互 CSP 含 connect-src 'none'（封主动外传）");
        // 释放交互 token（幂等；释放后 serve 404）
        const resR = fakeRes();
        releaseRoute(fakeReq("GET", ROUTES.release + "?token=" + payload.token, "127.0.0.1"), resR);
        assert.equal(resR._calls.status, 200, "#507 release 交互 token 200");
        const resGone = fakeRes();
        await serveRouteHandler(fakeReq("GET", serveUrl(payload.token, "index.html"), "127.0.0.1"), resGone);
        assert.equal(resGone._calls.status, 404, "#507 释放后交互 token serve 404");
      }
      // alloc 非 html → 400；不存在 → 404；缺参 → 400
      {
        const res = fakeRes();
        await allocRoute(fakeReq("GET", allocOf("assets/app.css"), "127.0.0.1"), res);
        assert.equal(res._calls.status, 400, "#73 alloc 非 html → 400");
      }
      {
        const res = fakeRes();
        await allocRoute(fakeReq("GET", allocOf("nope.html"), "127.0.0.1"), res);
        assert.equal(res._calls.status, 404, "#73 alloc 不存在 → 404");
      }
      {
        const res = fakeRes();
        await allocRoute(fakeReq("GET", `${ROUTES.alloc}?cwd=${encodeURIComponent(serveRoot)}`, "127.0.0.1"), res);
        assert.equal(res._calls.status, 400, "#73 alloc 缺 path → 400");
      }
      // A3：未知 token → 404（不泄露区分信息）
      {
        const res = fakeRes();
        await serveRouteHandler(fakeReq("GET", serveUrl("deadbeefdeadbeefdeadbeefdeadbeef", "index.html"), "127.0.0.1"), res);
        assert.equal(res._calls.status, 404, "#73 未知 token → 404");
      }
      // E1：serve 独立 MIME 判定——html→text/html、css→text/css、js→text/javascript、
      //     png→image/png、未知→octet-stream
      {
        const cases = [
          ["index.html", /^text\/html/],
          ["assets/app.css", /^text\/css/],
          ["assets/app.js", /^text\/javascript/],
          ["pic.png", /^image\/png/],
          ["blob.q7x9z", /^application\/octet-stream/],
        ];
        for (const [rest, re] of cases) {
          const res = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(token, rest), "127.0.0.1"), res);
          assert.equal(res._calls.status, 200, `#73 serve ${rest} 200`);
          assert.match(String(res._calls.headers["content-type"]), re, `#73 serve ${rest} Content-Type`);
        }
      }
      // A4：serve 响应一律 nosniff + referrer-policy no-referrer
      {
        const res = fakeRes();
        await serveRouteHandler(fakeReq("GET", serveUrl(token, "index.html"), "127.0.0.1"), res);
        assert.equal(res._calls.headers["x-content-type-options"], "nosniff", "#73 serve 带 nosniff");
        assert.equal(res._calls.headers["referrer-policy"], "no-referrer", "#73 serve 带 no-referrer");
      }
      // #549：serve 围栏放宽——sandbox iframe（opaque origin）相对路径子资源请求
      // 带 `sec-fetch-site: cross-site`；serve 路由经 allowCrossSiteNoCors 放行
      // 显式 no-cors 的标签型加载，cors/navigate/缺 mode 头仍 fail-closed 拒绝。
      {
        const res = fakeRes();
        await serveRouteHandler(
          fakeReq("GET", serveUrl(token, "assets/app.css"), "127.0.0.1", "127.0.0.1", {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "no-cors",
          }),
          res
        );
        assert.equal(res._calls.status, 200, "#549 serve 跨站 no-cors 子资源放行（css 200）");
      }
      {
        const res = fakeRes();
        await serveRouteHandler(
          fakeReq("GET", serveUrl(token, "index.html"), "127.0.0.1", "127.0.0.1", {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "no-cors",
          }),
          res
        );
        assert.equal(res._calls.status, 200, "#549 serve 跨站 no-cors 子资源放行（html 200）");
      }
      {
        const res = fakeRes();
        await serveRouteHandler(
          fakeReq("GET", serveUrl(token, "index.html"), "127.0.0.1", "127.0.0.1", {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "cors",
          }),
          res
        );
        assert.equal(res._calls.status, 403, "#549 serve 跨站 cors（fetch 形态）仍 403");
      }
      {
        const res = fakeRes();
        await serveRouteHandler(
          fakeReq("GET", serveUrl(token, "index.html"), "127.0.0.1", "127.0.0.1", {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
          }),
          res
        );
        assert.equal(res._calls.status, 403, "#549 serve 跨站 navigate（顶层导航）仍 403");
      }
      {
        const res = fakeRes();
        await serveRouteHandler(
          fakeReq("GET", serveUrl(token, "index.html"), "127.0.0.1", "127.0.0.1", {
            "sec-fetch-site": "cross-site",
          }),
          res
        );
        assert.equal(res._calls.status, 403, "#549 serve 跨站缺 mode 头 fail-closed 403");
      }
      // #549：跨站放宽是 serve 路由独有——alloc/release/file 对 cross-site no-cors 仍 403
      {
        const res = fakeRes();
        await allocRoute(
          fakeReq("GET", allocOf("index.html"), "127.0.0.1", "127.0.0.1", {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "no-cors",
          }),
          res
        );
        assert.equal(res._calls.status, 403, "#549 alloc 对跨站 no-cors 仍 403（不放宽）");
      }
      {
        const res = fakeRes();
        releaseRoute(
          fakeReq("GET", ROUTES.release + "?token=" + token, "127.0.0.1", "127.0.0.1", {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "no-cors",
          }),
          res
        );
        assert.equal(res._calls.status, 403, "#549 release 对跨站 no-cors 仍 403（不放宽）");
      }
      {
        const res = fakeRes();
        fileRoute(fakeReq("GET", ROUTES.file + `?cwd=${encodeURIComponent(serveRoot)}&path=assets%2Fapp.css`, "127.0.0.1", "127.0.0.1", {
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "no-cors",
        }), res);
        assert.equal(res._calls.status, 403, "#549 file 对跨站 no-cors 仍 403（不放宽）");
      }
      // E3：serve 字节直出不改写（body === 磁盘原文件）
      {
        const res = fakeRes();
        await serveRouteHandler(fakeReq("GET", serveUrl(token, "index.html"), "127.0.0.1"), res);
        assert.equal(res._calls.data.toString("utf8"), "<!doctype html><h1>hi</h1>\n", "#73 serve 不重写 HTML（字节一致）");
        assert.equal(String(res._calls.headers["content-length"]), String(Buffer.byteLength("<!doctype html><h1>hi</h1>\n")), "#73 Content-Length 正确");
      }
      // C3：目录请求 → 404（根路径 / 已知目录，不做目录列表）
      {
        const res = fakeRes();
        await serveRouteHandler(fakeReq("GET", `${ROUTES.serve}/${token}/`, "127.0.0.1"), res);
        assert.equal(res._calls.status, 404, "#73 serve 根路径（目录）→ 404");
      }
      // P2-4 对照：有效 token + 空 rest → 404（与未知 token 404 同码，不泄露区分信息）
      {
        const res = fakeRes();
        await serveRouteHandler(fakeReq("GET", `${ROUTES.serve}/${token}`, "127.0.0.1"), res);
        assert.equal(res._calls.status, 404, "#73 有效 token 空 rest → 404（C3 对照）");
      }
      {
        const res = fakeRes();
        await serveRouteHandler(fakeReq("GET", serveUrl(token, "subdir"), "127.0.0.1"), res);
        assert.equal(res._calls.status, 404, "#73 serve 已知目录 → 404（不做目录列表）");
      }
      // C4：root 越界（逃逸到 root 外存在的文件）→ 404——与 /file「逃逸 200」刻意相反。
      // 注意：字面 `../` 会被 URL 解析器折叠（`/serve/<token>/../x` → `/serve/x`，token 段
      // 被吃→404 来自未知 token，属「折叠语义」而非越界分支，测试会失真）——故用
      // `%2e%2e%2f` 编码形态断言：解码后还原 `../` 段，必须命中 realpath 越界分支（评审 P2-1）。
      {
        const res = fakeRes();
        await serveRouteHandler(fakeReq("GET", serveUrl(token, `..%2f${outsideName}`), "127.0.0.1"), res);
        assert.equal(res._calls.status, 404, "#73 serve 越界（%2e%2e 编码）→ 404（与 /file 逃逸 200 对照）");
      }
      // P1-1 回归：符号链接目录下 HTML 预览全链路（alloc→serve）必须 200——
      // root 与 rest 基于同一 realpath 归一基，rest 不得含 `..` 段。
      {
        const linkName = `fwp-serve-link-${Date.now()}`;
        const linkDir = join(serveParent, linkName);
        let linked = false;
        try {
          symlinkSync(serveRoot, linkDir); // serveRoot 真实目录 → 链接目录
          linked = true;
        } catch { /* 平台 symlink 受限 → 跳过 */ }
        if (linked) {
          try {
            const res = fakeRes();
            await allocRoute(fakeReq("GET", allocOf("index.html", linkDir), "127.0.0.1"), res);
            assert.equal(res._calls.status, 200, "#73 符号链接目录 alloc 200");
            const p = JSON.parse(res._calls.data);
            assert.ok(!p.rest.includes(".."), `#73 符号链接目录 rest 不含 ..（实际 ${p.rest}）`);
            const sres = fakeRes();
            await serveRouteHandler(fakeReq("GET", serveUrl(p.token, p.rest), "127.0.0.1"), sres);
            assert.equal(sres._calls.status, 200, "#73 符号链接目录 serve 200（P1-1 回归）");
            assert.equal(sres._calls.data.toString("utf8"), "<!doctype html><h1>hi</h1>\n", "#73 符号链接目录内容一致");
          } finally {
            rmSync(linkDir, { recursive: true, force: true });
          }
        } else {
          console.log("  (跳过 P1-1 符号链接目录断言：symlink 不可用)");
        }
      }
      // C2：编码攻击面——rest 以 / 开头、含 \0、交替分隔符 \、%2e%2e 解码段、绝对路径
      {
        const attackCases = [
          `/etc/passwd`,            // 以 / 开头（URL 解析后变成路径段）
          `a%2f..%2f${outsideName}`, // %2f 编码斜杠
          `..%2f${outsideName}`,     // %2e%2e 编码点
          `subdir/../../${outsideName}`,
          `a\\b.html`,               // Windows 交替分隔符
          `index.html%00`,           // \0 注入（NUL 编码）
        ];
        for (const rest of attackCases) {
          const res = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(token, rest), "127.0.0.1"), res);
          assert.ok(res._calls.status === 404 || res._calls.status === 400, `#73 攻击面 ${rest} → 404/400（实际 ${res._calls.status}）`);
          assert.ok(res._calls.status !== 500, `#73 攻击面 ${rest} 不 5xx`);
        }
      }
      // B5：release 后同 token → 404（幂等：重复 release 仍 200）
      {
        const res = fakeRes();
        releaseRoute(fakeReq("GET", `${ROUTES.release}?token=${token}`, "127.0.0.1"), res);
        assert.equal(res._calls.status, 200, "#73 release 200");
        const res2 = fakeRes();
        await serveRouteHandler(fakeReq("GET", serveUrl(token, "index.html"), "127.0.0.1"), res2);
        assert.equal(res2._calls.status, 404, "#73 release 后同 token → 404");
        const res3 = fakeRes();
        releaseRoute(fakeReq("GET", `${ROUTES.release}?token=${token}`, "127.0.0.1"), res3);
        assert.equal(res3._calls.status, 200, "#73 重复 release 幂等 200");
      }
      // B2：只读伺服、零落盘——serve 后 serveParent 下无新增文件（token 为内存态）
      {
        const before = new Set(readdirOf(serveParent));
        const res = fakeRes();
        await allocRoute(fakeReq("GET", allocOf("subdir/page.html"), "127.0.0.1"), res);
        const p2 = JSON.parse(res._calls.data);
        // alloc root = HTML 所在目录（serveRoot/subdir）→ rest 为相对该 root 的路径
        assert.equal(p2.rest, "page.html", "#73 子目录 html 的 rest 相对其所在目录");
        const res2 = fakeRes();
        await serveRouteHandler(fakeReq("GET", serveUrl(p2.token, p2.rest), "127.0.0.1"), res2);
        assert.equal(res2._calls.status, 200, "#73 多级目录伺服 200");
        const after = new Set(readdirOf(serveParent));
        for (const name of after) assert.ok(before.has(name), `#73 serve 零落盘：父目录无新增 ${name}`);
      }
      // B1：多 root 并存、互不串扰——两个不同 root 的 token 各自只能访问各自 root
      {
        const rootB = mkdtempSync(join(tmpdir(), "fwp-serve-b-"));
        try {
          writeFileSync(join(rootB, "index.html"), "<p>B</p>", "utf8");
          const ra = fakeRes();
          await allocRoute(fakeReq("GET", allocOf("index.html", serveRoot), "127.0.0.1"), ra);
          const pa = JSON.parse(ra._calls.data);
          const rb = fakeRes();
          await allocRoute(fakeReq("GET", allocOf("index.html", rootB), "127.0.0.1"), rb);
          const pb = JSON.parse(rb._calls.data);
          assert.notEqual(pa.token, pb.token, "#73 两 root 的 token 互不相同");
          const resA = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(pa.token, "index.html"), "127.0.0.1"), resA);
          assert.equal(resA._calls.data.toString("utf8"), "<!doctype html><h1>hi</h1>\n", "#73 token A 只服务 root A");
          const resB = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(pb.token, "index.html"), "127.0.0.1"), resB);
          assert.equal(resB._calls.data.toString("utf8"), "<p>B</p>", "#73 token B 只服务 root B");
          const cross = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(pa.token, "../b-index.html"), "127.0.0.1"), cross);
          assert.equal(cross._calls.status, 404, "#73 token A 无法经 ../ 访问 root B");
        } finally {
          rmSync(rootB, { recursive: true, force: true });
        }
      }
      // B3a：idle TTL——注入短 TTL + 可控时钟：命中刷新续存 / 到期回收后 404
      {
        // 用 createTokenStore + resetServeTokenStore 注入时钟（拨表断言）
        const { createTokenStore: mkStore, resetServeTokenStore: resetStore } = await import("../lib/index.js");
        let fakeNow = 1_000_000;
        const store = mkStore({ now: () => fakeNow, ttlMs: 10_000, maxTokens: 8, activeWindowMs: 5_000 });
        resetStore(store);
        try {
          const t1 = store.alloc(serveRoot);
          assert.ok(t1 !== null, "#73 B3a 注入 store 分配成功");
          assert.equal(store.size(), 1, "#73 B3a 分配后 1 个 token");
          // 命中刷新：get 后拨表前进 9s（< TTL）仍存活
          fakeNow += 9_000;
          const hit = store.get(t1);
          assert.ok(hit !== undefined && hit.root === serveRoot, "#73 B3a TTL 内 get 存活（命中刷新）");
          // 再拨 9s（上次 get 后 9s < 10s TTL）仍存活——证明 get 刷新了 lastHit
          fakeNow += 9_000;
          assert.ok(store.get(t1) !== undefined, "#73 B3a 命中刷新后 TTL 重新计时");
          // 闲置超过 TTL：拨 11s 后 get → 回收 → undefined
          fakeNow += 11_000;
          assert.equal(store.get(t1), undefined, "#73 B3a 闲置超 TTL → 回收");
          // 经 serve 路由验证到期 404
          const t2 = store.alloc(serveRoot);
          fakeNow += 11_000;
          const res = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(t2, "index.html"), "127.0.0.1"), res);
          assert.equal(res._calls.status, 404, "#73 B3a 到期 token 经 serve 路由 → 404");
        } finally {
          resetStore();
        }
      }
      // B4a：LRU 不淘汰活跃——达上限时活跃 token 保留、最久未用的非活跃 token 被淘汰
      {
        const { createTokenStore: mkStore, resetServeTokenStore: resetStore } = await import("../lib/index.js");
        let fakeNow = 2_000_000;
        // activeWindowMs=1s：t1 在窗口内（活跃），t2 老化出窗口（非活跃最旧）
        const store = mkStore({ now: () => fakeNow, ttlMs: 60_000, maxTokens: 3, activeWindowMs: 1_000 });
        resetStore(store);
        try {
          const t1 = store.alloc(serveRoot);
          const t2 = store.alloc(serveRoot);
          // 标记 t1 活跃（近 activeWindowMs 内有 serve 命中）
          fakeNow += 500;
          store.get(t1);
          fakeNow += 600; // t2 自分配起闲置 1.1s > 1s 窗口 → 非活跃；t1 活跃
          const t3 = store.alloc(serveRoot);
          assert.ok(t3 !== null, "#73 B4a 第三次分配成功");
          assert.equal(store.size(), 3, "#73 B4a 上限 3 已满");
          // 再分配一个 → 必须淘汰非活跃最旧 t2，保留活跃 t1
          fakeNow += 300; // t1 距上次命中 900ms < 1s 仍活跃；t3 刚分配亦活跃
          const t4 = store.alloc(serveRoot);
          assert.ok(t4 !== null, "#73 B4a 达上限时腾出空位分配成功");
          assert.ok(store.get(t1) !== undefined, "#73 B4a 活跃 token 不被淘汰");
          assert.equal(store.get(t2), undefined, "#73 B4a 最久未用的非活跃 token 被淘汰");
          assert.equal(store.size(), 3, "#73 B4a 淘汰后仍为上限");
        } finally {
          resetStore();
        }
      }
      // C1：realpath 双向校验——闭合符号链接逃逸（root/link -> root 外敏感文件）→ 404
      {
        // B5 已释放初始 token——重新分配有效 token 供 C1/D1/D2/子目录用例使用。
        const ra = fakeRes();
        await allocRoute(fakeReq("GET", allocOf("index.html"), "127.0.0.1"), ra);
        const pa = JSON.parse(ra._calls.data);
        const liveToken = pa.token;
        // POSIX 上断言；Windows symlink 受限按现有「跳过」惯例（try/catch 建链失败即跳过）
        let linked = false;
        try {
          const symlink = join(serveRoot, "escape-link");
          rmSync(symlink, { force: true });
          symlinkSync(outside, symlink);
          linked = true;
        } catch { /* Windows 权限受限 → 跳过 */ }
        if (linked) {
          const res = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(liveToken, "escape-link"), "127.0.0.1"), res);
          assert.equal(res._calls.status, 404, "#73 符号链接逃逸（root/link -> root 外）→ 404");
        } else {
          console.log("  (跳过 C1 符号链接断言：symlink 不可用)");
        }
        // 对照：同 token 正常文件仍 200（证明 404 源于链接逃逸而非 token 失效）
        {
          const res = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(liveToken, "index.html"), "127.0.0.1"), res);
          assert.equal(res._calls.status, 200, "#73 C1 对照：有效 token 正常文件 200");
        }
        // issue #344 对称修复：serve 对 SVG 补 CSP sandbox（与 /file 一致），防顶层
        // 导航时 SVG 内嵌 <script> 执行；非 SVG 资源不带该头。
        {
          writeFileSync(join(serveRoot, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>", "utf8");
          const resSvg = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(liveToken, "icon.svg"), "127.0.0.1"), resSvg);
          assert.equal(resSvg._calls.status, 200, "#344 SVG serve 200");
          assert.equal(resSvg._calls.headers["content-security-policy"], "sandbox", "#344 SVG serve 带 CSP sandbox（对称修复）");
          const resCss = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(liveToken, "assets/app.css"), "127.0.0.1"), resCss);
          assert.equal(resCss._calls.headers["content-security-policy"], undefined, "#344 非 SVG 不带 CSP");
          // issue #507：serve text/html 按 token 模式注入 CSP——static `sandbox`
          // （顶层导航无脚本通道）；非 html 资源不带（与 #344 语义一致）。
          const resHtml = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(liveToken, "index.html"), "127.0.0.1"), resHtml);
          assert.equal(resHtml._calls.headers["content-security-policy"], "sandbox", "#507 static html 响应带 CSP sandbox（顶层导航无脚本）");
          rmSync(join(serveRoot, "icon.svg"), { force: true });
        }
        // D1：流式直出——>1MB 资源 Content-Length == stat.size 且 body 完整
        {
          const bigName = "big.bin";
          const bigSize = 2 * 1024 * 1024 + 123;
          const bigBuf = Buffer.alloc(bigSize, 7);
          writeFileSync(join(serveRoot, bigName), bigBuf);
          const res = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(liveToken, bigName), "127.0.0.1"), res);
          assert.equal(res._calls.status, 200, "#73 大文件 200");
          assert.equal(String(res._calls.headers["content-length"]), String(bigSize), "#73 Content-Length == stat.size");
          assert.ok(Buffer.isBuffer(res._calls.data) && res._calls.data.length === bigSize, "#73 body 完整直出");
          rmSync(join(serveRoot, bigName), { force: true });
        }
        // D2：单资源超 maxAssetBytes → 413 + truncated + no-store（先 stat 判大小、不整读）
        {
          // 用 serve 路由 cfg 注入小上限（模拟 maxAssetBytes 配置生效；默认 20M 太大）
          const smallCfg = { maxAssetBytes: 64 };
          writeFileSync(join(serveRoot, "big.html"), "<p>" + "x".repeat(100) + "</p>", "utf8");
          const res = fakeRes();
          await serveTokenRoute(res, fakeReq("GET", serveUrl(liveToken, "big.html"), "127.0.0.1"), new URL(serveUrl(liveToken, "big.html")), smallCfg);
          assert.equal(res._calls.status, 413, "#73 超限 → 413");
          assert.equal(res._calls.headers["cache-control"], "no-store", "#73 413 不缓存");
          const payload = JSON.parse(res._calls.data);
          assert.equal(payload.truncated, true, "#73 413 带 truncated 标记");
          assert.equal(payload.max, 64, "#73 413 带 max 值（maxAssetBytes）");
          rmSync(join(serveRoot, "big.html"), { force: true });
        }
        // 子目录相对伺服（G3 前置）：root 内多级路径正常
        {
          const res = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(liveToken, "assets/app.css"), "127.0.0.1"), res);
          assert.equal(res._calls.status, 200, "#73 子目录资源 200");
          assert.equal(res._calls.data.toString("utf8"), "body{color:red}\n", "#73 子目录内容正确");
        }
        // P1-2 语义：root 内子目录 HTML 的 `../` 引用（折叠后仍落在 token 前缀内）可达——
        // 浏览器把 subdir/page.html 的 ../style.css 折叠为 /serve/<token>/style.css。
        {
          const res = fakeRes();
          await serveRouteHandler(fakeReq("GET", serveUrl(liveToken, "assets/../index.html"), "127.0.0.1"), res);
          assert.equal(res._calls.status, 200, "#73 root 内 ../ 折叠引用 200（token 段保留）");
        }
      }
      rmSync(outside, { force: true });
    } finally {
      rmSync(serveParent, { recursive: true, force: true });
    }
  }

  console.log("PASS dsh-web-file-preview smoke");
} finally {
  rmSync(root, { recursive: true, force: true });
}
