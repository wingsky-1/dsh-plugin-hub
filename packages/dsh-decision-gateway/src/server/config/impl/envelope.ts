/**
 * config 域实现：嵌套 PUT 包络归一化（D1，输出扁平体喂 validatePutBody）。
 *
 * 从 model.ts 拆出（内聚收窄）：包络形状与字段校验分属不同职责。
 * 无包络键（connection/version 均缺席）即扁平体直通；包络模式下 version 须为 1。
 */
import { RETIRED_KEYS } from "../../../shared/interface.ts";
import { ALLOWED_PUT_KEYS, isRecord } from "./model.ts";
import type { PutFailure } from "./model.ts";

/** 包络顶层允许键（扁平键另见 ALLOWED_PUT_KEYS；之外一律 400）。 */
const ENVELOPE_TOP_KEYS = [
  "version",
  "connection",
  "presets",
  "history",
  "apiKeyPlaintext",
  "confirm",
] as const;

/** connection 内允许键（hasPlaintextKey 只读派生，回显即忽略；之外一律 400）。 */
const CONNECTION_INNER_KEYS = [
  "apiKeyRef",
  "timeoutMs",
  "maxConcurrency",
  "truncBudget",
  "hasPlaintextKey",
] as const;

type EnvelopeShape =
  | { readonly ok: true; readonly conn: Record<string, unknown> | undefined }
  | { readonly ok: false; readonly failure: PutFailure };

/**
 * 包络模式的形状前置：connection 非对象即 400；version 存在则须为 1。
 *
 * 这两条与「无 connection/version 即扁平直通」互不干涉——直通的前提正是两者皆缺，
 * 而两者皆缺时本函数两条检查都是空转，所以前置执行不改变判定顺序的后果。
 */
function checkEnvelopeShape(body: Record<string, unknown>): EnvelopeShape {
  const conn: unknown = body["connection"];
  if (conn !== undefined && !isRecord(conn)) {
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_BODY",
        category: "bad-request",
        message: "connection must be an object",
      },
    };
  }
  if (body["version"] !== undefined && body["version"] !== 1) {
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_VERSION",
        category: "bad-request",
        message: "version must be 1",
      },
    };
  }
  return { ok: true, conn };
}

/** 顶层键白名单：退役键优先判（retired-key 类），其余越界即 unknown-key。 */
function checkTopKeys(body: Record<string, unknown>): PutFailure | null {
  for (const key of Object.keys(body)) {
    if ((RETIRED_KEYS as readonly string[]).includes(key)) {
      return {
        errorCode: "RETIRED_KEY",
        category: "retired-key",
        message: "retired key: " + key,
      };
    }
    if (
      !(ENVELOPE_TOP_KEYS as readonly string[]).includes(key) &&
      !(ALLOWED_PUT_KEYS as readonly string[]).includes(key)
    ) {
      return { errorCode: "UNKNOWN_KEY", category: "unknown-key", message: "unknown key: " + key };
    }
  }
  return null;
}

/** connection 内层键上提：越界键 400；hasPlaintextKey 是只读派生，跳过且不上提。 */
function liftConnectionKeys(
  conn: Record<string, unknown>,
  flat: Record<string, unknown>,
): PutFailure | null {
  for (const key of Object.keys(conn)) {
    if (!(CONNECTION_INNER_KEYS as readonly string[]).includes(key)) {
      return {
        errorCode: "UNKNOWN_KEY",
        category: "unknown-key",
        message: "unknown connection key: " + key,
      };
    }
    if (key === "hasPlaintextKey") continue;
    flat[key] = conn[key];
  }
  return null;
}

/** 顶层允许键下压到扁平体（version/connection 等包络键不经此面，已在上一步处理）。 */
function lowerTopKeys(body: Record<string, unknown>, flat: Record<string, unknown>): void {
  for (const key of ALLOWED_PUT_KEYS) {
    if (body[key] !== undefined) flat[key] = body[key];
  }
}

/** 嵌套包络归一化（成功即扁平体，失败即 400 负载）。 */
export function normalizePutEnvelope(
  body: unknown,
):
  | { readonly ok: true; readonly flat: Record<string, unknown> }
  | { readonly ok: false; readonly failure: PutFailure } {
  if (!isRecord(body)) {
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_BODY",
        category: "bad-request",
        message: "body must be an object",
      },
    };
  }
  const shape = checkEnvelopeShape(body);
  if (!shape.ok) return shape;
  if (shape.conn === undefined && body["version"] === undefined) return { ok: true, flat: body };
  const topFailed = checkTopKeys(body);
  if (topFailed !== null) return { ok: false, failure: topFailed };
  const flat: Record<string, unknown> = {};
  if (shape.conn !== undefined) {
    const liftFailed = liftConnectionKeys(shape.conn, flat);
    if (liftFailed !== null) return { ok: false, failure: liftFailed };
  }
  lowerTopKeys(body, flat);
  return { ok: true, flat };
}
