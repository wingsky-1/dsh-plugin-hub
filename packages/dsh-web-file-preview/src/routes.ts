/**
 * dsh-web-file-preview — 文件预览路由（宿主端）。
 *
 * GET /api/dsh-file-preview/file?cwd=<工作区根>&path=<相对|绝对路径>
 *   - loopback 围栏（非回环 403，方法非 GET 405）；
 *   - 路径按 cwd 解析（resolve，不做“逃出 cwd”拦截）；
 *   - 图片 → 二进制直出（Content-Type: image/*，供 <img> 同源加载）；
 *   - 文本/代码/Markdown → UTF-8 直出；超过 maxTextBytes 返回 413 + truncated（文档截断，C6/W10）。
 *   - 其余类型 → 415 提示不可预览。
 *
 * GET /api/dsh-file-preview/health  健康检查。
 *
 * 约定：不校验路径是否属于某个已登记的工作区，也不做“逃出 cwd”拦截
 * （能打开 dsh web 本身即高权限，任意文件访问由平台/用户负责，本插件不做重复
 * 兜底）。仅按 `resolve(cwd, path)` 直接定位后读取。
 */

import untildify from "untildify";
import { resolve, isAbsolute } from "node:path";
import { stat, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson, errorMessage } from "../../../shared/host-utils.js";
import { previewKindOf } from "./mime.js";
import { computeGitDiff } from "./git.js";
import type { DshRoute } from "../../../types/dsh.js";

/** 路由路径单一来源（客户端契约 / smoke 共用）。 */
export const ROUTES = {
  file: "/api/dsh-file-preview/file",
  diff: "/api/dsh-file-preview/diff",
  health: "/api/dsh-file-preview/health",
};

/** 宿主端配置面（apply normalizeConfig 后传入）。 */
export interface PreviewConfig {
  enabled?: boolean;
  /** 文本类预览最大字节数；超过返回 413+truncated（C6 落地，非预留）。 */
  maxTextBytes?: number;
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
  const resolved = isAbsolute(expandedPath) ? resolve(expandedPath) : resolve(cwd as string, expandedPath);
  let info;
  try {
    info = await stat(resolved);
  } catch {
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
    (kind.group === "text" || kind.group === "renderedMd" || kind.group === "renderedCode") &&
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
  if (kind.group === "text" || kind.group === "renderedMd" || kind.group === "renderedCode") {
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

/**
 * 组装全部按 loopback 围栏守护的路由（file + health）。
 * @param cfg - 配置。
 * @returns 可注册进 ctx.webServer 的路由数组。
 */
export function makeRoutes(cfg: PreviewConfig): DshRoute[] {
  const fileRoute: DshRoute = {
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
  const healthRoute: DshRoute = {
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
  const diffRoute: DshRoute = {
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
  return [fileRoute, diffRoute, healthRoute];
}
