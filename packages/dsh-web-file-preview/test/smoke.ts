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
  cleanRefChipPath, resolveAbsolutePath, splitReferenceFragment, serveTokenRoute, normalizeBasePath, rewriteTarget, dirResolvedPathOf,
  findUniqueByBasename, bareBasenameOf, resolveFile,
} from "../lib/index.js";
import { build as esbuildBuild } from "esbuild";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";

// 结构化单元测试（#83 阶段一：对齐 notifier 的 unit-*.test.ts 样板）
import "./unit-grouping.test.ts";
import "./unit-relpath.test.ts";
import "./unit-link-resolver.test.ts";
import "./unit-routes.test.ts";
import "./unit-serve-tokens.test.ts";
import "./unit-basename-fallback.test.ts";
import "./unit-git.test.ts";
import "./client-style.test.ts";

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

// issue #479：openPreview 入参归一（normalizeBasePath）——纯函数层；详细分支见
// unit-relpath.test.ts。此处补「归一化后 rewriteTarget 相对解析恢复」的层间回归：
// 相对 basePath 直接喂 rewriteTarget 全 NULL（P1 根因），归一为绝对后与绝对场景一致。
{
  const CWD = "/home/u/proj";
  const relBase = "docs/architecture/dsh-codegraph.md";
  const absBase = normalizeBasePath(relBase, CWD);
  assert.equal(absBase, "/home/u/proj/docs/architecture/dsh-codegraph.md", "#479 相对 basePath 归一为绝对");
  const relImg = rewriteTarget("diagrams/codegraph-architecture.svg", { cwd: CWD, basePath: relBase });
  const absImg = rewriteTarget("diagrams/codegraph-architecture.svg", { cwd: CWD, basePath: absBase });
  assert.equal(relImg, null, "#479 修复前（相对 basePath）：文内相对图片不重写（P1 根因已固化）");
  assert.ok(absImg !== null && absImg.path === "/home/u/proj/docs/architecture/diagrams/codegraph-architecture.svg", "#479 归一经 rewriteTarget 重写为预览目标");
}

// issue #479 P2：目录引用（[diagrams/](diagrams/) 等）——rewriteTarget 保持 null
// （目录不可预览），dirResolvedPathOf 返回目录绝对路径（rewrite.ts 据此标
// data-fp-dir → toast 提示，而非 target=_blank 新标签打开错误 URL）。
{
  const CWD = "/home/u/proj";
  const base = "/home/u/proj/docs/architecture/dsh-codegraph.md";
  const opts = { cwd: CWD, basePath: base };
  assert.equal(rewriteTarget("diagrams/", opts), null, "#479 P2 目录引用不可预览 → rewriteTarget null");
  assert.equal(dirResolvedPathOf("diagrams/", opts), "/home/u/proj/docs/architecture/diagrams/", "#479 P2 目录语义判定返回绝对目录路径");
  assert.equal(dirResolvedPathOf("./diagrams/", opts), "/home/u/proj/docs/architecture/diagrams/", "#479 P2 ./ 目录形态同样判定");
  assert.equal(dirResolvedPathOf("../../dir/", opts), "/home/u/proj/dir/", "#479 P2 ../ 上跳目录判定");
  assert.equal(dirResolvedPathOf("/abs/dir/", opts), "/abs/dir/", "#479 P2 绝对目录形态判定");
  assert.equal(dirResolvedPathOf("a.zip", opts), null, "#479 P2 不可预览文件不是目录");
  assert.equal(dirResolvedPathOf("a.md", opts), null, "#479 P2 可预览文件不是目录");
  assert.equal(dirResolvedPathOf("https://x/dir/", opts), null, "#479 P2 外域保留（非本地目录）");
  assert.equal(dirResolvedPathOf("diagrams", opts), null, "#479 P2 无尾斜杠目录引用不可判（维持现状）");
}


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
  // 不可预览类型 → 415
  {
    const res = fakeRes();
    await serveFileRoute(res, rawReqForFiles(), new URL(urlOf("blob.xyz")), {});
    assert.equal(res._calls.status, 415);
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
      // .env 裸名：extOf 空 → 分组 other → 415（「找到但不可预览」），而非 404
      //（「找不到」）——415 即证明 dot 文件被兜底命中（纯函数层 .env 命中断言
      // 见 unit-basename-fallback）。
      const resEnv = fakeRes();
      await serveFileRoute(resEnv, rawReqForFiles(), new URL(fileUrl(gitRoot, ".env")), {});
      assert.equal(resEnv._calls.status, 415, "#486 dot 文件（.env 裸名）兜底命中 → 415（找到但不可预览）");
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

  // 客户端契约 + 与宿主 ROUTES 路由一致性
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assertClientSourceContract(pkgDir);
  assertClientProductContract(pkgDir);
  const expectedRoutes = [ROUTES.file, ROUTES.diff, ROUTES.health, ROUTES.mermaid, ROUTES.serve, ROUTES.alloc, ROUTES.release];
  const literals = [...client.matchAll(/\/api\/dsh-file-preview\/[a-z-]+/g)].map((m) => m[0]);
  for (const literal of literals) assert.ok(expectedRoutes.includes(literal), `client 出现未知路由: ${literal}`);
  for (const route of expectedRoutes) assert.ok(literals.includes(route), `client 缺少路由: ${route}`);
  // issue #344 哨兵断言（防实现回退丢按钮）：断言**唯一字面量**（评审 F7）——
  // 「退出全屏/放大预览/退出放大」仅存在于 fullscreenLabel（不会被 css 中文注释/
  // 类名子串满足）；fwp-fs-btn 是按钮选择器唯一词。`.fwp-fs{` 带花括号前缀避免与
  // fwp-fs-btn/fwp-fs-on 子串混淆（css 经 text-loader 原样内联进 client.js）。
  assert.ok(client.includes("退出全屏"), "#344 client 含「退出全屏」文案（fullscreenLabel 唯一字面量）");
  assert.ok(client.includes("放大预览") && client.includes("退出放大"), "#344 client 含降级态文案（放大预览/退出放大）");
  assert.ok(client.includes('classList.add("fwp-fs-btn")') || client.includes(".fwp-fs-btn{"), "#344 client 含全屏按钮类名");
  assert.ok(client.includes(".fwp-fs{") || client.includes(".fwp-fs "), "#344 client 含视口放大降级类（带选择器上下文）");
  // i18n 接入哨兵（issue #348 → #378 抽取 shared）：NS / register / bind / 双语字典进产物
  assert.ok(client.includes('"filePreview"'), "i18n 命名空间 NS 进产物");
  assert.ok(client.includes("locale.register"), "locale.register（字典注册）进产物");
  assert.ok(client.includes("bindLocale"), "bindLocale（t 活绑定装配）进产物");
  // T4（#378）：locale.subscribe 返回值保存为 unsubLocale 并在卸载时调用——
  // 防重复 apply 后旧订阅持续重绑已停用实例（对齐 provider-usage 范式）。
  assert.ok(client.includes("unsubLocale = locale.subscribe"), "subscribe 返回值保存（unsubLocale）进产物");
  assert.ok(/unsubLocale!=null&&unsubLocale\(\)|unsubLocale\(\)/.test(client), "卸载调用 unsubLocale() 进产物");
  assert.ok(client.includes("Copy path") && client.includes("copyPath"), "en/zh 双语字典进产物");
  // issue #479 P2/P3 哨兵断言（防实现回退）：目录引用标 data-fp-dir（toast 提示而非
  // 新标签）、内嵌图失败标 fwp-img-failed 错误态 + imgFailHint 双语文案——minify 保留
  // 字符串字面量与类名，产物层可断言。
  assert.ok(client.includes("data-fp-dir"), "#479 P2 client 含目录引用标记（data-fp-dir）");
  assert.ok(client.includes("fwp-img-failed"), "#479 P3 client 含内嵌图失败错误态类名");
  assert.ok(client.includes("imgFailHint"), "#479 P3 client 含内嵌图失败提示文案键");
  assert.ok(client.includes("Image failed to load"), "#479 P3 en 文案进产物（双语平衡）");
  // issue #344（评审 F1/F2 防回退哨兵）：diff 渲染路径必须接入 render-limit 谓词
  // （renderDiff 超限降级）与返回栈 hadDiff 重探逻辑——minify 保留属性名（hadDiff）
  // 与导出函数名（exceedsTextRenderLimit），产物层可断言，防「修了一半」回归。
  assert.ok(client.includes("exceedsTextRenderLimit"), "#344 client 含渲染阈值谓词引用（F1 diff 降级接入）");
  assert.ok(client.includes("hadDiff"), "#344 client 含返回栈 diff 恢复标志（F2 重探逻辑）");
  // 0.1.2 适配（#323 Phase 1.3）：openPath 收口迁移到 ctx.remote.session.openWorkspacePath——
  // client 必须引用新调用面、不得再包装已删除的 workspaces.openPath。
  assert.ok(client.includes("openWorkspacePath"), "#323 client 含 openWorkspacePath 收口（0.1.2 迁移）");
  // #486-fix：客户端服务经 ctx 属性直访（provider-usage #383 同款）——宿主风格
  // ctx.get("remote") 在客户端注入代理抛 "without inject"；须 ctx.remote 直访且
  // inject 声明 remote/remote.session。
  assert.ok(client.includes("ctx.remote"), "#486-fix client 经 ctx.remote 直访取 Remote 网关");
  assert.ok(!client.includes('get("remote")'), "#486-fix client 不再用 ctx.get(\"remote\")（宿主风格不适配客户端代理）");
  assert.ok(!/\bws\.openPath\b/.test(client), "#323 不得再包装已删除的 workspaces.openPath");
  // issue #388 哨兵断言（防「布局主权对轰」实现回退）：宿主 dsh-web-mobile 窄视口
  // [aria-modal] 模板规则劫持卡片（根因见 issue）——修复 = 卡片固定 id + style.css
  // 末尾对轰块。断言 JS 产物含 id 字面量（minify 保留字符串属性赋值）、CSS 产物含
  // id 选择器对轰块、--fwp-card-* 变量名出现 ≥2 次（基础块定义 + 对轰块/media 覆写
  // 引用，防两块脱钩后对轰 important 落回错误值）、全屏与降级双选择器都在（防只改一半）。
  assert.ok(client.includes('"fwp-dialog-card"'), "#388 client 含卡片固定 id 赋值字面量");
  assert.ok(client.includes("#fwp-dialog-card{"), "#388 client 含布局主权对轰块（id 选择器）");
  assert.ok(client.includes("position:static !important"), "#388 对轰块含 position:static !important（对抗宿主 absolute !important）");
  {
    const varHits = client.match(/--fwp-card-(w|mh)/g)?.length ?? 0;
    assert.ok(varHits >= 4, `#388 设计值变量单一事实源（基础定义+media 覆写+对轰引用，实际 ${varHits} 处）`);
  }
  assert.ok(
    client.includes(".fwp-overlay:fullscreen #fwp-dialog-card") && client.includes(".fwp-overlay.fwp-fs #fwp-dialog-card"),
    "#388 全屏/降级双选择器都在（合并选择器列表，防只改一半）",
  );

  // ---- issue #104：mermaid 懒加载 chunk 宿主路由真实可读（P0 断言）----
  // 防「cleanFreeFloatingJs 把新 chunk 当游离产物删除 → 五连门禁全绿而功能坏」
  // 复发（复核批复必改项）：断言宿主路由能真实读出 lib/client-mermaid.js 内容，
  // 且直出字节与磁盘产物完全一致。
  {
    const onDisk = readFileSync(new URL("../lib/client-mermaid.js", import.meta.url), "utf8");
    assert.ok(onDisk.includes("mermaid"), "lib/client-mermaid.js 存在且含 mermaid 产物特征");
    assert.ok(onDisk.length > 100_000, `#104 mermaid chunk 为整库内联产物（实际 ${(onDisk.length / 1024 / 1024).toFixed(2)}MB）`);
    const res = fakeRes();
    await mermaidRoute(fakeReq("GET", ROUTES.mermaid, "127.0.0.1"), res);
    assert.equal(res._calls.status, 200, "#104 mermaid 路由 200");
    assert.ok(String(res._calls.headers["content-type"]).startsWith("text/javascript"), "#104 Content-Type text/javascript");
    assert.equal(res._calls.data === undefined ? undefined : res._calls.data.toString(), onDisk, "#104 路由直出内容 === 磁盘 lib/client-mermaid.js");
    // 协商缓存：同 ETag 二次请求命中 304
    const etag = res._calls.headers.etag;
    assert.ok(typeof etag === "string" && etag.length > 0, "#104 响应带弱 ETag");
    const res304 = fakeRes();
    await mermaidRoute(fakeReq("GET", ROUTES.mermaid, "127.0.0.1", "127.0.0.1", { "if-none-match": etag }), res304);
    assert.equal(res304._calls.status, 304, "#104 If-None-Match 命中 304");
    // 内联清单 sidecar（minified 产物注释被移除后的唯一证据源）与 license 归集覆盖
    const depRefs: Array<{ name: string }> = JSON.parse(readFileSync(new URL("../lib/client-mermaid.deps.json", import.meta.url), "utf8"));
    assert.ok(depRefs.some((r) => r.name === "mermaid"), "#104 deps 清单含 mermaid");
    const thirdParty = readFileSync(new URL("../lib/THIRD-PARTY-LICENSES", import.meta.url), "utf8");
    assert.ok(thirdParty.includes("mermaid@"), "#104 THIRD-PARTY-LICENSES 归集 mermaid（内联=分发副本）");
    assert.ok(/ISC/i.test(thirdParty), "#104 license 清单含 ISC 字样（d3 系）");
  }

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

  // ---- issue #73：client.js 产物契约哨兵（HTML iframe sandbox 预览）----
  // iframe 渲染 + sandbox 空集（无 allow-scripts/allow-same-origin，G4）+ token
  // 生命周期接线随产物下发；产物层证据防「实现回退丢安全约束」。
  {
    assert.ok(client.includes("fwp-html-frame"), "#73 client.js 含 html iframe 类名");
    assert.ok(client.includes("sandbox"), "#73 client.js 含 sandbox 装配");
    // G4/J1/J9（qa 实测红线回归哨兵）：sandbox 必须经 setAttribute("sandbox","")
    // 显式装配——`node.sandbox=""` 反射赋值不产生属性（同源+脚本执行）。产物层
    // 断言 setAttribute 形态存在；J1 放宽为「allow-scripts 仅经交互态装配、
    // 集合装配值由产物字符串锁定」；J9 红线不变：**绝无 allow-same-origin**。
    assert.ok(client.includes('setAttribute("sandbox"'), "#73 client.js 经 setAttribute 显式装配 sandbox（G4 回归哨兵）");
    assert.ok(client.includes('"allow-scripts"'), "#507 client.js 含 allow-scripts 装配值（交互态，J1 二期）");
    assert.ok(!client.includes("allow-same-origin"), "#73/#507 client.js 无 allow-same-origin 装配值（J9 红线）");
    assert.ok(client.includes("no-referrer"), "#73 client.js 含 referrerpolicy no-referrer（iframe 侧）");
    assert.ok(client.includes("serve"), "#73 client.js 含 serve 路由前缀拼接");
    assert.ok(client.includes("HTML 预览"), "#73 client.js 含 html 预览标题文案");
    assert.ok(client.includes("交互"), "#507 client.js 含交互 tab 文案");
    assert.ok(client.includes("脚本已启用"), "#507 client.js 含交互态徽标文案");
    // issue #563：交互 wrap 显式占满面板宽——wrap 是 .fwp-body（flex）项，缺
    // width:100% 时按 max-content 塌缩到 iframe 固有宽（300px），交互预览呈居中小盒。
    assert.ok(client.includes("fwp-html-wrap{position:relative;display:block;width:100%}"), "#563 client.js 交互 wrap 占满面板宽（宽度塌缩回归哨兵）");
    // issue #564：el() attrs 嵌套键 = 逐键 setAttribute 显式属性装配——此前该键落
    // else 分支静默丢失（tab data-mode 高亮从未工作、aria-label/title/role 全丢）。
    assert.match(client, /=== "attrs"\)/, "#564 client.js el() 含 attrs 嵌套键属性装配分支");
    assert.ok(client.includes('"data-mode": def.mode'), "#564 client.js 三 tab 携带 data-mode 装配值（高亮依据）");
  }

  // ---- issue #45：引用 → 预览目标重写决策（rewrite-target，纯逻辑直测）----
  // rewrite-target 无 DOM 依赖，同 link-resolver 模式：esbuild 打成内存 ESM、
  // 经 data-URI 导入，直测真实源码而非字符串契约。
  {
    const rtBundle = await esbuildBuild({
      entryPoints: [join(pkgDir, "src/client/rewrite-target.ts")],
      bundle: true, format: "esm", write: false, logLevel: "silent",
    });
    const { rewriteTarget: rt } = await import(
      `data:text/javascript;base64,${Buffer.from(rtBundle.outputFiles[0]!.text).toString("base64")}`
    ) as typeof import("../lib/client/rewrite-target.js");
    const opts = { cwd: "/home/u/proj", basePath: "/home/u/proj/docs/a.md" };
    // 相对可预览（U8 v2 既有）：预览 URL + fragment null。
    {
      const hit = rt("./b.md", opts);
      assert.ok(hit !== null, "#45 相对可预览仍重写");
      assert.equal(hit!.path, "/home/u/proj/docs/b.md", "#45 相对解析不变");
      assert.ok(hit!.url.startsWith("/api/dsh-file-preview/file?"), "#45 重写走预览 API");
      assert.equal(hit!.fragment, null, "#45 无锚点 fragment 为 null");
    }
    // 绝对路径可预览（新增）：同样重写为 Modal 内跳转目标。
    {
      const hit = rt("/home/u/proj/docs/design.md", opts);
      assert.ok(hit !== null, "#45 绝对路径可预览 → 重写（此前整页导航根因）");
      assert.equal(hit!.path, "/home/u/proj/docs/design.md", "#45 绝对路径原样入 path");
      assert.ok(hit!.url.includes("path=%2Fhome"), "#45 绝对路径编码进预览 URL");
    }
    // 带 fragment 的文件引用：fragment 剥离保留（附带瑕疵修复）。
    assert.equal(rt("./f.md#g", opts)!.fragment, "g", "#45 ./f.md#g 保留锚点 g");
    assert.equal(rt("./f.md#%E4%B8%AD", opts)!.fragment, "中", "#45 锚点解码一次");
    // 绝对路径不可预览后缀 → 不重写（rewriteAnchor 层 target=_blank 兜底）。
    assert.equal(rt("/home/u/proj/x.zip", opts), null, "#45 绝对路径 zip 不重写");
    // 纯锚点 / 外域 / 协议相对 / data: → 不重写。
    assert.equal(rt("#section", opts), null, "#45 纯锚点不走预览 URL");
    assert.equal(rt("https://x/a.md", opts), null, "#45 外域不重写");
    assert.equal(rt("//cdn/x.png", opts), null, "#45 协议相对不重写");
    assert.equal(rt("data:image/png;base64,AA==", opts), null, "#45 data URI 不重写");
  }
  // client.js 行为哨兵：纯锚点标记 / fragment 定位参数 / 未重写链接新标签兜底
  // （DOM 层真实行为由浏览器 MCP 实测覆盖，此处防产物回退丢实现）。
  for (const marker of ["data-fp-anchor", "data-fp-frag", 'setAttribute("target", "_blank")', "scrollIntoView"]) {
    assert.ok(client.includes(marker), `client.js 缺少 issue #45 标识: ${marker}`);
  }

  // ---- issue #104：client.js 行为哨兵 + 懒加载关键约束 ----
  {
    // strict 安全基线与主题自适应随产物下发；v11 无 setTheme（dist 类型与产物
    // 零命中）——主题切换必须走 re-initialize 路线，产物不得出现该不存在 API
    // 的调用点（返工回归哨兵，防「监听实为空操作」复发）。
    assert.ok(client.includes('"strict"'), "#104 client.js 含 securityLevel strict 基线");
    assert.ok(client.includes("prefers-color-scheme"), "#104 client.js 含明暗主题探测");
    assert.ok(!client.includes("setTheme"), "#104 client.js 无 setTheme 调用（v11 不存在该 API）");
    // 变量 URL 动态 import 必须保留为运行时 import(<成员表达式>)——esbuild 对
    // 字面量/相对路径会静态内联（懒加载退化），此形态是批复架构的关键约束。
    assert.ok(/import\([$\w][\w$.]*\)/.test(client), "#104 client.js 保留变量 URL 动态 import");
    // chunk 不允许被静态内联回 client.js：dagre-d3-es 是 mermaid 强依赖，
    // 若误内联必出现在产物中（懒加载失效哨兵）。
    assert.ok(!client.includes("dagre-d3-es"), "#104 client.js 未内联 mermaid 库体");
  }

  // ---- issue #293：client.js 产物契约哨兵（泛化查看器 + 外链拦截）----
  // 泛化重构后图片路径行为零回归的产物层证据：content 类（E1）、双 aria-label（B3）、
  // 外链 noopener 拦截（D1/D2）随产物下发；旧 img 专用类名不得残留（漂移哨兵）。
  {
    assert.ok(client.includes("fwp-lbox-content"), "#293 client.js 含泛化查看器 content 类（E1）");
    assert.ok(!client.includes("fwp-lbox-img"), "#293 client.js 无残留 .fwp-lbox-img 专用类名（E1 已泛化）");
    assert.ok(client.includes("图片预览"), "#293 client.js 含图片预览 aria-label（B3）");
    assert.ok(client.includes("图表预览"), "#293 client.js 含图表预览 aria-label（B3，mermaid 接线）");
    assert.ok(client.includes("noopener"), "#293 client.js 含外链 noopener 拦截（D1/D2）");
    assert.ok(client.includes("xlink:href"), "#293 client.js 含 xlink:href 外链读取（A4）");
    assert.ok(client.includes("translate("), "#293 client.js 含 transform 模板（A2 双路径共用）");
  }

  // ---- issue #104：mermaid hydration 编排纯逻辑直测（mermaid-core，无 DOM）----
  // 与 rewrite-target 同模式：esbuild 内存打包真实源码、经 data-URI 导入直测
  // 成功替换 / 单块语法错误回退 / chunk 加载失败整体回退 / 代数失效中断。
  {
    const mcBundle = await esbuildBuild({
      entryPoints: [join(pkgDir, "src/client/mermaid-core.ts")],
      bundle: true,
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    const { runMermaidHydration, mermaidBaseConfig } = await import(
      `data:text/javascript;base64,${Buffer.from(mcBundle.outputFiles[0]!.text).toString("base64")}`
    ) as typeof import("../src/client/mermaid-core.js");
    /** 构造受控 IO：loadError 注入 chunk 拉取失败；renderErrors 以源码为键注入语法错误。 */
    const mkIo = ({ loadError, renderErrors = {} } = {}) => {
      const events = [];
      let n = 0;
      return {
        events,
        io: {
          loadModule: () =>
            loadError !== undefined
              ? Promise.reject(loadError)
              : Promise.resolve({
                  initialize: (cfg) => events.push(["initialize", cfg]),
                  render: (id, src) =>
                    renderErrors[src] !== undefined
                      ? Promise.reject(new Error(renderErrors[src]))
                      : Promise.resolve({ svg: `<svg data-id="${id}"><path/></svg>` }),
                }),
          themeOf: () => "default",
          nextId: () => `fwp-mermaid-${++n}`,
          liveCheck: () => true,
          sanitizeSvg: (svg) => `SANITIZED(${svg})`,
          onReplaced: (i, html) => events.push(["replaced", i, html]),
          onFallback: (i) => events.push(["fallback", i]),
        },
      };
    };
    // 用例 0（issue #292）：mermaidBaseConfig 直测——返回对象含 suppressErrorRendering:true
    // 且既有四项（startOnLoad/securityLevel/htmlLabels/theme）原值不变，default/dark 双主题无漂移。
    {
      assert.deepEqual(
        mermaidBaseConfig("default"),
        { startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "default", suppressErrorRendering: true },
        "#292 mermaidBaseConfig(\"default\") 含 suppressErrorRendering:true 且原四项不变",
      );
      assert.deepEqual(
        mermaidBaseConfig("dark"),
        { startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "dark", suppressErrorRendering: true },
        "#292 mermaidBaseConfig(\"dark\") 含 suppressErrorRendering:true 且原四项不变",
      );
    }
    // 用例 1：全成功——安全基线 initialize 一次 + 逐块消毒替换、零回退。
    {
      const t = mkIo({});
      await runMermaidHydration(["graph TD;A-->B", "sequenceDiagram;A->>B:hi"], t.io);
      assert.deepEqual(
        t.events.filter((e) => e[0] === "initialize"),
        [["initialize", { startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "default", suppressErrorRendering: true }]],
        "#104 安全基线配置随 initialize 下发（issue #292 追加 suppressErrorRendering:true）",
      );
      assert.deepEqual(t.events.filter((e) => e[0] === "replaced").map((e) => e[1]), [0, 1], "#104 全部块替换");
      assert.ok(String(t.events.find((e) => e[0] === "replaced")[2]).startsWith("SANITIZED("), "#104 SVG 经二次消毒回调");
      assert.equal(t.events.some((e) => e[0] === "fallback"), false, "#104 成功路径无回退");
    }
    // 用例 2：单块语法错误 → 该块回退、其余块继续（不中断不静默）。
    {
      const t = mkIo({ renderErrors: { bad: "syntax error in graph" } });
      await runMermaidHydration(["bad", "good"], t.io);
      assert.deepEqual(t.events.filter((e) => e[0] === "fallback").map((e) => e[1]), [0], "#104 语法错误块回退");
      assert.deepEqual(t.events.filter((e) => e[0] === "replaced").map((e) => e[1]), [1], "#104 其余块继续渲染");
    }
    // 用例 3：chunk 加载失败 → 全部块回退、不外抛、不得触发 initialize。
    {
      const t = mkIo({ loadError: new Error("chunk fetch failed") });
      await runMermaidHydration(["a", "b"], t.io);
      assert.deepEqual(t.events.filter((e) => e[0] === "fallback").map((e) => e[1]), [0, 1], "#104 加载失败全部回退");
      assert.equal(t.events.some((e) => e[0] === "initialize"), false, "#104 加载失败不触发 initialize");
    }
    // 用例 4：空 sources 直接返回（普通 md 零动作）。
    {
      const t = mkIo({});
      await runMermaidHydration([], t.io);
      assert.equal(t.events.length, 0, "#104 无 mermaid 块零开销");
    }
    // 用例 5：代数失效（Modal 关闭重开 / 切 tab）→ 中断后续写回。
    {
      const t = mkIo({});
      let live = true;
      t.io.liveCheck = () => live;
      const baseLoad = t.io.loadModule;
      t.io.loadModule = () =>
        baseLoad().then((mod) => ({
          ...mod,
          render: () => {
            live = false; // 首块渲染期间 Modal 被关闭/切换
            return Promise.resolve({ svg: "<svg/>" });
          },
        }));
      await runMermaidHydration(["a", "b"], t.io);
      assert.equal(t.events.some((e) => e[0] === "replaced" || e[0] === "fallback"), false, "#104 代数失效后旧代结果不写回");
    }
  }

  // ---- issue #37：链接解析两阶段算法（link-resolver，纯逻辑直测）----
  // lib/client/*.js 由 bundle-host 按发布物边界清理（仅留顶层 index.js/client.js 与
  // .d.ts），故用仓库 devDependency esbuild 把源码即时打成内存 ESM、经 data-URI 导入，
  // 直测真实源码而非字符串契约。
  const resolverBundle = await esbuildBuild({
    entryPoints: [join(pkgDir, "src/client/link-resolver.ts")],
    bundle: true, format: "esm", write: false, logLevel: "silent",
  });
  const resolverCode = resolverBundle.outputFiles[0]!.text;
  const { resolveFileLink, decideGate, basenameOf, SCOPE_SELECTORS, EXEMPT_SELECTOR } = await import(
    `data:text/javascript;base64,${Buffer.from(resolverCode).toString("base64")}`
  ) as typeof import("../lib/client/link-resolver.js");
  // 最小投影构造器：attrs 缺省空串，parent 自内向外。
  const mkNode = (tag: string, attrs: Record<string, string>, text: string, parent: ReturnType<typeof mkNode> | null = null) =>
    ({ tag, attrs: { title: "", href: "", "data-ref-chip": "", ...attrs }, text, parent });
  // 用例 1：better-sidebar 文件树行 div(title=完整路径) > span(裸文件名)——本次 bug 主场景。
  {
    const span = mkNode("SPAN", {}, "成品.png");
    span.parent = mkNode("DIV", { title: "F:\\DailyChat\\sub\\成品.png" }, "");
    assert.deepEqual(resolveFileLink(span), { path: "F:\\DailyChat\\sub\\成品.png", kind: "file" }, "祖先凭证 basename 一致 → 采信完整路径");
  }
  // 用例 2：宿主产物 chip button(title=path) > span(name)。
  {
    const span = mkNode("SPAN", {}, "report.md");
    span.parent = mkNode("BUTTON", { title: "/w/a/report.md" }, "");
    assert.deepEqual(resolveFileLink(span), { path: "/w/a/report.md", kind: "file" }, "chip 结构 → 凭证路径");
  }
  // 用例 3：CODE 内联完整路径、无任何凭证。
  assert.deepEqual(
    resolveFileLink(mkNode("CODE", {}, "F:\\a\\b\\c.png")),
    { path: "F:\\a\\b\\c.png", kind: "file" },
    "内联完整路径无凭证 → 原样",
  );
  // 用例 4：相对路径文本无凭证。
  assert.deepEqual(
    resolveFileLink(mkNode("SPAN", {}, "sub/dir/img.png")),
    { path: "sub/dir/img.png", kind: "file" },
    "相对路径文本无凭证 → 原样",
  );
  // 用例 5：行空白点击（target 即带 title 的行节点本身）。
  assert.deepEqual(
    resolveFileLink(mkNode("DIV", { title: "/w/x/only.md" }, "")),
    { path: "/w/x/only.md", kind: "file" },
    "target 自身 title → 凭证",
  );
  // 用例 6：凭证与文本 basename 不一致 → 不猜（跳过该凭证），回退文本命中。
  {
    const span = mkNode("SPAN", {}, "cat.png");
    span.parent = mkNode("DIV", { title: "/other/notes.md" }, "");
    assert.deepEqual(resolveFileLink(span), { path: "cat.png", kind: "file" }, "basename 不一致 → 跳过凭证回退文本");
  }
  // 用例 7：仅裸名、全链无凭证 → 裸名兜底（旧行为）。
  assert.deepEqual(resolveFileLink(mkNode("SPAN", {}, "solo.txt")), { path: "solo.txt", kind: "file" }, "仅裸名 → 兜底");
  // 用例 8：ref-chip 权威分支不变。
  assert.deepEqual(
    resolveFileLink(mkNode("SPAN", { "data-ref-chip": "file", title: "@/abs/a.md" }, "@/abs/a.md")),
    { path: "/abs/a.md", kind: "file" },
    "ref-chip file → 去前导 @",
  );
  assert.deepEqual(
    resolveFileLink(mkNode("SPAN", { "data-ref-chip": "folder", title: "@/abs/dir/" }, "@/abs/dir/")),
    { path: null, kind: "folder" },
    "ref-chip folder → 提示语义",
  );
  // 用例 9：chip=session 节点整体跳过（其文本不参与嗅探），向上采信父凭证——固化 skip 时序语义。
  {
    const chip = mkNode("SPAN", { "data-ref-chip": "session", title: "@session-label" }, "notes.md");
    chip.parent = mkNode("DIV", { title: "/real/notes.md" }, "");
    assert.deepEqual(resolveFileLink(chip), { path: "/real/notes.md", kind: "file" }, "chip session 跳过后父凭证生效");
  }
  // 用例 10：basename 归一化（大小写 + 双向分隔符）一致即视为同一文件。
  {
    const span = mkNode("SPAN", {}, "Cat.PNG");
    span.parent = mkNode("DIV", { title: "F:/x/y/CAT.PNG" }, "");
    assert.deepEqual(resolveFileLink(span), { path: "F:/x/y/CAT.PNG", kind: "file" }, "basename 归一化比较");
    assert.equal(basenameOf("A\\B/C.PNG"), "c.png", "混合分隔符取末段并小写");
  }
  // 用例 11：点击闸门顺序——豁免属性优先于作用域；作用域外放行。
  {
    const probeAll = { matches: () => true };
    assert.equal(decideGate(probeAll, SCOPE_SELECTORS), "pass", "豁免优先于作用域");
    const probeFlowOnly = {
      matches: (sel: string) => sel !== EXEMPT_SELECTOR,
    };
    assert.equal(decideGate(probeFlowOnly, SCOPE_SELECTORS), "inspect", "对话流内且未豁免 → 解析");
    const probeNone = { matches: () => false };
    assert.equal(decideGate(probeNone, SCOPE_SELECTORS), "pass", "作用域外 → 放行");
  }

  // ---- issue #293：viewer-math 查看器纯逻辑直测（无 DOM，验收 A 组）----
  // 与 mermaid-core / link-resolver 同模式：esbuild 内存打包真实源码、经 data-URI
  // 导入直测（clamp 边界 / transform 字符串逐字节一致 / 触发谓词 / 外链锚点谓词）。
  // 谓词以最小投影注入（closest/querySelector/getAttribute/classList 语义）。
  {
    const vmBundle = await esbuildBuild({
      entryPoints: [join(pkgDir, "src/client/viewer-math.ts")],
      bundle: true, format: "esm", write: false, logLevel: "silent",
    });
    const { clampScale, viewerTransform, shouldOpenMermaidViewer, isExternalClickableAnchor } = await import(
      `data:text/javascript;base64,${Buffer.from(vmBundle.outputFiles[0]!.text).toString("base64")}`
    ) as typeof import("../src/client/viewer-math.js");
    // 最小投影工厂：closest 支持 .class token 与 a 标签；querySelector 只认 svg。
    const mkNode = (opts: any = {}): any => {
      const { cls = "", tag = "", hasSvg = false, attrs = {}, parent = null } = opts;
      return {
        cls, tag, hasSvg, attrs, parent,
        closest(sel: string) {
          const matches = (n: any) => sel.startsWith(".")
            ? n.cls.split(/\s+/).includes(sel.slice(1))
            : sel === "a" && n.tag === "A";
          for (let n: any = this; n !== null; n = n.parent) if (matches(n)) return n;
          return null;
        },
        querySelector(sel: string) { return sel === "svg" && this.hasSvg ? {} : null; },
        getAttribute(name: string) { return this.attrs[name] ?? null; },
        classList: { contains: (t: string) => cls.split(/\s+/).includes(t) },
      };
    };
    // A1 [硬性] clamp 边界 [0.2, 8]：边界恒等、越界收敛。
    {
      assert.equal(clampScale(0.2), 0.2, "A1 下边界恒等");
      assert.equal(clampScale(1), 1, "A1 中值恒等");
      assert.equal(clampScale(8), 8, "A1 上边界恒等");
      assert.equal(clampScale(0.1), 0.2, "A1 越界收敛到下界");
      assert.equal(clampScale(100), 8, "A1 越界收敛到上界");
      assert.equal(clampScale(-3), 0.2, "A1 负值收敛到下界");
      // 按钮 ×1.25 / ÷1.25、滚轮 ×1.12 / ×0.9、捏合 start×ratio 三路径连续作用恒在区间内。
      let s = 1;
      for (let i = 0; i < 20; i++) s = clampScale(s * 1.25);
      assert.equal(s, 8, "A1 按钮放大 20 次收敛上界");
      s = 1;
      for (let i = 0; i < 20; i++) s = clampScale(s / 1.25);
      assert.equal(s, 0.2, "A1 按钮缩小 20 次收敛下界");
      s = 5;
      for (let i = 0; i < 30; i++) s = clampScale(s * (i % 2 === 0 ? 1.12 : 0.9));
      assert.ok(s >= 0.2 && s <= 8, "A1 滚轮正反交替后恒在区间内");
      const ratios = [0.5, 1.5, 0.8, 2.2, 0.3, 3, 0.7];
      s = 1;
      for (const r of ratios) s = clampScale(s * r);
      assert.ok(s >= 0.2 && s <= 8, "A1 捏合多轮后恒在区间内");
    }
    // A2 [硬性] transform 字符串逐字节一致（与图片灯箱原 applyLboxTransform 同格式）。
    {
      assert.equal(viewerTransform(0, 0, 1), "translate(0px, 0px) scale(1)", "A2 恒等变换字符串");
      assert.equal(viewerTransform(-12.5, 3.25, 2.5), "translate(-12.5px, 3.25px) scale(2.5)", "A2 平移+缩放字符串逐字节一致");
      assert.equal(viewerTransform(0.1, -0.1, 0.2), "translate(0.1px, -0.1px) scale(0.2)", "A2 边界值字符串");
    }
    // A3 [硬性] shouldOpenMermaidViewer：holder 级命中 + 排除 fallback + svg 非空守卫。
    {
      const holder = mkNode({ cls: "fwp-mermaid", hasSvg: true });
      const svgChild = mkNode({ parent: holder });
      assert.equal(shouldOpenMermaidViewer(svgChild), true, "A3 SVG 子元素命中 holder → true");
      assert.equal(shouldOpenMermaidViewer(holder), true, "A3 点击 holder 自身 → true");
      const noSvgHolder = mkNode({ cls: "fwp-mermaid", hasSvg: false });
      assert.equal(shouldOpenMermaidViewer(noSvgHolder), false, "A3 无 svg 的 holder → false");
      const fallbackHolder = mkNode({ cls: "fwp-mermaid fwp-mermaid-fallback", hasSvg: true });
      assert.equal(shouldOpenMermaidViewer(fallbackHolder), false, "A3 fallback holder → false");
      const plainDiv = mkNode({ cls: "", hasSvg: true });
      assert.equal(shouldOpenMermaidViewer(plainDiv), false, "A3 非 mermaid 元素 → false");
      assert.equal(shouldOpenMermaidViewer(null), false, "A3 null target → false");
    }
    // A4 [硬性] isExternalClickableAnchor：xlink:href 优先、fallback href、仅绝对 http(s)。
    {
      const a = (attrs: Record<string, string>, parent = null) => mkNode({ tag: "A", attrs, parent });
      const svgInHolder = mkNode({ hasSvg: true });
      assert.equal(isExternalClickableAnchor(a({ "xlink:href": "https://x" })), true, "A4 xlink:href 绝对 https → true");
      assert.equal(isExternalClickableAnchor(a({ href: "https://x" })), true, "A4 href 绝对 https → true");
      assert.equal(isExternalClickableAnchor(a({ "xlink:href": "https://x", href: "https://y" })), true, "A4 xlink:href 优先于 href");
      assert.equal(isExternalClickableAnchor(a({ "xlink:href": "http://x" })), true, "A4 绝对 http → true");
      assert.equal(isExternalClickableAnchor(a({ href: "HTTPS://X" })), true, "A4 scheme 大小写不敏感");
      assert.equal(isExternalClickableAnchor(a({ href: "./x" })), false, "A4 相对链接不拦");
      assert.equal(isExternalClickableAnchor(a({ href: "#section" })), false, "A4 内部锚点不拦");
      assert.equal(isExternalClickableAnchor(a({ href: "ftp://x" })), false, "A4 非 http(s) 协议不拦");
      assert.equal(isExternalClickableAnchor(a({})), false, "A4 无 href 不拦");
      // 祖先链命中：svg > a > text，点击 text 命中 a。
      const text = mkNode({ parent: a({ "xlink:href": "https://x" }, svgInHolder) });
      assert.equal(isExternalClickableAnchor(text), true, "A4 祖先链 a 命中");
      assert.equal(isExternalClickableAnchor(mkNode({ cls: "", hasSvg: true })), false, "A4 非 a 元素不拦");
      assert.equal(isExternalClickableAnchor(null), false, "A4 null target → false");
    }
  }

  // ---- issue #344：fullscreen-math 全屏纯逻辑直测（无 DOM，验收 A1/A1b）----
  // 同 viewer-math 模式：esbuild 内存打包真实源码经 data-URI 直测，谓词以最小
  // Document/Element 投影注入（fullscreenEnabled/fullscreenElement/requestFullscreen/
  // exitFullscreen 语义），不依赖真实 DOM。
  {
    const fsBundle = await esbuildBuild({
      entryPoints: [join(pkgDir, "src/client/fullscreen-math.ts")],
      bundle: true, format: "esm", write: false, logLevel: "silent",
    });
    const {
      fullscreenSupported, isFullscreenActive, fullscreenLabel,
      shouldInterceptEscapeAsFullscreenExit, exitFullscreenQuiet,
    } = await import(
      `data:text/javascript;base64,${Buffer.from(fsBundle.outputFiles[0]!.text).toString("base64")}`
    ) as typeof import("../src/client/fullscreen-math.js");
    // A1 能力探测：fullscreenEnabled=true 且 target 有 requestFullscreen → supported。
    {
      const docOk = { fullscreenEnabled: true, fullscreenElement: null };
      const targetOk = { requestFullscreen: () => Promise.resolve() };
      assert.equal(fullscreenSupported(docOk, targetOk), true, "A1 能力齐全 → supported");
      assert.equal(fullscreenSupported({ fullscreenEnabled: false, fullscreenElement: null }, targetOk), false, "A1 fullscreenEnabled=false → 不支持");
      assert.equal(fullscreenSupported(docOk, { requestFullscreen: undefined } as any), false, "A1 元素无 requestFullscreen → 不支持");
      assert.equal(fullscreenSupported({ fullscreenEnabled: true, fullscreenElement: null } as any, targetOk), true, "A1 fullscreenElement 可缺省");
    }
    // A1 全屏态判定：fullscreenElement 非空 → active。
    {
      assert.equal(isFullscreenActive({ fullscreenEnabled: true, fullscreenElement: null }), false, "A1 非全屏 → inactive");
      assert.equal(isFullscreenActive({ fullscreenEnabled: true, fullscreenElement: {} }), true, "A1 有全屏元素 → active");
      assert.equal(isFullscreenActive({} as any), false, "A1 缺 fullscreenElement → inactive");
    }
    // A1 按钮文案：supported/active 四象限。
    {
      assert.equal(fullscreenLabel(false, true), "全屏", "A1 支持且非全屏 → 全屏");
      assert.equal(fullscreenLabel(true, true), "退出全屏", "A1 支持且全屏 → 退出全屏");
      assert.equal(fullscreenLabel(false, false), "放大预览", "A1 不支持且非全屏 → 放大预览");
      assert.equal(fullscreenLabel(true, false), "退出放大", "A1 不支持且放大 → 退出放大");
    }
    // A1 [硬性] Esc 协调：全屏态 Esc 拦截（不关 Modal）；非全屏/非 Esc 不拦。
    {
      assert.equal(shouldInterceptEscapeAsFullscreenExit(true, "Escape"), true, "A1 全屏+Esc → 拦截（只退全屏）");
      assert.equal(shouldInterceptEscapeAsFullscreenExit(false, "Escape"), false, "A1 非全屏+Esc → 不拦（走关闭）");
      assert.equal(shouldInterceptEscapeAsFullscreenExit(true, "Tab"), false, "A1 全屏+非 Esc → 不拦");
      assert.equal(shouldInterceptEscapeAsFullscreenExit(false, "Tab"), false, "A1 非全屏+非 Esc → 不拦");
    }
    // A1 幂等退出：有 exitFullscreen 则调用；无则 no-op。
    {
      let called = 0;
      exitFullscreenQuiet({ exitFullscreen: () => { called++; return Promise.resolve(); } });
      assert.equal(called, 1, "A1 有 exitFullscreen → 调用一次");
      assert.doesNotThrow(() => exitFullscreenQuiet({} as any), "A1 无 exitFullscreen → 不抛错");
    }
  }

  // ---- issue #344：render-limit 渲染防御阈值直测（无 DOM，验收 A2b）----
  {
    const rlBundle = await esbuildBuild({
      entryPoints: [join(pkgDir, "src/client/render-limit.ts")],
      bundle: true, format: "esm", write: false, logLevel: "silent",
    });
    const { exceedsTextRenderLimit, textFitsSnapshot, TEXT_RENDER_LIMIT_CODEPOINTS, SNAPSHOT_TEXT_LIMIT_CODEPOINTS } = await import(
      `data:text/javascript;base64,${Buffer.from(rlBundle.outputFiles[0]!.text).toString("base64")}`
    ) as typeof import("../src/client/render-limit.js");
    // A2b 渲染降级阈值：>1M → 降级；=1M / 以下 → 正常渲染。
    assert.equal(exceedsTextRenderLimit(TEXT_RENDER_LIMIT_CODEPOINTS), false, "A2b 恰好 1M → 不降级");
    assert.equal(exceedsTextRenderLimit(TEXT_RENDER_LIMIT_CODEPOINTS + 1), true, "A2b 超过 1M → 降级");
    assert.equal(exceedsTextRenderLimit(0), false, "A2b 空文本 → 不降级");
    // A2b backStack 快照防御：>1M 不入栈；=1M / 以下入栈。
    assert.equal(textFitsSnapshot(SNAPSHOT_TEXT_LIMIT_CODEPOINTS), true, "A2b 恰好 1M → 入栈");
    assert.equal(textFitsSnapshot(SNAPSHOT_TEXT_LIMIT_CODEPOINTS + 1), false, "A2b 超过 1M → 不入栈");
  }

  console.log("PASS dsh-web-file-preview smoke");
} finally {
  rmSync(root, { recursive: true, force: true });
}
