/**
 * dsh-notifier 客户端 —— 音频出口（解锁、自播、节流）。
 *
 * 这一份是**跨实例共享**的：AudioContext 与节流窗口若按实例各建一份，同一页面重复挂载后
 * 会出现两个上下文、两套节流，表现为同一帧响两次或该响的不响。故用 `const` 单例承载闭包状态
 * ——不是模块级 `let`（那会被 forbid-module-state-src 判红，而且表达不了「共享」这件事）。
 *
 * 时钟与构造器从端口进来，于是「未解锁 / 被挂起 / 被拒绝 / 不支持」四条分支都能在 node 里
 * 用假 AudioContext 跑出来——原先一条都测不到。
 */
import { FOLLOW_SYSTEM_TONE, TONES } from "../../shared/interface.ts";

/**
 * 音频面的原始事实（只有页面读得到；判定在 capabilities.ts）。
 *
 * 形状定义在**生产者**这一侧：本模块的 facts() 产出它，判定面（capabilities.ts 的 audioStateOf
 * 与 ClientFacts）只是消费它。反过来声明会让生产者 import 消费者，依赖方向反了——本文件里
 * 其它端口类型（AudioContextLike / AudioEngine）本来就是这么定义的。
 */
export interface AudioFacts {
  /** `window.AudioContext` 是否存在——只有它不存在才是「Web Audio 不可用」。 */
  supported: boolean;
  /** 当前 state；`null` = 尚未构造（用户还没点过页面）。 */
  state: "running" | "suspended" | "closed" | null;
  /** 是否曾成功跑到 `running`（已解锁的唯一凭据）。 */
  hasEverRun: boolean;
  /** 最近一次 `resume()` 是否被 reject（浏览器明确拒绝，而不是「还没轮到」）。 */
  resumeRejected: boolean;
}

/** 统一播放节流窗口（毫秒）：覆盖全部自播路径（通知音 + 只响不弹），试听不经本门。 */
export const PLAY_THROTTLE_MS = 1500;

/** 音频上下文的最小可判别面（真实 AudioContext 与测试替身都实现它）。 */
export interface AudioContextLike {
  state: string;
  currentTime: number;
  destination: unknown;
  createBuffer(channels: number, length: number, sampleRate: number): unknown;
  createBufferSource(): {
    buffer: unknown;
    connect(target: unknown): void;
    start(when: number): void;
  };
  createOscillator(): {
    type: string;
    frequency: { value: number };
    connect(target: unknown): void;
    start(when: number): void;
    stop(when: number): void;
  };
  createGain(): {
    gain: {
      setValueAtTime(value: number, when: number): void;
      exponentialRampToValueAtTime(value: number, when: number): void;
    };
    connect(target: unknown): void;
  };
  resume(): Promise<void> | void;
}

export interface AudioEnginePorts {
  /** 平台的 AudioContext 构造器（含老 Safari 的 webkit 前缀名）；没有即不支持 Web Audio。 */
  ctor(): (new () => AudioContextLike) | undefined;
  now(): number;
}

export interface AudioEngine {
  /** 必须在用户手势内调用：后台播放提示音需要已解锁的 AudioContext。 */
  unlock(): void;
  /** 自播节流门：同一窗口内只放行一次，防通知风暴叠播。 */
  gate(): boolean;
  playTone(tone: string | undefined): void;
  /** 试听：显式解锁 + 绕过统一节流（用户手势内直接试听不受限制）。 */
  playPreview(tone: string | undefined): void;
  facts(): AudioFacts;
}

interface AudioContextWithFacts extends AudioContextLike {
  state: string;
  /** 是否跑到过 running；生命周期与上下文实例严格相同。 */
  __dshRan?: boolean;
  /** resume() 是否被拒绝。 */
  __dshResumeRejected?: boolean;
}

export function createAudioEngine(ports: AudioEnginePorts): AudioEngine {
  let ctx: AudioContextWithFacts | null = null;
  let lastPlayAt = 0;

  function ensureContext(): AudioContextWithFacts | null {
    if (ctx !== null) return ctx;
    const Ctor = ports.ctor();
    if (Ctor === undefined) return null;
    ctx = new Ctor() as AudioContextWithFacts;
    return ctx;
  }

  function unlock(): void {
    try {
      const audio = ensureContext();
      if (audio === null) return;
      // 两个事实记在上下文实例上而不是模块里：它们的生命周期与那个上下文严格相同，
      // 单独开变量会让重建上下文后旧标记残留（自检面于是谎报「已解锁」）。
      if (audio.state === "suspended") {
        const resumed = audio.resume();
        if (resumed && typeof resumed.then === "function") {
          resumed.then(
            () => {
              audio.__dshRan = true;
            },
            () => {
              audio.__dshResumeRejected = true;
            },
          );
        }
      }
      if (audio.state === "running") audio.__dshRan = true;
      // 播一个空 buffer：这是让上下文真正进入 running 的手势内仪式
      const buffer = audio.createBuffer(1, 1, 22050);
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      source.start(0);
    } catch {
      // 音频不可用不阻塞通知
    }
  }

  function gate(): boolean {
    const now = ports.now();
    if (now - lastPlayAt < PLAY_THROTTLE_MS) return false;
    lastPlayAt = now;
    return true;
  }

  function playTone(tone: string | undefined): void {
    const audio = ctx;
    if (audio === null || audio.state !== "running") return;
    try {
      const start = audio.currentTime;
      const spec =
        tone !== undefined && Object.hasOwn(TONES, tone) ? TONES[tone] : TONES[FOLLOW_SYSTEM_TONE];
      for (const note of spec.notes) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = note.type || "sine";
        osc.frequency.value = note.freq;
        gain.gain.setValueAtTime(0.0001, start + note.at);
        gain.gain.exponentialRampToValueAtTime(0.18, start + note.at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.dur);
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.start(start + note.at);
        osc.stop(start + note.at + note.dur + 0.02);
      }
    } catch {
      // 播放失败忽略
    }
  }

  function playPreview(tone: string | undefined): void {
    unlock();
    playTone(tone);
  }

  function facts(): AudioFacts {
    const supported = ports.ctor() !== undefined;
    if (ctx === null) {
      return { supported, state: null, hasEverRun: false, resumeRejected: false };
    }
    return {
      supported,
      state: ctx.state as AudioFacts["state"],
      hasEverRun: ctx.__dshRan === true,
      resumeRejected: ctx.__dshResumeRejected === true,
    };
  }

  return { unlock, gate, playTone, playPreview, facts };
}
