/**
 * tools 域实现：连接探针（空体合法；密钥由调用方解析后传入；不记历史）。
 *
 * 从组合根沉入本域（内聚收窄）：探针的远端调用本就是 tools 能力，组合根只做密钥解析与装配。
 */
import { frozenPresetOf } from "../../../shared/interface.ts";
import type { FetchImpl } from "../deps.ts";
import { callWithRetry, defaultFetchImpl } from "./client.ts";

/** 探针结果。 */
export type ProbeResult =
  | { readonly ok: true; readonly latencyMs: number }
  | {
      readonly ok: false;
      readonly errorCode: string;
      readonly category: string;
      readonly message: string;
    };

/** 探针输入（key 缺席即 NO_KEY，不触网络）。 */
export interface ProbeInput {
  readonly key: string | undefined;
  readonly timeoutMs: number;
  readonly fetchImpl?: FetchImpl;
}

/** 执行连接探针（general 模板最小体；成功/失败均不记历史）。 */
export async function probeConnection(input: ProbeInput): Promise<ProbeResult> {
  if (input.key === undefined) {
    return { ok: false, errorCode: "NO_KEY", category: "no-key", message: "no api key" };
  }
  const template = frozenPresetOf("general");
  const started = Date.now();
  const outcome = await callWithRetry(
    {
      preset: "general",
      templateVersion: 1,
      state: { text: "connection probe", lang: "unknown" },
      questions: (template?.questions ?? []).map((q) => ({
        id: q.id,
        text: q.text,
        kind: q.kind,
        ...(q.options !== undefined ? { options: [...q.options] } : {}),
      })),
    },
    input.key,
    input.timeoutMs,
    input.fetchImpl ?? defaultFetchImpl(),
  );
  if (outcome.failure !== undefined || outcome.verdict === undefined) {
    const failure = outcome.failure ?? {
      code: "UPSTREAM",
      category: "upstream",
      message: "unknown",
    };
    return {
      ok: false,
      errorCode: failure.code,
      category: failure.category,
      message: failure.message,
    };
  }
  return { ok: true, latencyMs: Date.now() - started };
}
