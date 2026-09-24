/**
 * dsh-provider-usage — 配置归一化（单一职责：默认值 / schemastery schema / normalizeConfig）。
 *
 * 自 index.ts 抽离，导出面由 index.ts 转发 re-export
 * 保持不变（外部消费者仍从 lib/index.js 导入）。
 */

import z from "schemastery";
import { OPENCODE_GO_PROVIDER } from "./provider.ts";

export const DEFAULT_CONFIG = {
  adapter: "",
  staticPath: "",
  provider: OPENCODE_GO_PROVIDER,
  apiEndpoint: "",
  apiKey: "",
  historyDir: "",
  warmupIntervalMs: 300000,
  // 由 60000 下调至 30000——峰谷徽标倒计时跨时段边界的展示翻转延迟
  // = 宿主缓存 + 客户端轮询（60s）+ 渲染余量，缓存减半使端到端 ≤95s 可达。
  cacheDurationMs: 30000,
  // 2s→5s——commandcode 等三请求并行适配器在远端慢时 2s 频繁超时；
  // safeFetchData 为 Promise.race+Abort 纯异步超时，不阻塞主进程（超时会
  // 经合并信号真正 abort 底层 fetch）；
  // 取数锁为 per-provider 粒度，排队仅发生在同一 provider 内部，
  // 最坏 n×5s 只限单 provider 的并发请求，跨 provider 完全并行。
  fetchTimeoutMs: 5000,
  autoReload: true,
  maxAgeDays: 30,
  maxSizeMB: 20,
  // 会话用量趋势：聚合分片保留天数（日切压实后按天留存，明细仅当日）
  trendRetentionDays: 180,
};

/** 只接受布尔值的配置键（客户端 UI 按它渲染开关）；与 schema 里的 `z.boolean()` 字段一一对应。 */
export const BOOLEAN_KEYS: readonly string[] = ["autoReload"];

/**
 * 非负整数键及其上界（默认值不得越界）。上界取自下面 `normalizeConfig` 里的 `Math.min`——
 * 两处都是声明，config-matrix 门禁的 N4 断言它们与 DEFAULT_CONFIG 一致，漂移即红。
 *
 * 只列**有产品上界**的键：`warmupIntervalMs` / `cacheDurationMs` 只有下界（60000 / 5000），
 * 上界是机器极限而非产品约束，列进来等于编一个假上界；`fetchTimeoutMs` 固定不开放配置。
 */
export const COUNT_LIMITS: Record<string, number> = {
  maxAgeDays: 365,
  maxSizeMB: 500,
  trendRetentionDays: 3650,
};

export interface NormalizedConfig {
  adapter: string;
  staticPath: string;
  provider: string;
  apiEndpoint: string;
  apiKey: string;
  historyDir: string;
  warmupIntervalMs: number;
  cacheDurationMs: number;
  fetchTimeoutMs: number;
  autoReload: boolean;
  maxAgeDays: number;
  maxSizeMB: number;
  trendRetentionDays: number;
}

/**
 * 插件配置 schema（schemastery 对象；宿主设置面经 shared 接缝以 unknown 消费）。
 *
 * 显式 `z<平面接口>` 声明保持原样，RHS 末尾单重 as 收口（lan-proxy model.ts 同款，
 * dsh 0.1.7-rc.1 跟进）：bump 后本包编译程序内同时存在 schemastery@3.18.0（直引，
 * `z` 值的实际解析）与 @deepseek-ai/schemastery@3.18.4（经 dsh-settings 0.1.7 类型层
 * 传入）的 `declare global namespace Schemastery`；合并后 `.default()` 的输出侧携带
 * Volatile 包装（SchemaOutput），直接赋值判红（TS2322）；裸推断引用未导入的 fork
 * 模块名，声明发射不可移植（TS2883）；`z<any>` 退路被提交钩子终结
 *（@typescript-eslint/no-explicit-any，长久性错误）。as 是纯类型擦除：值面从未调用
 * .volatile()，运行时无此物；对外类型面与 0.1.7-rc.1 目标契约一致，零行为变化。平面形状另由
 * NormalizedConfig 契约化，键集一致性由 unit-config 回归断言与 config-matrix 门禁锁定。
 */
export const Config: z<{
  adapter: string;
  staticPath: string;
  provider: string;
  apiEndpoint: string;
  warmupIntervalMs: number;
  cacheDurationMs: number;
  fetchTimeoutMs: number;
  autoReload: boolean;
  maxAgeDays: number;
  maxSizeMB: number;
  trendRetentionDays: number;
}> = z.object({
  adapter: z
    .string()
    .default("")
    .description("用户适配器 mjs 文件路径（兼容配置声明；推荐经设置页「用量统计」添加）"),
  staticPath: z.string().default("").description("API 路径（如 /v1/usage；config.adapter 模式用）"),
  provider: z.string().default(OPENCODE_GO_PROVIDER).description("关联的模型 provider 名"),
  apiEndpoint: z
    .string()
    .default("")
    .description("API 基础地址（可选，不填使用内置默认或模型配置链）")
    .disabled(true),
  warmupIntervalMs: z
    .number()
    .default(DEFAULT_CONFIG.warmupIntervalMs)
    .description("后台预热间隔毫秒")
    .disabled(true),
  cacheDurationMs: z
    .number()
    .default(DEFAULT_CONFIG.cacheDurationMs)
    .description("缓存新鲜度毫秒")
    .disabled(true),
  fetchTimeoutMs: z
    .number()
    .default(DEFAULT_CONFIG.fetchTimeoutMs)
    .description("取数超时毫秒")
    .disabled(true),
  autoReload: z
    .boolean()
    .default(true)
    .description("热更新开关（编辑适配器 mjs 后自动重新加载；默认开启，可显式 false 关闭）"),
  maxAgeDays: z
    .number()
    .default(DEFAULT_CONFIG.maxAgeDays)
    .description("历史数据保留天数")
    .disabled(true),
  maxSizeMB: z
    .number()
    .default(DEFAULT_CONFIG.maxSizeMB)
    .description("历史数据大小上限（MB）")
    .disabled(true),
  trendRetentionDays: z
    .number()
    .default(DEFAULT_CONFIG.trendRetentionDays)
    .description("会话用量趋势聚合保留天数")
    .disabled(true),
  // 末尾 as 收口（lan-proxy model.ts 同款，见文件头注释）：合并后的 Mode 条件类型
  // 使直接赋值判红，as 保持对外类型面恒为 z<平面接口>，值面无任何变化。
}) as z<{
  adapter: string;
  staticPath: string;
  provider: string;
  apiEndpoint: string;
  warmupIntervalMs: number;
  cacheDurationMs: number;
  fetchTimeoutMs: number;
  autoReload: boolean;
  maxAgeDays: number;
  maxSizeMB: number;
  trendRetentionDays: number;
}>;

export function normalizeConfig(input: unknown): NormalizedConfig {
  const base = { ...DEFAULT_CONFIG };
  if (typeof input !== "object" || input === null) return base;
  const cfg = input as Record<string, unknown>;
  if (typeof cfg.adapter === "string") base.adapter = cfg.adapter;
  if (typeof cfg.staticPath === "string") base.staticPath = cfg.staticPath;
  if (typeof cfg.provider === "string") base.provider = cfg.provider;
  if (typeof cfg.apiEndpoint === "string") base.apiEndpoint = cfg.apiEndpoint;
  if (typeof cfg.apiKey === "string") base.apiKey = cfg.apiKey;
  if (typeof cfg.historyDir === "string") base.historyDir = cfg.historyDir;
  if (Number.isFinite(cfg.warmupIntervalMs))
    base.warmupIntervalMs = Math.max(60000, cfg.warmupIntervalMs as number);
  if (Number.isFinite(cfg.cacheDurationMs))
    base.cacheDurationMs = Math.max(5000, cfg.cacheDurationMs as number);
  // fetchTimeoutMs 固定 5s（不开放配置）：远端慢时 2s 频繁超时
  if (typeof cfg.autoReload === "boolean") base.autoReload = cfg.autoReload;
  // maxAgeDays 仅接受正整数——<=0 会令 maybePrune 下界落在未来（历史被全量清理）、
  // 面板查询区间 start>end 永空；非正整数一律视为非法回落默认值，上界 365 维持既有 clamp
  if (Number.isInteger(cfg.maxAgeDays) && (cfg.maxAgeDays as number) > 0) {
    base.maxAgeDays = Math.min(365, cfg.maxAgeDays as number);
  }
  if (Number.isFinite(cfg.maxSizeMB)) base.maxSizeMB = Math.min(500, cfg.maxSizeMB as number);
  // trend 聚合保留天数——仅正整数（上界 3650≈10 年），非法回落默认 180
  if (Number.isInteger(cfg.trendRetentionDays) && (cfg.trendRetentionDays as number) > 0) {
    base.trendRetentionDays = Math.min(3650, cfg.trendRetentionDays as number);
  }
  return base;
}
