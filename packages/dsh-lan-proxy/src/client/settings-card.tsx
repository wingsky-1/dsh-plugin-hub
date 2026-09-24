/**
 * dsh-lan-proxy — 设置页插件卡（SettingsCard）。
 *
 * 行为：在插件管理页的 dsh-lan-proxy 行详情中渲染配置卡片：
 * - summary 只返回内联摘要，不加载 config/health；
 * - page 在非-li wrapper 中直接返回完整配置体。
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
} from "./shared/interface.ts";
import {
  evaluateHostTrust,
  readHostTrustSignals,
  HOST_TRUST_STATUS_KEY,
  type HostTrustSignals,
} from "./host-trust-status.ts";

import { APP_ROUTES } from "./shared/interface.ts";
import { evaluateCaWarnings } from "./ca-status.ts";
import type { CertInfoView } from "./ca-status.ts";

const CONFIG_ROUTE = APP_ROUTES.config;
const HEALTH_ROUTE = APP_ROUTES.health;
const CA_CERT_ROUTE = APP_ROUTES.caCert;
const CA_GENERATE_ROUTE = APP_ROUTES.caGenerate;

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

/**
 * 动作失败体的字符串字段（throw { code, details } 与 fetch 异常两形态收口；
 * 非对象/非字符串一律空串，调用方回落 errorText）。
 */
function failureField(e: unknown, field: string): string {
  if (typeof e === "object" && e !== null && field in e) {
    const value = (e as Record<string, unknown>)[field];
    return typeof value === "string" ? value : "";
  }
  return "";
}

/** 异常文本（Error 取 message，其余 String 化）。 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
 * row entry 的 owner props 与卡片入参。view 决定摘要/页面分支；form 由 0.1.7-rc.1
 * Plugin Manager 传入，当前实现按任务边界保留既有 HTTP 配置写面。
 */
export interface SettingsCardProps {
  /** Plugin Manager 请求的 row entry 视图。 */
  readonly view: "summary" | "page";
  /** Plugin Manager 提供的官方配置表单面；当前 HTTP 写面暂不消费。 */
  readonly form?: unknown;
  /** 调用方注入的宿主端默认值快照。 */
  defaults?: LanProxySettingsView;
  /** host trust 信号读取器（issue #856）；缺省时只读页面侧信号（无 ctx.remote）。 */
  hostTrustSignals?: () => HostTrustSignals;
}

/**
 * 插件行配置页：启用 / LAN 端口 / HTTPS / 证书文件 / 启动横幅。
 * 改动只在点「保存」后生效：经 loopback HTTP 路由写入官方 settings 存储，
 * 宿主 scope.watch 立即重建转发器。
 */
type CaConfirm = null | { kind: "generate" | "leaf" | "ca" };
function BasicFields(props: {
  settings: LanProxySettingsView;
  patch: (p: Record<string, unknown>) => void;
}): React.ReactElement {
  const { settings, patch } = props;
  return (
    <React.Fragment>
      {" "}
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
    </React.Fragment>
  );
}
const CA_MODE_KEY: Record<string, string> = {
  "self-signed": "caModeSelfSigned",
  managed: "caModeManaged",
  custom: "caModeCustom",
  error: "caConfigError",
};
type CaAction =
  | { type: "confirm"; kind: "generate" | "leaf" | "ca" }
  | { type: "cancel" }
  | { type: "submit"; kind: "generate" | "leaf" | "ca"; confirmed: boolean }
  | { type: "clear" };
function caDispatch(
  setCaConfirm: React.Dispatch<React.SetStateAction<CaConfirm>>,
  runCaAction: (kind: "generate" | "leaf" | "ca", confirmed: boolean) => void,
  clearTriple: () => void,
  action: CaAction,
): void {
  if (action.type === "confirm") {
    setCaConfirm({ kind: action.kind });
    return;
  }
  if (action.type === "cancel") {
    setCaConfirm(null);
    return;
  }
  if (action.type === "clear") {
    clearTriple();
    return;
  }
  runCaAction(action.kind, action.confirmed);
}
function getCaStateView(hostFacts: Record<string, unknown> | null, caConfirm: CaConfirm) {
  const caState = typeof hostFacts?.caState === "string" ? hostFacts.caState : undefined;
  const caModeKey: string | null = caState !== undefined ? (CA_MODE_KEY[caState] ?? null) : null;
  let caConfirmLabel = "caGenerate";
  if (caConfirm?.kind === "leaf") caConfirmLabel = "caRotate";
  else if (caConfirm?.kind === "ca") caConfirmLabel = "caRotateCa";
  return { state: caState, modeKey: caModeKey, confirmLabel: caConfirmLabel };
}
function asCertInfo(hostFacts: Record<string, unknown> | null): CertInfoView | null {
  if (hostFacts?.certInfo === null || typeof hostFacts?.certInfo !== "object") return null;
  return hostFacts.certInfo as CertInfoView;
}
function getCaWarnView(
  hostFacts: Record<string, unknown> | null,
  httpsEnabled: boolean,
  caState: string | undefined,
) {
  const certInfo = asCertInfo(hostFacts);
  const caWarnings = certInfo !== null ? evaluateCaWarnings(certInfo, Date.now()) : null;
  const showCaWarnings = caWarnings !== null && caState === "managed" && httpsEnabled !== false;
  const caCurrentIps =
    certInfo !== null && Array.isArray(certInfo.currentIps)
      ? certInfo.currentIps.filter((ip): ip is string => typeof ip === "string")
      : [];
  const caLeafDate =
    certInfo !== null && typeof certInfo.leafValidTo === "string"
      ? certInfo.leafValidTo.slice(0, 10)
      : "";
  return {
    warnings: caWarnings,
    showWarnings: showCaWarnings,
    ips: caCurrentIps,
    leafDate: caLeafDate,
    customUnconfigured: hostFacts?.caConfigured !== true,
  };
}
type CaView = {
  state: string | undefined;
  modeKey: string | null;
  confirmLabel: string;
  warnings: ReturnType<typeof evaluateCaWarnings> | null;
  showWarnings: boolean;
  ips: string[];
  leafDate: string;
  customUnconfigured: boolean;
  caSaving: boolean;
  caMsg: { msg: string; err: boolean } | null;
  caConfirm: CaConfirm;
  mainSaving: boolean;
};
function CaWarnHints(props: { view: CaView }): React.ReactElement | null {
  const { view } = props;
  if (!view.showWarnings) return null;
  return (
    <React.Fragment>
      {view.warnings?.ipChanged ? (
        <div className="lp-set-hint">{t("caIpChanged", { ips: view.ips.join(", ") })}</div>
      ) : null}
      {view.warnings?.expiring ? (
        <div className="lp-set-hint">{t("caExpiring", { date: view.leafDate })}</div>
      ) : null}
    </React.Fragment>
  );
}
function CaActions(props: {
  view: CaView;
  onAction: (action: CaAction) => void;
}): React.ReactElement {
  const { view, onAction } = props;
  return (
    <React.Fragment>
      {view.state !== undefined ? (
        <div className="lp-set-row" id="lp-ca-generate">
          {view.state === "self-signed" ? (
            <button
              type="button"
              className="lp-set-save"
              onClick={() => onAction({ type: "submit", kind: "generate", confirmed: false })}
              disabled={view.caSaving}
            >
              {t("caGenerate")}
            </button>
          ) : null}
          {view.state === "managed" ? (
            <button
              type="button"
              className="lp-set-save"
              onClick={() => onAction({ type: "confirm", kind: "leaf" })}
              disabled={view.caSaving}
            >
              {t("caRotate")}
            </button>
          ) : null}
          {view.state === "managed" ? (
            <button
              type="button"
              className="lp-set-save"
              onClick={() => onAction({ type: "confirm", kind: "ca" })}
              disabled={view.caSaving}
            >
              {t("caRotateCa")}
            </button>
          ) : null}
          {view.state === "custom" || view.state === "error" ? (
            <button
              type="button"
              className="lp-set-save"
              disabled={true}
              title={t(view.state === "error" ? "caFilesMissing" : "caDisabledNoCa")}
            >
              {t("caGenerate")}
            </button>
          ) : null}
          {view.state === "error" ? (
            <button
              type="button"
              className="lp-set-save"
              onClick={() => onAction({ type: "clear" })}
              disabled={view.mainSaving}
            >
              {t("caClearSelfSigned")}
            </button>
          ) : null}
        </div>
      ) : null}
    </React.Fragment>
  );
}
function CaConfirmBox(props: {
  view: CaView;
  onAction: (action: CaAction) => void;
}): React.ReactElement {
  const { view, onAction } = props;
  return (
    <React.Fragment>
      {view.caMsg ? (
        <span className={view.caMsg.err ? "lp-set-error" : "lp-set-saved"}>{view.caMsg.msg}</span>
      ) : null}
      {view.caConfirm ? (
        <div className="lp-set-row">
          <span>{t("caConfirmTitle")}</span>
          <span className="lp-set-hint">{t("caConfirmBody")}</span>
          <button
            type="button"
            className="lp-set-save"
            onClick={() =>
              onAction({ type: "submit", kind: view.caConfirm!.kind, confirmed: true })
            }
            disabled={view.caSaving}
          >
            {t(view.confirmLabel)}
          </button>
          <button
            type="button"
            className="lp-set-save"
            onClick={() => onAction({ type: "cancel" })}
            disabled={view.caSaving}
          >
            {t("caConfirmCancel")}
          </button>
        </div>
      ) : null}
    </React.Fragment>
  );
}
function CaHints(props: { view: CaView }): React.ReactElement {
  const { view } = props;
  return (
    <React.Fragment>
      <div className="lp-set-row">
        <span>{t("caDownload")}</span>
        <a className="lp-set-input" href={CA_CERT_ROUTE + "?format=cer"}>
          {t("caDownloadLink")}
        </a>
      </div>
      <div className="lp-set-hint">{t("caDownloadHint")}</div>
      {view.modeKey ? (
        <div className="lp-set-status" data-ca-state={view.state}>
          {t(view.modeKey)}
        </div>
      ) : null}
      {view.state === "self-signed" ? (
        <div className="lp-set-hint">
          {t("caDisabledNoCa")} <a href="#lp-ca-generate">{t("caGenerate")}</a>
        </div>
      ) : null}
      {view.state === "custom" && view.customUnconfigured ? (
        <div className="lp-set-hint">
          {t("caDisabledNoCa")} <a href="#lp-ca-generate">{t("caGenerate")}</a>
        </div>
      ) : null}
      {view.state === "error" ? (
        <div className="lp-set-hint">
          {t("caFilesMissing")} <a href="#lp-ca-generate">{t("caClearSelfSigned")}</a>
        </div>
      ) : null}
      <CaWarnHints view={view} />
    </React.Fragment>
  );
}
function CaFields(props: {
  view: CaView;
  onAction: (action: CaAction) => void;
}): React.ReactElement {
  const { view, onAction } = props;
  return (
    <React.Fragment>
      <CaHints view={view} />
      <CaActions view={view} onAction={onAction} />
      <CaConfirmBox view={view} onAction={onAction} />
    </React.Fragment>
  );
}
function ExtraFields(props: {
  settings: LanProxySettingsView;
  patch: (p: Record<string, unknown>) => void;
}): React.ReactElement {
  const { settings, patch } = props;
  return (
    <React.Fragment>
      {" "}
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
      {settings.injectToken ? <div className="lp-set-warn">{t("injectTokenOnHint")}</div> : null}
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
    </React.Fragment>
  );
}
function StatusFoot(props: {
  compressLine: string | null;
  hostTrustStatus: ReturnType<typeof evaluateHostTrust>;
  hostFacts: Record<string, unknown> | null;
  saved: { msg: string; err: boolean } | null;
  saving: boolean;
  save: () => void;
}): React.ReactElement {
  const { compressLine, hostTrustStatus, hostFacts, saved, saving, save } = props;
  return (
    <React.Fragment>
      {" "}
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
        <button type="button" className="lp-set-save" onClick={() => save()} disabled={saving}>
          {t("save")}
        </button>
      </div>
    </React.Fragment>
  );
}
function SettingsCardPage(props: SettingsCardProps) {
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
  // 一键 CA 动作态（issue #930 Phase 2）：与保存通道独立的 inFlight + 确认框。
  const caFlight = React.useRef(false);
  const caSavingState = useState(false);
  const caSaving = caSavingState[0];
  const setCaSaving = caSavingState[1];
  const caMsgState = useState(null as { msg: string; err: boolean } | null);
  const caMsg = caMsgState[0];
  const setCaMsg = (msg: string, err?: boolean) => {
    caMsgState[1](msg ? { msg: msg, err: err === true } : null);
  };
  const caConfirmState = useState(null as null | { kind: "generate" | "leaf" | "ca" });
  const caConfirm = caConfirmState[0];
  const setCaConfirm = caConfirmState[1];

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
    return (
      <div className="lp-set-card" data-lan-page>
        {t("settingsLoading")}
      </div>
    );
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
    submitSavePatch(payload, snapshot, base, alive);
  }

  /**
   * PUT 提交与基线确认（save 与一键清空共用；草稿更新由调用方负责，基线确认
   * 以服务端回执为准）。载荷由调用方构造，本函数只做发送与反馈。
   */
  function submitSavePatch(
    payload: Record<string, unknown>,
    snapshot: Record<string, unknown>,
    base: { baseline: Record<string, unknown>; revision: number | null },
    alive: { value: boolean },
  ) {
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

  /**
   * 一键清空回自签（R4：隔离 PUT——载荷恒为三键空串 + revision，不合并草稿
   * 其它未保存改动；服务端空串走 replace 清除，成功后三键基线与草稿同步）。
   */
  function clearTripleToSelfSigned() {
    const alive = lifetime.current;
    const base = committed.current;
    if (!alive?.value || base === null || inFlight.current) return;
    const cleared = { tlsCertFile: "", tlsKeyFile: "", tlsCaCertFile: "" };
    setSettings(Object.assign({}, settingsValue, cleared));
    submitSavePatch(cleared, Object.assign({}, base.baseline, cleared), base, alive);
  }

  /**
   * 一键 CA 动作提交（issue #930 Phase 2）：kind 决定 body —— generate 首建
   * 默认无确认（残留 409 回来再弹框补确认），leaf/ca 恒经确认框（confirmed:true，
   * ca 另带 rotateCa:true）。成功后重 fetch（F9 即时可用）并清确认框。
   */
  function runCaAction(kind: "generate" | "leaf" | "ca", confirmed: boolean) {
    const alive = lifetime.current;
    if (!alive?.value || caFlight.current) return;
    const revision = committed.current?.revision;
    const payload: Record<string, unknown> = {
      expectedRevision: typeof revision === "number" ? revision : null,
    };
    if (confirmed) payload.confirmed = true;
    if (kind === "ca") payload.rotateCa = true;
    caFlight.current = true;
    setCaSaving(true);
    setCaMsg("");
    fetch(CA_GENERATE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r: Response) => {
        return r
          .json()
          .then((body: { ok?: unknown; error?: { code?: unknown; details?: unknown } }) => {
            if (!r.ok) {
              const errObj =
                typeof body?.error === "object" && body.error !== null ? body.error : undefined;
              const code = typeof errObj?.code === "string" ? errObj.code : "HTTP " + r.status;
              const details = typeof errObj?.details === "string" ? errObj.details : code;
              throw { code: code, details: details };
            }
            return body;
          });
      })
      .then(() => {
        if (!alive.value) return;
        setCaConfirm(null);
        setCaMsg(t("caGeneratedOk"));
        loadCard(alive);
      })
      .catch((e: unknown) => {
        if (!alive.value) return;
        const code = failureField(e, "code");
        // 自签残留态的 needs-confirm：弹框补确认后用户点确认即重发 confirmed:true。
        if (code === "needs-confirm" && kind === "generate") {
          setCaConfirm({ kind: "generate" });
          return;
        }
        if (code === "ca-revision-stale") {
          setCaMsg(t("caRevisionStale"), true);
          return;
        }
        setCaMsg(t("caGenerateFail", { msg: failureField(e, "details") || errorText(e) }), true);
      })
      .finally(() => {
        if (!alive.value) return;
        caFlight.current = false;
        setCaSaving(false);
      });
  }

  const compressLine = compressStatusLine(compress);
  // host trust 三段判定（issue #856）：判定是纯函数，展示走 i18n 字典。
  const hostTrustStatus = evaluateHostTrust(
    props.hostTrustSignals ? props.hostTrustSignals() : readHostTrustSignals(undefined),
  );
  // 一键 CA 展示态（issue #930 F7/F8/F9）：health.caState 唯一来源，客户端只渲染
  // 不判定；certInfo 缺席/不可读即无提醒（HTTP-only 无叶子同此）。
  const statePart = getCaStateView(hostFacts, caConfirm);
  const warnPart = getCaWarnView(hostFacts, settingsValue.httpsEnabled !== false, statePart.state);
  const caView = {
    ...statePart,
    ...warnPart,
    caSaving: caSaving,
    caMsg: caMsg,
    caConfirm: caConfirm,
    mainSaving: saving,
  };
  const onCaAction = (action: CaAction): void => {
    caDispatch(setCaConfirm, runCaAction, clearTripleToSelfSigned, action);
  };
  return (
    <div className="lp-set-card" data-lan-page>
      <div className="lp-set-body">
        <BasicFields settings={settingsValue} patch={patch} />
        <CaFields view={caView} onAction={onCaAction} />
        <ExtraFields settings={settingsValue} patch={patch} />
        <StatusFoot
          compressLine={compressLine}
          hostTrustStatus={hostTrustStatus}
          hostFacts={hostFacts}
          saved={saved}
          saving={saving}
          save={save}
        />
      </div>
    </div>
  );
}

/** 0.1.7-rc.1 row entry：summary 不挂载有副作用的页面表单，page 才加载完整配置。 */
export function SettingsCard(props: SettingsCardProps): React.ReactElement {
  if (props.view === "summary") {
    return (
      <span className="lp-set-summary" data-lan-summary>
        {t("settingsDescription")}
      </span>
    );
  }
  return <SettingsCardPage {...props} />;
}
