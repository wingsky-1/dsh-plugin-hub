/**
 * dsh-provider-usage/trend — 内存聚合（#503 M1）。
 *
 * 两级聚合（方案定稿）：
 * - cells：day×provider(×model) 桶，apply 时实时累加（含未压实的历史日）；
 * - pending：当日 per-step 明细/计数行（未压实窗口），支撑今日按小时/按会话细分
 *   与日切压实的落盘素材；日切时压实为 day×provider(×model) 聚合行并丢弃明细。
 *
 * 双算防线：明细/计数行在 apply 时已进 cells，压实只做「落盘形态转换」
 * （明细行 → 聚合行），绝不再次累加 cells；重启重建时聚合行与当日明细行
 * 二选一来源（agg 分片存在即权威，见 store 约定），同样不双算。
 *
 * null 语义：桶内 token 求和 null-aware（无任何有效数字保持 null）；
 * 调用/轮次/工具计数独立累加，与 token 有无无关。
 */
import { dayKey, lastNDayKeys } from "../charts.ts";
import {
  sumToken,
  TREND_ROW_VERSION,
  TREND_UNIDENTIFIED,
  type TrendAggRow,
  type TrendCell,
  type TrendCounterRow,
  type TrendDetailRow,
  type TrendDirRow,
  type TrendTokens,
} from "./types.ts";
import type { TrendCallRecord, TrendCorrectRecord, TrendCounterRecord, TrendEmit } from "./collector.ts";

/** 聚合指标（序列查询的取值维度；total = 四项 token 之和）。 */
export type TrendMetric = "total" | "input" | "output" | "cacheRead" | "cacheWrite" | "calls";

/** 序列粒度。 */
export type TrendGranularity = "day" | "week" | "month";

/** 堆叠柱单段（一个 provider 或 provider+model 组合在一个时间桶内的取值）。 */
export interface TrendStackPart {
  provider: string;
  model: string | null;
  value: number | null;
}

/** 堆叠柱单根（一个时间桶）。 */
export interface TrendStackPoint {
  /** 桶键：day=YYYY-MM-DD / week=周首日 / month=YYYY-MM。 */
  key: string;
  parts: TrendStackPart[];
  /** 各段之和（null-aware；空桶 null）。 */
  total: number | null;
}

/** 窗口摘要（趋势页汇总卡数据源）。 */
export interface TrendWindowSummary {
  /** 当前窗口指标总量。 */
  total: number | null;
  calls: number;
  turns: number;
  toolCalls: number;
  /** 峰值桶键（total 最大的时间桶；无数据 null）。 */
  peakKey: string | null;
  /** 取值最大的适配器段。 */
  top: { provider: string; model: string | null; value: number } | null;
  /** 上一同等窗口指标总量（环比基准；无数据 null）。 */
  prevTotal: number | null;
  /** 上一窗口数据是否完整（起点早于数据起点 = false；false 时环比不可比，#503 M2.1）。 */
  prevComplete: boolean;
}

/** 未压实行（内存持有；flush 时持久化，压实后移除）。 */
export interface PendingEntry {
  row: TrendDetailRow | TrendCounterRow;
  /** 已 append 到当日分片（重启重建的行也为 true，防二次落盘）。 */
  persisted: boolean;
}

/** 单元格空壳。 */
function emptyCell(): TrendCell {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, calls: 0, turns: 0, toolCalls: 0 };
}

export class TrendAggregator {
  /** day → provider → model(null 允许) → cell。 */
  private days = new Map<string, Map<string, Map<string | null, TrendCell>>>();
  /**
   * #633 A3：day → dir → cell（目录维度日汇总内存态）。
   * 生命周期与 days 同步（复核 P1-1 统一口径）：apply 实时累加 → rebuild 的
   * dir 汇总行与明细/计数行（有 dir 键者）双向读回 → 压实消费不删（与
   * cells 同策略，跨天后目录查询面历史柱不失——dirRows 纯内存无分片回读）
   * → prune 同步收缩（pruneDays 联动删除）。
   * 权威口径（复核 P1-1）：dirDays 是目录维度的唯一事实源——apply 平行累加 +
   * rebuild 双分支读回已覆盖全部 dir 事实，dirRows() 只做快照不再折算 pending
   * （单源无重无漏：同事实并存时折算会 2×，互补事实并存时按键去重会丢）。
   */
  private dirDays = new Map<string, Map<string, TrendCell>>();
  /** 未压实明细/计数行（跨日可能：时钟回拨把旧日事件记进对应日分片）。 */
  private pending: PendingEntry[] = [];

  // ---------------------------------------------------------------- 实时记账

  /** 应用一条定稿记录（collector emit 出口）。 */
  apply(e: TrendEmit): void {
    switch (e.type) {
      case "call":
        this.applyCall(e.record);
        return;
      case "correct":
        this.applyCorrect(e.record);
        return;
      case "counter":
        this.applyCounter(e.record);
        return;
    }
  }

  /** call 量累加进 cell（applyCall / rebuild 明细行共用，cells 与 dirCells 同构复用）。 */
  private addCall(cell: TrendCell, tokens: TrendTokens | null): void {
    cell.calls += 1;
    if (tokens !== null) {
      cell.input = sumToken(cell.input, tokens.input);
      cell.output = sumToken(cell.output, tokens.output);
      cell.cacheRead = sumToken(cell.cacheRead, tokens.cacheRead);
      cell.cacheWrite = sumToken(cell.cacheWrite, tokens.cacheWrite);
    }
  }

  private applyCall(r: TrendCallRecord): void {
    const day = dayKey(r.time);
    this.addCall(this.cellOf(day, r.provider, r.model), r.tokens);
    this.addCall(this.dirCellOf(day, r.dir), r.tokens); // #633 A3：目录维度平行累加（同 record 不二次 emit）
    const row: TrendDetailRow = {
      v: TREND_ROW_VERSION,
      kind: "detail",
      time: r.time,
      day,
      session: r.session,
      turn: r.turn,
      step: r.step,
      retry: r.retry,
      provider: r.provider,
      model: r.model,
      dir: r.dir, // #633 A1：目录归属落盘（collector.dirOf 已保证 sanitize 后 basename 或未识别桶，不重复净化）
      input: r.tokens?.input ?? null,
      output: r.tokens?.output ?? null,
      cacheRead: r.tokens?.cacheRead ?? null,
      cacheWrite: r.tokens?.cacheWrite ?? null,
      calls: 1,
      ...(r.interrupted === true ? { interrupted: true as const } : {}),
    };
    this.pending.push({ row, persisted: false });
  }

  /** 校正：覆盖未压实窗口内同 fold 键最后一条明细的 token（已压实的不追溯）。 */
  private applyCorrect(r: TrendCorrectRecord): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const { row } = this.pending[i];
      if (
        row.kind === "detail" &&
        row.session === r.session &&
        row.turn === r.turn &&
        row.step === r.step &&
        row.retry === r.retry
      ) {
        this.retokenCell(row, r.tokens); // 先回退旧值再累加新值（cell 增量一致）
        row.input = r.tokens.input;
        row.output = r.tokens.output;
        row.cacheRead = r.tokens.cacheRead;
        row.cacheWrite = r.tokens.cacheWrite;
        return;
      }
    }
    /* 未找到（已压实/重启后迟到）：校正窗口已关闭，按口径不追溯 */
  }

  /**
   * 明细行 token 变更的 cell 增量修正。
   * 复核 P1-1：cells 与 dirDays 双面同步修正——dirDays 单源化后（dirRows 只读
   * 快照、不再折算 pending），applyCorrect 的行值变更必须同步回目录桶，否则
   * 目录查询面与 cells/落盘行漂移（修正前折算侧取 pending 行新值掩盖了漂移，
   * 单源化后漂移会固化）。两桶增量一致（同 sub 差值），null-aware。
   */
  private retokenCell(row: TrendDetailRow, next: TrendTokens): void {
    const deltas: TrendTokens = {
      input: sub(row.input, next.input),
      output: sub(row.output, next.output),
      cacheRead: sub(row.cacheRead, next.cacheRead),
      cacheWrite: sub(row.cacheWrite, next.cacheWrite),
    };
    const cell = this.cellOf(row.day, row.provider, row.model);
    cell.input = sumToken(cell.input, deltas.input);
    cell.output = sumToken(cell.output, deltas.output);
    cell.cacheRead = sumToken(cell.cacheRead, deltas.cacheRead);
    cell.cacheWrite = sumToken(cell.cacheWrite, deltas.cacheWrite);
    if (row.dir !== undefined) {
      const dirCell = this.dirCellOf(row.day, row.dir);
      dirCell.input = sumToken(dirCell.input, deltas.input);
      dirCell.output = sumToken(dirCell.output, deltas.output);
      dirCell.cacheRead = sumToken(dirCell.cacheRead, deltas.cacheRead);
      dirCell.cacheWrite = sumToken(dirCell.cacheWrite, deltas.cacheWrite);
    }
  }

  /** counter 量累加进 cell（applyCounter / rebuild 计数行共用）。 */
  private addCounter(cell: TrendCell, turns: number, toolCalls: number): void {
    cell.turns += turns;
    cell.toolCalls += toolCalls;
  }

  private applyCounter(r: TrendCounterRecord): void {
    const day = dayKey(r.time);
    this.addCounter(this.cellOf(day, r.provider, r.model), r.turns, r.toolCalls);
    this.addCounter(this.dirCellOf(day, r.dir), r.turns, r.toolCalls); // #633 A3：目录维度平行累加
    const row: TrendCounterRow = {
      v: TREND_ROW_VERSION,
      kind: "counter",
      time: r.time,
      day,
      session: r.session,
      provider: r.provider,
      model: r.model,
      dir: r.dir, // #633 A1：目录归属落盘（同 detail 行约定）
      turns: r.turns,
      toolCalls: r.toolCalls,
    };
    this.pending.push({ row, persisted: false });
  }

  // ---------------------------------------------------------------- 重建（重启载入）

  /**
   * 重启重建：重放分片行进内存（cells 更新 + 未压实行登记）。
   * @param rows 校验过的分片行（agg 权威行 + 当日明细/计数行）
   * @param persistedRows 这些行是否已落盘（agg 行无意义；明细/计数行来自分片 = true）
   */
  rebuild(rows: Array<TrendAggRow | TrendDetailRow | TrendCounterRow | TrendDirRow>, persistedRows: boolean): void {
    for (const row of rows) {
      if (row.kind === "agg") {
        const cell = this.cellOf(row.day, row.provider, row.model);
        mergeCell(cell, row);
        continue;
      }
      // #633 A3：dir 汇总行重建 → 只进目录维度桶（cells 累加只发生在事件路径与
      // detail/counter 行重建，防双重计数）
      if (row.kind === "dir") {
        mergeCell(this.dirCellOf(row.day, row.dir), row);
        continue;
      }
      if (row.kind === "detail") {
        this.addCall(this.cellOf(row.day, row.provider, row.model), {
          input: row.input,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
        });
        // 复核 P1-1：明细行 rebuild 双面入账（与 cells 同策略）——dirDays 是目录
        // 维度唯一事实源（dirRows 纯快照不折算 pending），重建明细行的 dir 事实
        // 必须在此落桶，否则重启后目录查询面丢「分片明细形态存在、dirDays 缺失」
        // 的事实（自愈/当日重建两条路径同病；实测 Day0 input 10 → 7）。
        if (row.dir !== undefined) {
          this.addCall(this.dirCellOf(row.day, row.dir), {
            input: row.input,
            output: row.output,
            cacheRead: row.cacheRead,
            cacheWrite: row.cacheWrite,
          });
        }
      } else {
        this.addCounter(this.cellOf(row.day, row.provider, row.model), row.turns, row.toolCalls);
        // 复核 P1-1：计数行 rebuild 同上（turns/toolCalls 平行落 dir 桶）。
        if (row.dir !== undefined) {
          this.addCounter(this.dirCellOf(row.day, row.dir), row.turns, row.toolCalls);
        }
      }
      this.pending.push({ row, persisted: persistedRows });
    }
  }

  // ---------------------------------------------------------------- 压实（日切）

  /** 存在未持久化行的日 key（升序去重）。 */
  unpersistedDays(): string[] {
    const days = new Set<string>();
    for (const p of this.pending) {
      if (!p.persisted) days.add(p.row.day);
    }
    return [...days].sort();
  }

  /** pending 全部日 key（升序去重；压实遍历用）。 */
  pendingDays(): string[] {
    const days = new Set<string>();
    for (const p of this.pending) days.add(p.row.day);
    return [...days].sort();
  }

  /** 给定日是否存在未持久化的行（压实前置条件：该日必须已全部落盘）。 */
  hasUnpersisted(day: string): boolean {
    return this.pending.some((p) => p.row.day === day && !p.persisted);
  }

  /**
   * 取走全部未持久化行（对象引用快照；await 间隙新到的行是独立对象，不受影响）。
   * 行本身保留在 pending（cells 已计入；压实前一直是今日细分查询与压实的素材）。
   */
  takeUnpersisted(): PendingEntry[] {
    return this.pending.filter((p) => !p.persisted);
  }

  /** 精确标记快照条目已持久化（append 成功后调用；只翻转快照内的对象）。 */
  markPersisted(entries: PendingEntry[]): void {
    for (const p of entries) p.persisted = true;
  }

  /**
   * 全量目录日桶快照（day 升序；#633 分片 b 报告快照与统计目录分布数据源）。
   *
   * 权威口径（复核 P1-1）：dirDays 单源快照——apply 平行累加 + rebuild 双分支读回
   * 已覆盖全部 dir 事实，不再折算 pending 行（旧折算侧与 dirDays 并存时双算：
   * 同事实重建 → 2×；互补事实 → 按键去重丢数；实测同日重启续 apply input 17 → 7）。
   *
   * 残差投影（本次修复，取代「重建时补造」）：目录面 = dirDays 快照 + 每日残差。
   * 残差(day) = 该日聚合面（cells，全量事实）− 该日 dirDays 合计（有目录归属的事实），
   * 非零则投影为一条 `{day, dir: TREND_UNIDENTIFIED}` 行——语义即「该日无目录信息的
   * 数据」。这样两个查询面的日总量恒等（目录面 = 聚合面），且**不会双算**：
   *
   * - 旧分片（#633 之前的 agg 行，无 kind:"dir" 行）：cells 有值、dirDays 空 → 残差
   *   = 全量 → 历史柱恢复且不丢数（此前 dir 面历史全 null，实测差 20 倍）；
   * - 新分片（agg + dir 并存，同一批事实的两个投影）：cells 含 agg 行、dirDays 含 dir 行
   *   → 残差 ≈ 0（同一事实相减相消）→ 不补造、不双算；故**禁止**在 rebuild 里对
   *   agg 行补造未识别桶（会与 dir 行双算，反例：9-05 的 rjk2 calls=22 会变 44）；
   * - 混版日（升级当天：旧 agg 行 + 新 dir 行并存）：残差 = 旧 agg 部分 → 归未识别，
   *   新 dir 行照常分目录，既不丢升级前的历史、也不把新数据算进未识别；
   * - 当日未压实：apply 对 cells 与 dirDays 平行累加 → 残差 ≈ 0。
   *
   * 不变量：∀day 目录面日合计 == 聚合面日合计（残差为负即数据不一致——目录行多于聚合行，
   * 属双算/漂移征兆，投影按 0 处理并保持数值可解释，不产生负柱）。
   * 残留边界（文档化口径）：残差只有日粒度（dirDays 无 provider 维度），故「无目录信息的
   * 数据」只能整体归未识别桶，无法细分到 provider/model——目录面与 provider 面本互斥
   * （见 routes/ui.ts 的 dir/byDir 分流），无消费方需要该交叉维度。
   */
  dirRows(): TrendDirRow[] {
    const out: TrendDirRow[] = [];
    for (const day of [...this.dirDays.keys()].sort()) {
      for (const [dir, cell] of this.dirDays.get(day)!) {
        out.push({ v: TREND_ROW_VERSION, kind: "dir", day, dir, input: cell.input, output: cell.output, cacheRead: cell.cacheRead, cacheWrite: cell.cacheWrite, calls: cell.calls, turns: cell.turns, toolCalls: cell.toolCalls });
      }
    }
    // 每日残差：聚合面（cells）− 目录面（dirDays）。cells 的键是 day → provider →
    // model，逐层求和得该日全量；dirDays 的键是 day → dir，同法求该日目录合计。
    const aggByDay = new Map<string, TrendCell>();
    for (const [day, providers] of this.days) {
      let cell = aggByDay.get(day);
      if (cell === undefined) {
        cell = emptyCell();
        aggByDay.set(day, cell);
      }
      for (const models of providers.values()) {
        for (const c of models.values()) {
          cell.input = sumToken(cell.input, c.input);
          cell.output = sumToken(cell.output, c.output);
          cell.cacheRead = sumToken(cell.cacheRead, c.cacheRead);
          cell.cacheWrite = sumToken(cell.cacheWrite, c.cacheWrite);
          cell.calls += c.calls;
          cell.turns += c.turns;
          cell.toolCalls += c.toolCalls;
        }
      }
    }
    for (const [day, cell] of aggByDay) {
      let dirInput: number | null = null;
      let dirOutput: number | null = null;
      let dirCacheRead: number | null = null;
      let dirCacheWrite: number | null = null;
      let dirCalls = 0;
      let dirTurns = 0;
      let dirToolCalls = 0;
      const dirs = this.dirDays.get(day);
      if (dirs !== undefined) {
        for (const c of dirs.values()) {
          dirInput = sumToken(dirInput, c.input);
          dirOutput = sumToken(dirOutput, c.output);
          dirCacheRead = sumToken(dirCacheRead, c.cacheRead);
          dirCacheWrite = sumToken(dirCacheWrite, c.cacheWrite);
          dirCalls += c.calls;
          dirTurns += c.turns;
          dirToolCalls += c.toolCalls;
        }
      }
      // 残差 = 聚合面 − 目录面（null-aware：双方皆 null → 0/无残差；单侧 null 按 0 计）
      const input = diffToken(cell.input, dirInput);
      const output = diffToken(cell.output, dirOutput);
      const cacheRead = diffToken(cell.cacheRead, dirCacheRead);
      const cacheWrite = diffToken(cell.cacheWrite, dirCacheWrite);
      const calls = cell.calls - dirCalls;
      const turns = cell.turns - dirTurns;
      const toolCalls = cell.toolCalls - dirToolCalls;
      // 全部为 0/空 = 该日目录面已覆盖全量（新分片常态）→ 不补造行
      const hasResidual =
        calls > 0 || turns > 0 || toolCalls > 0 || (input ?? 0) > 0 || (output ?? 0) > 0 || (cacheRead ?? 0) > 0 || (cacheWrite ?? 0) > 0;
      if (!hasResidual) continue;
      out.push({
        v: TREND_ROW_VERSION,
        kind: "dir",
        day,
        dir: TREND_UNIDENTIFIED,
        // 负值（目录面多于聚合面）按 0 处理：保持数值可解释，不产生负柱（不一致属数据
        // 异常，由「日总量恒等」断言在测试面暴露，不在生产路径抛错连坐查询）。
        input: input !== null && input > 0 ? input : null,
        output: output !== null && output > 0 ? output : null,
        cacheRead: cacheRead !== null && cacheRead > 0 ? cacheRead : null,
        cacheWrite: cacheWrite !== null && cacheWrite > 0 ? cacheWrite : null,
        calls: calls > 0 ? calls : 0,
        turns: turns > 0 ? turns : 0,
        toolCalls: toolCalls > 0 ? toolCalls : 0,
      });
    }
    // 顺序契约：**不重排**——dirDays 分支已按 day 升序、day 内按 dir 键插入序输出，
    // 残差行按 day 升序追加在尾段。曾试过全局 sort(day, dir)，但它会把残差行的
    // 未识别键排到该日首位（"(" 的字典序最前），进而改变 dirTotals 的插入序；
    // dirTotals 用稳定排序（同 calls 保持插入序），下游「候选 calls 降序」断言
    // 因此被打破。行序是查询面契约的一部分（dirStacked 的图例并集、报告快照顺序），
    // 保持现有顺序 = 对既有行为零扰动。
    return out;
  }

  /**
   * 堆叠柱序列（目录维度；#633 分片 b B1 数据接口）。语义与 seriesStacked 同构：
   * 每时间桶按目录拆段；dirs 为图例并集（窗口内出现过的目录段，含未识别桶）。
   * dir 过滤可选（单目录形态——未识别桶键同为合法过滤值）。
   */
  dirStacked(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    dir: string | undefined,
    now: number,
  ): { series: TrendStackPoint[]; dirs: Array<{ dir: string }> } {
    const keys = this.granKeys(n, gran, now);
    const ranges = new Map(keys.map((k) => [k, this.granRange(k, gran)] as const));
    // 复核 P1-3：行快照提出桶循环（原实现每桶 this.dirRows() 全量快照，O(桶×行)
    // 单请求重复；对齐 seriesStacked 的 P1-2 先例——range 一次算全 + 快照单次
    // 取用，桶循环内只做窗口过滤消费）。
    const rows = this.dirRows();
    const series: TrendStackPoint[] = keys.map((key) => {
      const partsMap = new Map<string, TrendStackPart>();
      const range = ranges.get(key)!;
      for (const row of rows) {
        if (row.day < range.start || row.day > range.end) continue;
        if (dir !== undefined && row.dir !== dir) continue;
        const v = metricValue(row, metric);
        const cur = partsMap.get(row.dir);
        if (cur !== undefined) cur.value = sumToken(cur.value, v);
        else partsMap.set(row.dir, { provider: row.dir, model: null, value: v });
      }
      const parts = [...partsMap.values()];
      let total: number | null = null;
      for (const pt of parts) total = sumToken(total, pt.value);
      return { key, parts, total };
    });
    const legend = new Set<string>();
    for (const point of series) {
      for (const pt of point.parts) legend.add(pt.provider);
    }
    return { series, dirs: [...legend].sort().map((d) => ({ dir: d })) };
  }

  /**
   * 窗口摘要（目录维度；#633 分片 b B1 数据接口）。curRange/prevRange 语义与
   * windowSummary 完全同构：当前窗口总量/调用数/峰值桶/目录 top 段 + 上一窗口环比。
   * prevComplete 语义对齐：prev 窗口起点早于目录数据起点（dirRows 最早日）→ 不可比。
   */
  dirWindowSummary(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    dir: string | undefined,
    now: number,
    dirSeries?: TrendStackPoint[],
  ): TrendWindowSummary {
    const keys = this.granKeys(n, gran, now);
    const curRange = {
      start: this.granRange(keys[0], gran).start,
      end: this.granRange(keys[keys.length - 1], gran).end,
    };
    const prevKeys = this.granKeys(n, gran, this.prevWindowAnchor(now, n, gran));
    const prevRange = {
      start: this.granRange(prevKeys[0], gran).start,
      end: this.granRange(prevKeys[prevKeys.length - 1], gran).end,
    };
    let total: number | null = null;
    let calls = 0;
    let turns = 0;
    let toolCalls = 0;
    let prevTotal: number | null = null;
    let peakKey: string | null = null;
    let peakVal = -1;
    let top: { provider: string; model: string | null; value: number } | null = null;
    const series = dirSeries ?? this.dirStacked(n, gran, metric, dir, now).series;
    for (const point of series) {
      if (point.total !== null && point.total > peakVal) {
        peakVal = point.total;
        peakKey = point.key;
      }
      for (const pt of point.parts) {
        if (pt.value !== null && (top === null || pt.value > top.value)) {
          top = { provider: pt.provider, model: pt.model, value: pt.value };
        }
      }
    }
    const rows = this.dirRows();
    let firstDirDay: string | null = null;
    // 复核 P1-3：单遍遍历（原实现 3 次全量遍历 rows——最早日 + 当前窗口 + 上一
    // 窗口各一遍；窗口区间互斥，同遍累加语义不变）。
    for (const row of rows) {
      if (firstDirDay === null || row.day < firstDirDay) firstDirDay = row.day;
      const inDir = dir === undefined || row.dir === dir;
      if (inDir && row.day >= curRange.start && row.day <= curRange.end) {
        total = sumToken(total, metricValue(row, metric));
        calls += row.calls;
        turns += row.turns;
        toolCalls += row.toolCalls;
      }
      if (inDir && row.day >= prevRange.start && row.day <= prevRange.end) {
        prevTotal = sumToken(prevTotal, metricValue(row, metric));
      }
    }
    return {
      total,
      calls,
      turns,
      toolCalls,
      peakKey,
      top,
      prevTotal,
      // 与 windowSummary.prevComplete 同口径：prev 窗口起点早于目录数据起点 → 环比不可比
      prevComplete: prevRange.start >= (firstDirDay ?? "9999-12-31"),
    };
  }

  /**
   * 目录窗口总量表（#633 分片 b B4 目录范围口径影响 + B1 目录分布数据源）：
   * 给定日区间内按目录聚合 calls 与 metric 总量（calls 降序）。
   */
  dirTotals(
    startDay: string,
    endDay: string,
    metric: TrendMetric = "total",
  ): Array<{ dir: string; calls: number; total: number | null }> {
    const byDir = new Map<string, { dir: string; calls: number; total: number | null }>();
    for (const row of this.dirRows()) {
      if (row.day < startDay || row.day > endDay) continue;
      let cur = byDir.get(row.dir);
      if (cur === undefined) {
        cur = { dir: row.dir, calls: 0, total: null };
        byDir.set(row.dir, cur);
      }
      cur.calls += row.calls;
      cur.total = sumToken(cur.total, metricValue(row, metric));
    }
    return [...byDir.values()].sort((a, b) => b.calls - a.calls);
  }

  /**
   * 给定日的目录维度折算行（读侧投影；#633 A4）。
   * 实现委托 {@link rollupSnapshot}——与压实路径共用同一份折算逻辑，保证「读侧
   * 看到的行」与「压实写入的行」永远同源（单一事实源，防两套实现漂移）。
   */
  takeDirUnpersisted(day: string): TrendDirRow[] {
    return this.rollupSnapshot(day).dirRows;
  }

  /**
   * 压实快照（#654）：一次遍历同时产出「该日 pending 行的身份快照」与「同源折算的
   * agg / dir 行」。
   *
   * 为什么必须同源：压实是「折算 → 落盘 → 消费」三段式，中间隔着若干 await。若消费
   * 时按日键重新查询（旧 dropPending(day) 的实现），await 期间新到达的同日行既没被
   * 折算、也没落盘，却会被连带删除（永久丢行 + 内存/磁盘漂移）。这里返回的 consumed
   * 与 aggRows/dirRows 出自同一批行，调用方持久化成功后只消费 consumed——新到达的行
   * 留待下一轮压实。
   *
   * 折算口径与 #633 A4 一致：dir 键缺失的行只进 agg 行（目录维度为加性可选键，
   * 缺键 = 无 dir 事实可折叠，不在折算侧补造）。cells/dirDays 不动（apply 时已累加，
   * 压实只做落盘形态转换，绝不二次累加）。
   */
  rollupSnapshot(day: string): { consumed: PendingEntry[]; aggRows: TrendAggRow[]; dirRows: TrendDirRow[] } {
    const consumed: PendingEntry[] = [];
    const aggByKey = new Map<string, TrendAggRow>();
    const dirByKey = new Map<string, TrendDirRow>();
    for (const p of this.pending) {
      if (p.row.day !== day) continue;
      consumed.push(p);
      const row = p.row;
      const aggKey = `${row.provider}\u0000${row.model ?? ""}`;
      let agg = aggByKey.get(aggKey);
      if (agg === undefined) {
        agg = emptyAggRow(day, row.provider, row.model);
        aggByKey.set(aggKey, agg);
      }
      let dirAgg: TrendDirRow | undefined;
      if (row.dir !== undefined) {
        dirAgg = dirByKey.get(row.dir);
        if (dirAgg === undefined) {
          dirAgg = emptyDirRow(day, row.dir);
          dirByKey.set(row.dir, dirAgg);
        }
      }
      if (row.kind === "detail") {
        addDetailTo(agg, row);
        if (dirAgg !== undefined) addDetailTo(dirAgg, row);
      } else {
        addCounterTo(agg, row.turns, row.toolCalls);
        if (dirAgg !== undefined) addCounterTo(dirAgg, row.turns, row.toolCalls);
      }
    }
    return { consumed, aggRows: [...aggByKey.values()], dirRows: [...dirByKey.values()] };
  }

  /**
   * 给定日的折算聚合行（读侧投影；纯读不消费）。
   * 实现委托 {@link rollupSnapshot}——与压实路径共用同一份折算逻辑（单一事实源）。
   */
  rollupRowsOf(day: string): TrendAggRow[] {
    return this.rollupSnapshot(day).aggRows;
  }

  /**
   * 按身份消费 pending 行（压实 IO 全部成功后调用；#654）。
   * 只删除传入快照（{@link rollupSnapshot} 的 consumed）内的 entry——await 期间新到达
   * 的同日行不在快照内，保留到下一轮压实。空数组为 no-op，重复 entry 幂等。
   *
   * cells/dirDays 不动（压实只做落盘形态转换，绝不二次累加）。复核 P1-1：dirDays 亦
   * 不随消费联动删除——目录查询面（dirRows 纯内存快照）无分片回读，删桶 = 跨天历史
   * 柱全 null；压实事实已固化在 dir 分片 + dirDays，只随 pruneDays 收缩。
   */
  consume(entries: readonly PendingEntry[]): void {
    if (entries.length === 0) return;
    const doomed = new Set(entries);
    this.pending = this.pending.filter((p) => !doomed.has(p));
  }

  /**
   * 按日键消费 pending 行（兼容面）。
   * @deprecated #654：按日键删除会在压实 await 窗口内连带删除新到达的同日行（丢行），
   * 不再用于压实路径。新代码请用 {@link rollupSnapshot} + {@link consume}（按身份消费）；
   * 本方法保留仅为不破坏已发布的公开面，实现已委托为「按日取快照后按身份消费」。
   */
  dropPending(day: string, today: string): void {
    void today;
    this.consume(this.pending.filter((p) => p.row.day === day));
  }

  /**
   * 裁剪内存日桶（prune 同步收缩，长期运行不重启时 days 有界；cells 随桶整体丢弃）。
   * #633 复核 M1：dirDays 联动删除（与压实消费对称，生命周期与 days 一致；
   * 独立遍历不依赖 days 键集，纯 dir 日桶（无 agg 行的防御形态）也能清）。
   */
  pruneDays(beforeDay: string): number {
    let removed = 0;
    for (const day of [...this.days.keys()]) {
      if (day < beforeDay) {
        this.days.delete(day);
        removed += 1;
      }
    }
    for (const day of [...this.dirDays.keys()]) {
      if (day < beforeDay) this.dirDays.delete(day);
    }
    return removed;
  }

  /**
   * 日切压实（一步式）：折叠为聚合行返回并从 pending 移除。
   * 仅供启动自愈等「无并发 IO 失败窗口」的同步场景使用；flush 压实路径一律走
   * rollupSnapshot + consume 两步式（IO 失败内存行保留，防丢数）。
   * #633 A4：返回混存行——agg 行在前、dir 行在后（writeAggDay 写入约定）。
   * today 参数保留（与调用方注入时钟同源的语义锚点；消费已不依赖日键，见 consume）。
   */
  rollupDay(day: string, today: string): Array<TrendAggRow | TrendDirRow> {
    void today;
    const { consumed, aggRows, dirRows } = this.rollupSnapshot(day);
    this.consume(consumed);
    return [...aggRows, ...dirRows];
  }

  /** 从内存 pending 移除给定日已全部落盘的登记（重启自愈删除明细分片后同步内存视图）。 */
  forgetPersisted(day: string): void {
    this.pending = this.pending.filter((p) => !(p.row.day === day && p.persisted));
  }

  // ---------------------------------------------------------------- 查询

  /** 全量桶快照（day 升序；M2 路由与堆叠柱状的数据源）。 */
  buckets(): Array<{ day: string; providers: Array<{ provider: string; model: string | null; cell: TrendCell }> }> {
    const out: Array<{ day: string; providers: Array<{ provider: string; model: string | null; cell: TrendCell }> }> = [];
    for (const day of [...this.days.keys()].sort()) {
      const providers: Array<{ provider: string; model: string | null; cell: TrendCell }> = [];
      for (const [provider, models] of this.days.get(day)!) {
        for (const [model, cell] of models) {
          providers.push({ provider, model, cell });
        }
      }
      out.push({ day, providers });
    }
    return out;
  }

  /** 近 n 日序列（含今日；空日补 null——零 usage 语义，非 0）。 */
  seriesDays(n: number, now: number, metric: TrendMetric, provider?: string): Array<{ day: string; value: number | null }> {
    return lastNDayKeys(n, now).map((day) => ({ day, value: this.dayValue(day, metric, provider) }));
  }

  /** 近 n 周序列（周一起点；key = 周首日 day key）。 */
  seriesWeeks(n: number, now: number, metric: TrendMetric, provider?: string): Array<{ day: string; value: number | null }> {
    const keys = lastNWeekKeys(n, now);
    return keys.map((day) => ({ day, value: this.rangeValue(weekRange(day), metric, provider) }));
  }

  /** 近 n 月序列（key = YYYY-MM）。 */
  seriesMonths(n: number, now: number, metric: TrendMetric, provider?: string): Array<{ day: string; value: number | null }> {
    const keys = lastNMonthKeys(n, now);
    return keys.map((key) => ({ day: key, value: this.rangeValue(monthRange(key), metric, provider) }));
  }

  /**
   * 堆叠柱序列（/trend 路由数据源）：每时间桶按 provider（byModel 时细到
   * provider+model）拆段；providers 为图例并集（窗口内出现过的段）。
   */
  seriesStacked(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    provider: string | undefined,
    byModel: boolean,
    now: number,
  ): { series: TrendStackPoint[]; providers: Array<{ provider: string; model: string | null }> } {
    const keys = this.granKeys(n, gran, now);
    // 桶日区间一次算全（评审 P1-2：原实现对每桶在 days 日循环内重复调 granRange）
    const ranges = new Map(keys.map((k) => [k, this.granRange(k, gran)] as const));
    const series: TrendStackPoint[] = keys.map((key) => {
      const partsMap = new Map<string, TrendStackPart>();
      const range = ranges.get(key)!;
      for (const [day, models] of this.days) {
        if (day < range.start || day > range.end) continue;
        for (const [p, cells] of models) {
          if (provider !== undefined && p !== provider) continue;
          for (const [m, cell] of cells) {
            const id = byModel ? `${p}\u0000${m ?? ""}` : p;
            const v = metricValue(cell, metric);
            const cur = partsMap.get(id);
            if (cur !== undefined) cur.value = sumToken(cur.value, v);
            else partsMap.set(id, { provider: p, model: byModel ? m : null, value: v });
          }
        }
      }
      const parts = [...partsMap.values()];
      let total: number | null = null;
      for (const pt of parts) total = sumToken(total, pt.value);
      return { key, parts, total };
    });
    const legend = new Map<string, { provider: string; model: string | null }>();
    for (const point of series) {
      for (const pt of point.parts) {
        legend.set(byModel ? `${pt.provider}\u0000${pt.model ?? ""}` : pt.provider, {
          provider: pt.provider,
          model: byModel ? pt.model : null,
        });
      }
    }
    return { series, providers: [...legend.values()] };
  }

  /**
   * 窗口摘要（当前 n 桶 + 上一同等窗口环比基准）。
   * @param stackSeries 可选传入路由已算好的堆叠序列（n/gran/metric/provider 必须与本
   *   调用一致）——复用峰值/Top 遍历，消除单请求双算（评审 P1-2）；缺省时内部自算。
   */
  windowSummary(
    n: number,
    gran: TrendGranularity,
    metric: TrendMetric,
    provider: string | undefined,
    now: number,
    stackSeries?: TrendStackPoint[],
  ): TrendWindowSummary {
    const keys = this.granKeys(n, gran, now);
    const curRange = {
      start: this.granRange(keys[0], gran).start,
      end: this.granRange(keys[keys.length - 1], gran).end,
    };
    // 上一窗口：同长键序列整体前移 n 桶（day/week/month 各自步进语义）
    const prevKeys = this.granKeys(n, gran, this.prevWindowAnchor(now, n, gran));
    const prevRange = {
      start: this.granRange(prevKeys[0], gran).start,
      end: this.granRange(prevKeys[prevKeys.length - 1], gran).end,
    };
    let total: number | null = null;
    let calls = 0;
    let turns = 0;
    let toolCalls = 0;
    let peakKey: string | null = null;
    let peakVal = -1;
    let top: { provider: string; model: string | null; value: number } | null = null;
    // 复用路由已算的 stack 序列（评审 P1-2：消除单请求双算；缺省自算保持独立可用）
    const series = stackSeries ?? this.seriesStacked(n, gran, metric, provider, false, now).series;
    for (const point of series) {
      if (point.total !== null && point.total > peakVal) {
        peakVal = point.total;
        peakKey = point.key;
      }
      for (const pt of point.parts) {
        if (pt.value !== null && (top === null || pt.value > top.value)) {
          top = { provider: pt.provider, model: pt.model, value: pt.value };
        }
      }
    }
    for (const { cell } of this.rangeCells(curRange, provider)) {
      total = sumToken(total, metricValue(cell, metric));
      calls += cell.calls;
      turns += cell.turns;
      toolCalls += cell.toolCalls;
    }
    return {
      total,
      calls,
      turns,
      toolCalls,
      peakKey,
      top,
      prevTotal: this.rangeValue(prevRange, metric, provider),
      // 上一窗口起点早于数据起点（内存最早日，即留存/起算边缘）→ 基准不完整，环比不可比（#503 M2.1）
      prevComplete: prevRange.start >= (firstDayKeyOf(this.days) ?? "9999-12-31"),
    };
  }

  // ---------------------------------------------------------------- 内部

  /** 粒度桶键序列（升序，含当前桶）。 */
  private granKeys(n: number, gran: TrendGranularity, now: number): string[] {
    if (gran === "week") return lastNWeekKeys(n, now);
    if (gran === "month") return lastNMonthKeys(n, now);
    return lastNDayKeys(n, now);
  }

  /** 桶键 → 本地日区间。 */
  private granRange(key: string, gran: TrendGranularity): { start: string; end: string } {
    if (gran === "week") return weekRange(key);
    if (gran === "month") return monthRange(key);
    return { start: key, end: key };
  }

  /** 上一窗口锚点（把 now 前移 n 桶，得到 prevKeys 与当前窗口不重叠的时点）。 */
  private prevWindowAnchor(now: number, n: number, gran: TrendGranularity): number {
    const d = new Date(now);
    if (gran === "month") {
      d.setMonth(d.getMonth() - n);
      return d.getTime();
    }
    const days = gran === "week" ? n * 7 : n;
    d.setDate(d.getDate() - days);
    return d.getTime();
  }

  /** 日区间内的全部 (provider, model, cell)（升序日；provider 过滤可选）。 */
  private rangeCells(range: { start: string; end: string }, provider?: string): Array<{ provider: string; model: string | null; cell: TrendCell }> {
    const out: Array<{ provider: string; model: string | null; cell: TrendCell }> = [];
    for (const [day, models] of this.days) {
      if (day < range.start || day > range.end) continue;
      for (const [p, cells] of models) {
        if (provider !== undefined && p !== provider) continue;
        for (const [m, cell] of cells) out.push({ provider: p, model: m, cell });
      }
    }
    return out;
  }

  /** 单日取值（provider 过滤可选；跨 model 求和）。 */
  private dayValue(day: string, metric: TrendMetric, provider?: string): number | null {
    const models = this.days.get(day);
    if (models === undefined) return null;
    let acc: number | null = null;
    for (const [p, cells] of models) {
      if (provider !== undefined && p !== provider) continue;
      for (const cell of cells.values()) acc = sumToken(acc, metricValue(cell, metric));
    }
    return acc;
  }

  /** 日区间取值（[startDay, endDay] 闭区间，按本地日字典序比较）。 */
  private rangeValue(range: { start: string; end: string }, metric: TrendMetric, provider?: string): number | null {
    let acc: number | null = null;
    for (const [day, models] of this.days) {
      if (day < range.start || day > range.end) continue;
      for (const [p, cells] of models) {
        if (provider !== undefined && p !== provider) continue;
        for (const cell of cells.values()) acc = sumToken(acc, metricValue(cell, metric));
      }
    }
    return acc;
  }

  /** 统计摘要（health 观测面）。 */
  stats(): { days: number; pendingRows: number; unpersistedRows: number } {
    return {
      days: this.days.size,
      pendingRows: this.pending.length,
      unpersistedRows: this.pending.filter((p) => !p.persisted).length,
    };
  }

  // ---------------------------------------------------------------- 内部（桶构建）

  private cellOf(day: string, provider: string, model: string | null): TrendCell {
    let providers = this.days.get(day);
    if (providers === undefined) {
      providers = new Map();
      this.days.set(day, providers);
    }
    let models = providers.get(provider);
    if (models === undefined) {
      models = new Map();
      providers.set(provider, models);
    }
    let cell = models.get(model);
    if (cell === undefined) {
      cell = emptyCell();
      models.set(model, cell);
    }
    return cell;
  }

  /** dir 维度日桶定位（仿 cellOf；day → dir → cell，缺桶逐级补建；#633 A3）。 */
  private dirCellOf(day: string, dir: string): TrendCell {
    let dirs = this.dirDays.get(day);
    if (dirs === undefined) {
      dirs = new Map();
      this.dirDays.set(day, dirs);
    }
    let cell = dirs.get(dir);
    if (cell === undefined) {
      cell = emptyCell();
      dirs.set(dir, cell);
    }
    return cell;
  }
}

// ---------------------------------------------------------------- 纯函数

/** token 差（cell 回退用）：有值→null 时增量为 -old（cell 同步扣减，保证内存聚合
 *  与校正后的落盘明细一致）；双方皆 null 增量 0（null-aware 无变化）。 */
function sub(oldV: number | null, newV: number | null): number | null {
  if (newV === null) return oldV === null ? null : -oldV;
  if (oldV === null) return newV;
  return newV - oldV;
}

/**
 * 残差投影的 token 差（#633 修复）：聚合面 − 目录面，null-aware。
 * 双方皆 null → null（无该维度事实）；单侧 null 按 0 参与（另一侧有值即有残差）；
 * 负值保留给调用方判定（调用方按 0 处理并依赖「日总量恒等」断言暴露不一致）。
 */
function diffToken(aggV: number | null, dirV: number | null): number | null {
  if (aggV === null && dirV === null) return null;
  return (aggV ?? 0) - (dirV ?? 0);
}

/** 内存日桶的最早 day key（无数据返回 null；day key 字典序即时间序）。 */
function firstDayKeyOf(days: Map<string, unknown>): string | null {
  let first: string | null = null;
  for (const day of days.keys()) {
    if (first === null || day < first) first = day;
  }
  return first;
}

/** 空聚合行（压实折算起点；字段与 mergeCell 消费的 agg 行同构）。 */
function emptyAggRow(day: string, provider: string, model: string | null): TrendAggRow {
  return {
    v: TREND_ROW_VERSION,
    kind: "agg",
    day,
    provider,
    model,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    calls: 0,
    turns: 0,
    toolCalls: 0,
  };
}

/** 空目录汇总行（#633 A4；与 agg 行十数值字段同构，仅键换成 dir）。 */
function emptyDirRow(day: string, dir: string): TrendDirRow {
  return {
    v: TREND_ROW_VERSION,
    kind: "dir",
    day,
    dir,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    calls: 0,
    turns: 0,
    toolCalls: 0,
  };
}

/** 明细行并入聚合/目录汇总行（两者字段同构，同函数复用；null-aware 求和）。 */
function addDetailTo(agg: TrendAggRow | TrendDirRow, row: TrendDetailRow): void {
  agg.calls += 1;
  agg.input = sumToken(agg.input, row.input);
  agg.output = sumToken(agg.output, row.output);
  agg.cacheRead = sumToken(agg.cacheRead, row.cacheRead);
  agg.cacheWrite = sumToken(agg.cacheWrite, row.cacheWrite);
}

/** 计数行并入聚合/目录汇总行（同上，同函数复用）。 */
function addCounterTo(agg: TrendAggRow | TrendDirRow, turns: number, toolCalls: number): void {
  agg.turns += turns;
  agg.toolCalls += toolCalls;
}

/** 聚合行并入 cell（重建用；null-aware。agg 与 dir 汇总行十数值字段同构，同函数复用）。 */
function mergeCell(cell: TrendCell, row: TrendAggRow | TrendDirRow): void {
  cell.calls += row.calls;
  cell.turns += row.turns;
  cell.toolCalls += row.toolCalls;
  cell.input = sumToken(cell.input, row.input);
  cell.output = sumToken(cell.output, row.output);
  cell.cacheRead = sumToken(cell.cacheRead, row.cacheRead);
  cell.cacheWrite = sumToken(cell.cacheWrite, row.cacheWrite);
}

/** cell 的指标取值（total = 四项 token 之和）。 */
export function metricValue(cell: TrendCell, metric: TrendMetric): number | null {
  switch (metric) {
    case "total":
      return sumToken(sumToken(cell.input, cell.output), sumToken(cell.cacheRead, cell.cacheWrite));
    case "input":
      return cell.input;
    case "output":
      return cell.output;
    case "cacheRead":
      return cell.cacheRead;
    case "cacheWrite":
      return cell.cacheWrite;
    case "calls":
      return cell.calls;
  }
}

/**
 * 聚合行合并（flush 压实写盘前与既有聚合分片合并——迟到旧日行场景防覆盖丢数；
 * null-aware 求和，同 (provider, model) 键累加）。
 */
export function mergeAggRows(base: TrendAggRow[], add: TrendAggRow[]): TrendAggRow[] {
  const byKey = new Map<string, TrendAggRow>();
  for (const r of [...base, ...add]) {
    const key = `${r.provider}\u0000${r.model ?? ""}`;
    const cur = byKey.get(key);
    if (cur === undefined) {
      byKey.set(key, { ...r });
      continue;
    }
    cur.calls += r.calls;
    cur.turns += r.turns;
    cur.toolCalls += r.toolCalls;
    cur.input = sumToken(cur.input, r.input);
    cur.output = sumToken(cur.output, r.output);
    cur.cacheRead = sumToken(cur.cacheRead, r.cacheRead);
    cur.cacheWrite = sumToken(cur.cacheWrite, r.cacheWrite);
  }
  return [...byKey.values()];
}

/**
 * dir 汇总行合并（#633 A4 flush 压实写盘前与既有聚合分片内的 dir 行合并——
 * 迟到旧日行场景防覆盖丢数；十数值字段与 mergeAggRows 完全同构，null-aware
 * 求和，同 dir 键累加。输出保持输入相对顺序：base 在前（dir 行位于分片尾段））。
 */
export function mergeDirRows(base: TrendDirRow[], add: TrendDirRow[]): TrendDirRow[] {
  const byKey = new Map<string, TrendDirRow>();
  for (const r of [...base, ...add]) {
    const cur = byKey.get(r.dir);
    if (cur === undefined) {
      byKey.set(r.dir, { ...r });
      continue;
    }
    cur.calls += r.calls;
    cur.turns += r.turns;
    cur.toolCalls += r.toolCalls;
    cur.input = sumToken(cur.input, r.input);
    cur.output = sumToken(cur.output, r.output);
    cur.cacheRead = sumToken(cur.cacheRead, r.cacheRead);
    cur.cacheWrite = sumToken(cur.cacheWrite, r.cacheWrite);
  }
  return [...byKey.values()];
}

/** 周一为起点的周首日 day key（本地时区；DST 安全——逐日回退不用毫秒减法）。 */
export function weekStartKey(t: number): string {
  const d = new Date(t);
  const dow = d.getDay(); // 0=周日
  const back = (dow + 6) % 7; // 距周一的天数
  d.setDate(d.getDate() - back);
  return dayKey(d.getTime());
}

/** 近 n 个周首日 key（升序，含当前周）。 */
export function lastNWeekKeys(n: number, now: number): string[] {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const keys: string[] = [];
  for (let i = 0; i < n; i += 1) {
    keys.unshift(dayKey(d.getTime()));
    d.setDate(d.getDate() - 7);
  }
  return keys;
}

/** 近 n 个月 key（YYYY-MM，升序，含当月；本地时区逐月回退）。 */
export function lastNMonthKeys(n: number, now: number): string[] {
  const d = new Date(now);
  const keys: string[] = [];
  for (let i = 0; i < n; i += 1) {
    keys.unshift(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
  }
  return keys;
}

/** 月 key 的日区间（本地日字典序；月末取该月最后一天，DST 安全）。 */
export function monthRange(key: string): { start: string; end: string } {
  const [y, m] = key.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0); // 次月 0 日 = 本月末日
  return { start: dayKey(start.getTime()), end: dayKey(end.getTime()) };
}

/** 周首日 key 的日区间（7 天）。 */
export function weekRange(weekStart: string): { start: string; end: string } {
  const [y, m, d] = weekStart.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const endDate = new Date(y, m - 1, d + 6);
  return { start: dayKey(start.getTime()), end: dayKey(endDate.getTime()) };
}
