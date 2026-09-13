/**
 * dsh-notifier channels 域 —— 自包含提示音的 WAV 合成（#783）。
 *
 * 为什么在运行时合成、不随包附音频资产：现状的声音依赖发行版的
 * `sound-theme-freedesktop`（实测无头宿主上该目录**不存在** ⇒ 一点声音都没有，而宿主明明
 * 有 ALSA 播放设备），随包附 wav 则会把音频二进制带进 git、且「音色」设置事实上退化成
 * 同一个声。合成只需要几十行 RIFF/PCM，零依赖。
 *
 * 音符序列不在这里：音色事实收在 `shared/interface.ts`，与客户端试听/自播共用同一段
 * `notes`——本文件只负责把它渲染成采样，否则「试听是什么音、宿主放出来是什么音」会再次分叉。
 */
import { TONES } from "../../../../shared/interface.ts";
import type { ToneNote } from "../../../../shared/interface.ts";

/** 采样率取 44.1 kHz：ALSA 与 SDL 的默认路径都原生支持，避免重采样引入的额外依赖。 */
const SAMPLE_RATE = 44100;
/** 位深与声道固定 16-bit 单声道：提示音不需要立体声，单声道体积减半。 */
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
/** 首尾淡入淡出时长：消除播放两端的咔嗒声。 */
const FADE_MS = 8;
/** 振幅取满量程的 45%：提示音不该是刺耳的最大音量（听感由宿主音量控制）。 */
const AMPLITUDE = 0.45;

/**
 * 合成指定音色的 WAV 字节。
 *
 * 未知音色返回 null（**不猜一个默认音顶替**，与 `toneFileCandidates` 的候选同口径）：
 * 静默比放错音更容易被发现，也更诚实。
 */
export function synthToneWav(tone: string): Buffer | null {
  // 跨边界值不受编译期约束：原型链键名（`constructor` / `__proto__` / `hasOwnProperty`）
  // 不是 TONES 的成员，`in` 与直接取值都会读到 Object.prototype 上的成员而非音色。
  if (!Object.hasOwn(TONES, tone)) return null;
  const notes = TONES[tone].notes;
  if (notes.length === 0) return null;
  return encodeWav(renderSamples(notes));
}

/**
 * 把音符序列渲染成 16-bit PCM 采样。
 *
 * 总长取最晚结束的音符：`at` 留下的间隙必须是**真静音**（保持 0），把音符首尾相接会让
 * 客户端听上去有停顿、宿主上却没有。
 *
 * 时间上重叠的音符按采样**相加**而不是后者覆盖：客户端的 Web Audio 是多个振荡器同时响，
 * 覆盖会让重叠区只剩后一个音，于是同一份 notes 在两端听出两种旋律。
 */
function renderSamples(notes: readonly ToneNote[]): Int16Array {
  const startOf = (note: ToneNote): number => Math.round(note.at * SAMPLE_RATE);
  const lengthOf = (note: ToneNote): number => Math.round(note.dur * SAMPLE_RATE);
  const total = notes.reduce((end, note) => Math.max(end, startOf(note) + lengthOf(note)), 0);
  const mix = new Float64Array(total);
  for (const note of notes) {
    const start = startOf(note);
    const span = lengthOf(note);
    const fade = Math.min(Math.round((FADE_MS / 1000) * SAMPLE_RATE), Math.floor(span / 2));
    for (let i = 0; i < span && start + i < total; i += 1) {
      const phase = (i * note.freq) / SAMPLE_RATE;
      const wave = note.type === "triangle" ? triangleAt(phase) : Math.sin(2 * Math.PI * phase);
      mix[start + i] += wave * fadeEnvelope(i, span, fade) * AMPLITUDE;
    }
  }
  const samples = new Int16Array(total);
  for (let i = 0; i < total; i += 1) samples[i] = Math.round(mix[i] * 0x7fff);
  return samples;
}

/** 三角波：与客户端 Web Audio 的 `triangle` 同形（相位 0 起于 0，1/4 周期到峰）。 */
function triangleAt(phase: number): number {
  const p = phase - Math.floor(phase);
  if (p < 0.25) return 4 * p;
  if (p < 0.75) return 2 - 4 * p;
  return 4 * p - 4;
}

/** 首尾线性淡入淡出；`fade = 0`（极短音符）时退化为恒定包络，避免除零。 */
function fadeEnvelope(index: number, count: number, fade: number): number {
  if (fade <= 0) return 1;
  if (index < fade) return index / fade;
  const tailStart = count - fade;
  if (index >= tailStart) return (count - index) / fade;
  return 1;
}

/**
 * 44 字节 RIFF/WAVE 头 + PCM 数据（单声道 16-bit，无扩展块）。
 *
 * 采样率不再作参数：它由本模块的常量决定，收成参数只是把「唯一取值」伪装成可配置，
 * 而多一条调用路径就多一处可以传错的地方。
 */
function encodeWav(samples: Int16Array): Buffer {
  const dataBytes = samples.length * (BITS_PER_SAMPLE / 8);
  const buffer = Buffer.alloc(44 + dataBytes);
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt 块长度：PCM 固定 16
  buffer.writeUInt16LE(1, 20); // 1 = PCM（未压缩）
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32); // 块对齐
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) buffer.writeInt16LE(samples[i], 44 + i * 2);
  return buffer;
}
