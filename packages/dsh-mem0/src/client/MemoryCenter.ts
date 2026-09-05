/**
 * dsh-mem0 — Web 设置页 Tab「记忆中心」组件（阶段二：双区面板 + 全面配置化 + 模型消耗透明提示）。
 *
 * 遵循仓库规范：纯 React.createElement 构建，无 JSX/类型依赖。
 * 严禁任何硬编码人读文本，100% 走 msg(i18n)。
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
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  hasLlmApiKey?: boolean;
  llmModel: string;
  llmTemperature: number;

  embedderProvider: string;
  embedderBaseUrl: string;
  embedderApiKey: string;
  hasEmbedderApiKey?: boolean;
  embedderModel: string;

  retrievalTopK: number;
  customInstructions: string;
  enablePromptDiscipline: boolean;
  pythonBin: string;
}

export function MemoryCenter() {
  const useState = React.useState;
  const useEffect = React.useEffect;
  const useCallback = React.useCallback;
  const useMemo = React.useMemo;

  // 活跃子 Tab：memories | settings
  const [activeTab, setActiveTab] = useState("memories");

  const [status, setStatus] = useState({
    ready: false,
    currentNamespace: "global",
    globalNamespace: "global",
    mode: "stdio",
  } as StatusData);

  const [scope, setScope] = useState("project");
  const [itemsText, setItemsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [newMemory, setNewMemory] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  // 配置项表单状态
  const [config, setConfig] = useState({
    llmProvider: "openai",
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "",
    llmModel: "deepseek-chat",
    llmTemperature: 0.1,
    embedderProvider: "fastembed",
    embedderBaseUrl: "",
    embedderApiKey: "",
    embedderModel: "BAAI/bge-small-zh-v1.5",
    retrievalTopK: 5,
    customInstructions: "",
    enablePromptDiscipline: true,
    pythonBin: "python3",
  } as ConfigData);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [configMessage, setConfigMessage] = useState("");
  const [copiedCmd, setCopiedCmd] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/dsh-mem0/status");
      if (res.ok) {
        const data = (await res.json()) as StatusData;
        setStatus(data);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/dsh-mem0/config");
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; config: ConfigData };
        if (data.ok && data.config) {
          setConfig(data.config);
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

  useEffect(() => {
    fetchStatus();
    fetchConfig();
    fetchList(scope);
  }, [fetchStatus, fetchConfig, fetchList, scope]);

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
      const res = await fetch("/api/dsh-mem0/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; config: ConfigData };
        if (data.ok && data.config) {
          setConfig(data.config);
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

  // 根据当前选择的模型动态匹配消耗说明文案
  const embedderModelCostDesc = useMemo(() => {
    const m = config.embedderModel.toLowerCase();
    if (m.includes("bge-small")) return msg("descBgeSmall");
    if (m.includes("bge-base")) return msg("descBgeBase");
    if (m.includes("bge-large")) return msg("descBgeLarge");
    if (m.includes("text-embedding-3-small")) return msg("descOpenAiSmall");
    return config.embedderProvider === "fastembed" ? msg("descBgeSmall") : msg("descBgeLarge");
  }, [config.embedderModel, config.embedderProvider]);

  // Header
  const header = React.createElement(
    "div",
    { className: "dsh-mem0-header" },
    React.createElement(
      "div",
      null,
      React.createElement("h2", { className: "dsh-mem0-title" }, msg("title")),
      React.createElement("p", { className: "dsh-mem0-subtitle" }, msg("subtitle")),
    ),
    React.createElement(
      "span",
      { className: `dsh-mem0-badge ${status.ready ? "ready" : "offline"}` },
      status.ready ? msg("statusReady") : msg("statusOffline"),
    ),
  );

  // Diagnostic Banner (自愈引导)
  let diagBanner = null;
  const reason = status.status?.reason;
  if (!status.ready && reason) {
    if (reason === "python_not_found") {
      diagBanner = React.createElement(
        "div",
        { className: "dsh-mem0-diag-banner warning" },
        React.createElement("span", null, "⚠️ "),
        React.createElement("span", null, msg("diagPythonNotFound")),
      );
    } else if (reason === "dependency_missing") {
      diagBanner = React.createElement(
        "div",
        { className: "dsh-mem0-diag-banner warning", style: { flexDirection: "column", alignItems: "flex-start" } },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
          React.createElement("span", null, "⚠️ "),
          React.createElement("span", null, msg("diagDepMissing")),
          React.createElement(
            "button",
            {
              className: "dsh-mem0-btn primary small",
              disabled: isAutoInstalling,
              onClick: handleAutoInstall,
            },
            isAutoInstalling ? msg("autoInstallingBtn") : msg("autoInstallBtn"),
          ),
          React.createElement(
            "button",
            { className: "dsh-mem0-btn small", onClick: handleCopyCmd },
            copiedCmd ? msg("copied") : msg("copyCmd"),
          ),
        ),
        autoInstallMsg
          ? React.createElement(
              "div",
              { style: { fontSize: "12px", marginTop: "4px", color: "var(--dsw-alias-brand, #2563eb)" } },
              autoInstallMsg,
            )
          : null,
      );
    }
  }

  // Navigation Subtabs
  const navTabs = React.createElement(
    "div",
    { className: "dsh-mem0-tabs" },
    React.createElement(
      "button",
      {
        className: `dsh-mem0-tab-btn ${activeTab === "memories" ? "active" : ""}`,
        onClick: () => setActiveTab("memories"),
      },
      `📋 ${msg("memoriesTab")}`,
    ),
    React.createElement(
      "button",
      {
        className: `dsh-mem0-tab-btn ${activeTab === "settings" ? "active" : ""}`,
        onClick: () => setActiveTab("settings"),
      },
      `⚙️ ${msg("settingsTab")}`,
    ),
  );

  // Tab 1: Memories View
  let tab1Content = null;
  if (activeTab === "memories") {
    const toolbar = React.createElement(
      "div",
      { className: "dsh-mem0-toolbar" },
      React.createElement(
        "select",
        {
          className: "dsh-mem0-select",
          value: scope,
          onChange: (e: any) => setScope(e.target.value),
        },
        React.createElement("option", { value: "project" }, `${msg("scopeProject")} (${status.currentNamespace})`),
        React.createElement("option", { value: "global" }, msg("scopeGlobal")),
      ),
      React.createElement("input", {
        type: "text",
        className: "dsh-mem0-input",
        placeholder: msg("searchPlaceholder"),
        value: query,
        onChange: (e: any) => setQuery(e.target.value),
      }),
      React.createElement(
        "button",
        { className: "dsh-mem0-btn", onClick: () => fetchList(scope) },
        msg("refreshBtn"),
      ),
      React.createElement(
        "button",
        { className: "dsh-mem0-btn primary", onClick: () => setIsAdding(!isAdding) },
        msg("addBtn"),
      ),
    );

    const addForm = isAdding
      ? React.createElement(
          "div",
          { className: "dsh-mem0-card", style: { flexDirection: "column" } },
          React.createElement("textarea", {
            className: "dsh-mem0-input",
            rows: 3,
            placeholder: msg("addPlaceholder"),
            value: newMemory,
            onChange: (e: any) => setNewMemory(e.target.value),
            style: { width: "100%", resize: "vertical" },
          }),
          React.createElement(
            "div",
            { style: { display: "flex", justifyContent: "flex-end", gap: "8px", width: "100%" } },
            React.createElement(
              "button",
              { className: "dsh-mem0-btn", onClick: () => setIsAdding(false) },
              msg("cancelBtn"),
            ),
            React.createElement(
              "button",
              { className: "dsh-mem0-btn primary", onClick: handleAdd },
              msg("saveBtn"),
            ),
          ),
        )
      : null;

    let listContent: any;
    if (loading) {
      listContent = React.createElement("div", { className: "dsh-mem0-empty" }, msg("loading"));
    } else if (parsedLines.length === 0) {
      listContent = React.createElement("div", { className: "dsh-mem0-empty" }, msg("emptyList"));
    } else {
      const cards = parsedLines.map((line: string, idx: number) => {
        const idMatch =
          line.match(/^-\s*\[([a-zA-Z0-9_-]+)\]\s*(.*)$/) ||
          line.match(/^(?:-\s*)?(.*?)\s*\(id:\s*([a-zA-Z0-9_-]+)\)/);
        const memoryId = idMatch ? (idMatch[1].length > 10 ? idMatch[1] : idMatch[2]) : "";
        const content = idMatch ? (idMatch[1].length > 10 ? idMatch[2] : idMatch[1]) : line;

        return React.createElement(
          "div",
          { key: idx, className: "dsh-mem0-card" },
          React.createElement(
            "div",
            { style: { flex: 1 } },
            React.createElement("div", { className: "dsh-mem0-card-content" }, content),
            memoryId
              ? React.createElement("div", { className: "dsh-mem0-card-meta" }, `ID: ${memoryId}`)
              : null,
          ),
          memoryId
            ? React.createElement(
                "button",
                {
                  className: "dsh-mem0-del-btn",
                  onClick: () => handleDelete(memoryId),
                },
                msg("deleteBtn"),
              )
            : null,
        );
      });
      listContent = React.createElement("div", { className: "dsh-mem0-list" }, ...cards);
    }

    tab1Content = React.createElement(
      React.Fragment,
      null,
      toolbar,
      addForm,
      listContent,
    );
  }

  // Tab 2: Settings View
  let tab2Content = null;
  if (activeTab === "settings") {
    // LLM Section
    const llmSection = React.createElement(
      "div",
      { className: "dsh-mem0-config-card" },
      React.createElement("h3", { className: "dsh-mem0-config-title" }, `🤖 ${msg("llmConfig")}`),
      React.createElement(
        "div",
        { className: "dsh-mem0-grid" },
        React.createElement(
          "div",
          { className: "dsh-mem0-field" },
          React.createElement("label", null, msg("llmBaseUrl")),
          React.createElement("input", {
            type: "text",
            className: "dsh-mem0-input",
            value: config.llmBaseUrl,
            onChange: (e: any) => setConfig({ ...config, llmBaseUrl: e.target.value }),
          }),
        ),
        React.createElement(
          "div",
          { className: "dsh-mem0-field" },
          React.createElement("label", null, msg("llmApiKey")),
          React.createElement("input", {
            type: "password",
            className: "dsh-mem0-input",
            placeholder: config.hasLlmApiKey ? msg("apiKeyConfiguredPlaceholder") : msg("apiKeyEmptyPlaceholder"),
            value: config.llmApiKey,
            onChange: (e: any) => setConfig({ ...config, llmApiKey: e.target.value }),
          }),
        ),
        React.createElement(
          "div",
          { className: "dsh-mem0-field" },
          React.createElement("label", null, msg("llmModel")),
          React.createElement("input", {
            type: "text",
            className: "dsh-mem0-input",
            value: config.llmModel,
            onChange: (e: any) => setConfig({ ...config, llmModel: e.target.value }),
          }),
        ),
        React.createElement(
          "div",
          { className: "dsh-mem0-field" },
          React.createElement("label", null, `${msg("llmTemp")} (0.0 - 1.0)`),
          React.createElement("input", {
            type: "number",
            step: "0.05",
            min: "0",
            max: "1",
            className: "dsh-mem0-input",
            value: config.llmTemperature,
            onChange: (e: any) => setConfig({ ...config, llmTemperature: parseFloat(e.target.value) || 0 }),
          }),
        ),
      ),
      React.createElement(
        "div",
        { className: "dsh-mem0-model-tip", style: { marginTop: "10px" } },
        msg("llmCostDesc"),
      ),
    );

    // Embedder Section
    const embedderSection = React.createElement(
      "div",
      { className: "dsh-mem0-config-card" },
      React.createElement("h3", { className: "dsh-mem0-config-title" }, `🧬 ${msg("embedderConfig")}`),
      React.createElement(
        "div",
        { className: "dsh-mem0-grid" },
        React.createElement(
          "div",
          { className: "dsh-mem0-field" },
          React.createElement("label", null, msg("embedderProvider")),
          React.createElement(
            "select",
            {
              className: "dsh-mem0-select",
              value: config.embedderProvider,
              onChange: (e: any) => {
                const prov = e.target.value;
                setConfig({
                  ...config,
                  embedderProvider: prov,
                  embedderModel: prov === "fastembed" ? "BAAI/bge-small-zh-v1.5" : "BAAI/bge-large-zh-v1.5",
                  embedderBaseUrl: prov === "openai" ? "https://api.siliconflow.cn/v1" : "",
                });
              },
            },
            React.createElement("option", { value: "fastembed" }, msg("embedderProviderFastembed")),
            React.createElement("option", { value: "openai" }, msg("embedderProviderOpenai")),
          ),
        ),
        React.createElement(
          "div",
          { className: "dsh-mem0-field" },
          React.createElement("label", null, msg("embedderModel")),
          React.createElement(
            "select",
            {
              className: "dsh-mem0-select",
              value: config.embedderModel,
              onChange: (e: any) => setConfig({ ...config, embedderModel: e.target.value }),
            },
            React.createElement("option", { value: "BAAI/bge-small-zh-v1.5" }, msg("optBgeSmall")),
            React.createElement("option", { value: "BAAI/bge-base-zh-v1.5" }, msg("optBgeBase")),
            React.createElement("option", { value: "BAAI/bge-large-zh-v1.5" }, msg("optBgeLarge")),
            React.createElement("option", { value: "text-embedding-3-small" }, msg("optOpenAiSmall")),
          ),
        ),
        config.embedderProvider === "openai"
          ? React.createElement(
              "div",
              { className: "dsh-mem0-field" },
              React.createElement("label", null, msg("embedderBaseUrl")),
              React.createElement("input", {
                type: "text",
                className: "dsh-mem0-input",
                placeholder: "https://api.siliconflow.cn/v1",
                value: config.embedderBaseUrl,
                onChange: (e: any) => setConfig({ ...config, embedderBaseUrl: e.target.value }),
              }),
            )
          : null,
        config.embedderProvider === "openai"
          ? React.createElement(
              "div",
              { className: "dsh-mem0-field" },
              React.createElement("label", null, msg("embedderApiKey")),
              React.createElement("input", {
                type: "password",
                className: "dsh-mem0-input",
                placeholder: config.hasEmbedderApiKey ? msg("apiKeyConfiguredPlaceholder") : msg("apiKeyEmptyPlaceholder"),
                value: config.embedderApiKey,
                onChange: (e: any) => setConfig({ ...config, embedderApiKey: e.target.value }),
              }),
            )
          : null,
      ),
      React.createElement(
        "div",
        { className: "dsh-mem0-model-tip", style: { marginTop: "12px" } },
        React.createElement("strong", null, msg("embedderCostLabel")),
        React.createElement("div", { style: { marginTop: "4px" } }, embedderModelCostDesc),
      ),
    );

    // Advanced Options Section
    const advancedSection = React.createElement(
      "div",
      { className: "dsh-mem0-config-card" },
      React.createElement("h3", { className: "dsh-mem0-config-title" }, `⚙️ ${msg("advancedConfig")}`),
      React.createElement(
        "div",
        { className: "dsh-mem0-grid" },
        React.createElement(
          "div",
          { className: "dsh-mem0-field" },
          React.createElement("label", null, msg("topK")),
          React.createElement("input", {
            type: "number",
            min: "1",
            max: "20",
            className: "dsh-mem0-input",
            value: config.retrievalTopK,
            onChange: (e: any) => setConfig({ ...config, retrievalTopK: parseInt(e.target.value, 10) || 5 }),
          }),
        ),
        React.createElement(
          "div",
          { className: "dsh-mem0-field" },
          React.createElement("label", null, msg("pythonBin")),
          React.createElement("input", {
            type: "text",
            className: "dsh-mem0-input",
            value: config.pythonBin,
            onChange: (e: any) => setConfig({ ...config, pythonBin: e.target.value }),
          }),
        ),
      ),
      React.createElement(
        "div",
        { className: "dsh-mem0-field", style: { marginTop: "12px" } },
        React.createElement("label", null, msg("customInstructions")),
        React.createElement("textarea", {
          rows: 4,
          className: "dsh-mem0-input",
          style: { width: "100%", resize: "vertical" },
          value: config.customInstructions,
          onChange: (e: any) => setConfig({ ...config, customInstructions: e.target.value }),
        }),
      ),
    );

    // Save Button & Notification
    const saveRow = React.createElement(
      "div",
      { className: "dsh-mem0-save-row" },
      configMessage ? React.createElement("span", { className: "dsh-mem0-save-msg" }, configMessage) : null,
      React.createElement(
        "button",
        {
          className: "dsh-mem0-btn primary",
          disabled: isSavingConfig,
          onClick: handleSaveConfig,
        },
        isSavingConfig ? msg("savingBtn") : msg("saveConfigBtn"),
      ),
    );

    tab2Content = React.createElement(
      React.Fragment,
      null,
      llmSection,
      embedderSection,
      advancedSection,
      saveRow,
    );
  }

  return React.createElement(
    "div",
    { className: "dsh-mem0-container" },
    header,
    diagBanner,
    navTabs,
    tab1Content,
    tab2Content,
  );
}
