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
  const conn: unknown = body["connection"];
  if (conn === undefined && body["version"] === undefined) return { ok: true, flat: body };
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
  for (const key of Object.keys(body)) {
    if ((RETIRED_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        failure: {
          errorCode: "RETIRED_KEY",
          category: "retired-key",
          message: "retired key: " + key,
        },
      };
    }
    if (
      !(ENVELOPE_TOP_KEYS as readonly string[]).includes(key) &&
      !(ALLOWED_PUT_KEYS as readonly string[]).includes(key)
    ) {
      return {
        ok: false,
        failure: {
          errorCode: "UNKNOWN_KEY",
          category: "unknown-key",
          message: "unknown key: " + key,
        },
      };
    }
  }
  const flat: Record<string, unknown> = {};
  if (isRecord(conn)) {
    for (const key of Object.keys(conn)) {
      if (!(CONNECTION_INNER_KEYS as readonly string[]).includes(key)) {
        return {
          ok: false,
          failure: {
            errorCode: "UNKNOWN_KEY",
            category: "unknown-key",
            message: "unknown connection key: " + key,
          },
        };
      }
      if (key === "hasPlaintextKey") continue;
      flat[key] = (conn as Record<string, unknown>)[key];
    }
  }
  for (const key of ALLOWED_PUT_KEYS) {
    if (body[key] !== undefined) flat[key] = body[key];
  }
  return { ok: true, flat };
}
