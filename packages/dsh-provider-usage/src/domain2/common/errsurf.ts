/**
 * dsh-provider-usage — 域2每层错误面（阶段三 B，#670）。
 *
 * 背景：域2（trend/report）三层运行时错误原本只经 console.warn 诊断出口消散——
 * 无计数、无最近记录，/health 不可观测。本模块为「aggregate（趋势聚合/压实）、
 * schedule（报告调度）、execute（报告生成/执行）」三层提供统一的内存错误面：
 * 每层 = 累计计数 + 最近 N 条（时间戳/消息/上下文）。
 *
 * 形态对齐 registry.recordError 既有模式（内存 Map + snapshot 只读快照），但补上
 * 既有模式欠缺的两层语义：累计计数与最近 N 条环形缓冲——单 key 覆盖式 lastErrors
 * 只能回答「最近一次」，撑不起层健康观测。
 *
 * 接入策略（阶段三约束）：aggregator.ts 正被并行任务 A 拆分，本模块不直接触碰
 * src/trend/* 与 src/report/* 业务代码；三层上报经装配层 apply.ts 复用各对象既有
 * warn 诊断出口接线（组合根特权）：
 * - aggregate：TrendTracker 的 warn（压实失败/刷盘失败/归属异常汇聚于此）
 * - schedule：ReportScheduler 的 warn（tick 异常/提交失败）
 * - execute：ReportTaskQueue 的 warn（任务执行失败，消息已脱敏）
 * A 拆分完成后若需在 aggregator 内部记账/rollup 出错点直连上报，可注入本模块
 * 同形 record（空参 no-op 实现同签名，见 makeNoopLayerErrorSurface）。
 */
export type LayerErrorKey = "aggregate" | "schedule" | "execute";

/** 每层最近一条错误记录（时间戳/消息/上下文）。 */
export interface LayerErrorRecord {
  at: number;
  message: string;
  /** 层内定位（如聚合日键 / 报告周期与窗口键），可空。 */
  context?: string;
}

/** 单层错误面状态（health per-layer 段数据源）。 */
export interface LayerErrorState {
  /** 累计计数（自进程挂载起）。 */
  count: number;
  /** 最近 N 条（新在前；N = maxRecent）。 */
  recent: LayerErrorRecord[];
}

/** 域2每层错误面接口（record 为层代码可注入的上报入口）。 */
export interface LayerErrorSurface {
  record(layer: LayerErrorKey, message: string, context?: string): void;
  /** 只读快照（三键齐，未发生错误的层为 count 0 空队列）。 */
  snapshot(): Record<LayerErrorKey, LayerErrorState>;
}

export interface LayerErrorSurfaceOptions {
  /** 每层最近保留条数（默认 10）。 */
  maxRecent?: number;
  /** 注入时钟（测试用；默认 Date.now）。 */
  now?: () => number;
}

export const LAYER_ERROR_KEYS: readonly LayerErrorKey[] = ["aggregate", "schedule", "execute"];
export const LAYER_ERROR_MAX_RECENT_DEFAULT = 10;

export function makeLayerErrorSurface(opts: LayerErrorSurfaceOptions = {}): LayerErrorSurface {
  const maxRecent = opts.maxRecent ?? LAYER_ERROR_MAX_RECENT_DEFAULT;
  const now = opts.now ?? Date.now;
  const states = new Map<LayerErrorKey, LayerErrorState>(
    LAYER_ERROR_KEYS.map((layer) => [layer, { count: 0, recent: [] }]),
  );

  return {
    record(layer, message, context) {
      const state = states.get(layer);
      // 未知层忽略（防御：future 层枚举扩展时旧调用方不炸）
      if (state === undefined) return;
      state.count += 1;
      const entry: LayerErrorRecord = { at: now(), message };
      if (context !== undefined) entry.context = context;
      state.recent.unshift(entry);
      // 环形截断：Math.min 代替条件比较（语义 = 超限才裁，等价但无比较变异点）
      state.recent.length = Math.min(state.recent.length, maxRecent);
    },
    snapshot() {
      const out = {} as Record<LayerErrorKey, LayerErrorState>;
      for (const [layer, state] of states) {
        out[layer] = { count: state.count, recent: state.recent.map((r) => ({ ...r })) };
      }
      return out;
    },
  };
}

/** 空参数默认实现（供暂未接线/测试替身用；形态与真实 surface 一致）。 */
export function makeNoopLayerErrorSurface(): LayerErrorSurface {
  return {
    record() {},
    snapshot() {
      return {
        aggregate: { count: 0, recent: [] },
        schedule: { count: 0, recent: [] },
        execute: { count: 0, recent: [] },
      };
    },
  };
}