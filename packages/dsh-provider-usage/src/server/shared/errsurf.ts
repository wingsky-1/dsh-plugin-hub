/**
 * dsh-provider-usage — server/shared 错误面叶子（域2每层错误面的唯一物理定义）。
 *
 * S2 契约与共享层（#768 计划表 rev2 S2 行）：本文件是 errsurf 实现的 canonical 落点；
 * 旧过渡垫片 `src/domain2/common/errsurf.ts`（re-export）已于 #768 D13 随 common 目录消除。
 * 表达式与旧实现逐字一致（零行为变更，见 D13 基线对账）。
 *
 * 共享层准入论证（docs/ARCHITECTURE-METHOD.md §3 四级判据 + 本叶 Q5 尺子）：
 * - Q1（领域所有者）：无单一所有者——写入方分属 aggregate（压实/刷盘/归属异常）、
 *   schedule（tick 异常/提交失败）、execute（任务执行失败）三个域，读取方为
 *   ui-routes 的 /health per-layer 段。任一域独占它都会让另两域形成越权依赖，
 *   故不归任一域所有（METHOD §3 Q1 有主即止的反面：无主才共享）。
 * - Q2（消费合理）：三域各取所需最小面——写侧只调 record，读侧只调 snapshot；
 *   未把整表或诊断出口递给对方，无越权、无图方便、无绕过注入（共享设施按
 *   refactor skill §3 由实现块直接引用，不入注入面）。
 * - Q3（公共语言）：计数 + 最近 N 条环形缓冲 + 只读快照是稳定的层健康协议，
 *   不随任一域的业务模型漂移（与 registry.recordError 既有模式同构，补计数与环形语义）。
 * - Q4（零依赖 + ≥2 正当消费者）：本文件零 import；正当消费者 4 处——三域写
 *   （apply.ts 装配接线经各对象既有 warn 出口）+ 健康读（routes/ui.ts）。
 * - Q5（server/shared 叶子四性）：服务端内复用（apply 装配 + ui 健康读，客户端零引用，
 *   不进 src/shared 跨端面）；非跨端（宿主进程内存 Map，不打包进 client bundle）；
 *   进程期常驻（自进程挂载起累计计数，无落盘，重启即清零——与落盘态的 lastRun 对偶）；
 *   无单一所有者（见 Q1）。
 *
 * 接入策略不变：本模块不直接触碰业务代码；三层上报经装配层 apply.ts
 * 复用各对象既有 warn 诊断出口接线（组合根特权）：
 * - aggregate：TrendTracker 的 warn（压实失败/刷盘失败/归属异常汇聚于此）
 * - schedule：ReportScheduler 的 warn（tick 异常/提交失败）
 * - execute：ReportTaskQueue 的 warn（任务执行失败，消息已脱敏）
 * 若需在 aggregator 内部记账/rollup 出错点直连上报，可注入本模块
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
