/**
 * dsh-web-file-preview — 「用默认应用打开」请求的识别与官方地址构造（纯逻辑）。
 *
 * dsh 0.1.5-rc.1 起，对话内的文件点击默认已走官方右侧栏预览；仍会把文件交给
 * 外部应用的只剩 /api/present.open 一条链路：present 交付物卡片的菜单，以及助手
 * 最终回复里对 presented 文件的提及点击。本模块提供把该请求改写成官方预览所需的
 * 纯函数，供客户端装配与单元测试共用。
 *
 * 地址构造是官方 @deepseek-ai/dsh-util-workspace-path@0.1.5-rc.1（MIT）的源码级
 * 复刻（官方 ui-chat 内联了同一份实现）：官方右侧栏 tab 以完整地址作 contentId
 * 去重，cwd 折叠语义必须逐字一致，否则同一文件会被打开成两个 tab。仓库门禁只
 * 允许对官方包 import type，故此处不复用运行时依赖。
 */

/** 官方「打开文件」路由（dsh-client-ui-deliverables 的 PRESENT_OPEN_PATH）。 */
export const PRESENT_OPEN_PATH = "/api/present.open";

/** 官方文件地址前缀（dsh-util-workspace-path 的 FILE_ADDRESS_PREFIX）。 */
const FILE_ADDRESS_PREFIX = "dsh-resource://file/";

/** pending 记录的有效期：真实失效靠下一次点击覆盖，TTL 仅作泄漏兜底。 */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/** 捕获阶段记下的「最近一次文件路径点击」。 */
export interface PendingEntry {
  readonly path: string;
  readonly at: number;
}

// ---------------------------------------------------------- 官方地址构造（vendored）

function encodeSegment(segment: string): string {
  // 盘符冒号保持字面量，与官方地址解析的还原约定对齐。
  return encodeURIComponent(segment).replace(/%3A/gi, ":");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeSegment).join("/");
}

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
}

function isAbsoluteWorkspacePath(path: string): boolean {
  return path.startsWith("/") || isWindowsStylePath(path);
}

function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
}

/**
 * 一个路径在指定会话下的官方资源地址。
 *
 * cwd 内的绝对路径折叠为工作区相对路径：官方卡片与正文提及走 `openFile` 时产出
 * 同一地址，两处必须一致，否则侧栏会把同一文件显示成两个 tab。
 * @param sessionId - 该路径所属会话。
 * @param cwd - 会话工作区根；未知时传 undefined。
 * @param path - 绝对或工作区相对路径，任一分隔符拼写。
 * @returns `dsh-resource://file/session/<id>/<path>` 地址。
 */
export function fileAddressFor(sessionId: string, cwd: string | undefined, path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
  const root = cwd === undefined ? "" : cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
  if (root !== "" && normalized.startsWith(`${root}/`)) {
    return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
  }
  return sessionFileAddress(sessionId, normalized);
}

// ---------------------------------------------------------------- 请求识别

function baseHref(): string {
  const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin;
  return typeof origin === "string" && origin !== "" ? origin : "http://dsh.local";
}

/**
 * fetch 入参归一成 URL：官方在调用点用相对路径字符串，但包装器要对 Request 实例
 * 与绝对 URL 同样稳健，否则会漏拦。
 */
function urlOf(input: unknown): URL | null {
  try {
    if (typeof input === "string") return new URL(input, baseHref());
    if (input === null || typeof input !== "object") return null;
    const candidate = input as { href?: unknown; url?: unknown };
    if (typeof candidate.href === "string") return new URL(candidate.href, baseHref());
    if (typeof candidate.url === "string") return new URL(candidate.url, baseHref());
  } catch {
    /* 非法 URL 不是本插件要处理的请求 */
  }
  return null;
}

function methodOf(input: unknown, init: unknown): string {
  const fromInit = (init as { method?: unknown } | null | undefined)?.method;
  if (typeof fromInit === "string" && fromInit !== "") return fromInit.toUpperCase();
  const fromRequest = (input as { method?: unknown } | null | undefined)?.method;
  if (typeof fromRequest === "string" && fromRequest !== "") return fromRequest.toUpperCase();
  return "GET";
}

/**
 * 是否为官方「用默认应用打开」请求。
 *
 * `reveal`（在文件管理器中显示）刻意放行：它不打开文件内容，dsh 内也没有等价物，
 * 接管只会降级成预览并让官方卡片显示与实际不符的完成文案（issue #698 决策）。
 */
export function isOpenRequest(input: unknown, init: unknown): boolean {
  const url = urlOf(input);
  if (url === null || url.pathname !== PRESENT_OPEN_PATH) return false;
  if (methodOf(input, init) !== "POST") return false;
  return (url.searchParams.get("action") ?? "open") === "open";
}

/** 请求携带的会话 id（官方把它放在 query 里）；缺失返回 null。 */
export function sessionIdOf(input: unknown): string | null {
  const sessionId = urlOf(input)?.searchParams.get("sessionId") ?? null;
  return sessionId !== null && sessionId !== "" ? sessionId : null;
}

// ------------------------------------------------------------ 点击路径采集

/**
 * title 是否像一条文件路径。
 *
 * 只做结构判定、不做存在性检查：官方卡片的 title 是绝对路径，助手回复提及的
 * title 是模型给出的原始路径（可能相对，也可能只是裸文件名）。误记 pending 会让
 * 下一次「打开」落到错误文件，因此宁可漏记——漏记只是放行原生打开。
 */
export function looksLikeFilePath(value: string): boolean {
  const text = value.trim();
  if (text === "" || text.length > 1024) return false;
  if (/[\n\r]/.test(text)) return false;
  if (/^(?:https?|mailto|data|blob):/i.test(text)) return false;
  if (text.includes("/") || text.includes("\\")) return true;
  return /^[^\s/\\]+\.[A-Za-z0-9]{1,16}$/.test(text);
}

/** pending 是否可用（存在、未过期、且像路径）；不可用返回 null。 */
export function usablePending(entry: PendingEntry | undefined, now: number): string | null {
  if (entry === undefined) return null;
  if (!Number.isFinite(entry.at) || !Number.isFinite(now)) return null;
  if (now - entry.at > PENDING_TTL_MS) return null;
  return looksLikeFilePath(entry.path) ? entry.path.trim() : null;
}
