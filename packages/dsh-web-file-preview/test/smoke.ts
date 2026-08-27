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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  ROUTES, makeRoutes, serveFileRoute, previewKindOf, computeGitDiff,
  normalizeConfig, DEFAULT_CONFIG, groupOfPath, isLikelySingleFilePath, resolveRelativePath,
  cleanRefChipPath, resolveAbsolutePath, splitReferenceFragment,
} from "../lib/index.js";
import { build as esbuildBuild } from "esbuild";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";

// 结构化单元测试（#83 阶段一：对齐 notifier 的 unit-*.test.ts 样板）
import "./unit-grouping.test.ts";
import "./unit-relpath.test.ts";
import "./unit-link-resolver.test.ts";
import "./unit-routes.test.ts";

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
assert.equal(previewKindOf("hello.md").contentType, "text/markdown; charset=utf-8");
assert.equal(previewKindOf("a.txt").group, "text");
assert.equal(previewKindOf("a.exe").group, "other");
// issue #12：图片组 Content-Type 改由 mime 库提供——精确值逐项断言（原自写表等价映射）。
assert.equal(previewKindOf("a.png").contentType, "image/png");
assert.equal(previewKindOf("a.webp").contentType, "image/webp");
assert.equal(previewKindOf("a.svg").contentType, "image/svg+xml");
assert.equal(previewKindOf("a.avif").contentType, "image/avif");
assert.equal(previewKindOf("dir/a.JPG").contentType, "image/jpeg", "大小写不敏感且走 mime 库");

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
assert.equal(routes.length, 4, "file + diff + health + mermaid 四条路由");
const routePaths = routes.map((r) => r.path);
assert.equal(routePaths.includes(ROUTES.file), true);
assert.equal(routePaths.includes(ROUTES.diff), true);
assert.equal(routePaths.includes(ROUTES.health), true);
assert.equal(routePaths.includes(ROUTES.mermaid), true, "#104 mermaid chunk 路由注册");
for (const r of routes) assert.equal(r.kind, "exact");

// ------------------------------------------------------------ 围栏

function fakeReq(method, url, remoteAddress, host = "127.0.0.1", extraHeaders = {}) {
  return { method, url, headers: { host, ...extraHeaders }, socket: { remoteAddress } };
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
const mermaidRoute = routes[3].handler;

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

  // ---- issue #41：file 404 负路径 basename 兜底搜索（五场景）----
  {
    // 准备 git 仓：子目录深处的唯一裸名 + 两处同名歧义 + 被 .gitignore 忽略的文件
    const gitRoot = join(root, "bk-repo");
    mkdirSync(gitRoot, { recursive: true });
    const gb = (args) => git(gitRoot, args);
    const fileUrl = (cwd, p) =>
      `http://127.0.0.1${ROUTES.file}?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(p)}`;
    if (gb(["init"]).status === 0) {
      gb(["config", "user.email", "t@t"]);
      gb(["config", "user.name", "t"]);
      // 用例 1 — git 主路径·唯一命中：裸名实际位于 assets/deep/ → 200 且内容正确
      mkdirSync(join(gitRoot, "assets", "deep"), { recursive: true });
      writeFileSync(join(gitRoot, "assets", "deep", "solo.md"), "fallback hit", "utf8");
      gb(["add", "."]);
      {
        const res = fakeRes();
        await serveFileRoute(res, rawReqForFiles(), new URL(fileUrl(gitRoot, "solo.md")), {});
        assert.equal(res._calls.status, 200, "#41 git 仓库唯一裸名兜底命中 → 200");
        assert.equal(res._calls.data, "fallback hit", "#41 兜底按真实路径读出内容");
      }
      // 主路径不受影响：直接命中零新增开销（回归确认正常路径仍工作）
      writeFileSync(join(gitRoot, "direct.md"), "direct", "utf8");
      {
        const res = fakeRes();
        await serveFileRoute(res, rawReqForFiles(), new URL(fileUrl(gitRoot, "direct.md")), {});
        assert.equal(res._calls.status, 200, "#41 直接命中的主路径行为不变");
      }
      // 用例 2 — 多命中 → 放弃维持 404（basename 歧义即 inert）
      mkdirSync(join(gitRoot, "d1"), { recursive: true });
      mkdirSync(join(gitRoot, "d2"), { recursive: true });
      writeFileSync(join(gitRoot, "d1", "dup.md"), "one", "utf8");
      writeFileSync(join(gitRoot, "d2", "dup.md"), "two", "utf8");
      gb(["add", "."]);
      {
        const res = fakeRes();
        await serveFileRoute(res, rawReqForFiles(), new URL(fileUrl(gitRoot, "dup.md")), {});
        assert.equal(res._calls.status, 404, "#41 ≥2 同名 → 放弃维持 404");
      }
      // 用例 5 — gitignore 文件不暴露：被忽略的唯一同名文件不得经兜底泄露
      writeFileSync(join(gitRoot, ".gitignore"), "secret-*.txt\n", "utf8");
      mkdirSync(join(gitRoot, "ignored"), { recursive: true });
      writeFileSync(join(gitRoot, "ignored", "secret-leak.txt"), "should not expose", "utf8");
      gb(["add", "."]);
      {
        const res = fakeRes();
        await serveFileRoute(res, rawReqForFiles(), new URL(fileUrl(gitRoot, "secret-leak.txt")), {});
        assert.equal(res._calls.status, 404, "#41 gitignore 忽略的文件不经兜底暴露");
      }
    } else {
      console.log("  (跳过 #41 git 场景：git init 不可用)");
    }

    // 用例 3 — 非 git 工作区回退黑名单遍历命中
    const plainDir = join(root, "plain-ws");
    mkdirSync(join(plainDir, "nested"), { recursive: true });
    writeFileSync(join(plainDir, "nested", "only.txt"), "plain walk hit", "utf8");
    {
      const res = fakeRes();
      await serveFileRoute(res, rawReqForFiles(), new URL(fileUrl(plainDir, "only.txt")), {});
      assert.equal(res._calls.status, 200, "#41 非 git 回退遍历唯一命中 → 200");
      assert.equal(res._calls.data, "plain walk hit");
    }
    // 对照：同扩展名文件放非 git 目录可暴露，证明 #41 的 404 源于 gitignore 语义而非路径/类型错误
    writeFileSync(join(plainDir, "nested", "secret-leak.txt"), "should not expose", "utf8");
    {
      const res = fakeRes();
      await serveFileRoute(res, rawReqForFiles(), new URL(fileUrl(plainDir, "secret-leak.txt")), {});
      assert.equal(res._calls.status, 200, "#41 对照：同内容在非 git 区可暴露");
    }

    // 用例 4 — 触顶放弃（模块级注入小 walkLimit；路由层生产默认 20000 不宜构造大目录）
    const fbBundle = await esbuildBuild({
      entryPoints: [join(pkgDir, "src/basename-fallback.ts")],
      bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
    });
    const fbCode = fbBundle.outputFiles[0]!.text;
    const fb = await import(
      `data:text/javascript;base64,${Buffer.from(fbCode).toString("base64")}`
    ) as typeof import("../lib/basename-fallback.js");
    assert.equal(await fb.findUniqueByBasename(plainDir, "only.txt", { walkLimit: 0 }), null, "#41 触顶即放弃（walkLimit=0）");
    assert.equal(await fb.findUniqueByBasename(plainDir, "only.txt"), join(plainDir, "nested", "only.txt"), "#41 对照：不限触顶时回退遍历找到真实绝对路径");
    assert.equal(await fb.findUniqueByBasename(plainDir, "no-such-file.xyz"), null, "#41 零命中 → null 维持 404");
    // bareBasenameOf 单元语义：末段提取 / 尾分隔符与空值拒绝
    assert.equal(fb.bareBasenameOf("a/b/c.png"), "c.png");
    assert.equal(fb.bareBasenameOf("a\\b\\c.png"), "c.png", "Windows 分隔符兼容");
    assert.equal(fb.bareBasenameOf("dir/"), null, "尾分隔符末段为空 → 不兜底");
    assert.equal(fb.bareBasenameOf(""), null);
    assert.equal(fb.bareBasenameOf(".."), null, ".. 无末段凭证 → 不兜底");
  }

  // 客户端契约 + 与宿主 ROUTES 路由一致性
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assertClientSourceContract(pkgDir);
  assertClientProductContract(pkgDir);
  const expectedRoutes = [ROUTES.file, ROUTES.diff, ROUTES.health, ROUTES.mermaid];
  const literals = [...client.matchAll(/\/api\/dsh-file-preview\/[a-z-]+/g)].map((m) => m[0]);
  for (const literal of literals) assert.ok(expectedRoutes.includes(literal), `client 出现未知路由: ${literal}`);
  for (const route of expectedRoutes) assert.ok(literals.includes(route), `client 缺少路由: ${route}`);

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

  console.log("PASS dsh-web-file-preview smoke");
} finally {
  rmSync(root, { recursive: true, force: true });
}
