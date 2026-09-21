/**
 * dsh-notifier pipeline 域 —— 裁决：这条通知现在该不该发（唯一裁决点，别处不许再判）。
 * 判据不实现为抛错：本块挂在活的调用链上。
 */
import type { EffectiveConfig } from "../../deps.ts";
import { KIND_SWITCHES, inWindowMinutes } from "../../../../shared/interface.ts";
import { isBuiltinKind } from "../service/kinds.ts";
import type { BuiltinKind, NotifyKind } from "../service/kinds.ts";
import type { NotifyRequest } from "../service/type.ts";
import type { SuppressReason, Verdict } from "./type.ts";

/**
 * 单个窗口是否命中（纯函数：只看分钟数与起止，不读当前时间，方便逐分钟单测）。
 *
 * 事实源在 src/shared/quiet.ts（`inWindowMinutes`）：客户端本机回显与服务端裁决同源，
 * 改动只改共享处。这里保留名字，兼容既有 `judge/index.ts` 引用面与单测表驱动。
 */
export function inWindow(minutes: number, start: string, end: string): boolean {
  return inWindowMinutes(minutes, start, end);
}

/** 是否落在免打扰时段内：命中任一窗口即压制（并集语义）；空数组等于未命中。
 *
 * 单项逐个收窄：脏项（非对象、start/end 非字符串）按未命中跳过，不抛——本块挂在活的
 * 调用链上，判据不实现为抛错（见文件头）。 */
function isQuietNow(now: Date, quietHours: EffectiveConfig["quietHours"]): boolean {
  if (quietHours.enabled !== true) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const windows = Array.isArray(quietHours.windows) ? quietHours.windows : [];
  return windows.some((window) => {
    if (typeof window !== "object" || window === null || Array.isArray(window)) return false;
    const start = (window as { start?: unknown }).start;
    const end = (window as { end?: unknown }).end;
    if (typeof start !== "string" || typeof end !== "string") return false;
    return inWindow(minutes, start, end);
  });
}

/**
 * 裁决。判据顺序即短路顺序：**总开关 → kind 开关 → 动态 kind 确认 → 免打扰**。
 *
 * 每条规则写成一个有名函数、顺序在这四行里读得出来：此前四条规则混在一个函数体里、
 * 「`test` 不受约束」这个例外散在三处判断里，想插一条规则的人只能从中间猜位置。
 */
export function judgeRequest(
  config: EffectiveConfig,
  request: NotifyRequest,
  enabled: boolean,
): Verdict {
  const kind = request.kind;
  if (enabled === false) return blocked("disabled");
  // `test` 是用户主动按下的自检：过了总开关就不再受 kind 开关与免打扰约束——被静音吃掉
  // 等于测试按钮失效，而它验证的正是链路本身。这一句也是 `test` 在全文件唯一的例外。
  if (kind === "test") return passed();
  if (isBuiltinKind(kind) && isKindOff(config, kind)) return blocked("kind-off");
  if (isUnconfirmed(config, kind)) return blocked("unlisted");
  if (isQuietNow(new Date(), config.quietHours) && !allowsInQuiet(config.quietHours, kind)) {
    return blocked("quiet");
  }
  return passed();
}

/** 内置 kind 看它自己的事件开关（`test` 没有开关，调用方在此之前已放行它）。 */
function isKindOff(config: EffectiveConfig, kind: Exclude<BuiltinKind, "test">): boolean {
  return config[KIND_SWITCHES[kind]] !== true;
}

/** 外部注册的 kind 没有开关这一关，只认用户是否确认过（确认态的物理形态就是 allowKinds）。 */
function isUnconfirmed(config: EffectiveConfig, kind: NotifyKind): boolean {
  return !isBuiltinKind(kind) && !config.allowKinds.includes(kind);
}

/** 免打扰时段内放行谁：只有被显式写进 `allowKinds` 的 kind 能穿过去。 */
function allowsInQuiet(quietHours: EffectiveConfig["quietHours"], kind: NotifyKind): boolean {
  const allowed = quietHours.allowKinds ?? [];
  return allowed.includes(kind);
}

function passed(): Verdict {
  return { ok: true };
}

/** 压制：原因随记录写进历史，是「为什么我没收到」的唯一答案来源。 */
function blocked(reason: SuppressReason): Verdict {
  return { ok: false, reason };
}
