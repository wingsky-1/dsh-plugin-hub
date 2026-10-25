/**
 * dsh-notifier channels system synth — self-contained WAV generation when theme files are absent.
 *
 * WAV header facts, duration, dominant frequency, overlap, fade, and waveform shape are one
 * testable byte-level contract. The original describe title remains unchanged.
 */
import { describe, expect, it } from "vitest";

import { synthToneWav } from "../../../src/server/channels/impl/system/synth.ts";
import { TONES } from "../../../src/shared/interface.ts";
import { installSystemTestCleanup } from "./system-test-support.ts";

installSystemTestCleanup();

/** 极简 WAV 头解析：不引依赖，判据只认字节事实。 */
function parseWav(wav: Buffer) {
  return {
    riff: wav.toString("ascii", 0, 4),
    wave: wav.toString("ascii", 8, 12),
    fmtChunk: wav.toString("ascii", 12, 16),
    audioFormat: wav.readUInt16LE(20),
    channels: wav.readUInt16LE(22),
    sampleRate: wav.readUInt32LE(24),
    byteRate: wav.readUInt32LE(28),
    fmtSize: wav.readUInt32LE(16),
    blockAlign: wav.readUInt16LE(32),
    bitsPerSample: wav.readUInt16LE(34),
    dataChunk: wav.toString("ascii", 36, 40),
    dataBytes: wav.readUInt32LE(40),
    declared: wav.readUInt32LE(4),
    total: wav.length,
    samples: (() => {
      const out: number[] = [];
      for (let i = 44; i + 1 < wav.length; i += 2) out.push(wav.readInt16LE(i));
      return out;
    })(),
  };
}

const SAMPLE_RATE = 44100;
/** 8ms × 44.1kHz 与 0.45 × 0x7fff 的手写字面量：从实现里现算这两个数等于让实现自己
 *  判自己——改坏 AMPLITUDE / FADE_MS 都仍然绿（复核实测这两个变异体存活）。 */
const FADE_SAMPLES = 353;
const FULL_SCALE = 14745;
/** chime 重叠区（0.15s–0.3s）里两分量精确反相的样本下标：660Hz 音（起始 0）与 880Hz 音
 *  （起始 0.15s）在此处相位相反，正确实现相加后相消为 0；只把其中一个分量反相（或让后一
 *  个音覆盖前一个）时该点会升到满幅量级。 */
const OPPOSITE_PHASE_SAMPLE = 9135;

/**
 * 每个音色的手写事实：总时长、估计窗口与其中测得的主频、有声段数。**不从 TONES 现算**：
 * 期望值同源时改坏实现里任何一个数字都仍然绿（复核实测 M02/M05/M06 存活）。
 *
 * `segments` 是「被真静音隔开的连续有声段」：default 的第二音 at 恰等于第一音 dur，
 * 首尾相接故只有一段；只有 ding 的 at > dur 才留出可听见的间隙。
 */
const TONE_FACTS: Readonly<
  Record<
    string,
    {
      readonly totalMs: number;
      readonly leadMs: number;
      readonly leadHz: number;
      readonly segments: number;
    }
  >
> = {
  default: { totalMs: 380, leadMs: 160, leadHz: 880, segments: 1 },
  ding: { totalMs: 380, leadMs: 140, leadHz: 1318, segments: 2 },
  bell: { totalMs: 500, leadMs: 500, leadHz: 880, segments: 1 },
  chime: { totalMs: 800, leadMs: 150, leadHz: 660, segments: 1 },
  pop: { totalMs: 120, leadMs: 120, leadHz: 392, segments: 1 },
};

/** 零穿越估频：正弦/三角波每周期穿越两次；窗口取没有后续音符叠加的区间。 */
function dominantHz(samples: readonly number[], ms: number): number {
  const end = Math.round((ms / 1000) * SAMPLE_RATE);
  let crossings = 0;
  for (let i = 1; i < end; i += 1) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) {
      crossings += 1;
    }
  }
  return (crossings * SAMPLE_RATE) / (2 * end);
}

/**
 * 有声段数。静音要连续 `SILENCE_GAP` 个样本低于阈值才算断开：正弦每个半周期都会短暂
 * 低于阈值，不设最小静音长度会把每个半周期都算成一段（实测 880Hz 的 bell 会算成 96 段）。
 */
function soundSegments(samples: readonly number[]): number {
  const threshold = 100;
  const silenceGap = 50;
  let segments = 0;
  let quiet = silenceGap;
  for (const value of samples) {
    if (Math.abs(value) > threshold) {
      if (quiet >= silenceGap) segments += 1;
      quiet = 0;
    } else quiet += 1;
  }
  return segments;
}

/** 中段二阶差分的中位数：三角波分段线性（除峰值点外恒 0），正弦恒不为 0。 */
function medianAbsSecondDiff(samples: readonly number[]): number {
  const values: number[] = [];
  for (let i = FADE_SAMPLES; i < samples.length - FADE_SAMPLES; i += 1) {
    values.push(Math.abs(samples[i + 1] - 2 * samples[i] + samples[i - 1]));
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function samplesOf(tone: string): readonly number[] {
  return parseWav(synthToneWav(tone) as Buffer).samples;
}

function registerWavHeaderCase(): void {
  it("每个音色都产出参数自洽的 16-bit 单声道 WAV", () => {
    // 键集与手写事实表对齐：音色表多一个键或事实表漏一个音色，都必须红
    expect(Object.keys(TONES).sort()).toEqual(Object.keys(TONE_FACTS).sort());
    for (const tone of Object.keys(TONE_FACTS)) {
      const wav = synthToneWav(tone);
      expect(wav, `${tone} 应能合成`).not.toBeNull();
      const p = parseWav(wav as Buffer);
      expect(p.riff).toBe("RIFF");
      expect(p.wave).toBe("WAVE");
      expect(p.fmtChunk).toBe("fmt ");
      expect(p.audioFormat).toBe(1); // 1 = PCM 未压缩
      expect(p.channels).toBe(1);
      expect(p.sampleRate).toBe(SAMPLE_RATE);
      expect(p.bitsPerSample).toBe(16);
      expect(p.byteRate).toBe(p.sampleRate * 2);
      // fmt 块长度写成 0 时解码器不认这段头；块对齐写成 0/32 会按错步长读样本——
      // 两者都不会被 declared/dataBytes 那两条长度断言发现（aplay/ffplay 静默失败）
      expect(p.fmtSize).toBe(16);
      expect(p.blockAlign).toBe(2);
      expect(p.dataChunk).toBe("data");
      // 头里声明的长度必须与真实字节一致：长度字段写错时 aplay/ffplay 会当成截断文件
      expect(p.declared).toBe(p.total - 8);
      expect(p.dataBytes).toBe(p.total - 44);
    }
  });
}

function registerToneShapeCases(): void {
  it("段数、总时长与首音主频与手写字面量一致（改一个频率或时长就必须红）", () => {
    for (const [tone, fact] of Object.entries(TONE_FACTS)) {
      const samples = samplesOf(tone);
      expect(samples.length, `${tone} 总时长`).toBe(
        Math.round((fact.totalMs / 1000) * SAMPLE_RATE),
      );
      expect(soundSegments(samples), `${tone} 有声段数`).toBe(fact.segments);
      // 穿越计数取整带来约 ±3Hz 量化误差，容差 6Hz 仍能钉住「1318 改成 88」这类改错
      const measured = dominantHz(samples, fact.leadMs);
      expect(Math.abs(measured - fact.leadHz), `${tone} 首音主频（实测 ${measured}）`).toBeLessThan(
        6,
      );
    }
  });

  it("未知音色与原型链键名都返回 null —— 不拿默认音顶替", () => {
    // `constructor` / `__proto__` 这类键名在原型链上真实存在：`in` 或直接取值会拿到
    // Object.prototype 的成员，实测抛 `segments.reduce is not a function`
    for (const tone of ["nope", "", "constructor", "__proto__", "hasOwnProperty", "toString"]) {
      expect(synthToneWav(tone), tone).toBeNull();
    }
  });

  it("音符之间的 at 是真静音：ding 的两音之间 20ms 全为 0", () => {
    // 6174 = 0.14s、7056 = 0.16s（44.1kHz 下）：把 at 当摆设（首尾相接）时这段会被第二音
    // 填满；而「段边界回到 0」那种断言在正弦自相位 0 起时结构性恒真，发现不了这件事
    expect(
      samplesOf("ding")
        .slice(6174, 7056)
        .every((v) => v === 0),
    ).toBe(true);
  });
}

function registerOverlapAndEnvelopeCases(): void {
  it("时间上重叠的音符按采样相加：峰值高于单音区，且反相样本相消", () => {
    // 客户端 Web Audio 是多个振荡器同时响；服务端若让后一个音覆盖前一个，同一份 notes
    // 会在两端听出两种旋律
    const samples = samplesOf("chime");
    const single = Math.max(...samples.slice(0, 6615).map((v) => Math.abs(v)));
    const overlap = Math.max(...samples.slice(6615, 13230).map((v) => Math.abs(v)));
    expect(single).toBeGreaterThan(FULL_SCALE * 0.9);
    expect(overlap).toBeGreaterThan(single * 1.5);
    // 上面那条峰值判据对「相加」与「相减」同时成立（相消干涉的峰值同样接近两倍单音），
    // 反相点才分得开：9135 由两分量正弦的离线公式求得（不调用被测实现），660Hz 音（起始 0）
    // 与 880Hz 音（起始 0.15s）在该下标处精确反相，只把其中一个分量反相就会变成约
    // 2×0.975×满幅（实测：这条判据单独红的形态）。
    //
    // 登记（等价变异体，不可杀，勿再为它加断言）：synth.ts 的 `mix[start + i] += …` 被
    // Stryker 换成一元的 `-=` 时**不是缺陷**——写入点只有一处且初值为 0，实测两者产出的
    // 样本序列逐样本精确相反（5 个音色全部 a[i]+b[i]==0），即整段波形反相 180°：听觉不变，
    // 幅度类/零穿越类判据都不变，两分量之间的相对相位也没变（相消点仍是 0）。
    const opposite = Math.abs(samples[OPPOSITE_PHASE_SAMPLE] ?? Number.NaN);
    expect(opposite, `K=${OPPOSITE_PHASE_SAMPLE} 应相消`).toBeLessThan(FULL_SCALE * 0.2);
  });

  it("首尾淡入淡出：样本上界由线性包络决定，而不是「首样本为 0」这种恒真断言", () => {
    // 正弦自相位 0 起，首样本必为 0；淡出的末样本也必为 0。真正的判据是包络把首尾压在
    // 线性斜坡之下：去掉淡入淡出后第 63 个样本就能接近满幅
    for (const tone of ["pop", "ding", "bell"]) {
      const samples = samplesOf(tone);
      for (let i = 1; i < 64; i += 1) {
        const head = samples[i] ?? Number.NaN;
        expect(Math.abs(head), `${tone} 淡入 i=${i}`).toBeLessThanOrEqual(
          FULL_SCALE * (i / FADE_SAMPLES) + 1,
        );
        const tail = samples[samples.length - 1 - i] ?? Number.NaN;
        expect(Math.abs(tail), `${tone} 淡出 i=${i}`).toBeLessThanOrEqual(
          FULL_SCALE * ((i + 1) / FADE_SAMPLES) + 1,
        );
      }
    }
  });

  it("pop 是三角波而不是正弦：中段二阶差分中位数为 0（正弦恒不为 0）", () => {
    // 三角波在峰值之间严格线性，二阶差分只剩量化噪声；正弦的二阶差分与其自身成比例
    // （约 46×|sin|），中位数在 30 上下。把 type 改回缺省的正弦后这条必须红
    expect(medianAbsSecondDiff(samplesOf("pop"))).toBeLessThanOrEqual(2);
  });
}

describe("synth.ts：主题文件缺失时的自包含合成音（#783）", () => {
  registerWavHeaderCase();
  registerToneShapeCases();
  registerOverlapAndEnvelopeCases();
});
