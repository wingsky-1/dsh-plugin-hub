/**
 * dsh-notifier 客户端 —— 通知帧的展示策略（纯判定）。
 *
 * 「这一帧要不要提醒、走哪条通道、要不要页内自播」原先散在 showNotification /
 * handleNotifyFrame 两个函数里，与 Notification 构造、DOM 横幅、音频播放交织在一起，
 * 因此每条分支都没有判据。这里把判定提成纯函数：输入是帧与页面现状，输出是通道与声音策略，
 * 副作用留给调用方。
 *
 * 三条语义容易在重写中被「顺手简化」掉，故此处逐条保留：
 * 1. 缺 sound 字段的旧帧按「跟随系统默认」处理（0.2.3 的服务端不发这个字段）；
 * 2. playOnly + mode:"system" 归一为自播——无弹窗实体时 OS 不会发声，不归一就是「0 弹 0 播纯静默」；
 * 3. playOnly 不受页面可见性约束（纯声音提醒，不打扰界面）。
 */

/** 服务端下发的声音策略：静音 / 跟随系统默认（交给 OS）/ 页内自播（系统弹窗 silent 防双响）。 */
export interface SoundPolicy {
  selfPlay: boolean;
  silent: boolean;
  tone: string | undefined;
}

/** 一帧提醒的落点。 */
export type DisplayChannel = "notification" | "banner" | "title" | "none";

/**
 * 帧里的声音策略（帧级权威，不回查配置）。
 *
 * @param sound 帧的 sound 字段；缺失/非对象一律按 `{mode:"system"}`。
 * @param playOnly 只响不弹：不弹实体、仅按需自播。
 */
export function soundPolicyOf(sound: unknown, playOnly: boolean): SoundPolicy {
  const frame =
    typeof sound === "object" && sound !== null
      ? (sound as { mode?: unknown; tone?: unknown })
      : { mode: "system" };
  // 弹窗实体与 OS 发声二选一：selfplay 必须把自己标成 silent，否则与页内自播叠成双响
  const selfPlay = frame.mode === "selfplay";
  const baseSilent = frame.mode === "silent" || selfPlay;
  const tone = typeof frame.tone === "string" ? frame.tone : undefined;
  if (playOnly && frame.mode === "system") {
    return { selfPlay: true, silent: true, tone };
  }
  return { selfPlay, silent: baseSilent, tone };
}

/**
 * 降级通道：不弹系统通知时用横幅还是标题闪烁。页面可见时用横幅（用户看得见），
 * 隐藏时改标题（横幅在看不见的页面上没有意义）。playOnly 两者都不用。
 */
export function fallbackChannelOf(playOnly: boolean, visibility: string): DisplayChannel {
  if (playOnly) return "none";
  return visibility !== "hidden" ? "banner" : "title";
}

/** 是否走系统级通知：playOnly 不弹实体；不可用时走降级通道。 */
export function displayChannelOf(input: {
  playOnly: boolean;
  notificationUsable: boolean;
  visibility: string;
}): DisplayChannel {
  if (!input.playOnly && input.notificationUsable) return "notification";
  return fallbackChannelOf(input.playOnly, input.visibility);
}

/**
 * 帧要不要处理。
 *
 * 测试通知无条件处理（验证链路就是它的目的，与可见性、开关无关）；其余帧在页面可见时默认
 * 不提醒，除非帧自己说「可见时也弹」（whenVisible）——判定归宿主出口，页面不回查配置。
 * playOnly 例外：它不打扰界面，纯声音提醒，因此不受可见性约束。
 */
export function frameAccepted(input: {
  kind: unknown;
  whenVisible: unknown;
  playOnly: unknown;
  visibility: string;
}): boolean {
  if (input.kind === "test") return true;
  if (input.visibility !== "hidden" && input.whenVisible !== true) {
    return input.playOnly === true;
  }
  return true;
}
