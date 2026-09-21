/**
 * dsh-provider-usage — 趋势查询路由（server/ui-routes 域趋势块，
 * #768 D12 由 domain2/routes/ui.ts 迁入，零行为变更）。
 *
 * 本块回答「趋势窗口怎么算/查」：clampTrendN（n 封顶纯函数）+ handleTrend
 *（provider 面 / 目录面双查询面，形状归一，非法参数回退不 400 的既有语义保持）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { guardLoopbackMethod, writeJson } from "../../../../../shared/host-utils.js";
import { ADAPTER_CONTRACT_VERSION } from "../../shared/interface.ts";
import { TREND_DIR_MAX } from "../shared/interface.ts";
import type { UiRoutesContext } from "./context.ts";

const TREND_WINDOW: Record<string, number> = { day: 30, week: 12, month: 12 };
const TREND_METRICS = new Set(["total", "input", "output", "cacheRead", "cacheWrite", "calls"]);

export function clampTrendN(
  raw: string | null,
  gran: "day" | "week" | "month",
  retention: number,
): number {
  const cap =
    gran === "day"
      ? retention
      : gran === "week"
        ? Math.ceil(retention / 7)
        : Math.ceil(retention / 30);
  const parsed = raw === null || raw === "" ? NaN : Number(raw);
  const n = Number.isInteger(parsed) && parsed > 0 ? parsed : (TREND_WINDOW[gran] ?? 30);
  return Math.min(n, cap);
}

export function handleTrend(
  req: IncomingMessage,
  res: ServerResponse,
  context: UiRoutesContext,
): void {
  if (!guardLoopbackMethod(req, res, ["GET"])) return;
  const { statsService, trend } = context;
  const url = new URL(req.url ?? "/", "http://localhost");
  const g = url.searchParams.get("granularity") ?? "day";
  const granularity = g === "week" || g === "month" ? g : "day";
  const m = url.searchParams.get("metric") ?? "total";
  const metric = TREND_METRICS.has(m)
    ? (m as "total" | "input" | "output" | "cacheRead" | "cacheWrite" | "calls")
    : "total";
  const providerParam = url.searchParams.get("provider") ?? "";
  const provider =
    providerParam.length > 0 && providerParam.length <= 128 ? providerParam : undefined;
  // 可选目录过滤（GET query，风格与 provider 参数一致）——
  // 非空且不超数据层上限（TREND_DIR_MAX，与 isValidDirKey 同一事实源）按目录键过滤
  // （basename 净化值或未识别桶键）；未传/非法（空串/超长）→ undefined = 全目录聚合，
  // 行为与现状完全一致（非法回退不 400）。
  // 原硬编码 128 与数据层 256 不一致——129–256 字符的合法目录键会被静默
  // 降级为「全目录聚合」（查询面悄然变形，且原 smoke 用例把这个错误行为锁死）。
  // dir 与 provider 面分流：传 dir → 目录维度查询面；未传 → provider 维度
  // 原查询面（provider/byModel 参数语义原样保留，响应形状零变化）。
  const dirParam = url.searchParams.get("dir") ?? "";
  const dir = dirParam.length > 0 && dirParam.length <= TREND_DIR_MAX ? dirParam : undefined;
  // byDir=1 = 全目录拆段查询面（未传 dir 时按目录拆段 +
  // dirs 全集图例，支撑趋势面板「打开即见目录分布」与目录筛选下拉候选）；
  // 不带该参数时走既有两分支（现状响应形状零变化，smoke 断言原样成立）。
  // dir 过滤优先于 byDir（过滤面已隐含目录维度）；目录面与 provider 面互斥
  // （dir 行无 provider 关联，既定数据边界）。
  const byDirAll = dir === undefined && url.searchParams.get("byDir") === "1";
  const byModel = url.searchParams.get("byModel") === "1";
  const n = clampTrendN(
    url.searchParams.get("n"),
    granularity,
    statsService.config.trendRetentionDays,
  );
  const byDir = dir !== undefined || byDirAll;
  // dir 面与 provider 面的 stack 形状归一（两分支字段并集）——
  // 未过滤分支响应含 providers 图例（现状形状零变化），过滤分支含 dirs 目录图例。
  // byDir=1 全目录面加性附 providers 候选——默认请求恒带 byDir=1 时目录面
  // providers 恒空致适配器下拉无可选项（交互回归）；
  // 候选与 provider 面图例同源（seriesStacked 窗口内 distinct），series 不受影响
  // （dir 行无 provider 关联的既定数据边界不变，加性返回不破坏「未传参数零变化」）。
  // dir 过滤面保持空 providers（既有形状，过滤面选中态下适配器已互斥清空）。
  const dirStack = {
    ...trend.dirStacked(n, granularity, metric, dir),
    providers: [] as Array<{ provider: string; model: string | null }>,
  };
  if (byDirAll)
    dirStack.providers = trend.seriesStacked(n, granularity, metric, undefined, false).providers;
  const stack = byDir
    ? dirStack
    : {
        ...trend.seriesStacked(n, granularity, metric, provider, byModel),
        dirs: [] as Array<{ dir: string }>,
      };
  const summary = byDir
    ? trend.dirWindowSummary(n, granularity, metric, dir, stack.series)
    : trend.windowSummary(n, granularity, metric, provider, byModel ? undefined : stack.series);

  writeJson(res, 200, {
    ok: true,
    plugin: "dsh-provider-usage",
    version: ADAPTER_CONTRACT_VERSION,
    granularity,
    metric,
    provider: provider ?? null,
    // 目录过滤回显（null = 未过滤 = 现状形状）；dirs 由 stack
    // 归一形状携带（过滤分支 = 窗口内目录图例，含未识别桶；dir 落盘即 basename
    // 净化值，无路径分隔符）。byDir=1 全目录面回显 byDir=true。
    // 回显实际生效面——byDirAll 定义含 dir === undefined 守卫（dir 优先
    // 于 byDir），同传 dir+byDir 时 byDir 回显 false、dir 回显生效键（客户端以
    // 回显驱动控件选中态，虚假 true 会误导恢复逻辑；smoke 同传用例固化）。
    dir: dir ?? null,
    byDir: byDirAll,
    byModel,
    n,
    retentionDays: statsService.config.trendRetentionDays,
    ...stack,
    summary,
    firstDay: trend.firstRecordedDay(),
    generatedAt: Date.now(),
  });
}
