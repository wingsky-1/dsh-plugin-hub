/**
 * dsh-provider-usage/report — 报告生成（#503 M3，方案 §八 v1.2 定稿 ctx.llm.stream 路线）。
 *
 * - 零凭据、零独立网络出口：模型调用经宿主 llm 服务（ctx.llm.stream），
 *   凭据由 dsh 既有 provider 配置持有，本插件不接触（README 安全模型同步口径）；
 * - 生成消耗不入统计：llm.stream 不派发 session/event → 不进用量记账
 *   （方案 §八4，单测显式断言该前提），token 消耗单独记录在报告元数据（报告页可见）；
 * - 无会话副作用：一击式流式调用，不创建 agent/会话、无工具面（tools 不传）；
 * - provider/model 空串 = 跟随默认：dsh-llm 服务面无「默认 provider」API
 *   （仅 listProviders/listModels/stream），按注册序首个 provider/model 解析
 *   （单 provider 部署即默认；多 provider 建议在报告配置显式选择），解析结果写入元数据；
 * - 失败语义（方案 §八6）：流式异常 → ok:false 元数据（错误短句可读），不抛——
 *   幂等重试由调度层决定（onDue 抛错才不推进 lastRun，见接线层约定）；
 * - 官方类型层仅 import type（仓库契约门禁「@deepseek-ai/* 仅类型导入」）：
 *   prompt 消息自拼 Message 字面量（与官方 createUserMessage 产物同形——
 *   id = crypto.randomUUID()，官方 createMessage 同源 randomUUID 生成稳定 id；
 *   仅作只读传参，无需 freeze）。
 */
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  Message,
  MessageId,
  StreamChunk,
  TokenUsage,
} from "@deepseek-ai/dsh-llm";
import { metricValue } from "../trend/aggregator.ts";
import { sumToken, type TrendCell } from "../trend/types.ts";
import type { ReportPeriod } from "./config.ts";

/** 报告生成所用 llm 服务面（LlmRuntime 最小结构面——只依赖实际用到的三个方法）。 */
export interface ReportLlmService {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  listProviders(): LlmProviderInfo[];
  listModels(provider: string): Promise<LlmModelInfo[]>;
}

/** 报告 token 元数据（防御解析后；缺失维度 null）。 */
export interface ReportTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** 报告元数据（落盘与索引 JSONL 由接线层负责，本模块只产出数据）。 */
export interface ReportMeta {
  period: ReportPeriod;
  /** 窗口键（与 DueReport.key 一致，幂等标记单位）。 */
  key: string;
  startDay: string;
  endDay: string;
  /** 实际使用的 provider/model（空串「跟随默认」已解析为具体路由）。 */
  provider: string;
  model: string;
  /** 生成发起时间（epoch ms）。 */
  generatedAt: number;
  durationMs: number;
  ok: boolean;
  /** 失败原因（ok=false 时的可读短句）。 */
  error?: string;
  /** 生成消耗 token（流携带 usage chunk 时记录；不入用量统计）。 */
  tokens?: ReportTokenUsage;
}

/** 报告生成结果（正文 + 元数据）。 */
export interface ReportResult {
  /** 报告正文（LLM 产出的叙事文本；失败时为空串）。 */
  body: string;
  meta: ReportMeta;
}

export interface GenerateReportOptions {
  /** 宿主 llm 服务面（apply 层传 ctx.llm）。 */
  llm: ReportLlmService;
  period: ReportPeriod;
  key: string;
  startDay: string;
  endDay: string;
  /** 当期聚合统计 JSON 字符串（buildStatsSnapshot 产出；注入 {stats} 占位）。 */
  statsJson: string;
  /** 提示词模板（{stats} 占位；normalizeReportConfig 已保证非空）。 */
  promptTemplate: string;
  /** 配置的 provider/model；空串 = 跟随默认（解析为注册序首个）。 */
  provider: string;
  model: string;
  /** 取消信号（透传 GenerateOptions.signal）。 */
  signal?: AbortSignal;
  /** 注入时钟（测试；默认 Date.now）。 */
  now?: () => number;
}

/** 报告统计快照（注入 {stats} 的 JSON 形状；方案 §2.3「当期聚合统计」）。 */
export interface ReportStatsSnapshot {
  period: ReportPeriod;
  startDay: string;
  endDay: string;
  /** 窗口聚合总量。 */
  totals: {
    calls: number;
    turns: number;
    toolCalls: number;
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    /** 四项 token 之和（null-aware）。 */
    total: number | null;
  };
  /** 逐日总量序列（窗口内出现数据的日，升序）。 */
  byDay: Array<{ day: string; total: number | null }>;
  /** 按适配器聚合（calls 降序；叙事化「最活跃适配器/模型」数据源）。 */
  byProvider: Array<{ provider: string; model: string | null; calls: number; total: number | null }>;
  /** 上一同等长度窗口的指标总量（环比基准；接线层经 windowSummary 取得）。 */
  prevTotal: number | null;
}

/** 防御性有限数（usage chunk 字段跨宿主边界不受信）。 */
function safeNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 从 TokenUsage 防御提取报告 token 元数据。 */
function parseTokenUsage(u: unknown): ReportTokenUsage {
  const src = (typeof u === "object" && u !== null ? u : {}) as Record<string, unknown>;
  return {
    inputTokens: safeNum(src.inputTokens),
    outputTokens: safeNum(src.outputTokens),
    totalTokens: safeNum(src.totalTokens),
    cacheReadTokens: safeNum(src.cacheReadTokens),
    cacheWriteTokens: safeNum(src.cacheWriteTokens),
  };
}

/**
 * {stats} 占位替换（模板其余文本原样保留；占位多次出现全部替换）。
 * split+join 而非 replace 正则：避免模板内容被按正则语义误解析。
 */
export function applyPromptTemplate(template: string, statsJson: string): string {
  return template.split("{stats}").join(statsJson);
}

/** 空串跟随默认：注册序首个 provider/model（无可选项返回 null）。 */
async function resolveRoute(
  llm: ReportLlmService,
  provider: string,
  model: string,
): Promise<{ provider: string; model: string } | null> {
  let p = provider;
  if (p.length === 0) {
    p = llm.listProviders()[0]?.id ?? "";
    if (p.length === 0) return null;
  }
  let m = model;
  if (m.length === 0) {
    const models = await llm.listModels(p);
    m = models[0]?.id ?? "";
    if (m.length === 0) return null;
  }
  return { provider: p, model: m };
}

/**
 * 生成报告：流式收集正文与 token 元数据。
 * 失败（路由不可解析/流异常/取消）→ ok:false 元数据（不抛，正文空串）；
 * 成功 → ok:true + 正文 + tokens（首个 usage chunk 为准）。
 */
export async function generateReport(opts: GenerateReportOptions): Promise<ReportResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const metaBase = {
    period: opts.period,
    key: opts.key,
    startDay: opts.startDay,
    endDay: opts.endDay,
    generatedAt: started,
  };
  const fail = (error: string): ReportResult => ({
    body: "",
    meta: { ...metaBase, provider: opts.provider, model: opts.model, durationMs: now() - started, ok: false, error },
  });
  const route = await resolveRoute(opts.llm, opts.provider, opts.model);
  if (route === null) return fail("无可用的已注册 provider/model（须先在 dsh 注册适配器路由）");
  const prompt = applyPromptTemplate(opts.promptTemplate, opts.statsJson);
  // 自拼 user 消息（与官方 createUserMessage 产物同形：randomUUID 稳定 id +
  // 单 text 块 content + user source；仅作只读传参，无需 freeze）
  const message: Message = {
    id: crypto.randomUUID() as MessageId,
    role: "user",
    content: [{ type: "text", text: prompt }],
    source: { kind: "user" },
  };
  const genOpts: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [message],
    // tools 不传 = 无工具面（方案 §八5，类型层保证）
  };
  if (opts.signal !== undefined) genOpts.signal = opts.signal;
  let body = "";
  let tokens: ReportTokenUsage | null = null;
  try {
    for await (const chunk of opts.llm.stream(genOpts)) {
      if (chunk.type === "text-delta") body += chunk.text;
      else if (chunk.type === "usage" && tokens === null) tokens = parseTokenUsage(chunk.usage);
    }
  } catch (e: unknown) {
    // 流异常/取消 → 失败元数据；调度层据 ok 决定是否推进 lastRun（接线层约定）
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (body.trim().length === 0) return fail("模型未产出任何正文");
  return {
    body,
    meta: {
      ...metaBase,
      provider: route.provider,
      model: route.model,
      durationMs: now() - started,
      ok: true,
      ...(tokens !== null ? { tokens } : {}),
    },
  };
}

/**
 * 报告统计快照（纯计算）：从 tracker.buckets() 快照聚合窗口内数据。
 * 注入面收敛（方案 §八7）：只含聚合数值，不含会话明细与路径——
 * sanitizePaths 配置约束未来注入面扩展，v1 统计面无路径可脱敏。
 */
export function buildStatsSnapshot(input: {
  period: ReportPeriod;
  startDay: string;
  endDay: string;
  /** tracker.buckets() 快照（day 升序；day×provider×model×cell）。 */
  buckets: Array<{ day: string; providers: Array<{ provider: string; model: string | null; cell: TrendCell }> }>;
  /** 上一同等长度窗口的指标总量（环比基准；接线层经 windowSummary 取得）。 */
  prevTotal: number | null;
}): ReportStatsSnapshot {
  const totals = {
    calls: 0,
    turns: 0,
    toolCalls: 0,
    input: null as number | null,
    output: null as number | null,
    cacheRead: null as number | null,
    cacheWrite: null as number | null,
    total: null as number | null,
  };
  const byDay: Array<{ day: string; total: number | null }> = [];
  const byKey = new Map<string, { provider: string; model: string | null; calls: number; total: number | null }>();
  for (const { day, providers } of input.buckets) {
    if (day < input.startDay || day > input.endDay) continue;
    let dayTotal: number | null = null;
    for (const { provider, model, cell } of providers) {
      const total = metricValue(cell, "total");
      totals.calls += cell.calls;
      totals.turns += cell.turns;
      totals.toolCalls += cell.toolCalls;
      totals.input = sumToken(totals.input, cell.input);
      totals.output = sumToken(totals.output, cell.output);
      totals.cacheRead = sumToken(totals.cacheRead, cell.cacheRead);
      totals.cacheWrite = sumToken(totals.cacheWrite, cell.cacheWrite);
      dayTotal = sumToken(dayTotal, total);
      totals.total = sumToken(totals.total, total);
      const key = `${provider}\u0000${model ?? ""}`;
      const cur = byKey.get(key);
      if (cur === undefined) byKey.set(key, { provider, model, calls: cell.calls, total });
      else {
        cur.calls += cell.calls;
        cur.total = sumToken(cur.total, total);
      }
    }
    if (dayTotal !== null) byDay.push({ day, total: dayTotal });
  }
  const byProvider = [...byKey.values()].sort((a, b) => b.calls - a.calls);
  return {
    period: input.period,
    startDay: input.startDay,
    endDay: input.endDay,
    totals,
    byDay,
    byProvider,
    prevTotal: input.prevTotal,
  };
}
