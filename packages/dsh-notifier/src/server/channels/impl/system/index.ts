/**
 * dsh-notifier channels 域 —— 系统通知出口。
 *
 * 本目录承担系统出口的全部实现：**探测**平台可用能力（脚本 / 播放器 /
 * notify-send）、**构造**命令（平台 × 音色 / 标题正文 → spawn 参数数组，零
 * shell 拼接）、**执行**命令。命令构造收在这里是职责正确的表现——平台适配是
 * 出口的实现细节，不是文本处理，放出去会让本域为拼一条命令多欠一份跨域依赖。
 *
 * 依赖方向：只引用本目录与共享语言，不引用 `interface.ts`。
 */
import type { DeliverResult, NotifyMessage } from "../deliver/type.ts";
import { toneFileCandidates } from "./tones.ts";
import type { PlatformProbe, SystemTarget } from "./type.ts";

/** 探测当前平台的系统通知与音频能力。 */
function probePlatform(toastScript: string): PlatformProbe {
  void toastScript;
  throw new Error("not implemented: probePlatform");
}

/** 系统通知命令的构造参数。 */
type SystemCommandOptions = {
  /** 用户的声音选择；怎么发声由本出口决定。 */
  sound: boolean | string;
  /** 是否由本出口自播——弹出命令因此不带系统提示音，否则会响两声。 */
  selfPlay: boolean;
  toastScript: string;
};

/** 构造系统通知命令；空数组 = 本平台弹不出窗，调用方据此记 failed。 */
function buildSystemCommand(
  probe: PlatformProbe,
  title: string,
  message: string,
  options: SystemCommandOptions,
): readonly string[] {
  void probe;
  void title;
  void message;
  void options;
  throw new Error("not implemented: buildSystemCommand");
}

/** 构造自播命令（平台 × 音色 → spawn 参数）；空数组 = 本平台放不出声。 */
function buildSoundCommand(probe: PlatformProbe, tone: string): readonly string[] {
  const player = probe.players[0];
  if (player === undefined) return [];
  const file = toneFileCandidates(probe.platform, tone).find(exists);
  return file === undefined ? [] : [player, file];
}

/** 音色文件按候选顺序逐个探测，取第一个真实存在的。 */
function exists(path: string): boolean {
  void path;
  throw new Error("not implemented: exists");
}

/** 投递一条系统通知（弹出 + 可选提示音）。 */
export async function sendSystem(
  target: SystemTarget,
  message: NotifyMessage,
): Promise<DeliverResult> {
  const probe = probePlatform(target.toastScript);
  // 指定音色时由本出口自播，弹出命令因此不带系统提示音——否则会响两声。
  const tone = typeof target.sound === "string" ? target.sound : undefined;
  const commands: Array<readonly string[]> = [];

  if (target.pop) {
    const pop = buildSystemCommand(probe, message.title, message.body, {
      sound: target.sound,
      selfPlay: tone !== undefined,
      toastScript: target.toastScript,
    });
    if (pop.length > 0) commands.push(pop);
  }
  if (tone !== undefined) {
    const play = buildSoundCommand(probe, tone);
    if (play.length > 0) commands.push(play);
  }
  if (commands.length === 0) {
    return { status: "failed", stage: "delivered", reason: "本平台没有可用的系统通知通道" };
  }

  for (const command of commands) {
    const ok = await run(command);
    if (!ok) return { status: "failed", stage: "delivered", reason: "系统命令执行失败" };
  }
  return { status: "ok", stage: "delivered" };
}

/** 执行一条命令；失败返回 false——失败也是投递结果的一种，不外抛给上层。 */
async function run(command: readonly string[]): Promise<boolean> {
  void command;
  throw new Error("not implemented: run");
}
