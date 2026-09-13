/**
 * dsh-notifier channels 域 —— 自包含提示音的 WAV 合成（#783）。
 *
 * 为什么在运行时合成、不随包附音频资产：现状的声音依赖发行版的
 * `sound-theme-freedesktop`（实测无头宿主上该目录**不存在** ⇒ 一点声音都没有，而宿主明明
 * 有 ALSA 播放设备），随包附 wav 则会把音频二进制带进 git、且「音色」设置事实上退化成
 * 同一个声。合成只需要几十行 RIFF/PCM，零依赖。
 *
 * 为什么音色要分表、而不是所有音色合成都一个音：音色是用户可见的设置项，全合成同一个音
 * 等于把它变成摆设。表是**数据**（频率与时长的组合），本域不判断「用户能选哪些音色」。
 *
 * 波形取正弦 + 首尾短淡入淡出：方波/锯齿在扬声器上是可听见的爆音，而淡入淡出能消除
 * 播放起止两端的咔嗒声。
 */
import { LINUX_TONE_FILES } from "./tones.ts";

/** 采样率取 44.1 kHz：ALSA 与 SDL 的默认路径都原生支持，避免重采样引入的额外依赖。 */
const SAMPLE_RATE = 44100;
/** 位深与声道固定 16-bit 单声道：提示音不需要立体声，单声道体积减半。 */
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
/** 首尾淡入淡出时长：消除播放两端的咔嗒声。 */
const FADE_MS = 8;
/** 振幅取满量程的 45%：提示音不该是刺耳的最大音量（听感由宿主音量控制）。 */
const AMPLITUDE = 0.45;

/** 一段音：频率与时长（毫秒）。 */
export interface ToneSegment {
  readonly hz: number;
  readonly ms: number;
}

/**
 * 音色 → 音段序列（数据表）。
 *
 * 键与 tones.ts 的 LINUX_TONE_FILES 对齐：主题文件在位的宿主走主题文件（听感不变），
 * 缺主题文件的宿主用这里的合成音顶上，两侧音色键必须一一对应，否则会出现「某音色在
 * 有主题的宿主上能响、没主题的宿主上永远不响」。
 */
export const SYNTH_TONES: Readonly<Record<string, readonly ToneSegment[]>> = {
  default: [{ hz: 880, ms: 150 }],
  ding: [{ hz: 1175, ms: 130 }],
  bell: [
    { hz: 660, ms: 200 },
    { hz: 990, ms: 110 },
  ],
  chime: [
    { hz: 523, ms: 85 },
    { hz: 659, ms: 85 },
    { hz: 784, ms: 150 },
  ],
  pop: [{ hz: 440, ms: 60 }],
};

/** 本域能合成的音色键（供门禁/测试断言「合成表与主题表的键集一致」）。 */
export function synthToneNames(): readonly string[] {
  return Object.keys(SYNTH_TONES).sort();
}

/** 主题表里出现、但合成表没有的音色键（反向同理），供判据点名缺口。 */
export function synthToneGaps(): readonly string[] {
  const themed = new Set(["default", ...Object.keys(LINUX_TONE_FILES)]);
  const synth = new Set(synthToneNames());
  return [...themed].filter((t) => !synth.has(t)).sort();
}

/**
 * 合成指定音色的 WAV 字节。
 *
 * 未知音色返回 null（**不猜一个默认音顶替**，与 tones.ts 的 candidateNames 同口径）：
 * 静默比放错音更容易被发现，也更诚实。
 */
export function synthToneWav(tone: string): Buffer | null {
  const segments = SYNTH_TONES[tone];
  if (segments === undefined || segments.length === 0) return null;
  return encodeWav(renderSamples(segments), SAMPLE_RATE);
}

/** 把音段序列渲染成 16-bit PCM 采样（每段独立淡入淡出，段间不连续处因此不爆音）。 */
function renderSamples(segments: readonly ToneSegment[]): Int16Array {
  const total = segments.reduce((n, s) => n + Math.round((s.ms / 1000) * SAMPLE_RATE), 0);
  const samples = new Int16Array(total);
  let offset = 0;
  for (const segment of segments) {
    const count = Math.round((segment.ms / 1000) * SAMPLE_RATE);
    const fade = Math.min(Math.round((FADE_MS / 1000) * SAMPLE_RATE), Math.floor(count / 2));
    for (let i = 0; i < count; i += 1) {
      const envelope = fadeEnvelope(i, count, fade);
      const value = Math.sin((2 * Math.PI * segment.hz * i) / SAMPLE_RATE) * envelope * AMPLITUDE;
      samples[offset + i] = Math.round(value * 0x7fff);
    }
    offset += count;
  }
  return samples;
}

/** 首尾线性淡入淡出；`fade = 0`（极短音段）时退化为恒定包络，避免除零。 */
function fadeEnvelope(index: number, count: number, fade: number): number {
  if (fade <= 0) return 1;
  if (index < fade) return index / fade;
  const tailStart = count - fade;
  if (index >= tailStart) return (count - index) / fade;
  return 1;
}

/** 编码 44 字节 RIFF/WAVE 头 + PCM 数据（单声道 16-bit，无扩展块）。 */
function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * (BITS_PER_SAMPLE / 8);
  const buffer = Buffer.alloc(44 + dataBytes);
  const byteRate = sampleRate * CHANNELS * (BITS_PER_SAMPLE / 8);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt 块长度：PCM 固定 16
  buffer.writeUInt16LE(1, 20); // 1 = PCM（未压缩）
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32); // 块对齐
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) buffer.writeInt16LE(samples[i], 44 + i * 2);
  return buffer;
}
