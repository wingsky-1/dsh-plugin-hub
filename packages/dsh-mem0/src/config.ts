/**
 * dsh-mem0 — 配置模型、默认值、校验与脱敏（遵循 DSH 规范）。
 *
 * 职责：
 * 1. 声明完整配置类型 Mem0Config 与默认值；
 * 2. schemastery Config schema，供 settings 服务注册与 GUI 渲染；
 * 3. 敏感 API Key 脱敏回显与非对称安全更新（防止脱敏字符串覆盖真实密钥）；
 * 4. 环境变量自动兜底机制（DEEPSEEK_API_KEY, SILICONFLOW_API_KEY 等）。
 */

import z from "schemastery";

export const SETTINGS_NS = "dsh-mem0";

/** 默认提取提示词指令（中文优先，直述事实）。 */
export const DEFAULT_CUSTOM_INSTRUCTIONS =
  "记忆必须使用简体中文撰写（命令、路径、专有名词、库名保留原文）。\n" +
  "只提取：用户的工作偏好与约定、明确的架构决策、项目背景与核心目标、排错与踩坑经验。\n" +
  "忽略：一次性指令、寒暄与过程性调试文本。直述事实，不加任何'用户表示/User said'等前缀。";

export interface Mem0Config {
  /** LLM Provider 端点类型（默认 openai 兼容端点）。 */
  llmProvider: string;
  /** LLM 服务 Base URL。 */
  llmBaseUrl: string;
  /** LLM API Key（可选，缺省时自动读取环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY）。 */
  llmApiKey?: string;
  /** LLM 模型名称。 */
  llmModel: string;
  /** LLM 采样温度（0.0 ~ 1.0，默认 0.1 保证抽取确定性）。 */
  llmTemperature: number;

  /** Embedder 向量服务 Provider 类型（默认 openai 兼容端点）。 */
  embedderProvider: string;
  /** Embedder 向量服务 Base URL（默认硅基流动免费端点）。 */
  embedderBaseUrl: string;
  /** Embedder API Key（可选，缺省时自动读取环境变量 SILICONFLOW_API_KEY / EMBEDDING_API_KEY）。 */
  embedderApiKey?: string;
  /** Embedder 向量模型名称。 */
  embedderModel: string;

  /** 检索返回的默认条数 TopK（1 ~ 20，默认 5）。 */
  retrievalTopK: number;
  /** 自定义事实提取补充准则。 */
  customInstructions: string;
  /** 是否向 Agent 单会话注入记忆纪律提示词（默认 true）。 */
  enablePromptDiscipline: boolean;
  /** Python 解释器二进制路径（默认 python3，可指定特定虚拟环境路径）。 */
  pythonBin: string;
}

export const DEFAULT_CONFIG: Mem0Config = {
  llmProvider: "openai",
  llmBaseUrl: "https://api.deepseek.com/v1",
  llmApiKey: "",
  llmModel: "deepseek-chat",
  llmTemperature: 0.1,

  embedderProvider: "openai",
  embedderBaseUrl: "https://api.siliconflow.cn/v1",
  embedderApiKey: "",
  embedderModel: "BAAI/bge-large-zh-v1.5",

  retrievalTopK: 5,
  customInstructions: DEFAULT_CUSTOM_INSTRUCTIONS,
  enablePromptDiscipline: true,
  pythonBin: "python3",
};

/**
 * schemastery Config schema，用于官方 settings 存储注册与校验。
 */
export const Config: z<Mem0Config> = z.object({
  llmProvider: z.string().default(DEFAULT_CONFIG.llmProvider),
  llmBaseUrl: z.string().default(DEFAULT_CONFIG.llmBaseUrl),
  llmApiKey: z.string().default(""),
  llmModel: z.string().default(DEFAULT_CONFIG.llmModel),
  llmTemperature: z.number().min(0).max(1).default(DEFAULT_CONFIG.llmTemperature),

  embedderProvider: z.string().default(DEFAULT_CONFIG.embedderProvider),
  embedderBaseUrl: z.string().default(DEFAULT_CONFIG.embedderBaseUrl),
  embedderApiKey: z.string().default(""),
  embedderModel: z.string().default(DEFAULT_CONFIG.embedderModel),

  retrievalTopK: z.natural().min(1).max(20).default(DEFAULT_CONFIG.retrievalTopK),
  customInstructions: z.string().default(DEFAULT_CONFIG.customInstructions),
  enablePromptDiscipline: z.boolean().default(DEFAULT_CONFIG.enablePromptDiscipline),
  pythonBin: z.string().default(DEFAULT_CONFIG.pythonBin),
});

/**
 * 脱敏 API Key（如 sk-1234567890abcdef -> sk-***cdef），保护密钥不回传前端完整明文。
 */
export function maskApiKey(key?: string): string {
  if (!key || typeof key !== "string") return "";
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "********";
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-4)}`;
}

/**
 * 判断传入的字符串是否为前端回传的脱敏掩码占位符。
 */
export function isMaskedKey(val?: string): boolean {
  if (!val || typeof val !== "string") return false;
  return val.includes("***") || val === "********";
}

/**
 * 解析并脱敏配置对象供前端安全展示。
 */
export function sanitizeConfigForClient(cfg: Mem0Config): Record<string, unknown> {
  return {
    ...cfg,
    llmApiKey: maskApiKey(cfg.llmApiKey),
    hasLlmApiKey: Boolean(cfg.llmApiKey && cfg.llmApiKey.trim()),
    embedderApiKey: maskApiKey(cfg.embedderApiKey),
    hasEmbedderApiKey: Boolean(cfg.embedderApiKey && cfg.embedderApiKey.trim()),
  };
}

/**
 * 解析与合并客户端提交的配置变更（防脱敏字符覆盖真实 Key）。
 */
export function mergeConfigPatch(current: Mem0Config, patch: Record<string, unknown>): Mem0Config {
  const next: Mem0Config = { ...current };

  if (typeof patch.llmProvider === "string" && patch.llmProvider.trim()) {
    next.llmProvider = patch.llmProvider.trim();
  }
  if (typeof patch.llmBaseUrl === "string" && patch.llmBaseUrl.trim()) {
    next.llmBaseUrl = patch.llmBaseUrl.trim();
  }
  if (typeof patch.llmModel === "string" && patch.llmModel.trim()) {
    next.llmModel = patch.llmModel.trim();
  }
  if (typeof patch.llmTemperature === "number" && !Number.isNaN(patch.llmTemperature)) {
    next.llmTemperature = Math.max(0, Math.min(1, patch.llmTemperature));
  }

  // 密钥处理：若传入非脱敏的真实新 Key 则覆盖；若传空或脱敏字符则保留原有 Key
  if (typeof patch.llmApiKey === "string") {
    const raw = patch.llmApiKey.trim();
    if (raw && !isMaskedKey(raw)) {
      next.llmApiKey = raw;
    }
  }

  if (typeof patch.embedderProvider === "string" && patch.embedderProvider.trim()) {
    next.embedderProvider = patch.embedderProvider.trim();
  }
  if (typeof patch.embedderBaseUrl === "string" && patch.embedderBaseUrl.trim()) {
    next.embedderBaseUrl = patch.embedderBaseUrl.trim();
  }
  if (typeof patch.embedderModel === "string" && patch.embedderModel.trim()) {
    next.embedderModel = patch.embedderModel.trim();
  }
  if (typeof patch.embedderApiKey === "string") {
    const raw = patch.embedderApiKey.trim();
    if (raw && !isMaskedKey(raw)) {
      next.embedderApiKey = raw;
    }
  }

  if (typeof patch.retrievalTopK === "number" && patch.retrievalTopK >= 1 && patch.retrievalTopK <= 20) {
    next.retrievalTopK = Math.floor(patch.retrievalTopK);
  }
  if (typeof patch.customInstructions === "string") {
    next.customInstructions = patch.customInstructions;
  }
  if (typeof patch.enablePromptDiscipline === "boolean") {
    next.enablePromptDiscipline = patch.enablePromptDiscipline;
  }
  if (typeof patch.pythonBin === "string" && patch.pythonBin.trim()) {
    next.pythonBin = patch.pythonBin.trim();
  }

  return next;
}
