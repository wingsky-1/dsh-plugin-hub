/** tools 域出口：注入面（纯类型，零运行时）。 */
import type {
  AutomationCap,
  AutomationLevel,
  ConfigV1,
  CustomPreset,
  DecisionLang,
  DecisionTier,
} from "../../shared/interface.ts";

/** 最小日志面。 */
export interface LoggerPort {
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
}

/** 密钥解析器（组合根用 config 域装配：ENV 优先）。 */
export interface KeyResolver {
  (): { readonly key: string | undefined; readonly source: "env" | "plaintext" | "none" };
}

/** 决议事件（tools 域的记录事实面；组合根映射为 HistoryEntry 再落盘，tools 不直引 history 域）。sessionId 由 decide 落史前校验（非法回落 unknown，随事件同行）。precheckHit 为本地密形命中旗（S1-A：命中即 snippet 强制全掩码）。questions 为调用题目快照（含候选项全列）。 */
export interface DecideEvent {
  readonly sessionId: string;
  readonly precheckHit: boolean;
  readonly presetId: string;
  readonly text: string;
  readonly lang: DecisionLang;
  readonly truncated: boolean;
  readonly originalLength: number;
  readonly resultKind: string;
  readonly questions: readonly ValidQuestion[];
  readonly choice?: string;
  readonly score?: number;
  readonly confidence: number;
  readonly tier: DecisionTier;
  readonly automation: AutomationLevel;
  readonly latencyMs: number;
  readonly errorCode?: string;
}

/** 事件记录器（组合根用 history 域装配；测试可注入内存实现）。 */
export interface EventRecorder {
  (event: DecideEvent): void;
}

/** fetch 注入缝（默认全局 fetch 适配；单测注入 mock，全程离线）。 */
export interface FetchImpl {
  (
    url: string,
    init: {
      readonly method: string;
      readonly headers: Record<string, string>;
      readonly body: string;
      readonly signal: AbortSignal;
    },
  ): Promise<{ readonly status: number; readonly text: string }>;
}

/** decide 运行所需注入（连接参数取自配置快照，调用方按需刷新）。 */
export interface DecideDeps {
  readonly logger: LoggerPort;
  readonly connection: ConfigV1["connection"];
  readonly isEnabled: (presetId: string) => boolean;
  readonly capOf: (presetId: string) => AutomationCap;
  readonly customPresets?: ReadonlyMap<string, CustomPreset>;
  readonly resolveKey: KeyResolver;
  readonly recordEvent?: EventRecorder;
  /** 并发门（组合根按 maxConcurrency 创建信号量后传入；缺席即直行）。 */
  readonly limit?: <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  readonly fetchImpl?: FetchImpl;
  readonly root: string;
  readonly sessionId: string;
  readonly now?: () => number;
  /** 调用方取消信号（ToolRunContext.signal 经 depsFor 透传）。 */
  readonly signal: AbortSignal;
}

/** 校验后问题（文本已做 255 长度校验，id 已做 ASCII 校验；score 可带 2-10 levels，缺省即默认五档）。 */
export interface ValidQuestion {
  readonly id: string;
  readonly text: string;
  readonly kind: "choice" | "score";
  readonly options?: readonly string[];
  readonly levels?: readonly string[];
}

/** 校验后决议输入。 */
export interface ValidDecide {
  readonly presetId: string;
  readonly text: string;
  readonly lang: DecisionLang;
  readonly questions: readonly ValidQuestion[];
  readonly appliedSource: "override" | "custom";
}
