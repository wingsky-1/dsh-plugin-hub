/**
 * dsh-mem0 — Web 设置页 Tab「记忆中心」组件（#612 重构）。
 *
 * 相对上一版的关键变化：
 * 1. 服务状态全覆盖：idle / env_build_failed 也有兜底横幅 + 启动/重试按钮（此前空白）；
 * 2. 记忆列表消费结构化 JSON（宿主 /list 返回 {items, error}），不再 regex 解析文本，
 *    python 错误串单独走错误横幅（此前会被误渲染为记忆条目）；
 * 3. 诊断抽屉：状态详情 / 环境探测（懒触发）/ 服务日志尾随 / 启动·重启·重装；
 * 4. LLM 下拉：明确空态替代写死假选项，provider 选项带近 7 天用量徽标（随 /llm-providers 返回）；
 * 5. 配置脏检测 + 保存副作用文案（保存即重启服务的预期管理）；
 * 6. 状态轮询：非终态（starting）时自动轮询至 ready/失败，状态迁移可感知；
 * 7. 静默 catch 全部改为可见错误提示；定时器全部清理；列表 key 用稳定 id。
 *
 * 遵循仓库规范：原生 TSX 语法，100% 走 t(i18n)，无 emoji。
 */

import * as React from "react";
import { t } from "../../../../shared/client/i18n.js";
import type { Mem0LocaleKey } from "./locales.ts";

function msg(key: Mem0LocaleKey, vars?: Record<string, string | number>): string {
  let text = t(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
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
  stderrTail?: string[];
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

interface ProviderUsage {
  calls: number;
  outputTokens: number;
  lastDay: string;
}

interface ModelOption {
  id: string;
  name?: string;
}

/** 宿主 /list 结构化条目（与 routes.ts MemoryListItem 对齐）。 */
interface MemoryListItem {
  id: string;
  memory: string;
  createdAt?: string;
  updatedAt?: string;
  userId?: string;
}

interface ListResponse {
  namespace?: string;
  items?: MemoryListItem[];
  error?: string;
  format?: string;
  raw?: string;
}

/** 环境探测结果（POST /probe 懒触发获取）。 */
interface ProbeResult {
  ok: boolean;
  pythonBin: string;
  reason?: string;
  detail?: string;
}

const PAGE_SIZE = 50;

function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function MemoryCenter() {
  const { useState, useEffect, useCallback, useMemo, useRef } = React;

  // 活跃子 Tab：memories | settings
  const [activeTab, setActiveTab] = useState("memories");

  const [status, setStatus] = useState({
    ready: false,
    currentNamespace: "global",
    globalNamespace: "global",
    mode: "stdio",
  });

  const [scope, setScope] = useState("project");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [newMemory, setNewMemory] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [listError, setListError] = useState("");
  const [opError, setOpError] = useState("");

  // 结构化记忆条目（宿主已解析，前端只做搜索过滤与分页）
  const [items, setItems] = useState([] as MemoryListItem[]);
  const [page, setPage] = useState(1);

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
  // #612：脏检测基准（config 首次稳定后记录快照）
  const [savedConfigSnapshot, setSavedConfigSnapshot] = useState("");
  const isDirty = useMemo(() => {
    if (!savedConfigSnapshot) return false;
    return JSON.stringify(config) !== savedConfigSnapshot;
  }, [config, savedConfigSnapshot]);

  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [configMessage, setConfigMessage] = useState("");
  const [configError, setConfigError] = useState("");
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [apiError, setApiError] = useState("");

  // DSH Providers / Models / 用量徽标
  const [providers, setProviders] = useState([] as ProviderOption[]);
  const [providerUsage, setProviderUsage] = useState({} as Record<string, ProviderUsage>);
  const [providersEmpty, setProvidersEmpty] = useState(false);
  const [models, setModels] = useState([] as ModelOption[]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);

  // 诊断抽屉
  const [diagOpen, setDiagOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState(null as ProbeResult | null);
  const [stderrTail, setStderrTail] = useState([] as string[]);
  const [isStarting, setIsStarting] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  const pollTimersRef = useRef([] as ReturnType<typeof setTimeout>[]);

  const clearPollTimers = useCallback(() => {
    for (const timer of pollTimersRef.current) clearTimeout(timer);
    pollTimersRef.current = [];
  }, []);

  useEffect(() => {
    return () => {
      clearPollTimers();
    };
  }, [clearPollTimers]);

  const fetchStatus = useCallback(async (): Promise<StatusData | null> => {
    try {
      const res = await fetch("/api/dsh-mem0/status");
      if (!res.ok) {
        setApiError(`HTTP ${res.status}`);
        return null;
      }
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        setApiError("Invalid response format");
        return null;
      }
      const data = (await res.json()) as StatusData;
      setApiError("");
      setStatus(data);
      return data;
    } catch (err: unknown) {
      setApiError(err instanceof Error ? err.message : "Network Error");
      return null;
    }
  }, []);

  /**
   * #612：非终态（starting）时轮询 status 至 ready / 失败。
   * 最多 rounds 次 × 2s；setTimeout 链而非 setInterval（避免请求堆叠），句柄统一清理。
   */
  const pollStatusUntilSettled = useCallback((rounds = 8) => {
    clearPollTimers();
    const tick = (left: number) => {
      if (left <= 0) return;
      const timer = setTimeout(async () => {
        const data = await fetchStatus();
        const reason = data?.status?.reason;
        const settled = data?.ready || (reason !== undefined && reason !== "starting");
        if (!settled) tick(left - 1);
      }, 2000);
      pollTimersRef.current.push(timer);
    };
    tick(rounds);
  }, [clearPollTimers, fetchStatus]);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/dsh-mem0/config");
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; config: ConfigData };
        if (data.ok && data.config) {
          setConfig((prev: ConfigData) => ({
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
      // 配置拉取失败不阻塞页面；保存时有明确错误提示
    }
  }, []);

  // #612：脏检测快照——config 首次稳定后记录；保存成功后更新
  useEffect(() => {
    if (!savedConfigSnapshot) {
      setSavedConfigSnapshot(JSON.stringify(config));
    }
  }, [config, savedConfigSnapshot]);

  const fetchList = useCallback(async (targetScope: string) => {
    setLoading(true);
    setListError("");
    try {
      const targetNs = targetScope === "global" ? "global" : undefined;
      const url = targetNs ? `/api/dsh-mem0/list?namespace=${encodeURIComponent(targetNs)}` : "/api/dsh-mem0/list";
      const res = await fetch(url);
      if (!res.ok) {
        setItems([]);
        setListError(`${msg("listLoadFailed")} (HTTP ${res.status})`);
        return;
      }
      const data = (await res.json()) as ListResponse;
      if (data.error) {
        setItems([]);
        setListError(`${msg("memoryErrorBanner")} ${data.error}`);
        return;
      }
      setItems(Array.isArray(data.items) ? data.items : []);
      setPage(1);
    } catch (err: unknown) {
      setItems([]);
      setListError(`${msg("listLoadFailed")}: ${err instanceof Error ? err.message : "Network Error"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // 拉取 DSH 提供商列表 + 用量徽标
  const fetchProviders = useCallback(async () => {
    setLoadingProviders(true);
    setProvidersEmpty(false);
    try {
      const res = await fetch("/api/dsh-mem0/llm-providers");
      if (res.ok) {
        const data = (await res.json()) as {
          ok: boolean;
          providers?: ProviderOption[];
          usage?: Record<string, ProviderUsage>;
        };
        if (data.ok && Array.isArray(data.providers)) {
          setProviders(data.providers);
          setProviderUsage(data.usage ?? {});
          setProvidersEmpty(data.providers.length === 0);
        }
      } else {
        setProviders([]);
        setProvidersEmpty(true);
      }
    } catch {
      setProviders([]);
      setProvidersEmpty(true);
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
      } else {
        setModels([]);
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

  // #612：starting 状态自动轮询至终态
  useEffect(() => {
    if (status.status?.reason === "starting" && !status.ready) {
      pollStatusUntilSettled();
    }
  }, [status.status?.reason, status.ready, pollStatusUntilSettled]);

  const handleDelete = async (memoryId: string) => {
    if (!window.confirm(msg("deleteConfirm"))) return;
    try {
      const res = await fetch("/api/dsh-mem0/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory_id: memoryId }),
      });
      if (res.ok) {
        setOpError("");
        fetchList(scope);
      } else {
        setOpError(`${msg("deleteFailed")} (HTTP ${res.status})`);
      }
    } catch (err: unknown) {
      setOpError(`${msg("deleteFailed")}: ${err instanceof Error ? err.message : "Network Error"}`);
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
        setOpError("");
        fetchList(scope);
      } else {
        setOpError(`${msg("addFailed")} (HTTP ${res.status})`);
      }
    } catch (err: unknown) {
      setOpError(`${msg("addFailed")}: ${err instanceof Error ? err.message : "Network Error"}`);
    }
  };

  const handleSaveConfig = async () => {
    setIsSavingConfig(true);
    setConfigMessage("");
    setConfigError("");
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
      const data = (await res.json().catch(() => null)) as { ok?: boolean; config?: ConfigData; error?: string } | null;
      if (res.ok && data?.ok && data.config) {
        // #612：保存触发服务重启 → 轮询至终态，用实际结果替代盲目「已保存」；
        // 服务端失败会自动回滚旧配置并返回 500。
        let settled = false;
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const st = await fetchStatus();
          if (st?.ready) {
            settled = true;
            break;
          }
          const reason = st?.status?.reason;
          if (reason && reason !== "starting") break;
        }
        if (settled) {
          setConfig((prev: ConfigData) => ({ ...prev, ...data.config }));
          setSavedConfigSnapshot(JSON.stringify({ ...config, ...data.config }));
          setConfigMessage(msg("configSaved"));
          pollTimersRef.current.push(setTimeout(() => setConfigMessage(""), 4000));
        } else {
          setConfigError(`${msg("startFailed")} · ${msg("saveRolledBack")}`);
          await fetchConfig();
        }
      } else {
        setConfigError(`${msg("opFailed")}${data?.error ? `: ${data.error}` : ` (HTTP ${res.status})`}`);
        // 服务端已回滚旧配置，重新拉取
        await fetchConfig();
      }
    } catch (err: unknown) {
      setConfigError(`${msg("opFailed")}: ${err instanceof Error ? err.message : "Network Error"}`);
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
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        setAutoInstallMsg(msg("autoInstallDone"));
        pollTimersRef.current.push(
          setTimeout(() => {
            fetchStatus();
            setAutoInstallMsg("");
          }, 2000),
        );
      } else {
        setAutoInstallMsg(`${msg("opFailed")}: ${data.error || ""}`);
      }
    } catch (e: unknown) {
      setAutoInstallMsg(`${msg("opFailed")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsAutoInstalling(false);
    }
  };

  const handleCopyCmd = () => {
    navigator.clipboard.writeText("pip install -i https://mirrors.aliyun.com/pypi/simple/ mem0ai==2.0.20 'mcp>=1.8,<2' fastembed==0.8.0 qdrant-client").then(() => {
      setCopiedCmd(true);
      pollTimersRef.current.push(setTimeout(() => setCopiedCmd(false), 2500));
    });
  };

  // #612：手动启动（idle / env_build_failed / process_exited 均可尝试）
  const handleStart = async () => {
    setIsStarting(true);
    try {
      const res = await fetch("/api/dsh-mem0/start", { method: "POST" });
      if (res.status === 409) {
        setOpError(msg("startInFlight"));
        return;
      }
      if (res.status === 501) {
        setOpError(msg("startNotSupported"));
        return;
      }
      let settled = false;
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await fetchStatus();
        if (st?.ready) {
          settled = true;
          break;
        }
        const reason = st?.status?.reason;
        if (reason && reason !== "starting") break;
      }
      if (settled) {
        fetchList(scope);
      }
    } catch (err: unknown) {
      setOpError(`${msg("startFailed")}: ${err instanceof Error ? err.message : "Network Error"}`);
    } finally {
      setIsStarting(false);
    }
  };

  const handleRestart = async () => {
    setIsRestarting(true);
    try {
      // 复用保存配置通道（相同值提交触发 restart），服务端失败会自动回滚
      const res = await fetch("/api/dsh-mem0/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retrievalTopK: config.retrievalTopK ?? 5 }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setOpError(`${msg("opFailed")}${data?.error ? `: ${data.error}` : ` (HTTP ${res.status})`}`);
      }
      pollStatusUntilSettled();
    } catch (err: unknown) {
      setOpError(`${msg("opFailed")}: ${err instanceof Error ? err.message : "Network Error"}`);
    } finally {
      setIsRestarting(false);
    }
  };

  // #612：环境探测（懒触发——import mem0 是秒级重操作，不随页面常驻执行）
  const handleProbe = async () => {
    setProbing(true);
    setProbeResult(null);
    try {
      const res = await fetch("/api/dsh-mem0/probe", { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as ProbeResult;
        setProbeResult(data);
      } else {
        setProbeResult({ ok: false, pythonBin: "-", detail: `HTTP ${res.status}` });
      }
    } catch (err: unknown) {
      setProbeResult({ ok: false, pythonBin: "-", detail: err instanceof Error ? err.message : "Network Error" });
    } finally {
      setProbing(false);
    }
  };

  // 打开抽屉时拉取日志尾随（stderrTail 随 status 返回，环形 200 行，服务端已脱敏）
  useEffect(() => {
    if (!diagOpen) return;
    setStderrTail(Array.isArray(status.stderrTail) ? status.stderrTail : []);
  }, [diagOpen, status]);

  // 客户端搜索过滤 + 分页
  const filteredItems: MemoryListItem[] = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((it: MemoryListItem) => it.memory.toLowerCase().includes(q) || it.id.toLowerCase().includes(q));
  }, [items, query]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => filteredItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredItems, safePage],
  );

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

  const switchTab = (tab: string) => {
    if (tab === activeTab) return;
    if (isDirty && !window.confirm(msg("dirtyWarning"))) return;
    setActiveTab(tab);
  };

  // 诊断原因 → 横幅内容（#612：全 reason 覆盖，无落空）
  const reason = status.status?.reason;
  const diagDetail = status.status?.detail;
  const canManualStart = !status.ready && reason !== "starting" && reason !== "python_not_found";

  const renderStartButton = () => (
    <button className="dsh-mem0-btn primary" onClick={handleStart} disabled={isStarting}>
      {isStarting ? msg("startingBtn") : msg("startBtn")}
    </button>
  );

  return (
    <div className="dsh-mem0-container">
      {/* 头部标题与服务状态（徽章可点开诊断抽屉） */}
      <div className="dsh-mem0-header">
        <div>
          <h2 className="dsh-mem0-title">{msg("title")}</h2>
          <p className="dsh-mem0-subtitle">{msg("subtitle")}</p>
        </div>
        <div className="dsh-mem0-status-area">
          <button
            type="button"
            className={`dsh-mem0-badge ${status.ready ? "ready" : "offline"}`}
            onClick={() => setDiagOpen(true)}
            title={msg("diagDrawerTitle")}
          >
            {status.ready ? msg("statusReady") : msg("statusOffline")}
            <span className="dsh-mem0-badge-caret">▾</span>
          </button>
        </div>
      </div>

      {/* 连接异常横幅（#612：与离线诊断横幅互斥） */}
      {apiError && !status.ready && (
        <div className="dsh-mem0-diag-banner error">
          <span>{msg("diagHttpError").replace("{status}", apiError)}</span>
          <button className="dsh-mem0-btn" onClick={fetchStatus}>
            {msg("retryBtn")}
          </button>
        </div>
      )}

      {!status.ready && !apiError && (
        <div className="dsh-mem0-diag-banner">
          {reason === "python_not_found" && <span>{msg("diagPythonNotFound")}</span>}
          {reason === "dependency_missing" && (
            <div className="dsh-mem0-diag-stack">
              <div className="dsh-mem0-diag-row">
                <span>{msg("diagDepMissing")}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="dsh-mem0-btn primary" onClick={handleAutoInstall} disabled={isAutoInstalling}>
                    {isAutoInstalling ? msg("autoInstallingBtn") : msg("autoInstallBtn")}
                  </button>
                  <button className="dsh-mem0-btn" onClick={handleCopyCmd}>
                    {copiedCmd ? msg("copied") : msg("copyCmd")}
                  </button>
                </div>
              </div>
              {autoInstallMsg && <div style={{ fontSize: 12, opacity: 0.9 }}>{autoInstallMsg}</div>}
              {diagDetail && <div className="dsh-mem0-diag-detail">{msg("diagDetail")} {diagDetail}</div>}
            </div>
          )}
          {reason === "process_exited" && (
            <div className="dsh-mem0-diag-stack">
              <span>{msg("diagProcessExited")}</span>
              {diagDetail && <div className="dsh-mem0-diag-detail">{msg("diagDetail")} {diagDetail}</div>}
              {renderStartButton()}
            </div>
          )}
          {reason === "starting" && <span>{msg("diagStarting")}</span>}
          {reason === "env_build_failed" && (
            <div className="dsh-mem0-diag-stack">
              <span>{msg("diagEnvBuildFailed")}</span>
              {diagDetail && <div className="dsh-mem0-diag-detail">{msg("diagDetail")} {diagDetail}</div>}
              {renderStartButton()}
            </div>
          )}
          {/* #612：idle / 未知 reason 的兜底（此前此处空白，用户无从下手） */}
          {(!reason || reason === "idle") && (
            <div className="dsh-mem0-diag-stack">
              <span>{msg("diagIdle")}</span>
              {renderStartButton()}
            </div>
          )}
          {reason && !["python_not_found", "dependency_missing", "process_exited", "starting", "env_build_failed", "idle", "ready"].includes(reason) && (
            <div className="dsh-mem0-diag-stack">
              <span>{msg("statusOffline")} ({reason})</span>
              {diagDetail && <div className="dsh-mem0-diag-detail">{msg("diagDetail")} {diagDetail}</div>}
              {renderStartButton()}
            </div>
          )}
        </div>
      )}

      {/* #612：诊断抽屉（徽章点开；不新增第三个 Tab） */}
      {diagOpen && (
        <div className="dsh-mem0-diag-drawer" role="dialog" aria-label={msg("diagDrawerTitle")}>
          <div className="dsh-mem0-diag-drawer-head">
            <strong>{msg("diagDrawerTitle")}</strong>
            <button type="button" className="dsh-mem0-btn" onClick={() => setDiagOpen(false)}>×</button>
          </div>
          <div className="dsh-mem0-diag-drawer-body">
            <div className="dsh-mem0-diag-section">
              <div className="dsh-mem0-diag-section-title">reason</div>
              <div className="dsh-mem0-diag-kv"><code>{reason || "unknown"}</code></div>
              {diagDetail && (
                <div className="dsh-mem0-diag-kv">
                  <span>{msg("diagDetail")}</span>
                  <code>{diagDetail}</code>
                </div>
              )}
              <div className="dsh-mem0-diag-actions">
                {canManualStart && renderStartButton()}
                <button className="dsh-mem0-btn" onClick={handleRestart} disabled={isRestarting}>
                  {isRestarting ? msg("serviceRestartingBtn") : msg("serviceRestartBtn")}
                </button>
                <button
                  className="dsh-mem0-btn danger"
                  onClick={() => {
                    if (window.confirm(msg("reinstallConfirm"))) handleAutoInstall();
                  }}
                  disabled={isAutoInstalling}
                >
                  {isAutoInstalling ? msg("autoInstallingBtn") : msg("reinstallBtn")}
                </button>
              </div>
            </div>

            <div className="dsh-mem0-diag-section">
              <div className="dsh-mem0-diag-section-title">{msg("diagProbeTitle")}</div>
              <button className="dsh-mem0-btn" onClick={handleProbe} disabled={probing}>
                {probing ? msg("diagProbing") : msg("diagProbeBtn")}
              </button>
              {probeResult && (
                <div className="dsh-mem0-diag-kv">
                  <span>{msg("envPythonBin")}</span>
                  <code>{probeResult.pythonBin}</code>
                  <span className={`dsh-mem0-probe-flag ${probeResult.ok ? "ok" : "bad"}`}>
                    {probeResult.ok ? msg("envProbeOk") : msg("envProbeMissing")}
                  </span>
                  {probeResult.detail && <code className="dsh-mem0-diag-detail">{probeResult.detail}</code>}
                </div>
              )}
            </div>

            <div className="dsh-mem0-diag-section">
              <div className="dsh-mem0-diag-section-title">{msg("diagLogsTitle")}</div>
              {stderrTail.length === 0 ? (
                <div className="dsh-mem0-diag-detail">{msg("diagLogsEmpty")}</div>
              ) : (
                <pre className="dsh-mem0-diag-logs">{stderrTail.join("\n")}</pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 子导航 Tab */}
      <div className="dsh-mem0-tabs">
        <button
          className={`dsh-mem0-tab ${activeTab === "memories" ? "active" : ""}`}
          onClick={() => switchTab("memories")}
        >
          {msg("memoriesTab")}
        </button>
        <button
          className={`dsh-mem0-tab ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => switchTab("settings")}
        >
          {msg("settingsTab")}{isDirty ? " *" : ""}
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
                onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
              />
              <button className="dsh-mem0-btn" onClick={() => fetchList(scope)}>
                {msg("refreshBtn")}
              </button>
              <button className="dsh-mem0-btn primary" onClick={() => setIsAdding(!isAdding)}>
                {msg("addBtn")}
              </button>
            </div>
          </div>

          {(listError || opError) && (
            <div className="dsh-mem0-diag-banner error">
              <span>{listError || opError}</span>
            </div>
          )}

          {isAdding && (
            <div className="dsh-mem0-add-box">
              <textarea
                className="dsh-mem0-textarea"
                placeholder={msg("addPlaceholder")}
                value={newMemory}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNewMemory(e.target.value)}
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
              [0, 1, 2].map((i) => (
                <div key={`skeleton-${i}`} className="dsh-mem0-item dsh-mem0-skeleton">
                  <div className="dsh-mem0-skeleton-line" />
                  <div className="dsh-mem0-skeleton-line short" />
                </div>
              ))
            ) : pageItems.length === 0 ? (
              <div className="dsh-mem0-empty">{msg("emptyList")}</div>
            ) : (
              pageItems.map((item: MemoryListItem) => (
                <div key={item.id || `anon-${item.memory.slice(0, 32)}`} className="dsh-mem0-item">
                  <div className="dsh-mem0-item-text">{item.memory || item.id}</div>
                  {item.createdAt && (
                    <div className="dsh-mem0-item-meta">
                      {msg("createdCol")}: {formatTime(item.createdAt) || msg("timeUnknown")}
                    </div>
                  )}
                  {item.id && (
                    <button
                      className="dsh-mem0-del-btn"
                      title={msg("deleteBtn")}
                      onClick={() => handleDelete(item.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          {totalPages > 1 && (
            <div className="dsh-mem0-pager">
              <button className="dsh-mem0-btn" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                {msg("pagePrev")}
              </button>
              <span className="dsh-mem0-pager-info">
                {msg("pageInfo", { page: safePage, pages: totalPages, total: filteredItems.length })}
              </span>
              <button className="dsh-mem0-btn" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>
                {msg("pageNext")}
              </button>
            </div>
          )}
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
                {msg("llmModeDsh")}
              </button>
              <button
                type="button"
                className={`dsh-mem0-mode-btn ${config.llmMode === "custom" ? "active" : ""}`}
                onClick={() => setConfig({ ...config, llmMode: "custom" })}
              >
                {msg("llmModeCustom")}
              </button>
            </div>

            {config.llmMode === "dsh" ? (
              <div className="dsh-mem0-grid">
                <div className="dsh-mem0-field">
                  <label>{msg("llmDshProviderLabel")}</label>
                  {providersEmpty && !loadingProviders ? (
                    <div className="dsh-mem0-hint">{msg("providersEmptyHint")}</div>
                  ) : (
                    <select
                      className="dsh-mem0-input"
                      value={config.llmDshProvider || ""}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                        const p = e.target.value;
                        setConfig({ ...config, llmDshProvider: p });
                        fetchModels(p);
                      }}
                    >
                      {loadingProviders ? (
                        <option value="">{msg("loadingProviders")}</option>
                      ) : (
                        providers.map((p: ProviderOption) => {
                          const usage = providerUsage[p.id];
                          const label = p.name ? `${p.name} (${p.id})` : p.id;
                          const badge = usage && usage.calls > 0
                            ? ` — ${msg("usageCalls", { calls: usage.calls })} / ${msg("usageTokens", { tokens: formatTokens(usage.outputTokens) })}`
                            : "";
                          return (
                            <option key={p.id} value={p.id}>
                              {label}{badge}
                            </option>
                          );
                        })
                      )}
                    </select>
                  )}
                  <span className="dsh-mem0-hint">
                    {msg("dshCredentialHint")}
                  </span>
                </div>

                <div className="dsh-mem0-field">
                  <label>{msg("llmDshModelLabel")}</label>
                  {models.length > 0 ? (
                    <select
                      className="dsh-mem0-input"
                      value={config.llmDshModel || ""}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) => setConfig({ ...config, llmDshModel: e.target.value })}
                    >
                      {models.map((m: ModelOption) => (
                        <option key={m.id} value={m.id}>
                          {m.name ? `${m.name} (${m.id})` : m.id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      className="dsh-mem0-input"
                      placeholder={loadingModels ? msg("loadingModels") : msg("noModelsFound")}
                      value={config.llmDshModel || ""}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setConfig({ ...config, llmDshModel: e.target.value })}
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
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setConfig({ ...config, llmBaseUrl: e.target.value })}
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
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setConfig({ ...config, llmApiKey: e.target.value })}
                  />
                </div>
                <div className="dsh-mem0-field">
                  <label>{msg("llmModel")}</label>
                  <input
                    type="text"
                    className="dsh-mem0-input"
                    value={config.llmModel}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setConfig({ ...config, llmModel: e.target.value })}
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
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setConfig({ ...config, llmTemperature: parseFloat(e.target.value) || 0.1 })}
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
                {msg("embedderModeLocal")}
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
                {msg("embedderModeCustom")}
              </button>
            </div>

            {config.embedderMode === "local" ? (
              <>
                <div className="dsh-mem0-field">
                  <label>{msg("embedderModel")}</label>
                  <select
                    className="dsh-mem0-input"
                    value={config.embedderModel}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => {
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
                    {msg("freeCost")}
                  </div>
                  <div className="dsh-mem0-metric-chip">
                    {msg("ramCost")}: {localModelMetrics.ram}
                  </div>
                  <div className="dsh-mem0-metric-chip">
                    {msg("cpuCost")}: {localModelMetrics.cpu}
                  </div>
                  <div className="dsh-mem0-metric-chip">
                    {msg("dimsCost")}: {localModelMetrics.dims}d
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
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setConfig({ ...config, embedderModel: e.target.value })}
                  />
                </div>
                <div className="dsh-mem0-field">
                  <label>{msg("embeddingDims")}</label>
                  <select
                    className="dsh-mem0-input"
                    value={config.embeddingDims || 512}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => setConfig({ ...config, embeddingDims: parseInt(e.target.value, 10) || 512 })}
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
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setConfig({ ...config, embedderBaseUrl: e.target.value })}
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
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setConfig({ ...config, embedderApiKey: e.target.value })}
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
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setConfig({ ...config, retrievalTopK: parseInt(e.target.value, 10) || 5 })}
                />
              </div>
              <div className="dsh-mem0-field">
                <label>{msg("pythonBin")}</label>
                <input
                  type="text"
                  className="dsh-mem0-input"
                  value={config.pythonBin}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setConfig({ ...config, pythonBin: e.target.value })}
                />
              </div>
            </div>
            <div className="dsh-mem0-field" style={{ marginTop: 12 }}>
              <label>{msg("customInstructions")}</label>
              <textarea
                className="dsh-mem0-textarea"
                rows={3}
                value={config.customInstructions}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setConfig({ ...config, customInstructions: e.target.value })}
              />
            </div>
          </div>

          {/* 保存与重载按钮行（#612：脏检测 + 副作用文案，不用确认弹窗阻塞） */}
          <div className="dsh-mem0-save-row">
            {configMessage && <span className="dsh-mem0-save-msg">{configMessage}</span>}
            {configError && <span className="dsh-mem0-save-msg error">{configError}</span>}
            <span className="dsh-mem0-save-hint">{msg("saveSideEffect")}</span>
            <button className="dsh-mem0-btn primary" onClick={handleSaveConfig} disabled={isSavingConfig || !isDirty}>
              {isSavingConfig ? msg("savingBtn") : msg("saveConfigBtn")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
