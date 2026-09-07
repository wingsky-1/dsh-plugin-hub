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
  /**
   * LLM 模式：dsh (复用 DSH 模型，推荐) | custom (自定义端点)。
   * 类型面放宽为 string 以对齐 schemastery schema 推导；写入前经 mergeConfigPatch 运行时白名单校验。
   */
  llmMode?: string;
  /** DSH 模型提供商标识（如 deepseek, openai 等）。 */
  llmDshProvider?: string;
  /** DSH 模型标识（如 deepseek-chat 等）。 */
  llmDshModel?: string;

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

  /**
   * Embedder 模式：local (本地离线 FastEmbed 推荐) | custom (远程云端 OpenAI 兼容)。
   * 类型面放宽为 string 以对齐 schemastery schema 推导；写入前经 mergeConfigPatch 运行时白名单校验。
   */
  embedderMode?: string;
  /** Embedder 向量服务 Provider 类型（默认 fastembed 本地纯离线零费用）。 */
  embedderProvider: string;
  /** Embedder 向量服务 Base URL（若使用 OpenAI 兼容端点）。 */
  embedderBaseUrl: string;
  /** Embedder API Key（可选，缺省时自动读取环境变量 SILICONFLOW_API_KEY / EMBEDDING_API_KEY）。 */
  embedderApiKey?: string;
  /** Embedder 向量模型名称。 */
  embedderModel: string;
  /** 向量维度（可选，默认按模型推导；自定义远程模型时可指定）。 */
  embeddingDims?: number;

  /** 检索返回的默认条数 TopK（1 ~ 20，默认 5）。 */
  retrievalTopK: number;
  /** 自定义事实提取补充准则。 */
  customInstructions: string;
  /** 是否向 Agent 单会话注入记忆纪律提示词（默认 true）。 */
  enablePromptDiscipline: boolean;
  /**
   * #581：会话首轮智能预检索注入总开关（默认 true）。
   * 关闭后全程不检索不注入，仅保留 memory_search 工具与既有纪律提示词。
   */
  enableSmartPreInjection: boolean;
  /**
   * #581：预检索注入相似度阈值（默认 0.6，取值 [0,1]，越界回退默认）。
   * 仅相似度分数严格大于该值的记忆条目参与注入。
   */
  preInjectionThreshold: number;
  /**
   * #581：预检索注入条数上限（默认 3，取值 [1,10]，越界回退默认）。
   * 按分数降序最多取 N 条；命中 0 条时零注入。
   */
  preInjectionLimit: number;
  /** Python 解释器二进制路径（默认 python3，可指定特定虚拟环境路径）。 */
  pythonBin: string;
}

/** 默认配置：默认采用本地 fastembed 本地向量，开箱即用零费用零密钥！ */
export const DEFAULT_CONFIG: Mem0Config = {
  llmMode: "dsh",
  llmDshProvider: "deepseek",
  llmDshModel: "deepseek-chat",
  llmProvider: "openai",
  llmBaseUrl: "https://api.deepseek.com/v1",
  llmApiKey: "",
  llmModel: "deepseek-chat",
  llmTemperature: 0.1,

  embedderMode: "local",
  embedderProvider: "fastembed", // 默认本地 Embedding！
  embedderBaseUrl: "",
  embedderApiKey: "",
  embedderModel: "BAAI/bge-small-zh-v1.5",
  embeddingDims: 512,

  retrievalTopK: 5,
  customInstructions: DEFAULT_CUSTOM_INSTRUCTIONS,
  enablePromptDiscipline: true,
  enableSmartPreInjection: true,
  preInjectionThreshold: 0.6,
  preInjectionLimit: 3,
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
  recommended?: boolean;
}

export const EMBEDDER_MODELS_INFO: ModelCostInfo[] = [
  {
    name: "BAAI/bge-small-zh-v1.5",
    provider: "fastembed",
    dims: 512,
    isLocal: true,
    recommended: true,
    costZh: "【本地模型·默认推荐】永久完全免费，零网络请求，零 Token 计费",
    costEn: "[Local Model - Default] 100% Free, zero network requests, zero tokens",
    perfZh: "内存常驻仅 ~120MB，本地 CPU 计算毫秒级 (~5ms)，中文语义匹配度极高",
    perfEn: "RAM ~120MB, CPU latency ~5ms, high accuracy for Chinese",
  },
  {
    name: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    provider: "fastembed",
    dims: 384,
    isLocal: true,
    costZh: "【本地模型·多语言极轻量】永久完全免费，零网络请求，超低显存/内存",
    costEn: "[Local Model - Lightweight] 100% Free, multilingual ultra-lightweight",
    perfZh: "内存占用仅 ~80MB，本地 CPU 极速运算 (~3ms)，适合资源受限环境",
    perfEn: "RAM ~80MB, CPU latency ~3ms, ideal for low-spec devices",
  },
  {
    name: "intfloat/multilingual-e5-large",
    provider: "fastembed",
    dims: 1024,
    isLocal: true,
    costZh: "【本地模型·高精多语言】永久完全免费，首启需下载 ~600MB 权重文件",
    costEn: "[Local Model - High Precision] 100% Free, first run downloads ~600MB weights",
    perfZh: "内存占用约 ~400MB，CPU 运算约 ~25ms，1024 维跨语言超强表征",
    perfEn: "RAM ~400MB, CPU latency ~25ms, 1024-dim strong multilingual representations",
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
  llmMode: z.string().default(DEFAULT_CONFIG.llmMode ?? "dsh"),
  llmDshProvider: z.string().default(DEFAULT_CONFIG.llmDshProvider ?? "deepseek"),
  llmDshModel: z.string().default(DEFAULT_CONFIG.llmDshModel ?? "deepseek-chat"),

  llmProvider: z.string().default(DEFAULT_CONFIG.llmProvider),
  llmBaseUrl: z.string().default(DEFAULT_CONFIG.llmBaseUrl),
  llmApiKey: z.string().default(""),
  llmModel: z.string().default(DEFAULT_CONFIG.llmModel),
  llmTemperature: z.number().min(0).max(1).default(DEFAULT_CONFIG.llmTemperature),

  embedderMode: z.string().default(DEFAULT_CONFIG.embedderMode ?? "local"),
  embedderProvider: z.string().default(DEFAULT_CONFIG.embedderProvider),
  embedderBaseUrl: z.string().default(DEFAULT_CONFIG.embedderBaseUrl),
  embedderApiKey: z.string().default(""),
  embedderModel: z.string().default(DEFAULT_CONFIG.embedderModel),
  embeddingDims: z.number().default(DEFAULT_CONFIG.embeddingDims ?? 512),

  retrievalTopK: z.natural().min(1).max(20).default(DEFAULT_CONFIG.retrievalTopK),
  customInstructions: z.string().default(DEFAULT_CONFIG.customInstructions),
  enablePromptDiscipline: z.boolean().default(DEFAULT_CONFIG.enablePromptDiscipline),
  enableSmartPreInjection: z.boolean().default(DEFAULT_CONFIG.enableSmartPreInjection),
  preInjectionThreshold: z.number().min(0).max(1).default(DEFAULT_CONFIG.preInjectionThreshold),
  preInjectionLimit: z.number().min(1).max(10).default(DEFAULT_CONFIG.preInjectionLimit),
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

  if (patch.llmMode === "dsh" || patch.llmMode === "custom") {
    next.llmMode = patch.llmMode;
  }
  if (typeof patch.llmDshProvider === "string" && patch.llmDshProvider.trim()) {
    next.llmDshProvider = patch.llmDshProvider.trim();
  }
  if (typeof patch.llmDshModel === "string" && patch.llmDshModel.trim()) {
    next.llmDshModel = patch.llmDshModel.trim();
  }

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

  if (patch.embedderMode === "local" || patch.embedderMode === "custom") {
    next.embedderMode = patch.embedderMode;
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
  if (typeof patch.embeddingDims === "number" && patch.embeddingDims > 0) {
    next.embeddingDims = Math.floor(patch.embeddingDims);
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
  // #581：三新键白名单；数值越界一律回退默认值（不落盘越界残值）
  if (typeof patch.enableSmartPreInjection === "boolean") {
    next.enableSmartPreInjection = patch.enableSmartPreInjection;
  }
  if (typeof patch.preInjectionThreshold === "number" && !Number.isNaN(patch.preInjectionThreshold)) {
    next.preInjectionThreshold = patch.preInjectionThreshold >= 0 && patch.preInjectionThreshold <= 1
      ? patch.preInjectionThreshold
      : DEFAULT_CONFIG.preInjectionThreshold;
  }
  if (typeof patch.preInjectionLimit === "number" && !Number.isNaN(patch.preInjectionLimit)) {
    next.preInjectionLimit = patch.preInjectionLimit >= 1 && patch.preInjectionLimit <= 10
      ? Math.floor(patch.preInjectionLimit)
      : DEFAULT_CONFIG.preInjectionLimit;
  }
  if (typeof patch.pythonBin === "string" && patch.pythonBin.trim()) {
    next.pythonBin = patch.pythonBin.trim();
  }

  return next;
}
