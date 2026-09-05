/**
 * dsh-mem0 — 配置模型、默认值、校验与脱敏（遵循 DSH 规范）。
 *
 * 职责：
 * 1. 声明完整配置类型 Mem0Config 与默认值（默认使用本地 fastembed 零费用向量）；
 * 2. 导出每个模型的资源消耗与成本元数据，给用户透明的决策指引；
 * 3. schemastery Config schema，供 settings 服务注册与 GUI 渲染；
 * 4. 敏感 API Key 脱敏回显与非对称安全更新（防止脱敏字符串覆盖真实密钥）；
 * 5. 环境变量自动兜底机制（DEEPSEEK_API_KEY, SILICONFLOW_API_KEY 等）。
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

  /** Embedder 向量服务 Provider 类型（默认 fastembed 本地纯离线零费用）。 */
  embedderProvider: string;
  /** Embedder 向量服务 Base URL（若使用 OpenAI 兼容端点）。 */
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

/** 默认配置：默认采用本地 fastembed 本地向量，开箱即用零费用零密钥！ */
export const DEFAULT_CONFIG: Mem0Config = {
  llmProvider: "openai",
  llmBaseUrl: "https://api.deepseek.com/v1",
  llmApiKey: "",
  llmModel: "deepseek-chat",
  llmTemperature: 0.1,

  embedderProvider: "fastembed", // 默认本地 Embedding！
  embedderBaseUrl: "",
  embedderApiKey: "",
  embedderModel: "BAAI/bge-small-zh-v1.5",

  retrievalTopK: 5,
  customInstructions: DEFAULT_CUSTOM_INSTRUCTIONS,
  enablePromptDiscipline: true,
  pythonBin: "python3",
};

/**
 * 向量模型信息与消耗说明。
 */
export interface ModelCostInfo {
  name: string;
  provider: string;
  dims: number;
  isLocal: boolean;
  costZh: string;
  costEn: string;
  perfZh: string;
  perfEn: string;
}

export const EMBEDDER_MODELS_INFO: ModelCostInfo[] = [
  {
    name: "BAAI/bge-small-zh-v1.5",
    provider: "fastembed",
    dims: 512,
    isLocal: true,
    costZh: "【本地模型·默认推荐】永久完全免费，零网络请求，零 Token 计费",
    costEn: "[Local Model - Default] 100% Free, zero network requests, zero tokens",
    perfZh: "内存常驻仅 ~120MB，本地 CPU 计算毫秒级 (~5ms)，中文语义匹配度极高",
    perfEn: "RAM ~120MB, CPU latency ~5ms, high accuracy for Chinese",
  },
  {
    name: "BAAI/bge-base-zh-v1.5",
    provider: "fastembed",
    dims: 768,
    isLocal: true,
    costZh: "【本地模型】永久完全免费，零网络请求，零 Token 计费",
    costEn: "[Local Model] 100% Free, zero network requests, zero tokens",
    perfZh: "内存占用约 ~240MB，CPU 运算约 ~15ms，表达更精细的高维模型",
    perfEn: "RAM ~240MB, CPU latency ~15ms, 768-dim high precision",
  },
  {
    name: "BAAI/bge-large-zh-v1.5",
    provider: "openai",
    dims: 1024,
    isLocal: false,
    costZh: "【硅基流动云端】永久免费 (需配置 SiliconFlow 免费 API Key 与 Base URL)",
    costEn: "[SiliconFlow Cloud] 100% Free (requires SiliconFlow API Key & Base URL)",
    perfZh: "网络延迟约 100~200ms，1024 维超大模型高精度召回",
    perfEn: "Network latency ~100-200ms, 1024-dim large model recall",
  },
  {
    name: "text-embedding-3-small",
    provider: "openai",
    dims: 1536,
    isLocal: false,
    costZh: "【OpenAI 云端】约 $0.02 / 100万 tokens (约合 0.15 元 / 百万词)",
    costEn: "[OpenAI Cloud] ~$0.02 / 1M tokens",
    perfZh: "国际网络链路延迟，1536 维标准多语言模型",
    perfEn: "Standard multilingual model, 1536 dims",
  },
];

export const LLM_MODELS_INFO = [
  {
    name: "deepseek-chat",
    costZh: "输入 1 元 / 1M tokens，输出 2 元 / 1M tokens（单次记忆提炼消耗 ~200-400 tokens，单次成本约 0.0005 元人民币）",
    costEn: "Input 1 RMB/1M, Output 2 RMB/1M (~300 tokens per memory, ~$0.00007)",
  },
  {
    name: "gpt-4o-mini",
    costZh: "输入 $0.15 / 1M tokens，输出 $0.60 / 1M tokens（单次提炼约 0.0001 美元）",
    costEn: "Input $0.15/1M, Output $0.60/1M (~$0.0001 per extraction)",
  },
];

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
  if (typeof patch.embedderBaseUrl === "string") {
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
