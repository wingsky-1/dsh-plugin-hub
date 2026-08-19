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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  ROUTES, makeRoutes, serveFileRoute, previewKindOf, computeGitDiff,
  normalizeConfig, DEFAULT_CONFIG, groupOfPath, isLikelySingleFilePath,
} from "../lib/index.js";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

// ------------------------------------------------------------ 分组单一事实源（grouping）

assert.deepEqual(groupOfPath("a.md").group, "md");
assert.deepEqual(groupOfPath("b.ts").group, "code");
assert.deepEqual(groupOfPath("c.png").group, "image");
assert.deepEqual(groupOfPath("d.txt").group, "text");
assert.deepEqual(groupOfPath("e.xyz").group, "other");
assert.deepEqual(groupOfPath("dir/a.JPG").group, "image", "扩展名大小写不敏感");

// previewKindOf 由 grouping 派生：md→renderedMd、code→renderedCode，双端一致。
assert.equal(previewKindOf("a.md").group === "renderedMd", groupOfPath("a.md").group === "md", "md 双端分组一致");
assert.equal(previewKindOf("a.js").group === "renderedCode", groupOfPath("a.js").group === "code", "code 双端分组一致");
assert.equal(previewKindOf("a.txt").group === "text", groupOfPath("a.txt").group === "text", "text 双端分组一致");

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


// ------------------------------------------------------------ 纯函数

assert.equal(previewKindOf("foo.png").group, "image");
assert.equal(previewKindOf("dir/a.JPG").group, "image", "扩展名大小写不敏感");
assert.equal(previewKindOf("a.md").group, "renderedMd", "Markdown 渲染组");
assert.equal(previewKindOf("a.js").group, "renderedCode", "代码渲染组");
assert.equal(previewKindOf("hello.md").contentType, "text/markdown; charset=utf-8");
assert.equal(previewKindOf("a.txt").group, "text");
assert.equal(previewKindOf("a.exe").group, "other");

assert.equal(normalizeConfig(undefined).enabled, true, "默认启用");
assert.equal(normalizeConfig(undefined).maxTextBytes, DEFAULT_CONFIG.maxTextBytes, "默认文本上限");
assert.equal(normalizeConfig({ enabled: false }).enabled, false);
assert.equal(normalizeConfig({ maxTextBytes: 1234 }).maxTextBytes, 1234);
assert.equal(normalizeConfig({ maxTextBytes: -1 }).maxTextBytes, DEFAULT_CONFIG.maxTextBytes, "非法上限丢弃");
assert.equal(normalizeConfig({ maxTextBytes: "x" }).maxTextBytes, DEFAULT_CONFIG.maxTextBytes, "非数字丢弃");

// ------------------------------------------------------------ ~ 波浪号展开
// 宿主端用 untildify（业界标准、零依赖、跨平台）做 ~ 展开，具体语义由第三方
// 库保证；此处仅保留最贴近原 bug 的「~/ 能读到真实家目录文件」集成回归用例
// （见下方真实文件服务节）。

const routes = makeRoutes({});
assert.equal(routes.length, 3, "file + diff + health 三条路由");
const routePaths = routes.map((r) => r.path);
assert.equal(routePaths.includes(ROUTES.file), true);
assert.equal(routePaths.includes(ROUTES.diff), true);
assert.equal(routePaths.includes(ROUTES.health), true);
for (const r of routes) assert.equal(r.kind, "exact");

// ------------------------------------------------------------ 围栏

function fakeReq(method, url, remoteAddress, host = "127.0.0.1") {
  return { method, url, headers: { host }, socket: { remoteAddress } };
}
function fakeRes() {
  const calls = { status: 0, headers: {}, data: null };
  return {
    _calls: calls,
    writeHead(status, headers) { calls.status = status; calls.headers = headers || {}; return this; },
    end(data) { calls.data = data; },
  };
}
/** 文件路由所需的最小 req（headers 可自定义）。 */
function rawReqForFiles(headers = {}) {
  return { headers };
}

function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" });
}

const fileRoute = routes[0].handler;
const healthRoute = routes[2].handler;

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
}
// health 非回环 403
{
  const res = fakeRes();
  healthRoute(fakeReq("GET", ROUTES.health, "8.8.8.8"), res);
  assert.equal(res._calls.status, 403, "health 非回环 403");
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
      writeFileSync(join(gitRoot, "new.txt"), "x\n", "utf8");
      assert.equal((await computeGitDiff(gitRoot, "new.txt")).untracked, true, "未跟踪新文件 → untracked");
    } else {
      console.log("  (跳过 git 断言：git init 不可用)");
    }
    assert.equal((await computeGitDiff(root, "hello.md")).reason, "not-git", "非 git 目录 → not-git");
  }

  // 客户端契约 + 与宿主 ROUTES 路由一致性
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assertClientSourceContract(pkgDir);
  assertClientProductContract(pkgDir);
  const expectedRoutes = [ROUTES.file, ROUTES.diff, ROUTES.health];
  const literals = [...client.matchAll(/\/api\/dsh-file-preview\/[a-z-]+/g)].map((m) => m[0]);
  for (const literal of literals) assert.ok(expectedRoutes.includes(literal), `client 出现未知路由: ${literal}`);
  for (const route of expectedRoutes) assert.ok(literals.includes(route), `client 缺少路由: ${route}`);

  console.log("PASS dsh-web-file-preview smoke");
} finally {
  rmSync(root, { recursive: true, force: true });
}
