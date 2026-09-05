/**
 * dsh-mem0 — 客户端双语字典（zh / en）。
 *
 * 遵循仓库 i18n 规范：zh 为 key 源，en 必须覆盖全部 key。
 * 严禁在客户端代码中硬编码任何人读文本。
 */

export const zh = {
  tabLabel: "记忆中心",
  title: "长期记忆中心",
  subtitle: "查看并管理跨会话的持久记忆、技术约定与用户偏好",
  mode: "运行模式",
  statusReady: "服务就绪 (stdio)",
  statusOffline: "服务未就绪",
  currentNs: "当前项目空间",
  searchPlaceholder: "检索记忆（语义搜索）…",
  searchBtn: "搜索",
  scopeAll: "全部空间",
  scopeProject: "当前项目",
  scopeGlobal: "全局空间",
  deleteConfirm: "确定要永久删除此条记忆吗？",
  deleteBtn: "删除",
  addBtn: "手工记录记忆",
  addPlaceholder: "输入要沉淀的技术决策、约定或偏好…",
  saveBtn: "保存",
  cancelBtn: "取消",
  emptyList: "当前空间暂无记录的记忆条目",
  refreshBtn: "刷新",
  loading: "加载中…",
  opSuccess: "操作成功",
  opFailed: "操作失败",

  // 阶段二：双区切换与配置中心
  memoriesTab: "记忆列表",
  settingsTab: "引擎配置",
  configSectionTitle: "记忆引擎与端点配置",
  configSectionSubtitle: "可动态配置 LLM、向量 Embedding 端点、中文提取规则与运行参数",
  llmConfig: "大语言模型 (LLM) 配置",
  llmBaseUrl: "API 基础端点 (Base URL)",
  llmApiKey: "API Key (留空保持原值)",
  llmModel: "模型名称 (Model)",
  llmTemp: "采样温度 (Temperature)",
  llmCostDesc: "💡 消耗说明：默认 deepseek-chat 单次记忆提炼消耗 ~200-400 tokens，单次成本约 0.0005 元人民币，几乎零成本。",

  embedderConfig: "向量模型 (Embedder) 配置",
  embedderProvider: "向量引擎类型",
  embedderProviderFastembed: "本地 FastEmbed (推荐，零费用，零网络)",
  embedderProviderOpenai: "OpenAI 兼容远程端点 (硅基流动 / 阿里云 / OpenAI)",
  embedderBaseUrl: "向量 API 端点 (Base URL)",
  embedderApiKey: "向量 API Key (留空保持原值)",
  embedderModel: "向量模型名称",
  embedderCostLabel: "📊 资源消耗与特点说明：",
  apiKeyConfiguredPlaceholder: "sk-•••• (已配置，留空保持原值)",
  apiKeyEmptyPlaceholder: "输入 API Key…",

  advancedConfig: "高级参数与抽取准则",
  topK: "默认检索条数 (TopK)",
  customInstructions: "中文事实提取补充指令",
  pythonBin: "Python 二进制执行路径",
  saveConfigBtn: "保存配置并热重启引擎",
  savingBtn: "正在保存与重载…",
  configSaved: "配置已保存，引擎热重启完成！",

  // 自愈诊断
  diagPythonNotFound: "未检测到 Python 可执行程序，长期记忆已安全降级。请在宿主环境安装 Python 3.10+。",
  diagDepMissing: "检测到缺少 Python 依赖库，请在终端执行一键安装：",
  copyCmd: "复制命令",
  copied: "已复制！",

  // 嵌入模型介绍说明
  optBgeSmall: "BAAI/bge-small-zh-v1.5 (本地推荐，512维)",
  optBgeBase: "BAAI/bge-base-zh-v1.5 (本地高精度，768维)",
  optBgeLarge: "BAAI/bge-large-zh-v1.5 (硅基流动云端，1024维)",
  optOpenAiSmall: "text-embedding-3-small (OpenAI云端，1536维)",
  descBgeSmall: "【本地模型·默认推荐】永久完全免费，零网络请求，零 Token 计费。内存仅占 ~120MB，CPU 毫秒级计算 (~5ms)，中文语义匹配表现优异。",
  descBgeBase: "【本地模型】永久完全免费，零网络请求，零 Token 计费。内存占用约 ~240MB，CPU 计算约 15ms，768 维高精度向量。",
  descBgeLarge: "【硅基流动云端】永久免费 (需配置 SiliconFlow API Key 与 Base URL)。网络延迟约 100~200ms，1024 维高精度召回。",
  descOpenAiSmall: "【OpenAI 云端】约 $0.02 / 100万 tokens (约合 0.15 元 / 百万词)。1536 维多语言标准模型，需海外网络。",
};

export type Mem0LocaleKey = keyof typeof zh;

export const en: Record<Mem0LocaleKey, string> = {
  tabLabel: "Memory Center",
  title: "Persistent Memory Center",
  subtitle: "Browse and manage long-term associative memories, decisions, and preferences",
  mode: "Mode",
  statusReady: "Service Ready (stdio)",
  statusOffline: "Service Offline",
  currentNs: "Current Project Namespace",
  searchPlaceholder: "Search memories (semantic)...",
  searchBtn: "Search",
  scopeAll: "All Scopes",
  scopeProject: "Current Project",
  scopeGlobal: "Global Scope",
  deleteConfirm: "Are you sure you want to permanently delete this memory?",
  deleteBtn: "Delete",
  addBtn: "Add Memory Manually",
  addPlaceholder: "Enter architectural decision, convention, or preference...",
  saveBtn: "Save",
  cancelBtn: "Cancel",
  emptyList: "No memories stored in this namespace",
  refreshBtn: "Refresh",
  loading: "Loading...",
  opSuccess: "Operation succeeded",
  opFailed: "Operation failed",

  // Phase 2
  memoriesTab: "Memories",
  settingsTab: "Engine Settings",
  configSectionTitle: "Memory Engine & Endpoint Configuration",
  configSectionSubtitle: "Dynamically configure LLM, embedding endpoint, extraction rules, and runtime options",
  llmConfig: "LLM Configuration",
  llmBaseUrl: "API Base URL",
  llmApiKey: "API Key (leave blank to keep current)",
  llmModel: "Model Name",
  llmTemp: "Temperature",
  llmCostDesc: "💡 Estimated Cost: Default deepseek-chat consumes ~200-400 tokens per memory (~$0.00007), nearly zero cost.",

  embedderConfig: "Embedder Configuration",
  embedderProvider: "Embedder Engine Type",
  embedderProviderFastembed: "Local FastEmbed (Recommended, 100% Free, Offline)",
  embedderProviderOpenai: "OpenAI-compatible Remote Endpoint (SiliconFlow / OpenAI)",
  embedderBaseUrl: "Embedder Base URL",
  embedderApiKey: "Embedder API Key (leave blank to keep current)",
  embedderModel: "Embedding Model Name",
  embedderCostLabel: "📊 Resource Cost & Characteristics:",
  apiKeyConfiguredPlaceholder: "sk-•••• (Configured, leave blank to keep current)",
  apiKeyEmptyPlaceholder: "Enter API Key...",

  advancedConfig: "Advanced Options & Instructions",
  topK: "Default Retrieval Limit (TopK)",
  customInstructions: "Custom Extraction Instructions",
  pythonBin: "Python Executable Path",
  saveConfigBtn: "Save & Hot Reload Engine",
  savingBtn: "Saving & Reloading...",
  configSaved: "Configuration saved and engine reloaded successfully!",

  // Self-healing Diagnostics
  diagPythonNotFound: "Python executable not detected. Memory is gracefully degraded. Please install Python 3.10+.",
  diagDepMissing: "Python dependencies missing. Please run in your terminal:",
  copyCmd: "Copy Command",
  copied: "Copied!",

  // Model Descriptions
  optBgeSmall: "BAAI/bge-small-zh-v1.5 (Local Default, 512 dims)",
  optBgeBase: "BAAI/bge-base-zh-v1.5 (Local High-dim, 768 dims)",
  optBgeLarge: "BAAI/bge-large-zh-v1.5 (SiliconFlow Cloud, 1024 dims)",
  optOpenAiSmall: "text-embedding-3-small (OpenAI Cloud, 1536 dims)",
  descBgeSmall: "[Local - Recommended Default] 100% Free, zero network requests, zero tokens. RAM ~120MB, CPU latency ~5ms, optimized for Chinese.",
  descBgeBase: "[Local] 100% Free, zero network requests, zero tokens. RAM ~240MB, CPU latency ~15ms, 768 dims.",
  descBgeLarge: "[SiliconFlow Cloud] 100% Free (requires SiliconFlow API Key & Base URL). Latency ~100-200ms, 1024 dims.",
  descOpenAiSmall: "[OpenAI Cloud] ~$0.02 / 1M tokens. 1536 dims standard multilingual model.",
};
