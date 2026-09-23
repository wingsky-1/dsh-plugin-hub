/**
 * dsh-jev-decide — 历史 tab（React，settings.section 独立页）。
 *
 * 要素：工作目录下拉 + 会话下拉过滤，条目倒序含概率条 + tier + 截断徽标 + 错误行，
 * 会话级清空两步确认仅调 DELETE 单会话。概率条细条 + 80% 阈值线（仅展示，判定以服务端
 * tier 为准）+ 数字；无图表库，手写 div。
 */
import * as React from "react";
import {
  APP_ROUTES,
  failureCategory,
  fetchTimeout,
  parseHistoryPayload,
} from "../api/interface.ts";
import type { JevHistoryEntry } from "../api/interface.ts";
import { t } from "../locale.ts";
import { fmtTime, shortId } from "./format.ts";
import { ProbBar, tierBadge } from "./prob.tsx";

const PAGE_LIMIT = 200;

function EntryItem({ entry }: { readonly entry: JevHistoryEntry }): React.ReactElement {
  const meta: string[] = [];
  if (entry.resultKind !== "") meta.push(entry.resultKind);
  if (entry.choice !== undefined && entry.choice !== "") meta.push("choice=" + entry.choice);
  meta.push("orig=" + entry.originalLength);
  meta.push(entry.automation);
  meta.push(entry.provider);
  meta.push(entry.latencyMs + "ms");
  return (
    <li className="dj-histItem">
      <div className="dj-histHead">
        <span className="dj-histTime">{fmtTime(entry.ts)}</span>
        {entry.rootDisplay !== "" && <span className="dj-badge">{entry.rootDisplay}</span>}
        <span className="dj-badge" title={entry.sessionId}>
          {entry.sessionTitle !== undefined && entry.sessionTitle !== ""
            ? entry.sessionTitle
            : shortId(entry.sessionId)}
        </span>
        {entry.presetId !== "" && (
          <span className="dj-badge" title={entry.presetId}>
            {(entry.presetTitle ?? entry.presetId) +
              (entry.templateVersion > 0 ? " v" + entry.templateVersion : "")}
          </span>
        )}
        <span className="dj-badge">{entry.lang}</span>
        {entry.truncated && <span className="dj-badge dj-badgeWarn">{t("truncBadge")}</span>}
        {tierBadge(entry.tier)}
      </div>
      {entry.snippetRedacted !== "" && (
        <div className="dj-histSnippet">{entry.snippetRedacted}</div>
      )}
      <ProbBar entry={entry} />
      <div className="dj-meta">{meta.join(" · ")}</div>
      {entry.questions !== undefined && entry.questions.length > 0 && (
        <ul className="dj-opts">
          {entry.questions.map((q) => (
            <li className="dj-opt" key={q.id}>
              <div className="dj-optHead">
                <span>{q.text}</span>
              </div>
              {q.options !== undefined && <div className="dj-meta">{q.options.join(" / ")}</div>}
            </li>
          ))}
        </ul>
      )}
      {entry.errorCode !== undefined && entry.errorCode !== "" && (
        <div className="dj-errLine">
          {t("errPrefix")}
          {entry.errorCode}
        </div>
      )}
    </li>
  );
}

type Msg = { readonly kind: "info" | "error"; readonly text: string };

export function HistoryPane(): React.ReactElement {
  const [entries, setEntries] = React.useState<JevHistoryEntry[]>([]);
  const [root, setRoot] = React.useState("");
  const [sessionId, setSessionId] = React.useState("");
  const [msg, setMsg] = React.useState<Msg | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [armed, setArmed] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fetchList = React.useCallback((wantRoot: string, wantSession: string) => {
    setArmed(false);
    setFailed(false);
    setMsg({ kind: "info", text: t("loading") });
    const q = new URLSearchParams();
    if (wantRoot !== "") q.set("root", wantRoot);
    if (wantSession !== "") q.set("sessionId", wantSession);
    q.set("limit", String(PAGE_LIMIT));
    void fetchTimeout(APP_ROUTES.history + "?" + q.toString(), {
      headers: { accept: "application/json" },
    })
      .then(async (res) => {
        if (!alive.current) return;
        if (!res.ok) {
          let cat = "http-" + res.status;
          try {
            cat = failureCategory(res.status, await res.json());
          } catch {
            /* 非 JSON 即保持状态码类别 */
          }
          throw new Error(cat);
        }
        const list = parseHistoryPayload(await res.json());
        list.sort((a, b) => b.ts - a.ts);
        setEntries(list);
        setMsg({ kind: "info", text: t("historyOrderNote") });
      })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setEntries([]);
        setFailed(true);
        setMsg({
          kind: "error",
          text: t("loadFail") + (e instanceof Error ? e.message : String(e)),
        });
      });
  }, []);

  React.useEffect(() => {
    fetchList(root, sessionId);
  }, [root, sessionId, fetchList]);

  const roots = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) {
      if (e.rootDisplay !== "" && !m.has(e.rootDisplay)) m.set(e.rootDisplay, e.rootHash);
    }
    return [...m.keys()].sort();
  }, [entries]);
  const sessions = React.useMemo(() => {
    const s = new Set<string>();
    for (const e of entries) if (e.sessionId !== "") s.add(e.sessionId);
    return [...s].sort();
  }, [entries]);

  const clear = (): void => {
    if (sessionId === "" || clearing) return;
    if (!armed) {
      setArmed(true);
      setMsg({ kind: "info", text: t("confirmClearAgain") });
      return;
    }
    setClearing(true);
    setMsg({ kind: "info", text: t("clearing") });
    const q = new URLSearchParams();
    if (root !== "") q.set("root", root);
    q.set("sessionId", sessionId);
    void fetchTimeout(APP_ROUTES.history + "?" + q.toString(), {
      method: "DELETE",
      headers: { accept: "application/json" },
    })
      .then(async (res) => {
        if (!alive.current) return;
        if (!res.ok) {
          let cat = "http-" + res.status;
          try {
            cat = failureCategory(res.status, await res.json());
          } catch {
            /* 非 JSON 即保持状态码类别 */
          }
          throw new Error(cat);
        }
        try {
          const b: unknown = await res.json();
          if (
            b !== null &&
            typeof b === "object" &&
            (b as Record<string, unknown>)["deleted"] === false
          ) {
            throw new Error("delete-not-confirmed");
          }
        } catch (e: unknown) {
          if (e instanceof Error && e.message === "delete-not-confirmed") throw e;
        }
        setArmed(false);
        setMsg({ kind: "info", text: t("clearOk") });
        fetchList(root, sessionId);
      })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setArmed(false);
        setMsg({
          kind: "error",
          text: t("clearFail") + (e instanceof Error ? e.message : String(e)),
        });
      })
      .finally(() => {
        if (alive.current) setClearing(false);
      });
  };

  return (
    <div className="dj-pane" data-tab="history">
      <div className="dj-fold">
        <button type="button" className="dj-foldHead" onClick={() => setFilterOpen((v) => !v)}>
          <span>{t("filterTitle")}</span>
          <span>{filterOpen ? "▾" : "▸"}</span>
        </button>
        <div className="dj-foldBody" hidden={!filterOpen}>
          <div className="dj-field">
            <label>{t("wsLabel")}</label>
            <select
              className="dj-select"
              autoComplete="off"
              aria-label={t("wsFilterAria")}
              value={root}
              onChange={(e) => setRoot(e.target.value)}
            >
              <option value="">{t("allWs")}</option>
              {roots.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="dj-field">
            <label>{t("sessLabel")}</label>
            <select
              className="dj-select"
              autoComplete="off"
              aria-label={t("sessFilterAria")}
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            >
              <option value="">{t("allSess")}</option>
              {sessions.map((id) => (
                <option key={id} value={id} title={id}>
                  {shortId(id, 12) + (id.length > 12 ? "…" : "")}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="dj-tools">
        <span className="dj-badge">{t("countEntries", { n: entries.length })}</span>
        <button
          type="button"
          className="dj-btn dj-btnSmall"
          onClick={() => fetchList(root, sessionId)}
        >
          {t("refresh")}
        </button>
        <button
          type="button"
          className="dj-btn dj-btnSmall dj-btnDanger"
          title={t("clearScopeNote")}
          disabled={sessionId === "" || clearing}
          onClick={clear}
        >
          {armed ? t("confirmClear") : t("clearSession")}
        </button>
      </div>
      {msg !== null && (
        <div className="dj-field">
          <span className={msg.kind === "error" ? "dj-errLine" : "dj-note"}>{msg.text}</span>
        </div>
      )}
      {failed && (
        <div className="dj-field">
          <button
            type="button"
            className="dj-btn dj-btnSmall"
            onClick={() => fetchList(root, sessionId)}
          >
            {t("retry")}
          </button>
        </div>
      )}
      <ul className="dj-hist">
        {entries.length === 0 && !failed ? (
          <div className="dj-note">{t("emptyHistory")}</div>
        ) : (
          entries.map((e, i) => (
            <EntryItem key={e.rootHash + "/" + e.sessionId + "/" + e.ts + "/" + i} entry={e} />
          ))
        )}
      </ul>
    </div>
  );
}
