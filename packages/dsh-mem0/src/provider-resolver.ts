/**
 * dsh-mem0 — DSH LLM Provider 与模型解析器（凭据静默解析 + loopback 路由数据源）。
 *
 * 核心能力：
 * 1. 动态拉取 DSH 全局配置的 LLM Provider 列表；
 * 2. 动态拉取指定 Provider 下的 Model 列表（带 5s 超时竞速、pending 异常拦截与 60s TTL 缓存）；
 * 3. 服务端静默解析 Provider 真实 Base URL 与 API Key（优先 DSH Seam，回落环境变量与 .credentials.yaml）；
 * 4. 前端只传递标识（dshProvider/dshModel），零凭据泄露风险。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dshHome } from "../../../shared/dsh-home.js";
import type { Mem0Config } from "./config.ts";

export interface ProviderItem {
  id: string;
  name?: string;
}

export interface ModelItem {
  id: string;
  name?: string;
}

/** 官方内置 Provider 默认 Base URL 兜底映射表。 */
const KNOWN_PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  openai: "https://api.openai.com/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  moonshot: "https://api.moonshot.cn/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
};

/** 服务端 60 秒模型列表 TTL 缓存。 */
interface ModelCacheEntry {
  expiresAt: number;
  models: ModelItem[];
}

const modelCache = new Map<string, ModelCacheEntry>();

/**
 * 获取 DSH 当前已注册的 LLM 提供商列表。
 */
export function listLlmProviders(ctx?: unknown): ProviderItem[] {
  if (!ctx || typeof ctx !== "object") return [];
  const anyCtx = ctx as { llm?: { listProviders?: () => unknown } };
  if (typeof anyCtx.llm?.listProviders !== "function") return [];

  try {
    const raw = anyCtx.llm.listProviders();
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is { id: string; name?: string } =>
        typeof (item as { id?: unknown })?.id === "string" && (item as { id: string }).id.length > 0)
      .map((item) => ({
        id: item.id,
        ...(typeof item.name === "string" && item.name.length > 0 ? { name: item.name } : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * 拉取指定 Provider 下的模型列表（带 5s 超时竞速、pending 异常拦截与 60s TTL 缓存）。
 */
export async function listLlmModels(
  ctx: unknown,
  provider: string,
): Promise<{ ok: boolean; models?: ModelItem[]; reason?: string }> {
  const trimmed = (provider || "").trim();
  if (!trimmed) {
    return { ok: false, reason: "empty-provider" };
  }

  // 1. 检查缓存
  const cached = modelCache.get(trimmed);
  if (cached && Date.now() < cached.expiresAt) {
    return { ok: true, models: cached.models };
  }

  if (!ctx || typeof ctx !== "object") {
    return { ok: false, reason: "no-llm-service" };
  }
  const anyCtx = ctx as { llm?: { listModels?: (p: string) => Promise<unknown> } };
  if (typeof anyCtx.llm?.listModels !== "function") {
    return { ok: false, reason: "no-list-models" };
  }

  let timer: NodeJS.Timeout | null = null;
  try {
    const pending = anyCtx.llm.listModels(trimmed);
    // 防御性捕获，避免未处理的 Promise 拒绝导致进程异常
    pending.catch(() => {});

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("discover-timeout")), 5000);
    });

    const raw = (await Promise.race([pending, timeout])) as unknown;
    const models: ModelItem[] = Array.isArray(raw)
      ? raw
          .filter((m): m is { id: string; name?: string } =>
            typeof (m as { id?: unknown })?.id === "string" && (m as { id: string }).id.length > 0)
          .map((m) => ({
            id: m.id,
            ...(typeof m.name === "string" && m.name.length > 0 ? { name: m.name } : {}),
          }))
      : [];

    modelCache.set(trimmed, {
      expiresAt: Date.now() + 60_000,
      models,
    });

    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "discover-failed",
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 转义正则特殊字符。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从 .credentials.yaml 按 keyName 读取密钥。 */
function credentialsKeyFromYaml(text: string, keyName: string): string | undefined {
  const match = text.match(new RegExp(`${escapeRegex(keyName)}\\s*:\\s*["']?([^"'\r\n#]+)`, "u"));
  if (match === null) return undefined;
  const key = match[1].trim();
  return key.length > 0 ? key : undefined;
}

/**
 * 通过 DSH 通用凭据 Seam 解析密钥。
 *
 * #612 防护纪律：宿主服务 seam（llm/settings/credentials）的任何调用都可能因
 * 服务未就绪、半卸载等状态同步抛错，全链 try-catch 兜底，失败静默降级到下一层兜底链，
 * 绝不让异常炸穿 buildEnvOverrides 断掉 executor 启动链。
 */
async function resolveViaCredentialSeam(provider: string, ctx?: unknown): Promise<string | undefined> {
  if (!ctx || typeof ctx !== "object") return undefined;
  try {
    const anyCtx = ctx as {
      llm?: { listConfigurableProviders?: () => Array<{ provider: string; settingsNs: string; settingsPath?: string[] }> };
      get?: (name: string) => unknown;
    };
    if (typeof anyCtx.llm?.listConfigurableProviders !== "function") return undefined;

    const dir = anyCtx.llm.listConfigurableProviders().find((c) => c.provider === provider);
    if (!dir) return undefined;

    const settings = anyCtx.get?.("settings") as { get?: (ns: string) => unknown } | undefined;
    const credentials = anyCtx.get?.("credentials") as { resolve?: (ref: string) => Promise<{ value?: string } | undefined> } | undefined;
    if (!settings || typeof settings.get !== "function") return undefined;
    if (!credentials || typeof credentials.resolve !== "function") return undefined;

    let node: unknown = settings.get(dir.settingsNs);
    for (const seg of dir.settingsPath ?? []) {
      node = (node as Record<string, unknown> | undefined)?.[seg];
    }
    const ref = (node as { apiKeyEnv?: string } | undefined)?.apiKeyEnv;
    if (typeof ref !== "string" || ref.length === 0) return undefined;

    const got = await credentials.resolve(ref);
    if (got && typeof got.value === "string" && got.value.length > 0) {
      return got.value;
    }
    return undefined;
  } catch {
    // 宿主服务 seam 未就绪/半卸载：静默降级到环境变量与 .credentials.yaml 兜底链
    return undefined;
  }
}

/**
 * 解析 Base URL（从 settings 中提取或回退已知内置提供商映射）。
 *
 * #612 防护纪律：#610 曾因 ctx.llm 未在 inject 声明，宿主服务属性访问同步抛错
 * 炸穿本函数导致 executor 永不启动。本函数是启动链关键路径，seam 调用全部
 * try-catch 兜底，失败一律回退 KNOWN_PROVIDER_BASE_URLS 内置映射。
 */
function resolveBaseUrl(provider: string, ctx?: unknown): string {
  if (ctx && typeof ctx === "object") {
    try {
      const anyCtx = ctx as {
        llm?: { listConfigurableProviders?: () => Array<{ provider: string; settingsNs: string; settingsPath?: string[] }> };
        get?: (name: string) => unknown;
      };
      if (typeof anyCtx.llm?.listConfigurableProviders === "function") {
        const dir = anyCtx.llm.listConfigurableProviders().find((c) => c.provider === provider);
        if (dir) {
          const settings = anyCtx.get?.("settings") as { get?: (ns: string) => unknown } | undefined;
          if (settings && typeof settings.get === "function") {
            let node: unknown = settings.get(dir.settingsNs);
            for (const seg of dir.settingsPath ?? []) {
              node = (node as Record<string, unknown> | undefined)?.[seg];
            }
            const endpoint = (node as { baseURL?: string; apiEndpoint?: string } | undefined)?.baseURL
              || (node as { baseURL?: string; apiEndpoint?: string } | undefined)?.apiEndpoint;
            if (typeof endpoint === "string" && endpoint.trim().length > 0) {
              return endpoint.trim();
            }
          }
        }
      }
    } catch {
      // 宿主服务 seam 未就绪/半卸载：静默回退内置映射，绝不让异常炸穿启动链
    }
  }

  const normalized = provider.toLowerCase();
  if (KNOWN_PROVIDER_BASE_URLS[normalized]) {
    return KNOWN_PROVIDER_BASE_URLS[normalized];
  }

  return "https://api.deepseek.com/v1";
}

/**
 * 解析 API Key（多层兜底链：DSH Seam -> 环境变量 -> .credentials.yaml）。
 */
async function resolveApiKey(provider: string, ctx?: unknown): Promise<string | undefined> {
  // 0. DSH 凭据 Seam
  try {
    const seamKey = await resolveViaCredentialSeam(provider, ctx);
    if (seamKey) return seamKey;
  } catch {
    // ignore
  }

  // 1. 环境变量 {PROVIDER}_API_KEY
  const envVar = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  const envKey = process.env[envVar];
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    return envKey.trim();
  }

  // 特殊官方环境变量名兜底
  if (provider === "deepseek" && process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY.trim();
  }
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY.trim();
  }

  // 2. .credentials.yaml
  try {
    const credPath = join(dshHome(), ".credentials.yaml");
    if (existsSync(credPath)) {
      const text = await readFile(credPath, "utf8");
      const fromYaml = credentialsKeyFromYaml(text, envVar);
      if (fromYaml) return fromYaml;
      if (provider === "deepseek") {
        const dsKey = credentialsKeyFromYaml(text, "DEEPSEEK_API_KEY");
        if (dsKey) return dsKey;
      }
    }
  } catch {
    // ignore
  }

  return undefined;
}

export interface ResolvedLlmRuntimeConfig {
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmTemperature: number;
}

/**
 * 核心解析入口：根据当前配置与 DSH 上下文，在服务端安全解析真实的 LLM 运行配置。
 */
export async function resolveLlmRuntimeConfig(
  config: Mem0Config,
  ctx?: unknown,
): Promise<ResolvedLlmRuntimeConfig> {
  if (config.llmMode === "custom") {
    return {
      llmProvider: config.llmProvider || "openai",
      llmBaseUrl: config.llmBaseUrl || "https://api.deepseek.com/v1",
      llmApiKey: config.llmApiKey || "",
      llmModel: config.llmModel || "deepseek-chat",
      llmTemperature: config.llmTemperature ?? 0.1,
    };
  }

  const provider = (config.llmDshProvider || "deepseek").trim();
  const model = (config.llmDshModel || "deepseek-chat").trim();

  const apiKey = (await resolveApiKey(provider, ctx)) || config.llmApiKey || "";
  const baseUrl = resolveBaseUrl(provider, ctx);

  return {
    llmProvider: "openai",
    llmBaseUrl: baseUrl,
    llmApiKey: apiKey,
    llmModel: model,
    llmTemperature: config.llmTemperature ?? 0.1,
  };
}
