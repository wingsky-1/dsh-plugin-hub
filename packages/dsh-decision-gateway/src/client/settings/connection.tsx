/**
 * dsh-decision-gateway — 连接 tab（React，settings.section 独立页）。
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
import type { DecisionConfigV1 } from "../api/interface.ts";
import { t } from "../locale.ts";

type Msg = { readonly kind: "info" | "error" | "ok"; readonly text: string };

/** 保存路径的类别键（嵌套面只看 category/errorCode；顶层面多认 error/code）。 */
const NESTED_PUT_KEYS = ["category", "errorCode"] as const;
const TOP_PUT_KEYS = ["category", "errorCode", "error", "code"] as const;

/** 非空串或 null（命中非串/空串即 null）。 */
function nonEmptyStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 键表里按 ?? 语义取第一个已定义值（null/undefined 跳过；非串命中即停，不继续下探）。 */
function firstDefinedAt(rec: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = rec[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * PUT 失败体的类别提取（保存路径专用口径，与 api/contract 的 failureCategory 刻意不同）。
 *
 * 本口径按 ?? 逐级取、命中非串即停，也不回落 message；failureCategory 取第一个非空串
 * 并回落 message。保存路径历来是本口径（load 路径用的是 failureCategory），此处原样
 * 搬出、不改客户端可见文案——两条口径要合并得单独裁决，不在复杂度整改里顺手改。
 */
export function putFailureCategory(status: number, body: unknown): string {
  const fallback = "http-" + status;
  if (body === null || typeof body !== "object") return fallback;
  const rec = body as Record<string, unknown>;
  const nested = rec["error"];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return (
      nonEmptyStr(firstDefinedAt(nested as Record<string, unknown>, NESTED_PUT_KEYS)) ?? fallback
    );
  }
  return nonEmptyStr(firstDefinedAt(rec, TOP_PUT_KEYS)) ?? fallback;
}

/**
 * PUT 体组装（互斥与 ENV 形状已在前置门过；未知键永不发送）。
 *
 * nums 下标即契约：0..2 归 connection（timeoutMs/maxConcurrency/truncBudget），
 * 3..4 归 history（perSession/totalSessions）。未知键一律不进 body。
 */
export function buildPutBody(
  snapshot: DecisionConfigV1,
  nums: readonly number[],
  envName: string,
  plainValue: string,
): Record<string, unknown> {
  const hasPlain = plainValue !== "";
  return {
    version: 1,
    connection: {
      timeoutMs: nums[0],
      maxConcurrency: nums[1],
      truncBudget: nums[2],
      ...(!hasPlain && envName !== "" ? { apiKeyRef: envName } : {}),
    },
    presets: snapshot.presets.map((p) => ({
      id: p.id,
      enabled: p.enabled,
      automationCap: p.automationCap,
    })),
    history: { perSession: nums[3], totalSessions: nums[4] },
    ...(hasPlain ? { apiKeyPlaintext: plainValue } : {}),
    // 切 ENV→明文：附 apiKeyRef:null 清掉已存引用，否则服务端互斥 400。
    ...(hasPlain && snapshot.connection.apiKeyRef ? { apiKeyRef: null } : {}),
  };
}

/** 掩码徽标行 + 提示行（掩码文案由母体算好传入，Key 永不回显原文）。 */
function ConnectionStatus(props: {
  readonly conn: DecisionConfigV1["connection"] | undefined;
  readonly mask: string;
  readonly msg: Msg | null;
}): React.ReactElement {
  const { conn, mask, msg } = props;
  return (
    <>
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
    </>
  );
}

/** 密钥轨道卡（radio 互斥；未选中轨整体隐藏；明文框折叠，明文永不回显）。 */
function KeyModeSection(props: {
  readonly useEnv: boolean;
  readonly setKeyMode: (mode: "env" | "plain") => void;
  readonly env: string;
  readonly setEnv: (v: string) => void;
  readonly plain: string;
  readonly setPlain: (v: string) => void;
  readonly plainOpen: boolean;
  readonly setPlainOpen: (v: boolean) => void;
}): React.ReactElement {
  const { useEnv, setKeyMode, env, setEnv, plain, setPlain, plainOpen, setPlainOpen } = props;
  return (
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
          <button type="button" className="dj-foldHead" onClick={() => setPlainOpen(!plainOpen)}>
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
    </div>
  );
}

/** 高级折叠（连接三键 + 历史两键；字段表驱动，加字段只改表不改 JSX）。 */
function AdvancedSection(props: {
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  readonly fields: ReadonlyArray<readonly [string, string, (v: string) => void, string]>;
}): React.ReactElement {
  const { open, onToggle, fields } = props;
  return (
    <div className="dj-fold">
      <button type="button" className="dj-foldHead" onClick={() => onToggle(!open)}>
        <span>{t("advTitle")}</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      <div className="dj-foldBody" hidden={!open}>
        {fields.map(([label, value, set, hint]) => (
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
  );
}

export function ConnectionPane(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<DecisionConfigV1 | null>(null);
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
    const body = buildPutBody(snapshot, nums, envName, plainValue);
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
          let body: unknown = null;
          try {
            body = await res.json();
          } catch {
            /* 非 JSON 即按状态码归类 */
          }
          throw new Error(putFailureCategory(res.status, body));
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

  const numFields: ReadonlyArray<readonly [string, string, (v: string) => void, string]> = [
    [t("advTimeout"), timeoutMs, setTimeoutMs, t("advTimeoutHint")],
    [t("advConcurrency"), maxConcurrency, setMaxConcurrency, t("advConcurrencyHint")],
    [t("advTrunc"), truncBudget, setTruncBudget, t("advTruncHint")],
    [t("advPerSession"), perSession, setPerSession, t("advPerSessionHint")],
    [t("advTotalSessions"), totalSessions, setTotalSessions, t("advTotalSessionsHint")],
  ];
  return (
    <div className="dj-pane" data-tab="connection">
      <ConnectionStatus conn={conn} mask={mask} msg={msg} />
      <KeyModeSection
        useEnv={useEnv}
        setKeyMode={setKeyMode}
        env={env}
        setEnv={setEnv}
        plain={plain}
        setPlain={setPlain}
        plainOpen={plainOpen}
        setPlainOpen={setPlainOpen}
      />
      <div className="dj-tools">
        <button type="button" className="dj-btn dj-btnSmall" disabled={testing} onClick={selfCheck}>
          {t("testOffline")}
        </button>
        <span className="dj-note">{testOut}</span>
      </div>
      <AdvancedSection open={advOpen} onToggle={setAdvOpen} fields={numFields} />
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
