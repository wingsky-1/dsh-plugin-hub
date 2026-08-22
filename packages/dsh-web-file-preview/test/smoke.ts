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
  cleanRefChipPath,
} from "../lib/index.js";
import { build as esbuildBuild } from "esbuild";
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

  // 客户端契约 + 与宿主 ROUTES 路由一致性
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assertClientSourceContract(pkgDir);
  assertClientProductContract(pkgDir);
  const expectedRoutes = [ROUTES.file, ROUTES.diff, ROUTES.health];
  const literals = [...client.matchAll(/\/api\/dsh-file-preview\/[a-z-]+/g)].map((m) => m[0]);
  for (const literal of literals) assert.ok(expectedRoutes.includes(literal), `client 出现未知路由: ${literal}`);
  for (const route of expectedRoutes) assert.ok(literals.includes(route), `client 缺少路由: ${route}`);

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

  console.log("PASS dsh-web-file-preview smoke");
} finally {
  rmSync(root, { recursive: true, force: true });
}
