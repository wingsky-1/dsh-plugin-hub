/**
 * dsh-notifier pipeline 域 —— 裁决：这条通知现在该不该发（唯一裁决点，别处不许再判）。
 * 判据不实现为抛错：本块挂在活的调用链上。
 */
import type { EffectiveConfig } from "../../deps.ts";
import { isBuiltinKind } from "../service/kinds.ts";
import type { BuiltinKind } from "../service/kinds.ts";
import type { NotifyRequest } from "../service/type.ts";
import type { KindSwitchKey, Verdict } from "./type.ts";

/** 内置种类的开关；`test` 不在表里——它不对应任何宿主事件，也就没有开关。 */
const KIND_SWITCHES: Record<Exclude<BuiltinKind, "test">, KindSwitchKey> = {
  ask: "notifyAsk",
  question: "notifyQuestion",
  done: "notifyTaskDone",
  "subagent-done": "notifySubagentDone",
  error: "notifyTaskError",
  "turn-end": "notifyTurnEnd",
};

/** `"HH:MM"` → 当日分钟数；形状非法或越界返回 NaN。 */
function parseClock(text: string): number {
  const match = /^(\d{2}):(\d{2})$/u.exec(text);
  if (match === null) return NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return NaN;
  return hours * 60 + minutes;
}

/**
 * 是否落在免打扰时段内：支持跨午夜（`start > end`）。
 * `start === end`（零长窗口）与解析失败一律算未命中——脏设置不该把通知全部吃掉。
 */
function isQuietNow(now: Date, quietHours: EffectiveConfig["quietHours"]): boolean {
  if (quietHours.enabled !== true) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = parseClock(quietHours.start);
  const end = parseClock(quietHours.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/**
 * 裁决。判据顺序即短路顺序：总开关 → kind 开关 → 动态 kind 确认 → 免打扰。
 * `test` 跳过 kind 开关与免打扰：它没有宿主事件也就没有开关，而用户是主动按下它的
 * ——被静音吃掉等于测试按钮失效。
 */
export function judgeRequest(
  config: EffectiveConfig,
  request: NotifyRequest,
  enabled: boolean,
): Verdict {
  const kind = request.kind;
  if (enabled === false) return { ok: false, reason: "disabled" };
  if (isBuiltinKind(kind) && kind !== "test" && !config[KIND_SWITCHES[kind]]) {
    return { ok: false, reason: "kind-off" };
  }
  // 外部注册的 kind 没有开关这一关，只认用户是否确认过（确认态的物理形态就是 allowKinds）。
  if (!isBuiltinKind(kind) && !config.allowKinds.includes(kind)) {
    return { ok: false, reason: "unlisted" };
  }
  if (kind !== "test" && isQuietNow(new Date(), config.quietHours)) {
    const allowed = config.quietHours.allowKinds ?? [];
    if (!allowed.includes(kind)) return { ok: false, reason: "quiet" };
  }
  return { ok: true };
}
