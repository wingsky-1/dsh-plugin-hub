/**
 * dsh-jev-decide — 连接 tab（React，settings.section 独立页）。
 *
 * 要素：密钥二选一卡（radio 互斥，未选中轨整体隐藏；切轨保存自动清对方）/
 * 离线自检 / 高级折叠 / 保存。Key 永不回显原文；placeholder 禁真密钥示例。
 * 保存语义与 vanilla 一致：互斥阻断、ENV 形状校验、明文免二次确认、
 * 未知键永不发送、保存后清空明文框并重载掩码态。
 */
import * as React from "react";
import {
  APP_ROUTES,
  failureCategory,
  fetchTimeout,
  parseConfigPayload,
  validApiKeyRef,
} from "../api/interface.ts";
import type { JevConfigV1 } from "../api/interface.ts";
import { t } from "../locale.ts";

type Msg = { readonly kind: "info" | "error" | "ok"; readonly text: string };

export function ConnectionPane(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<JevConfigV1 | null>(null);
  const [keyMode, setKeyMode] = React.useState<"env" | "plain">("env");
  const [env, setEnv] = React.useState("");
  const [plain, setPlain] = React.useState("");
  const [timeoutMs, setTimeoutMs] = React.useState("8000");
  const [maxConcurrency, setMaxConcurrency] = React.useState("4");
  const [truncBudget, setTruncBudget] = React.useState("32000");
  const [perSession, setPerSession] = React.useState("200");
  const [totalSessions, setTotalSessions] = React.useState("50");
  const [msg, setMsg] = React.useState<Msg | null>(null);
  const [testOut, setTestOut] = React.useState("");
  const [testing, setTesting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [plainOpen, setPlainOpen] = React.useState(false);
  const [advOpen, setAdvOpen] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = React.useCallback(() => {
    setFailed(false);
    setMsg({ kind: "info", text: t("loading") });
    void fetchTimeout(APP_ROUTES.config, { headers: { accept: "application/json" } })
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
        const cfg = parseConfigPayload(await res.json());
        if (cfg === null) throw new Error("config-shape-unknown");
        setSnapshot(cfg);
        setEnv(cfg.connection.apiKeyRef ?? "");
        setPlain("");
        // 按存量同步轨道（ENV 优先，无绑定回落 ENV）：首屏不再永远停在 ENV。
        setKeyMode(
          cfg.connection.apiKeyRef ? "env" : cfg.connection.hasPlaintextKey ? "plain" : "env",
        );
        setTimeoutMs(String(cfg.connection.timeoutMs));
        setMaxConcurrency(String(cfg.connection.maxConcurrency));
        setTruncBudget(String(cfg.connection.truncBudget));
        setPerSession(String(cfg.history.perSession));
        setTotalSessions(String(cfg.history.totalSessions));
        setMsg({ kind: "info", text: t("loadedNote") });
      })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setSnapshot(null);
        setFailed(true);
        setMsg({
          kind: "error",
          text: t("loadFail") + (e instanceof Error ? e.message : String(e)),
        });
      });
  }, []);
  React.useEffect(load, [load]);

  const useEnv = keyMode === "env";
  const conn = snapshot?.connection;
  const mask =
    conn === undefined ? t("notLoaded") : conn.hasPlaintextKey ? t("maskOn") : t("maskOff");

  const save = (): void => {
    if (snapshot === null || saving) return;
    const envName = useEnv ? env.trim() : "";
    const plainValue = !useEnv ? plain : "";
    if (plainValue !== "" && envName !== "") {
      setMsg({ kind: "error", text: t("mutualError") });
      return;
    }
    if (envName !== "" && !validApiKeyRef(envName)) {
      setMsg({ kind: "error", text: t("envBad") });
      return;
    }
    const nums = [timeoutMs, maxConcurrency, truncBudget, perSession, totalSessions].map(Number);
    if (!nums.every((n) => Number.isFinite(n))) {
      setMsg({ kind: "error", text: t("nanError") });
      return;
    }
    const body: Record<string, unknown> = {
      version: 1,
      connection: {
        timeoutMs: nums[0],
        maxConcurrency: nums[1],
        truncBudget: nums[2],
        ...(plainValue !== "" ? {} : envName !== "" ? { apiKeyRef: envName } : {}),
      },
      presets: snapshot.presets.map((p) => ({
        id: p.id,
        enabled: p.enabled,
        automationCap: p.automationCap,
      })),
      history: { perSession: nums[3], totalSessions: nums[4] },
      ...(plainValue !== "" ? { apiKeyPlaintext: plainValue } : {}),
      // 切 ENV→明文：附 apiKeyRef:null 清掉已存引用，否则服务端互斥 400。
      ...(plainValue !== "" && snapshot.connection.apiKeyRef ? { apiKeyRef: null } : {}),
    };
    setSaving(true);
    setMsg({ kind: "info", text: t("saving") });
    void fetchTimeout(APP_ROUTES.config, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!alive.current) return;
        if (!res.ok) {
          let cat = "http-" + res.status;
          try {
            const b: unknown = await res.json();
            if (b !== null && typeof b === "object") {
              const rec = b as Record<string, unknown>;
              const nested = rec["error"];
              if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
                const v =
                  (nested as Record<string, unknown>)["category"] ??
                  (nested as Record<string, unknown>)["errorCode"];
                if (typeof v === "string" && v.length > 0) cat = v;
              } else {
                const v = rec["category"] ?? rec["errorCode"] ?? rec["error"] ?? rec["code"];
                if (typeof v === "string" && v.length > 0) cat = v;
              }
            }
          } catch {
            /* 忽略 */
          }
          throw new Error(cat);
        }
        setPlain("");
        setMsg({ kind: "ok", text: t("savedReload") });
        load();
      })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setMsg({
          kind: "error",
          text: t("saveFail") + (e instanceof Error ? e.message : String(e)),
        });
      })
      .finally(() => {
        if (alive.current) setSaving(false);
      });
  };

  const selfCheck = (): void => {
    if (testing) return;
    setTesting(true);
    setTestOut(t("testing"));
    void fetchTimeout(APP_ROUTES.testConnection, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
    })
      .then(async (res) => {
        if (!alive.current) return;
        let category = "";
        try {
          const body: unknown = await res.json();
          const hit = failureCategory(res.status, body);
          if (hit !== "http-" + res.status) category = hit;
        } catch {
          /* 非 JSON 即按状态码 */
        }
        setTestOut(
          res.ok
            ? category !== ""
              ? t("testOk") + "（" + category + "）"
              : t("testOk")
            : t("testFail") + (category !== "" ? category : "http-" + res.status),
        );
      })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setTestOut(t("testFail") + (e instanceof Error ? e.message : String(e)));
      })
      .finally(() => {
        if (alive.current) setTesting(false);
      });
  };

  return (
    <div className="dj-pane" data-tab="connection">
      <div className="dj-tools">
        <span className={conn?.hasPlaintextKey ? "dj-badge dj-badgeOn" : "dj-badge"}>{mask}</span>
        {conn?.hasPlaintextKey === true && (
          <span className="dj-note" aria-label={t("maskDotsAria")}>
            {"••••••••"}
          </span>
        )}
        {conn?.apiKeyRef !== undefined && conn.apiKeyRef !== "" && (
          <span className="dj-badge">
            {t("maskEnv")}
            {conn.apiKeyRef}
          </span>
        )}
      </div>
      {msg !== null && (
        <div className="dj-field">
          <span className={msg.kind === "error" ? "dj-errLine" : "dj-note"}>{msg.text}</span>
        </div>
      )}
      <div className="dj-field" role="radiogroup" aria-label={t("keyMode")}>
        <label>{t("keyMode")}</label>
        <div className="dj-tools">
          <label>
            <input
              type="radio"
              name="dj-keymode"
              value="env"
              checked={useEnv}
              onChange={() => setKeyMode("env")}
            />
            {t("keyEnv")}
          </label>
          <label>
            <input
              type="radio"
              name="dj-keymode"
              value="plain"
              checked={!useEnv}
              onChange={() => setKeyMode("plain")}
            />
            {t("keyPlain")}
          </label>
        </div>
        <span className="dj-note">{useEnv ? t("modeEnvNote") : t("modePlainNote")}</span>
      </div>
      {useEnv ? (
        <div className="dj-field">
          <label>{t("envLabel")}</label>
          <input
            className="dj-input"
            aria-label={t("envAria")}
            inputMode="text"
            autoComplete="off"
            value={env}
            placeholder={t("envPlaceholder")}
            onChange={(e) => setEnv(e.target.value)}
          />
          <span className="dj-note">{t("envRule")}</span>
        </div>
      ) : (
        <div className="dj-fold">
          <button type="button" className="dj-foldHead" onClick={() => setPlainOpen((v) => !v)}>
            <span>{t("plainFoldTitle")}</span>
            <span>{plainOpen ? "▾" : "▸"}</span>
          </button>
          <div className="dj-foldBody" hidden={!plainOpen}>
            <div className="dj-field">
              <input
                className="dj-input"
                type="password"
                aria-label={t("plainAria")}
                autoComplete="off"
                value={plain}
                placeholder={t("plainPlaceholder")}
                onChange={(e) => setPlain(e.target.value)}
              />
              <span className="dj-note">{t("plainNote")}</span>
            </div>
          </div>
        </div>
      )}
      <div className="dj-tools">
        <button type="button" className="dj-btn dj-btnSmall" disabled={testing} onClick={selfCheck}>
          {t("testOffline")}
        </button>
        <span className="dj-note">{testOut}</span>
      </div>
      <div className="dj-fold">
        <button type="button" className="dj-foldHead" onClick={() => setAdvOpen((v) => !v)}>
          <span>{t("advTitle")}</span>
          <span>{advOpen ? "▾" : "▸"}</span>
        </button>
        <div className="dj-foldBody" hidden={!advOpen}>
          {(
            [
              [t("advTimeout"), timeoutMs, setTimeoutMs, t("advTimeoutHint")],
              [t("advConcurrency"), maxConcurrency, setMaxConcurrency, t("advConcurrencyHint")],
              [t("advTrunc"), truncBudget, setTruncBudget, t("advTruncHint")],
              [t("advPerSession"), perSession, setPerSession, t("advPerSessionHint")],
              [t("advTotalSessions"), totalSessions, setTotalSessions, t("advTotalSessionsHint")],
            ] as Array<[string, string, (v: string) => void, string]>
          ).map(([label, value, set, hint]) => (
            <div className="dj-field" key={label}>
              <label>{label}</label>
              <input
                className="dj-input"
                inputMode="numeric"
                autoComplete="off"
                value={value}
                onChange={(e) => set(e.target.value)}
              />
              <span className="dj-note">{hint}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="dj-foot">
        {failed && (
          <button type="button" className="dj-btn dj-btnSmall" onClick={load}>
            {t("retry")}
          </button>
        )}
        <button
          type="button"
          className="dj-btn dj-btnPrimary"
          disabled={saving || snapshot === null}
          onClick={save}
        >
          {t("save")}
        </button>
      </div>
    </div>
  );
}
