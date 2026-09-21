/**
 * history 域实现：DecideEvent → HistoryEntry 组装（本域唯一懂脱敏/哈希的装配点）。
 *
 * tools 域只产出 DecideEvent（无哈希/脱敏概念），组合根经此函数映射后追加；
 * rootDisplay 仅 basename、snippet 先脱敏后截断≤200、密钥无字段可入——三条红线在此收口。
 */
import { TEMPLATE_VERSION } from "../../../shared/interface.ts";
import type { AutomationLevel, HistoryEntry } from "../../../shared/interface.ts";
import { rootDisplayOf, rootHashOf, stateHashOf } from "./hash.ts";
import { redactSnippet } from "./redact.ts";

/** 事件面（tools 域 DecideEvent 的结构子集，避免跨域值引用）。 */
export interface EntryEvent {
  readonly presetId: string;
  readonly text: string;
  readonly lang: "en" | "zh" | "unknown";
  readonly truncated: boolean;
  readonly originalLength: number;
  readonly resultKind: string;
  readonly choice?: string;
  readonly score?: number;
  readonly confidence: number;
  readonly tier: "none" | "high" | "low";
  readonly automation: AutomationLevel;
  readonly latencyMs: number;
  readonly errorCode?: string;
}

/** 组装完整条目（now 由调用方注入，单测可定钟）。 */
export function assembleEntry(
  root: string,
  sessionId: string,
  event: EntryEvent,
  now: number,
): HistoryEntry {
  return {
    ts: now,
    rootHash: rootHashOf(root),
    rootDisplay: rootDisplayOf(root),
    sessionId,
    presetId: event.presetId,
    templateVersion: TEMPLATE_VERSION,
    stateHash: stateHashOf(event.text),
    snippetRedacted: redactSnippet(event.text),
    lang: event.lang,
    truncated: event.truncated,
    originalLength: event.originalLength,
    resultKind: event.resultKind,
    ...(event.choice !== undefined ? { choice: event.choice } : {}),
    ...(event.score !== undefined ? { score: event.score } : {}),
    confidence: event.confidence,
    tier: event.tier,
    automation: event.automation,
    provider: "official",
    latencyMs: event.latencyMs,
    ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
  };
}
