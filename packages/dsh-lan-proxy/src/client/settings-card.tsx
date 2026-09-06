/**
 * dsh-lan-proxy — 设置页插件卡（SettingsCard）。
 *
 * 行为：在「设置 → 插件」面板渲染 dsh-lan-proxy 配置卡片（settings.plugin.item
 * 插槽，idle 插件同款风格）：
 * - 启用开关 / LAN 端口 / HTTPS 开关与端口 / 证书与私钥文件 / 启动横幅开关；
 * - 点「保存」经 loopback HTTP 配置路由提交增量 patch，宿主端转写官方 settings
 *   命名空间（scope.update/replace），scope.watch 触发转发器热更新（保存即热
 *   更新，无需重启 dsh web）。
 */

import * as React from "react";
import { t } from "../../../../shared/client/i18n.js";

const CONFIG_ROUTE = "/api/dsh-lan-proxy/config";

/** 展示缺省值（与宿主 DEFAULT_OPTIONS 同构；用户层未保存的键回落这些值）。 */
export const DEFAULT_SETTINGS: Record<string, any> = {
  enabled: true,
  port: 3081,
  httpsEnabled: true,
  httpsPort: 3443,
  tlsCertFile: "",
  tlsKeyFile: "",
  printBanner: true,
  wsBridgeEnabled: true,
  wsCompressEnabled: true,
  wsCompressPaths: ["/api/remote.mux"],
  httpCompressEnabled: true,
  httpCompressLevel: 1,
  injectToken: true,
};

/** 增量 diff 的键值比较：路径白名单数组按元素逐一比较，其余严格相等。 */
function sameSetting(key: string, a: any, b: any): boolean {
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

/** HTTP 压缩状态行文案（issue #33 子项 3）；无快照返回 null（不渲染该行）。 */
function compressStatusLine(c: any): string | null {
  if (!c || typeof c !== "object") return null;
  if (c.httpCompressEnabled === false) return t("compressOff");
  if (c.httpCompressMounted !== true) return t("compressInactive");
  const stats = c.httpCompressStats || {};
  return t("compressOn", { neg: stats.compressed || 0, pass: stats.passthrough || 0 });
}

/**
 * 设置面板插件项：启用 / LAN 端口 / HTTPS / 证书文件 / 启动横幅。
 * 改动只在点「保存」后生效：经 loopback HTTP 路由写入官方 settings 存储，
 * 宿主 scope.watch 立即重建转发器。
 */
export function SettingsCard(props?: { defaults?: Record<string, any> }) {
  const DEFAULTS = props?.defaults || DEFAULT_SETTINGS;
  const useState = React.useState;
  const useEffect = React.useEffect;
  const draft = useState(null);
  const settings = draft[0] as any;
  const setSettings = draft[1] as any;
  // 保存反馈（i18n 重构：msg + err 结构化状态，不能用文案内容判断错误态）
  const savedDraft = useState(null);
  const saved = savedDraft[0] as any;
  const setSaved = (msg: string, err?: boolean) => {
    savedDraft[1](msg ? { msg: msg, err: err === true } : null);
  };
  const openState = useState(false);
  const open = openState[0];
  const setOpen = openState[1];
  // HTTP 压缩运行快照（issue #33 子项 3）：GET 快照附带，底部轻量状态行展示。
  const compressDraft = useState(null);
  const compress = compressDraft[0];
  const setCompress = compressDraft[1];
  // 加载基线（issue #33 子项 2）：保存时只提交与基线不同的键（增量 diff），
  // 未改动的键不提交——组合层 base 设值不会被客户端默认值静默覆盖回写。
  let baseline: Record<string, any> | null = null;
  // 乐观并发凭据（官方 descriptor.revision）：PUT 时回传，冲突时提示刷新。
  let revision: any = null;

  function loadCard(alive: { value: boolean }) {
    fetch(CONFIG_ROUTE, { headers: { accept: "application/json" } })
      .then((r: any) => r.json())
      .then((v: any) => {
        if (!alive.value) return;
        const merged: Record<string, any> = {};
        // 展示校准（issue #33 子项 2）：DEFAULTS 兜底 → 宿主生效值（组合层
        // base 设值的键显示实际生效值）→ 用户层（上次在本卡片保存的内容，
        // 作为编辑基线；descriptor.user 的键存在即用户设过值）。
        for (const key in DEFAULTS) merged[key] = DEFAULTS[key];
        const effective = (v && v.effective) || {};
        for (const ek in DEFAULTS) {
          if (effective[ek] !== undefined && effective[ek] !== null) merged[ek] = effective[ek];
        }
        const user = (v && v.user) || {};
        for (const pk in user) merged[pk] = user[pk];
        baseline = Object.assign({}, merged);
        revision = (v && v.revision) || null;
        setCompress((v && v.compress) || null);
        setSettings(merged);
      })
      .catch((e: any) => {
        if (!alive.value) return;
        setSaved(t("loadFail", { msg: (e && e.message) || e }), true);
      });
  }

  useEffect(() => {
    const alive = { value: true };
    loadCard(alive);
    return () => {
      alive.value = false;
    };
  }, []);

  if (!settings) {
    return <li className="lp-set-card">{t("settingsLoading")}</li>;
  }

  function patch(p: any) {
    setSettings(Object.assign({}, settings, p));
    setSaved("");
  }

  function save() {
    // 本地预校验（issue #33 子项 1）：数字键先归一化，非法值在提交前就
    // 指明字段与合法范围——不依赖宿主整体拒绝后才报错。
    const portValue = Number(settings.port);
    if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
      setSaved(t("portRangeFail"), true);
      return;
    }
    const httpsPortValue = Number(settings.httpsPort);
    if (!Number.isInteger(httpsPortValue) || httpsPortValue < 1 || httpsPortValue > 65535) {
      setSaved(t("httpsPortRangeFail"), true);
      return;
    }
    const levelValue = Number(settings.httpCompressLevel);
    if (!Number.isInteger(levelValue) || levelValue < 0 || levelValue > 3) {
      setSaved(t("levelRangeFail"), true);
      return;
    }
    // 增量提交（issue #33 子项 2）：只发送与加载基线不同的键，未改动的键
    // 不提交——组合层 base 设值不会被客户端默认值静默覆盖回写；宿主端把
    // patch 经 scope.update 增量合并进官方设置存储的用户层。
    const normalized: Record<string, any> = { port: portValue, httpsPort: httpsPortValue, httpCompressLevel: levelValue };
    const payload: Record<string, any> = {};
    for (const key in DEFAULTS) {
      const cur = key in normalized ? normalized[key] : settings[key];
      if (baseline === null || !sameSetting(key, cur, baseline[key])) payload[key] = cur;
    }
    if (Object.keys(payload).length === 0) {
      setSaved(t("unchanged"));
      return;
    }
    fetch(CONFIG_ROUTE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: payload, expectedRevision: revision }),
    }).then((r: any) => {
      return r.json().then((body: any) => {
        if (!r.ok) {
          const err = (body && body.error) || {};
          throw new Error(err.details || err.code || ("HTTP " + r.status));
        }
        return body;
      });
    }).then((body: any) => {
      baseline = Object.assign({}, settings);
      revision = (body && body.revision) || revision;
      setSaved(t("savedOk"));
      setTimeout(() => { setSaved(""); }, 2200);
    }).catch((e: any) => {
      const msg = (e && e.message) || e;
      setSaved(String(msg).indexOf("已被其他窗口修改") >= 0
        ? t("saveFailConflict", { msg: msg })
        : t("saveFail", { msg: msg }), true);
    });
  }

  const compressLine = compressStatusLine(compress);

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
              onChange={(e: any) => patch({ enabled: e.target.checked })}
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
              onChange={(e: any) => patch({ port: e.target.value })}
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-https-enabled">{t("httpsCoexist")}</label>
            <input
              id="lp-set-https-enabled"
              type="checkbox"
              checked={settings.httpsEnabled}
              onChange={(e: any) => patch({ httpsEnabled: e.target.checked })}
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
              onChange={(e: any) => patch({ httpsPort: e.target.value })}
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
              onChange={(e: any) => patch({ tlsCertFile: e.target.value })}
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
              onChange={(e: any) => patch({ tlsKeyFile: e.target.value })}
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-banner">{t("printBanner")}</label>
            <input
              id="lp-set-banner"
              type="checkbox"
              checked={settings.printBanner}
              onChange={(e: any) => patch({ printBanner: e.target.checked })}
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
              onChange={(e: any) => patch({ wsBridgeEnabled: e.target.checked })}
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-ws-compress">{t("wsCompress")}</label>
            <input
              id="lp-set-ws-compress"
              type="checkbox"
              checked={settings.wsCompressEnabled}
              onChange={(e: any) => patch({ wsCompressEnabled: e.target.checked })}
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
              onChange={(e: any) => {
                const parts = e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean);
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
              onChange={(e: any) => patch({ httpCompressEnabled: e.target.checked })}
            />
          </div>
          <div className="lp-set-row">
            <label htmlFor="lp-set-level">{t("compressLevel")}</label>
            <select
              id="lp-set-level"
              className="lp-set-input"
              value={String(settings.httpCompressLevel)}
              onChange={(e: any) => patch({ httpCompressLevel: Number(e.target.value) })}
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
              onChange={(e: any) => patch({ injectToken: e.target.checked })}
            />
          </div>
          {settings.injectToken ? (
            <div className="lp-set-warn">{t("injectTokenOnHint")}</div>
          ) : null}
          <div className="lp-set-hint">{t("bodyHint")}</div>
          {compressLine ? (
            <div className="lp-set-status">{compressLine}</div>
          ) : null}
          <div className="lp-set-foot">
            {saved ? (
              <span className={saved.err ? "lp-set-error" : "lp-set-saved"}>{saved.msg}</span>
            ) : null}
            <button type="button" className="lp-set-save" onClick={save}>
              {t("save")}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
