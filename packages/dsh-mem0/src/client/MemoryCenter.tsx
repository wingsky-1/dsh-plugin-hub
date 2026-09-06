/**
 * dsh-mem0 — Web 设置页 Tab「记忆中心」组件（阶段二：TSX 原生组件 + LLM 复用 + 向量精简与资源指示）。
 *
 * 遵循仓库规范：原生 TSX 语法，零手写 React.createElement，100% 走 t(i18n)。
 */

import * as React from "react";
import { t } from "../../../../shared/client/i18n.js";
import type { Mem0LocaleKey } from "./locales.ts";

function msg(key: Mem0LocaleKey): string {
  return t(key);
}

interface StatusData {
  ready: boolean;
  status?: {
    ready: boolean;
    reason: string;
    detail?: string;
  };
  currentNamespace: string;
  globalNamespace: string;
  mode: string;
}

interface ConfigData {
  llmMode?: "dsh" | "custom";
  llmDshProvider?: string;
  llmDshModel?: string;

  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  hasLlmApiKey?: boolean;
  llmModel: string;
  llmTemperature: number;

  embedderMode?: "local" | "custom";
  embedderProvider: string;
  embedderBaseUrl: string;
  embedderApiKey: string;
  hasEmbedderApiKey?: boolean;
  embedderModel: string;
  embeddingDims?: number;

  retrievalTopK: number;
  customInstructions: string;
  enablePromptDiscipline: boolean;
  pythonBin: string;
}

interface ProviderOption {
  id: string;
  name?: string;
}

interface ModelOption {
  id: string;
  name?: string;
}

export function MemoryCenter() {
  const { useState, useEffect, useCallback, useMemo } = React;

  // 活跃子 Tab：memories | settings
  const [activeTab, setActiveTab] = useState("memories");

  const [status, setStatus] = useState({
    ready: false,
    currentNamespace: "global",
    globalNamespace: "global",
    mode: "stdio",
  });

  const [scope, setScope] = useState("project");
  const [itemsText, setItemsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [newMemory, setNewMemory] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  // 配置表单状态
  const [config, setConfig] = useState({
    llmMode: "dsh",
    llmDshProvider: "deepseek",
    llmDshModel: "deepseek-chat",
    llmProvider: "openai",
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "",
    llmModel: "deepseek-chat",
    llmTemperature: 0.1,

    embedderMode: "local",
    embedderProvider: "fastembed",
    embedderBaseUrl: "",
    embedderApiKey: "",
    embedderModel: "BAAI/bge-small-zh-v1.5",
    embeddingDims: 512,

    retrievalTopK: 5,
    customInstructions: "",
    enablePromptDiscipline: true,
    pythonBin: "python3",
  });

  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [configMessage, setConfigMessage] = useState("");
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [apiError, setApiError] = useState(null);

  // DSH Providers 与 Models 动态拉取状态
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/dsh-mem0/status");
      if (!res.ok) {
        setApiError(`HTTP ${res.status}`);
        return;
      }
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        setApiError("Invalid response format");
        return;
      }
      const data = (await res.json()) as StatusData;
      setApiError(null);
      setStatus(data);
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : "Network Error");
    }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/dsh-mem0/config");
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; config: ConfigData };
        if (data.ok && data.config) {
          setConfig((prev: any) => ({
            ...prev,
            ...data.config,
            llmMode: data.config.llmMode ?? "dsh",
            llmDshProvider: data.config.llmDshProvider ?? "deepseek",
            llmDshModel: data.config.llmDshModel ?? "deepseek-chat",
            embedderMode: data.config.embedderMode ?? "local",
            embeddingDims: data.config.embeddingDims ?? 512,
          }));
        }
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchList = useCallback(async (targetScope: string) => {
    setLoading(true);
    try {
      const targetNs = targetScope === "global" ? "global" : undefined;
      const url = targetNs ? `/api/dsh-mem0/list?namespace=${encodeURIComponent(targetNs)}` : "/api/dsh-mem0/list";
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { result?: string };
        setItemsText(data.result || "");
      } else {
        setItemsText("");
      }
    } catch {
      setItemsText("");
    } finally {
      setLoading(false);
    }
  }, []);

  // 拉取 DSH 提供商列表
  const fetchProviders = useCallback(async () => {
    setLoadingProviders(true);
    try {
      const res = await fetch("/api/dsh-mem0/llm-providers");
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; providers?: ProviderOption[] };
        if (data.ok && Array.isArray(data.providers)) {
          setProviders(data.providers);
        }
      }
    } catch {
      // ignore
    } finally {
      setLoadingProviders(false);
    }
  }, []);

  // 根据选中的 Provider 拉取模型列表
  const fetchModels = useCallback(async (providerId: string) => {
    if (!providerId) {
      setModels([]);
      return;
    }
    setLoadingModels(true);
    try {
      const res = await fetch(`/api/dsh-mem0/llm-models?provider=${encodeURIComponent(providerId)}`);
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; models?: ModelOption[] };
        if (data.ok && Array.isArray(data.models)) {
          setModels(data.models);
        } else {
          setModels([]);
        }
      }
    } catch {
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchConfig();
    fetchList(scope);
    fetchProviders();
  }, [fetchStatus, fetchConfig, fetchList, fetchProviders, scope]);

  // 当处于设置页且处于 dsh 模式时，跟随当前 provider 拉取模型
  useEffect(() => {
    if (activeTab === "settings" && config.llmMode === "dsh" && config.llmDshProvider) {
      fetchModels(config.llmDshProvider);
    }
  }, [activeTab, config.llmMode, config.llmDshProvider, fetchModels]);

  const handleDelete = async (memoryId: string) => {
    if (!window.confirm(msg("deleteConfirm"))) return;
    try {
      const res = await fetch("/api/dsh-mem0/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory_id: memoryId }),
      });
      if (res.ok) {
        fetchList(scope);
      }
    } catch {
      // ignore
    }
  };

  const handleAdd = async () => {
    const trimmed = newMemory.trim();
    if (!trimmed) return;
    try {
      const targetNs = scope === "global" ? "global" : status.currentNamespace;
      const res = await fetch("/api/dsh-mem0/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, namespace: targetNs }),
      });
      if (res.ok) {
        setNewMemory("");
        setIsAdding(false);
        fetchList(scope);
      }
    } catch {
      // ignore
    }
  };

  const handleSaveConfig = async () => {
    setIsSavingConfig(true);
    setConfigMessage("");
    try {
      const payload = {
        ...config,
        embedderProvider: config.embedderMode === "local" ? "fastembed" : "openai",
      };
      const res = await fetch("/api/dsh-mem0/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; config: ConfigData };
        if (data.ok && data.config) {
          setConfig((prev: any) => ({ ...prev, ...data.config }));
        }
        setConfigMessage(msg("configSaved"));
        fetchStatus();
        setTimeout(() => setConfigMessage(""), 4000);
      } else {
        setConfigMessage(msg("opFailed"));
      }
    } catch {
      setConfigMessage(msg("opFailed"));
    } finally {
      setIsSavingConfig(false);
    }
  };

  const [isAutoInstalling, setIsAutoInstalling] = useState(false);
  const [autoInstallMsg, setAutoInstallMsg] = useState("");

  const handleAutoInstall = async () => {
    setIsAutoInstalling(true);
    setAutoInstallMsg(msg("autoInstallingBtn"));
    try {
      const res = await fetch("/api/dsh-mem0/install", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setAutoInstallMsg(msg("autoInstallDone"));
        setTimeout(() => {
          fetchStatus();
          setAutoInstallMsg("");
        }, 2000);
      } else {
        setAutoInstallMsg(`${msg("opFailed")}: ${data.error || ""}`);
      }
    } catch (e: any) {
      setAutoInstallMsg(`${msg("opFailed")}: ${e?.message || String(e)}`);
    } finally {
      setIsAutoInstalling(false);
    }
  };

  const handleCopyCmd = () => {
    navigator.clipboard.writeText("pip install -i https://mirrors.aliyun.com/pypi/simple/ mem0ai==2.0.20 'mcp>=1.8,<2' fastembed==0.8.0 qdrant-client").then(() => {
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2500);
    });
  };

  const parsedLines: string[] = useMemo(() => {
    if (!itemsText) return [];
    return itemsText
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean)
      .filter((l: string) => !query || l.toLowerCase().includes(query.toLowerCase()));
  }, [itemsText, query]);

  // 本地模型指标
  const localModelMetrics = useMemo(() => {
    const m = config.embedderModel.toLowerCase();
    if (m.includes("paraphrase")) {
      return { ram: "~80MB", cpu: "~3ms", dims: "384", desc: msg("descParaphrase") };
    }
    if (m.includes("e5-large")) {
      return { ram: "~400MB", cpu: "~25ms", dims: "1024", desc: msg("descE5Large") };
    }
    return { ram: "~120MB", cpu: "~5ms", dims: "512", desc: msg("descBgeSmall") };
  }, [config.embedderModel]);

  return (
    <div className="dsh-mem0-container">
      {/* 头部标题与服务状态 */}
      <div className="dsh-mem0-header">
        <div>
          <h2 className="dsh-mem0-title">{msg("title")}</h2>
          <p className="dsh-mem0-subtitle">{msg("subtitle")}</p>
        </div>
        <div className="dsh-mem0-status-area">
          <span className={`dsh-mem0-badge ${status.ready ? "ready" : "offline"}`}>
            {status.ready ? msg("statusReady") : msg("statusOffline")}
          </span>
        </div>
      </div>

      {/* 异常自愈横幅 */}
      {apiError && (
        <div className="dsh-mem0-diag-banner error">
          <span>⚠️ {msg("diagHttpError").replace("{status}", apiError)}</span>
          <button className="dsh-mem0-btn" onClick={fetchStatus}>
            {msg("retryBtn")}
          </button>
        </div>
      )}

      {!status.ready && !apiError && (
        <div className="dsh-mem0-diag-banner">
          {status.status?.reason === "python_not_found" && <span>⚠️ {msg("diagPythonNotFound")}</span>}
          {status.status?.reason === "dependency_missing" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <span>⚠️ {msg("diagDepMissing")}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="dsh-mem0-btn primary"
                    onClick={handleAutoInstall}
                    disabled={isAutoInstalling}
                  >
                    {isAutoInstalling ? msg("autoInstallingBtn") : msg("autoInstallBtn")}
                  </button>
                  <button className="dsh-mem0-btn" onClick={handleCopyCmd}>
                    {copiedCmd ? msg("copied") : msg("copyCmd")}
                  </button>
                </div>
              </div>
              {autoInstallMsg && <div style={{ fontSize: 12, opacity: 0.9 }}>{autoInstallMsg}</div>}
              {status.status?.detail && (
                <div className="dsh-mem0-diag-detail">
                  {msg("diagDetail")} {status.status.detail}
                </div>
              )}
            </div>
          )}
          {status.status?.reason === "process_exited" && <span>⚠️ {msg("diagProcessExited")}</span>}
          {status.status?.reason === "starting" && <span>⏳ {msg("diagStarting")}</span>}
        </div>
      )}

      {/* 子导航 Tab */}
      <div className="dsh-mem0-tabs">
        <button
          className={`dsh-mem0-tab ${activeTab === "memories" ? "active" : ""}`}
          onClick={() => setActiveTab("memories")}
        >
          📋 {msg("memoriesTab")}
        </button>
        <button
          className={`dsh-mem0-tab ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => setActiveTab("settings")}
        >
          ⚙️ {msg("settingsTab")}
        </button>
      </div>

      {/* Tab 1: 记忆管理列表 */}
      {activeTab === "memories" && (
        <>
          <div className="dsh-mem0-toolbar">
            <div className="dsh-mem0-scope-toggle">
              <button
                className={`dsh-mem0-scope-btn ${scope === "project" ? "active" : ""}`}
                onClick={() => setScope("project")}
              >
                {msg("scopeProject")} ({status.currentNamespace || "default"})
              </button>
              <button
                className={`dsh-mem0-scope-btn ${scope === "global" ? "active" : ""}`}
                onClick={() => setScope("global")}
              >
                {msg("scopeGlobal")}
              </button>
            </div>
            <div className="dsh-mem0-search-box">
              <input
                type="text"
                className="dsh-mem0-input"
                placeholder={msg("searchPlaceholder")}
                value={query}
                onChange={(e: any) => setQuery(e.target.value)}
              />
              <button className="dsh-mem0-btn" onClick={() => fetchList(scope)}>
                {msg("refreshBtn")}
              </button>
              <button className="dsh-mem0-btn primary" onClick={() => setIsAdding(!isAdding)}>
                {msg("addBtn")}
              </button>
            </div>
          </div>

          {isAdding && (
            <div className="dsh-mem0-add-box">
              <textarea
                className="dsh-mem0-textarea"
                placeholder={msg("addPlaceholder")}
                value={newMemory}
                onChange={(e: any) => setNewMemory(e.target.value)}
              />
              <div className="dsh-mem0-add-actions">
                <button className="dsh-mem0-btn primary" onClick={handleAdd}>
                  {msg("saveBtn")}
                </button>
                <button className="dsh-mem0-btn" onClick={() => setIsAdding(false)}>
                  {msg("cancelBtn")}
                </button>
              </div>
            </div>
          )}

          <div className="dsh-mem0-list">
            {loading ? (
              <div className="dsh-mem0-empty">{msg("loading")}</div>
            ) : parsedLines.length === 0 ? (
              <div className="dsh-mem0-empty">{msg("emptyList")}</div>
            ) : (
              parsedLines.map((line, idx) => {
                const match = line.match(/^-\s*\[(.*?)\]\s*(.*)$/) || line.match(/^-\s*(.*?)\s*\(id:\s*(.*?)\)/);
                const memoryId = match ? (match[1]?.length > 20 ? match[1] : match[2]) : "";
                const text = match ? (match[1]?.length > 20 ? match[2] : match[1]) : line;

                return (
                  <div key={idx} className="dsh-mem0-item">
                    <div className="dsh-mem0-item-text">{text || line}</div>
                    {memoryId && (
                      <button
                        className="dsh-mem0-del-btn"
                        title={msg("deleteBtn")}
                        onClick={() => handleDelete(memoryId)}
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {/* Tab 2: 引擎参数配置 */}
      {activeTab === "settings" && (
        <div className="dsh-mem0-config-panel">
          {/* LLM 接入配置 */}
          <div className="dsh-mem0-config-card">
            <div className="dsh-mem0-config-title">{msg("llmConfig")}</div>

            {/* LLM 模式切换 */}
            <div className="dsh-mem0-mode-toggle">
              <button
                type="button"
                className={`dsh-mem0-mode-btn ${config.llmMode === "dsh" ? "active" : ""}`}
                onClick={() => setConfig({ ...config, llmMode: "dsh" })}
              >
                🌟 {msg("llmModeDsh")}
              </button>
              <button
                type="button"
                className={`dsh-mem0-mode-btn ${config.llmMode === "custom" ? "active" : ""}`}
                onClick={() => setConfig({ ...config, llmMode: "custom" })}
              >
                🛠️ {msg("llmModeCustom")}
              </button>
            </div>

            {config.llmMode === "dsh" ? (
              <div className="dsh-mem0-grid">
                <div className="dsh-mem0-field">
                  <label>{msg("llmDshProviderLabel")}</label>
                  <select
                    className="dsh-mem0-input"
                    value={config.llmDshProvider || "deepseek"}
                    onChange={(e: any) => {
                      const p = e.target.value;
                      setConfig({ ...config, llmDshProvider: p });
                      fetchModels(p);
                    }}
                  >
                    {loadingProviders ? (
                      <option value="">{msg("loadingProviders")}</option>
                    ) : providers.length === 0 ? (
                      <>
                        <option value="deepseek">{msg("fallbackProviderDeepseek")}</option>
                        <option value="openai">{msg("fallbackProviderOpenai")}</option>
                      </>
                    ) : (
                      providers.map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {p.name ? `${p.name} (${p.id})` : p.id}
                        </option>
                      ))
                    )}
                  </select>
                  <span className="dsh-mem0-hint">
                    🔒 {msg("dshCredentialHint")}
                  </span>
                </div>

                <div className="dsh-mem0-field">
                  <label>{msg("llmDshModelLabel")}</label>
                  {models.length > 0 ? (
                    <select
                      className="dsh-mem0-input"
                      value={config.llmDshModel || "deepseek-chat"}
                      onChange={(e: any) => setConfig({ ...config, llmDshModel: e.target.value })}
                    >
                      {models.map((m: any) => (
                        <option key={m.id} value={m.id}>
                          {m.name ? `${m.name} (${m.id})` : m.id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      className="dsh-mem0-input"
                      placeholder={loadingModels ? msg("loadingModels") : "deepseek-chat"}
                      value={config.llmDshModel || ""}
                      onChange={(e: any) => setConfig({ ...config, llmDshModel: e.target.value })}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="dsh-mem0-grid">
                <div className="dsh-mem0-field">
                  <label>{msg("llmBaseUrl")}</label>
                  <input
                    type="text"
                    className="dsh-mem0-input"
                    value={config.llmBaseUrl}
                    onChange={(e: any) => setConfig({ ...config, llmBaseUrl: e.target.value })}
                  />
                </div>
                <div className="dsh-mem0-field">
                  <label>{msg("llmApiKey")}</label>
                  <input
                    type="password"
                    className="dsh-mem0-input"
                    placeholder={
                      config.hasLlmApiKey ? msg("apiKeyConfiguredPlaceholder") : msg("apiKeyEmptyPlaceholder")
                    }
                    value={config.llmApiKey}
                    onChange={(e: any) => setConfig({ ...config, llmApiKey: e.target.value })}
                  />
                </div>
                <div className="dsh-mem0-field">
                  <label>{msg("llmModel")}</label>
                  <input
                    type="text"
                    className="dsh-mem0-input"
                    value={config.llmModel}
                    onChange={(e: any) => setConfig({ ...config, llmModel: e.target.value })}
                  />
                </div>
                <div className="dsh-mem0-field">
                  <label>{msg("llmTemp")}</label>
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    className="dsh-mem0-input"
                    value={config.llmTemperature}
                    onChange={(e: any) => setConfig({ ...config, llmTemperature: parseFloat(e.target.value) || 0.1 })}
                  />
                </div>
              </div>
            )}
            <div className="dsh-mem0-model-tip" style={{ marginTop: 12 }}>
              {msg("llmCostDesc")}
            </div>
          </div>

          {/* Embedder 向量模型配置 */}
          <div className="dsh-mem0-config-card">
            <div className="dsh-mem0-config-title">{msg("embedderConfig")}</div>

            {/* 向量模式单选切换 */}
            <div className="dsh-mem0-mode-toggle">
              <button
                type="button"
                className={`dsh-mem0-mode-btn ${config.embedderMode === "local" ? "active" : ""}`}
                onClick={() =>
                  setConfig({
                    ...config,
                    embedderMode: "local",
                    embedderProvider: "fastembed",
                    embedderModel: "BAAI/bge-small-zh-v1.5",
                    embeddingDims: 512,
                  })
                }
              >
                ⚡ {msg("embedderModeLocal")}
              </button>
              <button
                type="button"
                className={`dsh-mem0-mode-btn ${config.embedderMode === "custom" ? "active" : ""}`}
                onClick={() =>
                  setConfig({
                    ...config,
                    embedderMode: "custom",
                    embedderProvider: "openai",
                  })
                }
              >
                ☁️ {msg("embedderModeCustom")}
              </button>
            </div>

            {config.embedderMode === "local" ? (
              <>
                <div className="dsh-mem0-field">
                  <label>{msg("embedderModel")}</label>
                  <select
                    className="dsh-mem0-input"
                    value={config.embedderModel}
                    onChange={(e: any) => {
                      const val = e.target.value;
                      const dims = val.includes("384") ? 384 : val.includes("1024") ? 1024 : 512;
                      setConfig({ ...config, embedderModel: val, embeddingDims: dims });
                    }}
                  >
                    <option value="BAAI/bge-small-zh-v1.5">{msg("optBgeSmall")}</option>
                    <option value="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2">
                      {msg("optParaphrase")}
                    </option>
                    <option value="intfloat/multilingual-e5-large">{msg("optE5Large")}</option>
                  </select>
                </div>

                {/* 流式硬件资源消耗指示卡片 */}
                <div className="dsh-mem0-metrics-row">
                  <div className="dsh-mem0-metric-chip highlight">
                    ✅ {msg("freeCost")}
                  </div>
                  <div className="dsh-mem0-metric-chip">
                    💾 {msg("ramCost")}: {localModelMetrics.ram}
                  </div>
                  <div className="dsh-mem0-metric-chip">
                    ⚡ {msg("cpuCost")}: {localModelMetrics.cpu}
                  </div>
                  <div className="dsh-mem0-metric-chip">
                    📐 {msg("dimsCost")}: {localModelMetrics.dims}d
                  </div>
                </div>
                <div className="dsh-mem0-model-tip" style={{ marginTop: 10 }}>
                  {localModelMetrics.desc}
                </div>
              </>
            ) : (
              <div className="dsh-mem0-grid">
                <div className="dsh-mem0-field">
                  <label>{msg("embedderModel")}</label>
                  <input
                    type="text"
                    className="dsh-mem0-input"
                    placeholder="BAAI/bge-large-zh-v1.5 / text-embedding-3-small"
                    value={config.embedderModel}
                    onChange={(e: any) => setConfig({ ...config, embedderModel: e.target.value })}
                  />
                </div>
                <div className="dsh-mem0-field">
                  <label>{msg("embeddingDims")}</label>
                  <select
                    className="dsh-mem0-input"
                    value={config.embeddingDims || 512}
                    onChange={(e: any) => setConfig({ ...config, embeddingDims: parseInt(e.target.value, 10) || 512 })}
                  >
                    <option value={512}>512d (bge-small)</option>
                    <option value={768}>768d (bge-base)</option>
                    <option value={1024}>1024d (bge-large / e5-large)</option>
                    <option value={1536}>1536d (OpenAI text-embedding-3-small)</option>
                    <option value={3072}>3072d (OpenAI text-embedding-3-large)</option>
                  </select>
                </div>
                <div className="dsh-mem0-field">
                  <label>{msg("embedderBaseUrl")}</label>
                  <input
                    type="text"
                    className="dsh-mem0-input"
                    placeholder="https://api.siliconflow.cn/v1"
                    value={config.embedderBaseUrl}
                    onChange={(e: any) => setConfig({ ...config, embedderBaseUrl: e.target.value })}
                  />
                </div>
                <div className="dsh-mem0-field">
                  <label>{msg("embedderApiKey")}</label>
                  <input
                    type="password"
                    className="dsh-mem0-input"
                    placeholder={
                      config.hasEmbedderApiKey ? msg("apiKeyConfiguredPlaceholder") : msg("apiKeyEmptyPlaceholder")
                    }
                    value={config.embedderApiKey}
                    onChange={(e: any) => setConfig({ ...config, embedderApiKey: e.target.value })}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 高级抽取参数与 Python 路径 */}
          <div className="dsh-mem0-config-card">
            <div className="dsh-mem0-config-title">{msg("advancedConfig")}</div>
            <div className="dsh-mem0-grid">
              <div className="dsh-mem0-field">
                <label>{msg("topK")}</label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  className="dsh-mem0-input"
                  value={config.retrievalTopK}
                  onChange={(e: any) => setConfig({ ...config, retrievalTopK: parseInt(e.target.value, 10) || 5 })}
                />
              </div>
              <div className="dsh-mem0-field">
                <label>{msg("pythonBin")}</label>
                <input
                  type="text"
                  className="dsh-mem0-input"
                  value={config.pythonBin}
                  onChange={(e: any) => setConfig({ ...config, pythonBin: e.target.value })}
                />
              </div>
            </div>
            <div className="dsh-mem0-field" style={{ marginTop: 12 }}>
              <label>{msg("customInstructions")}</label>
              <textarea
                className="dsh-mem0-textarea"
                rows={3}
                value={config.customInstructions}
                onChange={(e: any) => setConfig({ ...config, customInstructions: e.target.value })}
              />
            </div>
          </div>

          {/* 保存与重载按钮行 */}
          <div className="dsh-mem0-save-row">
            {configMessage && <span className="dsh-mem0-save-msg">{configMessage}</span>}
            <button className="dsh-mem0-btn primary" onClick={handleSaveConfig} disabled={isSavingConfig}>
              {isSavingConfig ? msg("savingBtn") : msg("saveConfigBtn")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
