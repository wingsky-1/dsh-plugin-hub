/**
 * dsh-provider-usage — 客户端路由契约（host-seams R2 收敛点）。
 *
 * 与宿主 ROUTES（src/apply/apply.ts）同值的镜像：两边各写一份的失败形态是静默的
 * （对不上只表现成请求 404），故两端一致性由单测锁定（16 键与宿主 ROUTES 键 1:1、
 * 值全等，见 test/client/client-routes.test.ts）。
 *
 * 收敛前 16 个字面量散在 client/core.ts（11 处）与 client/report.tsx（5 处），
 * 两处皆不在 verify-host-seams R2 定义层允许集内（非 shared、非 client/index、
 * 非 routes\/contract 基名），门禁 R2-L\/R2-B 判红；收敛后定义只剩本文件一份
 * （R2 允许：client\/shared），core\/report 改经具名表 import。
 *
 * 构建期 __DSH_ROUTES__ 存在时优先取注入值（bundle-host extraDefine）；非 bundle
 * 环境（单测经 esbuild define 置 undefined）回落本地镜像。fallback 形
 * （__DSH_ROUTES__?.key ?? 字面量）与收敛前 core\/report 逐字同形，只换位置。
 */

/** 宿主端 ROUTES（构建期经 __DSH_ROUTES__ 注入）。 */
declare const __DSH_ROUTES__: Record<string, string> | undefined;

export const STATS_URL = __DSH_ROUTES__?.stats ?? "/api/dsh-provider-usage/stats";
export const HISTORY_URL = __DSH_ROUTES__?.history ?? "/api/dsh-provider-usage/history";
export const HEALTH_URL = __DSH_ROUTES__?.health ?? "/api/dsh-provider-usage/health";
/** 会话用量趋势。 */
export const TREND_URL = __DSH_ROUTES__?.trend ?? "/api/dsh-provider-usage/trend";
/** 适配器管理路由（设置页主列表同源；现行 API，无替代）。 */
export const ADAPTERS_URL = __DSH_ROUTES__?.adapters ?? "/api/dsh-provider-usage/adapters.json";
/** 适配器切换路由（现行 API，无替代）。 */
export const SELECT_URL = __DSH_ROUTES__?.select ?? "/api/dsh-provider-usage/adapters/select";
/** 适配器预览路由（现行 API，无替代）。 */
export const INSPECT_URL = __DSH_ROUTES__?.inspect ?? "/api/dsh-provider-usage/adapters/inspect";
/** 适配器登记路由（现行 API，无替代）。 */
export const ADD_URL = __DSH_ROUTES__?.add ?? "/api/dsh-provider-usage/adapters/add";
export const UI_CONFIG_URL = __DSH_ROUTES__?.uiConfig ?? "/api/dsh-provider-usage/ui-config";
export const EVENTS_URL = __DSH_ROUTES__?.events ?? "/api/dsh-provider-usage/events";
export const REPORT_CONFIG_URL =
  __DSH_ROUTES__?.reportConfig ?? "/api/dsh-provider-usage/report-config";
export const REPORT_MODELS_URL =
  __DSH_ROUTES__?.reportModels ?? "/api/dsh-provider-usage/report-models";
export const REPORTS_URL = __DSH_ROUTES__?.reports ?? "/api/dsh-provider-usage/reports";
export const REPORT_DETAIL_URL =
  __DSH_ROUTES__?.reportDetail ?? "/api/dsh-provider-usage/reports/detail";
export const REPORT_GENERATE_URL =
  __DSH_ROUTES__?.reportGenerate ?? "/api/dsh-provider-usage/reports/generate";
/** 报告生成任务状态轮询（生成异步化，POST generate 返回 taskId 后轮询此接口）。 */
export const REPORT_GENERATE_STATUS_URL =
  __DSH_ROUTES__?.reportGenerateStatus ?? "/api/dsh-provider-usage/reports/generate/status";
