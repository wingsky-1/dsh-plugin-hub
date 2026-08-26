/**
 * dsh-provider-usage — 配置归一化（单一职责：默认值 / schemastery schema / normalizeConfig）。
 *
 * #276 方案 A 阶段 3 拆分：自 index.ts 抽离，导出面由 index.ts 转发 re-export
 * 保持不变（外部消费者仍从 lib/index.js 导入）。
 */

import z from "schemastery";
import { OPENCODE_GO_PROVIDER } from "./adapters/opencode-go.ts";

export const DEFAULT_CONFIG = {
  adapter: "",
  staticPath: "",
  provider: OPENCODE_GO_PROVIDER,
  apiEndpoint: "",
  apiKey: "",
  historyDir: "",
  warmupIntervalMs: 300000,
  // #198 H1：由 60000 下调至 30000——峰谷徽标倒计时跨时段边界的展示翻转延迟
  // = 宿主缓存 + 客户端轮询（60s）+ 渲染余量，缓存减半使端到端 ≤95s 可达。
  cacheDurationMs: 30000,
  // #206 配套：2s→5s——commandcode 等三请求并行适配器在远端慢时 2s 频繁超时；
  // safeFetchData 为 Promise.race+Abort 纯异步超时，不阻塞主进程（#120 起超时会
  // 经合并信号真正 abort 底层 fetch）；
  // #120 后取数锁为 per-provider 粒度，排队仅发生在同一 provider 内部，
  // 最坏 n×5s 只限单 provider 的并发请求，跨 provider 完全并行。
  fetchTimeoutMs: 5000,
  autoReload: true,
  maxAgeDays: 30,
  maxSizeMB: 20,
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
}

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
}> = z.object({
  adapter: z.string().default("").description("用户适配器 mjs 文件路径（兼容配置声明；推荐经设置页「用量统计」添加）"),
  staticPath: z.string().default("").description("API 路径（如 /v1/usage；config.adapter 模式用）"),
  provider: z.string().default(OPENCODE_GO_PROVIDER).description("关联的模型 provider 名"),
  apiEndpoint: z.string().default("").description("API 基础地址（可选，不填使用内置默认或模型配置链）").disabled(true),
  warmupIntervalMs: z.number().default(DEFAULT_CONFIG.warmupIntervalMs).description("后台预热间隔毫秒").disabled(true),
  cacheDurationMs: z.number().default(DEFAULT_CONFIG.cacheDurationMs).description("缓存新鲜度毫秒").disabled(true),
  fetchTimeoutMs: z.number().default(DEFAULT_CONFIG.fetchTimeoutMs).description("取数超时毫秒").disabled(true),
  autoReload: z.boolean().default(true).description("热更新开关（编辑适配器 mjs 后自动重新加载；默认开启，可显式 false 关闭）"),
  maxAgeDays: z.number().default(DEFAULT_CONFIG.maxAgeDays).description("历史数据保留天数").disabled(true),
  maxSizeMB: z.number().default(DEFAULT_CONFIG.maxSizeMB).description("历史数据大小上限（MB）").disabled(true),
});

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
  if (Number.isFinite(cfg.warmupIntervalMs)) base.warmupIntervalMs = Math.max(60000, cfg.warmupIntervalMs as number);
  if (Number.isFinite(cfg.cacheDurationMs)) base.cacheDurationMs = Math.max(5000, cfg.cacheDurationMs as number);
  // fetchTimeoutMs 固定 5s（不开放配置）：远端慢时 2s 频繁超时（#206 配套）
  if (typeof cfg.autoReload === "boolean") base.autoReload = cfg.autoReload;
  // #184：maxAgeDays 仅接受正整数——<=0 会令 maybePrune 下界落在未来（历史被全量清理）、
  // 面板查询区间 start>end 永空；非正整数一律视为非法回落默认值，上界 365 维持既有 clamp
  if (Number.isInteger(cfg.maxAgeDays) && (cfg.maxAgeDays as number) > 0) {
    base.maxAgeDays = Math.min(365, cfg.maxAgeDays as number);
  }
  if (Number.isFinite(cfg.maxSizeMB)) base.maxSizeMB = Math.min(500, cfg.maxSizeMB as number);
  return base;
}