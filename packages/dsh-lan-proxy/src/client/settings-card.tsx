/**
 * dsh-lan-proxy — 设置页插件卡（SettingsCard）。
 *
 * 行为：在「设置 → 插件」面板渲染 dsh-lan-proxy 配置卡片（settings.plugin.item
 * 插槽，idle 插件同款风格）：
 * - 启用开关 / LAN 端口 / HTTPS 开关与端口 / 证书与私钥文件 / CA 公钥文件与下载直链 / 启动横幅开关；
 * - 点「保存」经 loopback HTTP 配置路由提交增量 patch，宿主端转写官方 settings
 *   命名空间（scope.update/replace），scope.watch 触发转发器热更新（保存即热
 *   更新，无需重启 dsh web）。
 */

import * as React from "react";
import { t } from "../../../../shared/client/i18n.js";
import { DEFAULTS as CLIENT_DEFAULTS } from "./shared/interface.ts";
import type {
  CompressSnapshotView,
  ConfigSnapshotView,
  LanProxySettingsView,
  PutResultView,
} from "./shared/view.ts";
import {
  evaluateHostTrust,
  readHostTrustSignals,
  HOST_TRUST_STATUS_KEY,
  type HostTrustSignals,
} from "./host-trust-status.ts";

import { APP_ROUTES } from "./shared/interface.ts";

const CONFIG_ROUTE = APP_ROUTES.config;
const HEALTH_ROUTE = APP_ROUTES.health;
const CA_CERT_ROUTE = APP_ROUTES.caCert;

/** 增量 diff 的键值比较：路径白名单数组按元素逐一比较，其余严格相等。 */
function sameSetting(key: string, a: unknown, b: unknown): boolean {
  if (key === "wsCompressPaths") {
    const la = Array.isArray(a) ? a : [];
    const lb = Array.isArray(b) ? b : [];
    if (la.length !== lb.length) return false;
    for (let i = 0; i < la.length; i++) {
      if (la[i] !== lb[i]) return false;
    }
    return true;
  }
  return a === b;
}

/** 保存数字键归一化结果（validateSaveNumbers 成功形态）。 */
type SaveNumbers = {
  readonly portValue: number;
  readonly httpsPortValue: number;
  readonly levelValue: number;
};

/** 保存数字键校验失败形态（错误键由调用方经 t() 转文案，保持纯函数无 i18n 依赖）。 */
type SaveNumbersError = {
  readonly error: "portRangeFail" | "httpsPortRangeFail" | "levelRangeFail";
};

/**
 * 本地预校验（issue #33 子项 1，原 save 首段）：数字键先归一化，非法值返回错误键——
 * 不依赖宿主整体拒绝后才报错。成功返回归一化三值，失败返回错误键（调用方 setSaved）。
 */
function validateSaveNumbers(
  settingsValue: Record<string, unknown>,
): SaveNumbers | SaveNumbersError {
  const portValue = Number(settingsValue.port);
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    return { error: "portRangeFail" };
  }
  const httpsPortValue = Number(settingsValue.httpsPort);
  if (!Number.isInteger(httpsPortValue) || httpsPortValue < 1 || httpsPortValue > 65535) {
    return { error: "httpsPortRangeFail" };
  }
  const levelValue = Number(settingsValue.httpCompressLevel);
  if (!Number.isInteger(levelValue) || levelValue < 0 || levelValue > 3) {
    return { error: "levelRangeFail" };
  }
  return { portValue, httpsPortValue, levelValue };
}

/**
 * 增量提交构造（issue #33 子项 2，原 save 中段）：只发送与加载基线不同的键，未改动的键
 * 不提交——组合层 base 设值不会被客户端默认值静默覆盖回写。
 * 基线只确认本次提交的规范化快照，不把等待期间的新编辑算作已保存。
 */
function buildSavePatch(
  settingsValue: Record<string, unknown>,
  validated: SaveNumbers,
  baseline: Record<string, unknown>,
  defaults: Record<string, unknown>,
): { readonly snapshot: Record<string, unknown>; readonly payload: Record<string, unknown> } {
  const normalized: Record<string, unknown> = {
    port: validated.portValue,
    httpsPort: validated.httpsPortValue,
    httpCompressLevel: validated.levelValue,
  };
  const snapshot: Record<string, unknown> = {};
  const payload: Record<string, unknown> = {};
  for (const key in defaults) {
    const cur = key in normalized ? normalized[key] : settingsValue[key];
    snapshot[key] = Array.isArray(cur) ? [...cur] : cur;
    if (!sameSetting(key, cur, baseline[key])) payload[key] = snapshot[key];
  }
  return { snapshot, payload };
}

/** HTTP 压缩状态行文案（issue #33 子项 3）；无快照返回 null（不渲染该行）。 */
function compressStatusLine(c: unknown): string | null {
  if (!c || typeof c !== "object") return null;
  const snap = c as CompressSnapshotView;
  if (snap.httpCompressEnabled === false) return t("compressOff");
  if (snap.httpCompressMounted !== true) return t("compressInactive");
  const stats = snap.httpCompressStats || {};
  return t("compressOn", { neg: stats.compressed || 0, pass: stats.passthrough || 0 });
}

/**
 * settings.plugin.item 插槽的 props。形参本身不可写成可选（`props?`）：可选参数会让
 * 组件 props 泛型带上 undefined，React.createElement 的类型校验随之失配（TS2769），
 * 只能靠宽化断言消音。
 */
export interface SettingsCardProps {
  /** 调用方注入的宿主端默认值快照。 */
  defaults?: LanProxySettingsView;
  /** host trust 信号读取器（issue #856）；缺省时只读页面侧信号（无 ctx.remote）。 */
  hostTrustSignals?: () => HostTrustSignals;
}

/**
 * 设置面板插件项：启用 / LAN 端口 / HTTPS / 证书文件 / 启动横幅。
 * 改动只在点「保存」后生效：经 loopback HTTP 路由写入官方 settings 存储，
 * 宿主 scope.watch 立即重建转发器。
 */
export function SettingsCard(props: SettingsCardProps) {
  const DEFAULTS = props.defaults || CLIENT_DEFAULTS;
  const useState = React.useState;
  const useEffect = React.useEffect;
  // 显式声明状态形状：useState(null) 会把状态推成字面 null，写入任何非 null 值都编不过。
  const draft = useState(null as LanProxySettingsView | null);
  const settings = draft[0];
  const setSettings = draft[1];
  // 保存反馈（i18n 重构：msg + err 结构化状态，不能用文案内容判断错误态）
  const savedDraft = useState(null as { msg: string; err: boolean } | null);
  const saved = savedDraft[0];
  const feedbackTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  function clearFeedbackTimer() {
    if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = null;
  }
  const setSaved = (msg: string, err?: boolean) => {
    clearFeedbackTimer();
    savedDraft[1](msg ? { msg: msg, err: err === true } : null);
  };
  const openState = useState(false);
  const open = openState[0];
  const setOpen = openState[1];
  // HTTP 压缩运行快照（issue #33 子项 3）：GET 快照附带，底部轻量状态行展示。
  const compressDraft = useState(null as CompressSnapshotView | null);
  const compress = compressDraft[0];
  const setCompress = compressDraft[1];
  // 宿主侧 host trust 事实（issue #856）：来自 health 路由；页面侧事实由纯函数判定。
  const hostFactsDraft = useState(null as Record<string, unknown> | null);
  const hostFacts = hostFactsDraft[0];
  const setHostFacts = hostFactsDraft[1];
  // 加载基线（issue #33 子项 2）：保存时只提交与基线不同的键（增量 diff），
  // 未改动的键不提交——组合层 base 设值不会被客户端默认值静默覆盖回写。
  const committed = React.useRef<{
    baseline: Record<string, unknown>;
    revision: number | null;
  } | null>(null);
  // 每次 effect 拥有独立令牌；StrictMode 重装不能复活上一代响应。
  const lifetime = React.useRef<{ value: boolean } | null>(null);
  const inFlight = React.useRef(false);
  const [saving, setSaving] = useState(false);

  function loadCard(alive: { value: boolean }) {
    fetch(CONFIG_ROUTE, { headers: { accept: "application/json" } })
      .then((r: Response) => r.json())
      .then((v: ConfigSnapshotView) => {
        if (!alive.value) return;
        const merged: LanProxySettingsView = {};
        // 展示校准（issue #33 子项 2）：DEFAULTS 兜底 → 宿主生效值（组合层
        // base 设值的键显示实际生效值）→ 用户层（上次在本卡片保存的内容，
        // 作为编辑基线；descriptor.user 的键存在即用户设过值）。
        for (const key in DEFAULTS) merged[key] = DEFAULTS[key];
        const effective: Record<string, unknown> = (v && v.effective) || {};
        for (const ek in DEFAULTS) {
          if (effective[ek] !== undefined && effective[ek] !== null) merged[ek] = effective[ek];
        }
        const user: Record<string, unknown> = (v && v.user) || {};
        for (const pk in user) merged[pk] = user[pk];
        committed.current = {
          baseline: { ...merged },
          revision:
            typeof v?.revision === "number" && Number.isInteger(v.revision) ? v.revision : null,
        };
        setCompress((v && v.compress) || null);
        setSettings(merged);
      })
      .catch((e: unknown) => {
        if (!alive.value) return;
        const detail = e instanceof Error ? e.message : undefined;
        setSaved(t("loadFail", { msg: detail || e }), true);
      });
    // 宿主侧事实（issue #856）：health 带 ownsHostCompat。
    // 页面侧事实（marker / isLoopback）宿主看不到，两侧在卡片里合在一处显示；
    // 该诊断行失败不影响卡片主体（例如直连非本插件服务的页面会 403）。
    fetch(HEALTH_ROUTE, { headers: { accept: "application/json" } })
      .then((r: Response) => r.json())
      .then((v: Record<string, unknown> | null) => {
        if (!alive.value) return;
        setHostFacts(v && typeof v === "object" ? v : null);
      })
      .catch(() => {});
  }

  useEffect(() => {
    const alive = { value: true };
    lifetime.current = alive;
    loadCard(alive);
    return () => {
      alive.value = false;
      clearFeedbackTimer();
    };
  }, []);

  if (!settings) {
    return <li className="lp-set-card">{t("settingsLoading")}</li>;
  }

  // 收窄后的别名：save/patch 是函数声明（提升到作用域顶部），tsc 不会把上面的 null
  // 收窄带进它们的闭包，直接引用 settings 会被判 possibly null。
  const settingsValue = settings;

  function patch(p: Record<string, unknown>) {
    setSettings(Object.assign({}, settingsValue, p));
    setSaved("");
  }

  function save() {
    const alive = lifetime.current;
    const base = committed.current;
    if (!alive?.value || base === null || inFlight.current) return;
    const validated = validateSaveNumbers(settingsValue);
    if ("error" in validated) {
      if (validated.error === "portRangeFail") setSaved(t("portRangeFail"), true);
      else if (validated.error === "httpsPortRangeFail") setSaved(t("httpsPortRangeFail"), true);
      else setSaved(t("levelRangeFail"), true);
      return;
    }
    const { snapshot, payload } = buildSavePatch(settingsValue, validated, base.baseline, DEFAULTS);
    if (Object.keys(payload).length === 0) {
      setSaved(t("unchanged"));
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setSaved("");
    fetch(CONFIG_ROUTE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: payload, expectedRevision: base.revision }),
    })
      .then((r: Response) => {
        return r.json().then((body: PutResultView) => {
          if (!r.ok) {
            const nested = body.error;
            const errObj = typeof nested === "object" && nested !== null ? nested : undefined;
            throw new Error((errObj && (errObj.details || errObj.code)) || "HTTP " + r.status);
          }
          return body;
        });
      })
      .then((body: PutResultView) => {
        if (!alive.value) return;
        committed.current = {
          baseline: snapshot,
          revision:
            typeof body?.revision === "number" && Number.isInteger(body.revision)
              ? body.revision
              : base.revision,
        };
        setSaved(t("savedOk"));
        feedbackTimer.current = setTimeout(() => {
          if (alive.value) setSaved("");
        }, 2200);
      })
      .catch((e: unknown) => {
        if (!alive.value) return;
        const msg = (e instanceof Error ? e.message : undefined) || e;
        setSaved(
          String(msg).indexOf("已被其他窗口修改") >= 0
            ? t("saveFailConflict", { msg: msg })
            : t("saveFail", { msg: msg }),
          true,
        );
      })
      .finally(() => {
        if (!alive.value) return;
        inFlight.current = false;
        setSaving(false);
      });
  }

  const compressLine = compressStatusLine(compress);
  // host trust 三段判定（issue #856）：判定是纯函数，展示走 i18n 字典。
  const hostTrustStatus = evaluateHostTrust(
    props.hostTrustSignals ? props.hostTrustSignals() : readHostTrustSignals(undefined),
  );

  return (
    <li className={"lp-set-card" + (open ? " lp-set-cardOpen" : "")}>
      <button
        type="button"
        className="lp-set-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="lp-set-headText">
          <span className="lp-set-name">{t("settingsName")}</span>
          <span className="lp-set-description">{t("settingsDescription")}</span>
        </span>
        <svg
          className={"lp-set-chevron" + (open ? " lp-set-chevronOpen" : "")}
          width={14}
          height={14}
          viewBox="0 0 14 14"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
            fill="currentColor"
          />
        </svg>
      </button>
      {open ? (
        <div className="lp-set-body">
          <div className="lp-set-row">
            <label htmlFor="lp-set-enabled">{t("enable")}</label>
            <input
              id="lp-set-enabled"
              type="checkbox"
              checked={settings.enabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ enabled: e.target.checked })
              }
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-port">{t("lanPort")}</label>
            <input
              id="lp-set-port"
              className="lp-set-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={settings.port}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => patch({ port: e.target.value })}
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-https-enabled">{t("httpsCoexist")}</label>
            <input
              id="lp-set-https-enabled"
              type="checkbox"
              checked={settings.httpsEnabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ httpsEnabled: e.target.checked })
              }
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-https-port">{t("httpsPort")}</label>
            <input
              id="lp-set-https-port"
              className="lp-set-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={settings.httpsPort}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ httpsPort: e.target.value })
              }
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-cert">{t("certFile")}</label>
            <input
              id="lp-set-cert"
              className="lp-set-input"
              type="text"
              placeholder={t("certPlaceholder")}
              value={settings.tlsCertFile}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ tlsCertFile: e.target.value })
              }
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-key">{t("keyFile")}</label>
            <input
              id="lp-set-key"
              className="lp-set-input"
              type="text"
              placeholder={t("keyPlaceholder")}
              value={settings.tlsKeyFile}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ tlsKeyFile: e.target.value })
              }
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-ca">{t("caCertFile")}</label>
            <input
              id="lp-set-ca"
              className="lp-set-input"
              type="text"
              placeholder={t("caCertPlaceholder")}
              value={settings.tlsCaCertFile}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ tlsCaCertFile: e.target.value })
              }
            />
          </div>
          <div className="lp-set-row">
            <span>{t("caDownload")}</span>
            <a className="lp-set-input" href={CA_CERT_ROUTE + "?format=cer"}>
              {t("caDownloadLink")}
            </a>
          </div>
          <div className="lp-set-hint">{t("caDownloadHint")}</div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-banner">{t("printBanner")}</label>
            <input
              id="lp-set-banner"
              type="checkbox"
              checked={settings.printBanner}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ printBanner: e.target.checked })
              }
            />
          </div>
          {/* WS 桥接总开关（issue #552 解耦）：默认开——所有 WS 走「终结 + 桥接」
              （保活基座：代答上游 Ping + 半开探活）。关闭 = 透传，移动端切后台
              不再有保活兜底（README 标注断连风险）。与下方压缩开关正交。 */}
          <div className="lp-set-row">
            <label htmlFor="lp-set-ws-bridge">{t("wsBridge")}</label>
            <input
              id="lp-set-ws-bridge"
              type="checkbox"
              checked={settings.wsBridgeEnabled !== false}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ wsBridgeEnabled: e.target.checked })
              }
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-ws-compress">{t("wsCompress")}</label>
            <input
              id="lp-set-ws-compress"
              type="checkbox"
              checked={settings.wsCompressEnabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ wsCompressEnabled: e.target.checked })
              }
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-ws-paths">{t("wsPaths")}</label>
            <input
              id="lp-set-ws-paths"
              className="lp-set-input"
              type="text"
              placeholder="/api/remote.mux"
              title={t("wsPathsHint")}
              value={(settings.wsCompressPaths || []).join(", ")}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                const parts = e.target.value
                  .split(",")
                  .map((s: string) => s.trim())
                  .filter(Boolean);
                patch({ wsCompressPaths: parts });
              }}
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-http-compress">{t("httpCompress")}</label>
            <input
              id="lp-set-http-compress"
              type="checkbox"
              checked={settings.httpCompressEnabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ httpCompressEnabled: e.target.checked })
              }
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-level">{t("compressLevel")}</label>
            <select
              id="lp-set-level"
              className="lp-set-input"
              value={String(settings.httpCompressLevel)}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                patch({ httpCompressLevel: Number(e.target.value) })
              }
            >
              <option value="0">{t("level0")}</option>
              <option value="1">{t("level1")}</option>
              <option value="2">{t("level2")}</option>
              <option value="3">{t("level3")}</option>
            </select>
          </div>
          {/* injectToken（issue #380）：默认开启——LAN 设备免 token 直入；开启态
              持久显示安全警示（评审要求：横幅一次性警示不足，卡片常驻提醒）。 */}
          <div className="lp-set-row">
            <label htmlFor="lp-set-inject-token">{t("injectToken")}</label>
            <input
              id="lp-set-inject-token"
              type="checkbox"
              checked={settings.injectToken}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ injectToken: e.target.checked })
              }
            />
          </div>
          {settings.injectToken ? (
            <div className="lp-set-warn">{t("injectTokenOnHint")}</div>
          ) : null}
          {/* ownsHostCompat（issue #856）：默认关——向非回环页面声明 ownsHost 等同
              伪造上游拓扑事实位；开启态常驻警示，底部另有三段判定结果。 */}
          <div className="lp-set-row">
            <label htmlFor="lp-set-owns-host-compat">{t("ownsHostCompat")}</label>
            <input
              id="lp-set-owns-host-compat"
              type="checkbox"
              checked={settings.ownsHostCompat === true}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patch({ ownsHostCompat: e.target.checked })
              }
            />
          </div>
          {settings.ownsHostCompat === true ? (
            <div className="lp-set-warn">{t("ownsHostCompatHint")}</div>
          ) : null}
          <div className="lp-set-hint">{t("bodyHint")}</div>
          {compressLine ? <div className="lp-set-status">{compressLine}</div> : null}
          <div
            className={hostTrustStatus === "contract-drift" ? "lp-set-warn" : "lp-set-status"}
            data-host-trust={hostTrustStatus}
          >
            {t(HOST_TRUST_STATUS_KEY[hostTrustStatus])}
          </div>
          {hostFacts ? (
            <div className="lp-set-status">
              {t("hostTrustHostFacts", {
                compat: hostFacts.ownsHostCompat === true ? t("hostTrustOn") : t("hostTrustOff"),
              })}
            </div>
          ) : null}
          <div className="lp-set-foot">
            {saved ? (
              <span className={saved.err ? "lp-set-error" : "lp-set-saved"}>{saved.msg}</span>
            ) : null}
            <button type="button" className="lp-set-save" onClick={save} disabled={saving}>
              {t("save")}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
