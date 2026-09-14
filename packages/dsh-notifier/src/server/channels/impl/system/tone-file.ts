/**
 * dsh-notifier channels 域 system 块 —— 自播素材的来源与生命周期。
 *
 * 这里只回答「本次播什么、什么时候收」：素材是宿主的主题文件还是运行时合成的一段 WAV，临时文件
 * 何时落盘、何时 unlink、何时连目录一起释放。播放器知识与命令行构造不在这里（归 `players.ts` 与
 * `index.ts`），文件系统原语也不在这里（归 `deps.ts` 的进程事实端口）。
 */
import { systemDeps } from "./deps.ts";
import { synthToneWav } from "./synth.ts";
import { toneFileCandidates } from "./tones.ts";
import type { ToneStage } from "./type.ts";

/** 本次自播的素材：宿主主题文件优先，缺失时才走运行时合成。 */
export type ToneSource =
  | { readonly kind: "theme"; readonly path: string }
  | { readonly kind: "synth"; readonly bytes: Buffer }
  | { readonly kind: "none" };

/**
 * 主题文件优先：宿主装了 `sound-theme-freedesktop` 时仍用它调过的素材（合成音只是无头宿主的兜底，
 * 不是替换品）。只有候选**全部**不存在时才落合成音，且只对 Linux 合成——darwin/win32 有系统自带
 * 素材与播放器，合成兜底解决的正是 #783 的无头 Linux 现场。
 */
export function resolveToneSource(platform: string, tone: string): ToneSource {
  const deps = systemDeps();
  const theme = toneFileCandidates(platform, tone).find((path) => deps.existsSync(path));
  if (theme !== undefined) return { kind: "theme", path: theme };
  if (platform !== "linux") return { kind: "none" };
  const bytes = synthToneWav(tone);
  return bytes === null ? { kind: "none" } : { kind: "synth", bytes };
}

/** 把合成音落到临时文件：失败（`/tmp` 只读挂载）时本次**没有可执行的播放动作**。 */
export function stageToneSource(bytes: Buffer): ToneStage {
  return systemDeps().stageToneAudio(bytes);
}

/**
 * 删掉本次的临时音频文件。**只删这一个文件**，目录留到释放面：按次删目录会让并发投递里先完成的
 * 那一笔把另一笔正在播的文件一起收走（实测的失败形态是播放器报 42B 的「打不开」）。
 */
export function unstageToneAudio(path: string): void {
  systemDeps().unstageToneAudio(path);
}

/**
 * 释放音频临时目录（通道域的释放面）：组合根在卸载时调一次，端口侧在进程退出时也挂一次。
 * 幂等、**never-throw**——卸载链上一个出口失败不该拖垮其余释放动作。
 */
export function releaseSoundTemps(): void {
  systemDeps().releaseToneTemps();
}
