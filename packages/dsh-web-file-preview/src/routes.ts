/**
 * dsh-web-file-preview — 文件预览路由（宿主端）。
 *
 * GET /api/dsh-file-preview/file?cwd=<工作区根>&path=<相对|绝对路径>
 *   - loopback 围栏（非回环 403，方法非 GET 405）；
 *   - 路径按 cwd 解析（resolve，不做“逃出 cwd”拦截）；
 *   - 图片 → 二进制直出（Content-Type: image/*，供 <img> 同源加载）；
 *   - 文本/代码/Markdown/HTML → UTF-8 直出（HTML 也保持 text/plain，见 E2）；
 *     超过 maxTextBytes 返回 413 + truncated（文档截断，C6/W10）。
 *   - 其余类型 → 415 提示不可预览。
 *
 * GET /api/dsh-file-preview/health  健康检查。
 *
 * GET /api/dsh-file-preview/mermaid  Mermaid 懒加载 chunk（issue #104）：
 *   从包内 lib/client-mermaid.js 直出的静态资产端点（无用户输入路径、零穿越面），
 *   客户端 md 出现 mermaid 代码块时才动态 import 拉取。
 *
 * GET /api/dsh-file-preview/alloc?cwd=&path=  serve token 分配（issue #73）：
 *   把「HTML 文件所在目录」登记为只读 root，返回随机 token + 相对 root 的
 *   POSIX 相对路径（rest）；仅 .html/.htm 可分配（其余 400）。
 *
 * GET /api/dsh-file-preview/serve/<token>/<rest>  HTML 虚拟静态伺服（issue #73，
 *   prefix 路由，spec A 组）：
 *   - token → root 目录映射（进程级单例，见 serve-tokens.ts）；
 *   - realpath 双向根越界防护（闭合符号链接逃逸，C1）+ 编码攻击面拒绝（C2）；
 *   - 目录请求 404 不做目录列表（C3）；root 越界 404（C4，与 /file 刻意相反）；
 *   - 流式直出 + Content-Length（D1）；超过 maxAssetBytes → 413 + no-store（D2）；
 *   - 独立 MIME 判定：html → text/html，其余按 mime 库（E1）。
 *
 * GET /api/dsh-file-preview/release?token=  serve token 显式释放（B5，幂等）：
 *   客户端 closeModal 上报；未释放由 TTL/LRU 兜底回收。
 *
 * 约定：不校验路径是否属于某个已登记的工作区，也不做“逃出 cwd”拦截
 * （能打开 dsh web 本身即高权限，任意文件访问由平台/用户负责，本插件不做重复
 * 兜底）。仅按 `resolve(cwd, path)` 直接定位后读取。
 * 例外：/serve 把目录映射成 web root，是安全模型变更点——必须做严格 root 越界
 * 防护（realpath 双向校验 + 编码攻击面拒绝），与 /file 的“不做逃出拦截”刻意相反。
 */

import untildify from "untildify";
import { resolve, isAbsolute, join, relative, dirname, sep } from "node:path";
import { stat, readFile, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import mime from "mime";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson, errorMessage } from "../../../shared/host-utils.js";
import { previewKindOf } from "./mime.ts";
import { computeGitDiff } from "./git.ts";
import { bareBasenameOf, findUniqueByBasename } from "./basename-fallback.ts";
import { extOf, groupOfPath } from "./grouping.ts";
import { createTokenStore, type TokenStore } from "./serve-tokens.ts";
// 官方路由对象类型（仅 import type，编译期擦除；contract-check 禁止运行时值导入）。
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";

/** 路由路径单一来源（客户端契约 / smoke 共用）。 */
export const ROUTES = {
  file: "/api/dsh-file-preview/file",
  diff: "/api/dsh-file-preview/diff",
  health: "/api/dsh-file-preview/health",
  // Mermaid 懒加载 chunk（issue #104）：刻意不带 .js 后缀——客户端契约 smoke 的
  // 路由字面量正则为 [a-z-]+（匹配不到带点字面量），带点路由名会静默漏检。
  mermaid: "/api/dsh-file-preview/mermaid",
  // issue #73：HTML 虚拟静态伺服。serve 为 prefix kind（无尾斜杠，接管
  // /serve/<token>/… 任意子路径）；alloc/release 为 exact kind。
  serve: "/api/dsh-file-preview/serve",
  alloc: "/api/dsh-file-preview/alloc",
  release: "/api/dsh-file-preview/release",
};

/** 宿主端配置面（apply normalizeConfig 后传入）。 */
export interface PreviewConfig {
  enabled?: boolean;
  /** 文本类预览最大字节数；超过返回 413+truncated（C6 落地，非预留）。 */
  maxTextBytes?: number;
  /** serve 单资源最大字节数（issue #73 D2/D3）；超过返回 413+truncated+no-store。 */
  maxAssetBytes?: number;
}

function queryParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null ? undefined : value;
}

/**
 * readFile 失败错误 → HTTP 错误码：stat 与 readFile 之间文件被删/被换为目录时
 * 归 404（与 stat 阶段不存在同语义）；其余（权限、IO）归 500。
 */
function readErrorCode(error: unknown): number {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EISDIR" ? 404 : 500;
}

/** read 失败错误文案（与 stat 阶段不存在时的文案一致，避免同类根因两套提示）。 */
function readErrorText(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EISDIR" ? `not found: ${path}` : "read failed";
}

/**
 * 文件预览路由的核心处理（已通过围栏校验后调用）。
 * @param res - node ServerResponse。
 * @param req - 请求。
 * @param url - 解析后的请求 URL（含 cwd / path 查询参数）。
 * @param cfg - 配置（maxTextBytes 用于文本截断判定）。
 */
export async function serveFileRoute(
  res: ServerResponse,
  req: IncomingMessage,
  url: URL,
  cfg: PreviewConfig
): Promise<void> {
  const cwd = queryParam(url, "cwd");
  const path = queryParam(url, "path");
  if (path === undefined || path === "") {
    writeJson(res, 400, { error: "missing path" });
    return;
  }
  // cwd 仅在 path 为相对路径时必需（评审 C5）：绝对路径无需 cwd 即可定位；
  // 相对路径缺 cwd 直接 400，避免误导性提示。
  if (!isAbsolute(untildify(path)) && (cwd === undefined || cwd === "")) {
    writeJson(res, 400, { error: "missing cwd (relative path requires cwd)" });
    return;
  }
  // 不做「逃出 cwd」拦截：按 `resolve(cwd, path)` 直接定位（绝对路径用绝对，
  // 相对路径相对 cwd 解析；`~`/`~/` 前缀先经 untildify 展开为用户主目录，
  // 业界标准实现，见 https://www.npmjs.com/package/untildify）。
  // 任意文件访问由平台/用户负责（见文件头约定）。
  // C5：绝对路径无需 cwd（上层校验已保证「相对路径必有 cwd」）。
  const expandedPath = untildify(path);
  let resolved = isAbsolute(expandedPath) ? resolve(expandedPath) : resolve(cwd as string, expandedPath);
  let info: Stats | undefined;
  try {
    info = await stat(resolved);
  } catch {
    // issue #41 — 仅此 404 负路径进入的 basename 兜底（默认开启，无设置项）：
    // 相对路径未命中且带 cwd 时，按裸文件名在工作区内受控搜索唯一真实文件；
    // 绝对路径（完整凭证打错不换目标）与无 cwd 不兜底；0 命中 / ≥2 歧义 /
    // 触顶一律维持原 404。兜底链路任何意外都吞掉并保持 404，绝不放大为 500。
    if (!isAbsolute(expandedPath) && cwd !== undefined && cwd !== "") {
      const name = bareBasenameOf(path);
      if (name !== null) {
        try {
          const found = await findUniqueByBasename(cwd, name);
          if (found !== null) {
            resolved = found;
            info = await stat(resolved); // 命中后复检（竞态删除 → info 保持 undefined → 404）
          }
        } catch {
          // 维持 404
        }
      }
    }
  }
  if (info === undefined) {
    writeJson(res, 404, { error: `not found: ${path}` });
    return;
  }
  if (!info.isFile()) {
    writeJson(res, 400, { error: `not a file: ${path}` });
    return;
  }
  const kind = previewKindOf(path);
  // 文本超限检查必须在 ETag/304 判断**之前**（评审 W10/C6）：若先走 304，
  // 带缓存标签的超限文件会永远命中「未变化」绕过 413，用户看不到超限提示。
  // 413 响应不缓存（no-store），避免客户端把超限状态当可复用缓存。
  if (
    (kind.group === "text" || kind.group === "renderedMd" || kind.group === "renderedCode" || kind.group === "renderedHtml") &&
    cfg.maxTextBytes !== undefined &&
    info.size > cfg.maxTextBytes
  ) {
    res.writeHead(413, {
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        error: `file too large to preview (${info.size} bytes; limit ${cfg.maxTextBytes})`,
        truncated: true,
        size: info.size,
        max: cfg.maxTextBytes,
      })
    );
    return;
  }
  // —— ETag（弱校验，基于 stat 的 size+mtimeMs，O(1)）；Cache-Control: no-cache
  // 让浏览器可协商 304，避免重复下载；文件未变时客户端自动发 If-None-Match 命中 304。
  const etag = `"${info.size}-${info.mtimeMs}"`;
  const baseHeaders = {
    "cache-control": "no-cache",
    "etag": etag,
    "referrer-policy": "no-referrer",
    // 防 MIME 嗅探/类型混淆：预览内容一律按声明 Content-Type 呈现（尤其 SVG）。
    "x-content-type-options": "nosniff",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return;
  }
  if (kind.group === "image") {
    try {
      const data = await readFile(resolved);
      const headers: Record<string, string> = {
        ...baseHeaders,
        "content-type": kind.contentType,
        "content-length": String(data.length),
      };
      // SVG 顶层导航可执行内嵌 <script>（同源 XSS 通道）；CSP sandbox 使该文档
      // 失去脚本/导航能力（图形渲染不受影响），Modal 内 <img>/blob 预览不经过
      // 顶层导航，行为不变。
      if (kind.ext === "svg") headers["content-security-policy"] = "sandbox";
      res.writeHead(200, headers);
      res.end(data);
    } catch (error) {
      writeJson(res, readErrorCode(error), { error: readErrorText(error, path) });
    }
    return;
  }
  if (kind.group === "text" || kind.group === "renderedMd" || kind.group === "renderedCode" || kind.group === "renderedHtml") {
    try {
      const body = await readFile(resolved, "utf8");
      res.writeHead(200, {
        ...baseHeaders,
        "content-type": kind.contentType,
      });
      res.end(body);
    } catch (error) {
      writeJson(res, readErrorCode(error), { error: readErrorText(error, path) });
    }
    return;
  }
  writeJson(res, 415, { error: `unsupported preview type: .${kind.ext}` });
}

// ---------------------------------------------------------------- issue #73：serve token 虚拟伺服

/**
 * 进程级懒起单例 token 存储（issue #73 B1）：同进程内多会话 / 多 root 并存。
 * 惰性创建（首个 alloc 才建），插件生命周期内不销毁（内存态，进程退出即消失）。
 */
let tokenStore: TokenStore | undefined;

/** 取进程级单例 token 存储（测试可经 resetServeTokenStore 重置注入自定义实例）。 */
export function getTokenStore(): TokenStore {
  if (tokenStore === undefined) tokenStore = createTokenStore();
  return tokenStore;
}

/** 重置单例（测试注入短 TTL / 时钟 / 上限用；生产不调用）。 */
export function resetServeTokenStore(store?: TokenStore): void {
  tokenStore = store;
}

/** 分配前校验路径：必须是存在的文件且属于 html 渲染组（.html/.htm）。 */
async function resolveAllocTarget(cwd: string | undefined, path: string): Promise<
  { ok: true; absPath: string } | { ok: false; status: number; error: string }
> {
  if (path === undefined || path === "") {
    return { ok: false, status: 400, error: "missing path" };
  }
  if (!isAbsolute(untildify(path)) && (cwd === undefined || cwd === "")) {
    return { ok: false, status: 400, error: "missing cwd (relative path requires cwd)" };
  }
  const expandedPath = untildify(path);
  const resolved = isAbsolute(expandedPath) ? resolve(expandedPath) : resolve(cwd as string, expandedPath);
  if (groupOfPath(resolved).group !== "html") {
    return { ok: false, status: 400, error: "alloc only supports html preview" };
  }
  let info: Stats;
  try {
    info = await stat(resolved);
  } catch {
    return { ok: false, status: 404, error: `not found: ${path}` };
  }
  if (!info.isFile()) {
    return { ok: false, status: 400, error: `not a file: ${path}` };
  }
  return { ok: true, absPath: resolved };
}

/**
 * token 分配（spec A5）：root = HTML 文件所在目录（realpath 归一，闭合符号链接）。
 * rest = 磁盘绝对路径相对 root 的 POSIX 相对路径——root 与 rest 必须基于**同一份
 * realpath 归一后的路径**（评审 P1-1）：HTML 所在目录是符号链接时（macOS
 * /tmp→/private/tmp、软链 worktree、iCloud 挂载均常态），若 rest 用未归一路径
 * 计算会含 `..` 段，serve 侧 realpath 判定必 404。
 */
export async function allocServeToken(
  res: ServerResponse,
  url: URL,
  cfg: PreviewConfig
): Promise<void> {
  const cwd = queryParam(url, "cwd");
  const path = queryParam(url, "path") ?? "";
  const target = await resolveAllocTarget(cwd, path);
  if (!target.ok) {
    writeJson(res, target.status, { error: target.error });
    return;
  }
  // 先对目标文件 realpath 归一（闭合文件级符号链接），再取目录归一为 root——
  // 两侧同源，rest 恒为 root 内 POSIX 相对路径（无 `..`）。
  let realFile: string;
  try {
    realFile = await realpath(target.absPath);
  } catch {
    writeJson(res, 404, { error: `not found: ${path}` });
    return;
  }
  let root: string;
  try {
    root = await realpath(dirname(realFile));
  } catch {
    writeJson(res, 404, { error: `not found: ${path}` });
    return;
  }
  const store = getTokenStore();
  const token = store.alloc(root);
  if (token === null) {
    // 全部活跃且达上限：拒绝新分配（防泄漏优先于可用性），客户端提示稍后再试。
    writeJson(res, 429, { error: "too many active previews, close some previews first" });
    return;
  }
  // rest 恒等于「realpath 归一后的磁盘绝对路径相对 root 的 POSIX 相对路径」
  // （spec 四、资源解析）。注意：响应不带 root——客户端只消费 token/rest，
  // root 属多余信息面（评审 P2-3，与 A3「不泄露区分信息」精神一致）。
  const rest = relative(root, realFile).split(sep).join("/");
  writeJson(res, 200, { ok: true, token, rest });
}

/** serve 单资源 Content-Type（E1）：html → text/html；其余按 mime 库；未知 octet-stream。 */
export function serveContentTypeOf(rest: string): string {
  const ext = extOf(rest);
  if (ext === "html" || ext === "htm") return "text/html; charset=utf-8";
  const type = mime.getType(ext);
  return type !== null ? type : "application/octet-stream";
}

/**
 * serve 路由核心（spec A/C/D/E 组；已通过围栏校验后调用）。
 * 语义与 /file 刻意相反：root 越界一律 404（把目录映射成 web root 的安全模型变更点）。
 */
export async function serveTokenRoute(
  res: ServerResponse,
  req: IncomingMessage,
  url: URL,
  cfg: PreviewConfig
): Promise<void> {
  // /serve/<token>/<rest>：prefix 路由 path 之后形如 "/<token>/<rest>"——先剥前导斜杠。
  const afterPrefix = url.pathname.slice(ROUTES.serve.length).replace(/^\//, "");
  const slash = afterPrefix.indexOf("/");
  const token = slash === -1 ? afterPrefix : afterPrefix.slice(0, slash);
  const rest = slash === -1 ? "" : afterPrefix.slice(slash + 1);
  if (token === "" || rest === "" || rest.startsWith("/") || rest.includes("\\")) {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  const store = getTokenStore();
  const entry = store.get(token);
  if (entry === undefined) {
    writeJson(res, 404, { error: "not found" }); // A3：未知/过期 token 一律 404，不泄露区分信息
    return;
  }
  // rest 编码攻击面：pathname 保留百分号编码（%2e%2e / %2f 不会先被 URL 解析器还原），
  // 先 decodeURIComponent 还原（失败=非法编码 → 404），再做「.. / .」段与 NUL 拒绝（C2）。
  let decodedRest: string;
  try {
    decodedRest = decodeURIComponent(rest);
  } catch {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  if (decodedRest.includes("\0")) {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  const segments = decodedRest.split("/");
  if (segments.some((seg) => seg === ".." || seg === ".")) {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  // 拼接 + realpath 双向校验（C1）：root 在分配时已 realpath；这里对目标再次
  // realpath 后判定仍落在 root 内——闭合符号链接逃逸（root/link -> /etc）。
  const candidate = join(entry.root, ...segments);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  if (real !== entry.root && !real.startsWith(entry.root + sep)) {
    writeJson(res, 404, { error: "not found" }); // C4：越界 404
    return;
  }
  let info: Stats;
  try {
    info = await stat(real);
  } catch {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  if (!info.isFile()) {
    writeJson(res, 404, { error: "not found" }); // C3：目录请求 404，不做目录列表
    return;
  }
  // 超限检查先于 ETag/304（与 /file 同语义，D2）：413 响应不缓存（no-store）。
  // 响应头与 /file 413 一致（nosniff + no-referrer，评审 P2-5）。
  if (cfg.maxAssetBytes !== undefined && info.size > cfg.maxAssetBytes) {
    res.writeHead(413, {
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        error: `asset too large to serve (${info.size} bytes; limit ${cfg.maxAssetBytes})`,
        truncated: true,
        size: info.size,
        max: cfg.maxAssetBytes,
      })
    );
    return;
  }
  const etag = `"${info.size}-${info.mtimeMs}"`;
  const baseHeaders: Record<string, string> = {
    "cache-control": "no-cache",
    "etag": etag,
    "referrer-policy": "no-referrer", // A4：防外部资源收到含 token 的 Referer
    "x-content-type-options": "nosniff", // A4：防 MIME 嗅探/类型混淆
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return;
  }
  // 流式直出（D1）：createReadStream + Content-Length，不整读进内存。
  // 手动管道（data/end/error 事件 + res.write）而非 stream.pipe(res)：
  //  - 不依赖 dest 的 pipe 协议（测试 fakeRes 无需实现 .on）；
  //  - 错误处理确定：headersSent 前可回写 500，之后销毁连接；
  //  - 返回 promise 在流结束时 resolve——调用方 await 即代表响应完整发出
  //    （测试无需轮询等待）；
  //  - 断连兜底（评审 P1-3）：客户端中止请求 → res close → 销毁读流并 resolve，
  //    否则流停在 pause() 泄漏 fd、promise 悬挂。
  return new Promise<void>((resolvePromise) => {
    const stream = createReadStream(real);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    const contentType = serveContentTypeOf(rest);
    const headers: Record<string, string> = {
      ...baseHeaders,
      "content-type": contentType,
      "content-length": String(info.size),
    };
    // issue #344 对称修复（评审 P3）：serve 对 SVG 补 CSP sandbox——与 /file 一致，
    // 防止该 serve URL 被顶层导航打开时 SVG 内嵌 <script> 执行（maxAssetBytes 提至
    // 20M 后暴露面放大；loopback 围栏 + 128-bit token 已缓解，但语义应对齐）。
    if (contentType === "image/svg+xml") headers["content-security-policy"] = "sandbox";
    res.writeHead(200, headers);
    stream.on("data", (chunk) => {
      if (!res.write(chunk)) stream.pause(); // 背压：下游写不动时暂停读
    });
    res.on("drain", () => stream.resume());
    stream.on("end", () => { res.end(); finish(); });
    stream.on("error", () => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: "read failed" });
      } else if (typeof (res as any).destroy === "function") {
        (res as any).destroy();
      }
      finish();
    });
    // 断连/关闭兜底：res close（浏览器中止、连接重置）→ 销毁读流、解除悬挂。
    res.on("close", () => { stream.destroy(); finish(); });
    stream.on("close", () => { if (!settled) finish(); });
  });
}

/** token 显式释放（B5，幂等）：客户端 closeModal 上报；未知 token 也返回 ok（无探测面）。 */
export function releaseServeToken(res: ServerResponse, url: URL): void {
  const token = queryParam(url, "token");
  if (token === undefined || token === "") {
    writeJson(res, 400, { error: "missing token" });
    return;
  }
  getTokenStore().release(token);
  writeJson(res, 200, { ok: true });
}

/**
 * Mermaid 懒加载 chunk 静态资产端点核心处理（已通过围栏校验后调用，issue #104）。
 *
 * 从本包 lib/ 同目录读取构建产物 client-mermaid.js（宿主 index.js 亦在 lib/，
 * bundle 后 import.meta.url 即 lib/index.js → 相对定位不随部署路径漂移）。
 * 无用户输入路径（不从请求读文件名）——零路径穿越面；协商缓存策略与 /file
 * 一致（弱 ETag + no-cache），chunk 仅在 mermaid 块首次出现时拉取一次。
 */
export async function serveMermaidRoute(res: ServerResponse, req: IncomingMessage): Promise<void> {
  const chunkUrl = new URL("./client-mermaid.js", import.meta.url);
  let info: Stats;
  try {
    info = await stat(chunkUrl);
  } catch {
    writeJson(res, 404, { error: "mermaid chunk not built (client-mermaid.js missing)" });
    return;
  }
  // ETag/304 与 /file 同策略：chunk 构建后不可变，浏览器模块缓存 + 协商 304
  // 保证同一会话第二次遇到 mermaid 文档不重复下载。
  const etag = `"${info.size}-${info.mtimeMs}"`;
  const baseHeaders = {
    "cache-control": "no-cache",
    "etag": etag,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return;
  }
  try {
    const body = await readFile(chunkUrl);
    res.writeHead(200, {
      ...baseHeaders,
      "content-type": "text/javascript; charset=utf-8",
      "content-length": String(body.length),
    });
    res.end(body);
  } catch (error) {
    writeJson(res, 500, { error: `read mermaid chunk failed: ${errorMessage(error)}` });
  }
}

/**
 * 组装全部按 loopback 围栏守护的路由（file + diff + health + mermaid）。
 * @param cfg - 配置。
 * @returns 可注册进 ctx.webServer 的路由数组。
 */
export function makeRoutes(cfg: PreviewConfig): WebRoute[] {
  const fileRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.file,
    handler: (req: IncomingMessage, res: ServerResponse): Promise<void> | void => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      return serveFileRoute(res, req, url, cfg);
    },
  };
  const healthRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.health,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      writeJson(res, 200, { ok: true, plugin: "dsh-web-file-preview" });
    },
  };
  const diffRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.diff,
    // async：diff 计算（execFile）不阻塞服务事件循环（评审 C3）；try/catch 兜底防
    // 参数型异常穿透到 webServer 层。
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const cwd = queryParam(url, "cwd");
      const path = queryParam(url, "path");
      if (cwd === undefined || cwd === "" || path === undefined || path === "") {
        writeJson(res, 400, { error: "missing cwd or path" });
        return;
      }
      try {
        const result = await computeGitDiff(cwd, path);
        writeJson(res, 200, { ok: true, ...result });
      } catch (error) {
        writeJson(res, 500, { error: `diff failed: ${errorMessage(error)}` });
      }
    },
  };
  // Mermaid 懒加载 chunk（issue #104）：无用户输入路径的静态资产端点，
  // 围栏语义与 file/diff 完全一致（非回环 403 / 方法非 GET 405）。
  const mermaidRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.mermaid,
    handler: (req: IncomingMessage, res: ServerResponse): Promise<void> | void => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      return serveMermaidRoute(res, req);
    },
  };
  // issue #73：serve token 分配（exact）。
  const allocRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.alloc,
    handler: (req: IncomingMessage, res: ServerResponse): Promise<void> | void => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      return allocServeToken(res, new URL(req.url ?? "/", "http://localhost"), cfg);
    },
  };
  // issue #73：HTML 虚拟静态伺服（prefix：/serve/<token>/ 下任意子路径均被接管，A1）。
  const serveRoute: WebRoute = {
    kind: "prefix",
    path: ROUTES.serve,
    handler: (req: IncomingMessage, res: ServerResponse): Promise<void> | void => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      return serveTokenRoute(res, req, new URL(req.url ?? "/", "http://localhost"), cfg);
    },
  };
  // issue #73：serve token 显式释放（exact，幂等）。
  const releaseRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.release,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      releaseServeToken(res, new URL(req.url ?? "/", "http://localhost"));
    },
  };
  return [fileRoute, diffRoute, healthRoute, mermaidRoute, allocRoute, serveRoute, releaseRoute];
}
