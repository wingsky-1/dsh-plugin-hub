/**
 * dsh-mcp-manager — 服务器配置归一化（纯函数，单一事实源）。
 *
 * normalizeServer 校验并规范化一条 MCP 服务器配置（stdio / streamable-http），
 * 供 Manager 增改与 mcpServers JSON 导入路径共用；SERVER_NAME_PATTERN 为
 * 服务器名命名空间约束（与官方 dsh-mcp-client 一致），物理定义已上移 server/shared/constants.ts
 * ——workspace 域的 id 生成器要用同一份判定（#767 S1-4a），此处只转出同名符号，调用点不变。
 *
 * reconnect 在此处按官方口径收紧（#767 S1-1）：官方对未知键直接抛错，而本插件的配置面
 * 是用户手写 JSON（可手排 mcp.json），故未知键改为静默丢弃（口径与顶层未知字段一致）；
 * 真正会改变重连语义的错值（时长越界、预算非正整数）仍在配置写入时拒绝，避免把错误推迟
 * 到连接期才暴露。
 */

import type { ServerConfig } from "./impl/model/type.ts";
// 默认超时取共享层单一物理定义（模块求值期消费，端口注入不可达；I2①）。
import { DEFAULT_TOOL_CALL_TIMEOUT_MS, SERVER_NAME_PATTERN } from "../shared/interface.ts";

export { SERVER_NAME_PATTERN };

/** 官方 reconnect 的键集（与 @deepseek-ai/dsh-mcp-client 的 Reconnect schema 逐字同值）。 */
const RECONNECT_KEYS = new Set(["enabled", "initialDelayMs", "maxDelayMs", "maxAttempts"]);

/** setTimeout 的上限；官方 resolveReconnectPolicy 用它约束两段退避时长。 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** 官方默认值（与 @deepseek-ai/dsh-mcp-client 的 RECONNECT_DEFAULTS 逐字同值）。 */
const RECONNECT_DEFAULTS = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
} as const;

/** 退避时长边界（官方口径：正有限数且不超过定时器上限）。 */
function assertReconnectDelay(value: unknown, path: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `${path} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
}

/** 校验 reconnect 字段间关系：回答「退避预算自洽吗？」——与官方同口径先补默认值
 * 再判关系（只写 initialDelayMs 而它大于默认 maxDelayMs 时装载期会抛，不提前拒绝
 * 会把错误推迟到连接期）+ maxAttempts 正整数。单字段形状（delay 边界/enabled 布尔）
 * 的校验在 normalizeReconnect 内（不同问题）。 */
function assertReconnectRelation(out: Record<string, unknown>): void {
  // 与官方同口径：**先补默认值再判关系**。只写 initialDelayMs 而它大于默认 maxDelayMs 时，
  // 官方在装载期就会抛；这里不提前拒绝，错误就又被推迟到连接期。
  const initialDelayMs =
    (out.initialDelayMs as number | undefined) ?? RECONNECT_DEFAULTS.initialDelayMs;
  const maxDelayMs = (out.maxDelayMs as number | undefined) ?? RECONNECT_DEFAULTS.maxDelayMs;
  if (initialDelayMs > maxDelayMs) {
    throw new Error("reconnect.initialDelayMs must be less than or equal to maxDelayMs");
  }
  const { maxAttempts } = out;
  if (
    maxAttempts !== undefined &&
    (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1)
  ) {
    throw new Error("reconnect.maxAttempts must be a positive integer");
  }
}

/**
 * 收紧 reconnect：只保留官方 4 键，边界按官方口径拒绝。
 *
 * 保留「输入里写了的键」而不是补齐默认值：默认值由官方 resolveReconnectPolicy 在装载期补，写回一份
 * 显式默认值会改变落盘形态，并让「配置是否变化」的字符串比对（manager 的 force 重连判定）
 * 对存量配置误报。
 *
 * 未登记键不出声：本函数是纯函数（可观察副作用会让它与装配顺序相关），且服务端源码不写
 * console——宿主 stdout 可能承载协议数据。需要提示用户的通道在 UI 校验面。
 */
function normalizeReconnect(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("reconnect must be an object");
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (RECONNECT_KEYS.has(key)) out[key] = value;
  }
  assertReconnectFields(out);
  return out;
}

/** reconnect 字段逐项校验（两个延迟的范围、enabled 的布尔、两者的关系）。 */
export function assertReconnectFields(out: Record<string, unknown>): void {
  if (out.initialDelayMs !== undefined)
    assertReconnectDelay(out.initialDelayMs, "reconnect.initialDelayMs");
  if (out.maxDelayMs !== undefined) assertReconnectDelay(out.maxDelayMs, "reconnect.maxDelayMs");
  if (out.enabled !== undefined && typeof out.enabled !== "boolean") {
    throw new Error("reconnect.enabled must be a boolean");
  }
  assertReconnectRelation(out);
}

/** 校验传输必填：回答「该传输形态能建吗？」——stdio 要非空 command；streamable-http
 * 要非空 url 且可解析、协议仅 http(s)（B13）。字段组装（applyTransportFields）不管
 * 合法性，只管落定（不同问题）。 */
function assertTransportRequired(src: Record<string, unknown>, transport: string): void {
  if (transport === "stdio") {
    if (typeof src.command !== "string" || (src.command as string).trim() === "") {
      throw new Error("stdio server requires a command");
    }
    return;
  }
  if (typeof src.url !== "string" || (src.url as string).trim() === "") {
    throw new Error("streamable-http server requires a url");
  }
  let parsed: URL;
  try {
    parsed = new URL(src.url as string);
  } catch {
    throw new Error(`invalid url: ${src.url}`);
  }
  // B13：streamable-http 仅接受 http(s)；ftp/file 等协议可解析但语义不符
  // （README 口径「streamable-http(远程)」），显式白名单拒绝。
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${parsed.protocol}//`);
  }
}

/** 落定传输相关字段：回答「传输字段怎么组装？」——stdio 组 command/args/cwd/env，
 * http 组 url/headers；调用前已由 assertTransportRequired 保证必填合法（不同问题）。 */
function applyTransportFields(
  server: ServerConfig,
  src: Record<string, unknown>,
  transport: string,
): void {
  if (transport === "stdio") {
    server.command = src.command as string;
    if (Array.isArray(src.args)) server.args = (src.args as unknown[]).map(String);
    if (typeof src.cwd === "string" && (src.cwd as string) !== "") server.cwd = src.cwd as string;
    if (typeof src.env === "object" && src.env !== null) {
      server.env = Object.fromEntries(
        Object.entries(src.env as Record<string, unknown>).map(([key, value]) => [
          key,
          String(value),
        ]),
      );
    }
    return;
  }
  server.url = src.url as string;
  if (typeof src.headers === "object" && src.headers !== null) {
    server.headers = Object.fromEntries(
      Object.entries(src.headers as Record<string, unknown>).map(([key, value]) => [
        key,
        String(value),
      ]),
    );
  }
}

/** 调用超时归一：正数向下取整；非数 / 非正回落缺省。 */
export function normalizeToolCallTimeoutMs(value: unknown): number {
  return typeof value === "number" && value > 0 ? Math.floor(value) : DEFAULT_TOOL_CALL_TIMEOUT_MS;
}

/** 自定义描述归一：非空字符串去首尾空白；空串与非字符串判缺省（不落键）。 */
export function normalizeDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 校验并规范化一条服务器配置。 */
export function normalizeServer(input: unknown): ServerConfig {
  if (typeof input !== "object" || input === null)
    throw new Error("server config must be an object");
  const src = input as Record<string, unknown>;
  const name = String(src.name ?? "").trim();
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`server name must match ${SERVER_NAME_PATTERN.source}`);
  }
  const transport =
    src.transport === "streamable-http"
      ? "streamable-http"
      : src.transport === "stdio"
        ? "stdio"
        : undefined;
  if (transport === undefined) throw new Error('transport must be "stdio" or "streamable-http"');
  assertTransportRequired(src, transport);
  const server: ServerConfig = {
    name,
    transport,
    enabled: src.enabled !== false,
    toolCallTimeoutMs: normalizeToolCallTimeoutMs(src.toolCallTimeoutMs),
    reconnect: normalizeReconnect(src.reconnect),
    // 能力目录的自定义描述（用户手写；MCP 协议无服务器级自描述，完整保留不截断）。
    description: normalizeDescription(src.description),
  };
  applyTransportFields(server, src, transport);
  return server;
}
