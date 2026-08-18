/**
 * dsh-web-file-preview — 文件预览路由（宿主端）。
 *
 * GET /api/dsh-file-preview/file?cwd=<工作区根>&path=<相对|绝对路径>
 *   - loopback 围栏（非回环 403，方法非 GET 405）；
 *   - 路径按 cwd 解析（resolve，不做“逃出 cwd”拦截）；
 *   - 图片 → 二进制直出（Content-Type: image/*，供 <img> 同源加载）；
 *   - 文本/代码/Markdown → UTF-8 全文直出（暂不截断，大文件方案归性能阶段）；
 *   - 其余类型 → 415 提示不可预览。
 *
 * GET /api/dsh-file-preview/health  健康检查。
 *
 * 约定：不校验路径是否属于某个已登记的工作区，也不做“逃出 cwd”拦截
 * （能打开 dsh web 本身即高权限，任意文件访问由平台/用户负责，本插件不做重复
 * 兜底）。仅按 `resolve(cwd, path)` 直接定位后读取。
 */

import untildify from "untildify";
import { resolve } from "node:path";
import { stat, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson } from "../../../shared/host-utils.js";
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
  /** 保留兼容旧配置；暂不实施截断（当前整读全文）。 */
  maxTextBytes?: number;
}

function queryParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null ? undefined : value;
}

/**
 * 文件预览路由的核心处理（已通过围栏校验后调用）。
 * @param res - node ServerResponse。
 * @param url - 解析后的请求 URL（含 cwd / path 查询参数）。
 * @param cfg - 配置（预留）。
 */
export async function serveFileRoute(
  res: ServerResponse,
  req: IncomingMessage,
  url: URL,
  cfg: PreviewConfig
): Promise<void> {
  const cwd = queryParam(url, "cwd");
  const path = queryParam(url, "path");
  if (cwd === undefined || cwd === "" || path === undefined || path === "") {
    writeJson(res, 400, { error: "missing cwd or path" });
    return;
  }
  // 不做「逃出 cwd」拦截：按 `resolve(cwd, path)` 直接定位（绝对路径用绝对，
  // 相对路径相对 cwd 解析；`~`/`~/` 前缀先经 untildify 展开为用户主目录，
  // 业界标准实现，见 https://www.npmjs.com/package/untildify）。
  // 任意文件访问由平台/用户负责（见文件头约定）。
  const resolved = resolve(cwd, untildify(path));
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
  // —— ETag（弱校验，基于 stat 的 size+mtimeMs，O(1)）；Cache-Control: no-cache
  // 让浏览器可协商 304，避免重复下载；文件未变时客户端自动发 If-None-Match 命中 304。
  const etag = `"${info.size}-${info.mtimeMs}"`;
  const baseHeaders = {
    "cache-control": "no-cache",
    "etag": etag,
    "referrer-policy": "no-referrer",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return;
  }
  if (kind.group === "image") {
    try {
      const data = await readFile(resolved);
      res.writeHead(200, {
        ...baseHeaders,
        "content-type": kind.contentType,
        "content-length": data.length,
      });
      res.end(data);
    } catch {
      writeJson(res, 500, { error: "read failed" });
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
    } catch {
      writeJson(res, 500, { error: "read failed" });
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
      writeJson(res, 200, { ok: true, plugin: "dsh-web-file-preview" });
    },
  };
  const diffRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.diff,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
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
      const result = computeGitDiff(cwd, path);
      writeJson(res, 200, { ok: true, ...result });
    },
  };
  return [fileRoute, diffRoute, healthRoute];
}
