/**
 * dsh-mem0 — Web 设置页 Tab「记忆中心」组件。
 *
 * 遵循仓库规范：纯 React.createElement 构建，无 JSX/类型依赖。
 */

import * as React from "react";
import { t } from "../../../../shared/client/i18n.js";
import type { Mem0LocaleKey } from "./locales.ts";

function msg(key: Mem0LocaleKey): string {
  return t(key);
}

interface StatusData {
  ready: boolean;
  currentNamespace: string;
  globalNamespace: string;
  mode: string;
}

export function MemoryCenter() {
  const useState = React.useState;
  const useEffect = React.useEffect;
  const useCallback = React.useCallback;
  const useMemo = React.useMemo;

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
    fetchList(scope);
  }, [fetchStatus, fetchList, scope]);

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

  const parsedLines: string[] = useMemo(() => {
    if (!itemsText) return [];
    return itemsText
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean)
      .filter((l: string) => !query || l.toLowerCase().includes(query.toLowerCase()));
  }, [itemsText, query]);

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

  // Toolbar
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

  // Add Form
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
            "取消",
          ),
          React.createElement(
            "button",
            { className: "dsh-mem0-btn primary", onClick: handleAdd },
            msg("saveBtn"),
          ),
        ),
      )
    : null;

  // List View
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

  return React.createElement(
    "div",
    { className: "dsh-mem0-container" },
    header,
    toolbar,
    addForm,
    listContent,
  );
}
