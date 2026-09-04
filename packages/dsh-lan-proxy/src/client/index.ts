/**
 * dsh-lan-proxy — 浏览器端（自包含）。
 *
 * 行为：在「设置 → 插件」面板渲染 dsh-lan-proxy 配置卡片（settings.plugin.item
 * 插槽，idle 插件同款风格）：
 * - 启用开关 / LAN 端口 / HTTPS 开关与端口 / 证书与私钥文件 / 启动横幅开关；
 * - 点「保存」经 loopback HTTP 配置路由提交增量 patch，宿主端转写官方 settings
 *   命名空间（scope.update/replace），scope.watch 触发转发器热更新（保存即热
 *   更新，无需重启 dsh web）。
 *
 * 配置单一事实源在宿主官方 settings 存储（issue #110）；卡片读取走 GET 快照
 * （user 层 + effective 生效值 + 压缩协商计数），多标签页共享。
 */

// 浏览器半区干净模块：只导出 apply/inject；React 由构建期 external 注入（经 factory
// 注入的 require("react") 解析，dsh web 不暴露全局 React）。契约外壳（IIFE/load/
// Symbol.toStringTag 装配）由 scripts/build/build-client.ts 统一生成——源码不写任何 loader。
// 样式：独立 style.css（见同目录），build-client 的 .css text-loader 构建期内联为字符串
import STYLE from "./style.css";
// 样式注入收敛 shared/client/ensure-style.js（issue #477）：本包只补
// { id, cssText, version } 实参；STYLE_ID/CSS_VERSION 常量保留为调用实参来源，
// disposer（getElementById(STYLE_ID)）沿用常量。
import { ensureStyle } from "../../../../shared/client/ensure-style.js";
import * as React from "react";
// i18n（issue #348）：复用官方 dsh-client-locale——zh/en 双语字典，LocaleNamespaceMap
// 声明合并进官方 ui-slots 类型面；仅 import type（编译期擦除，无运行时依赖）。
import { zh, en, type LanProxyLocaleKey } from "./locales.ts";
// 显式类型导入，先把 @deepseek-ai/dsh-client-ui-slots 拉进模块解析图：上游发布物
// lib/types/*.d.ts 相对导入保留 .ts 后缀，declare module 增强的模块名解析会判
// TS2664（microsoft/TypeScript#63960 同类；上游修复发布物后此行可删）。
import type { LocaleNamespaceMap } from "@deepseek-ai/dsh-client-ui-slots";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** dsh-lan-proxy 设置卡文案。 */
    "settings.lanProxy": LanProxyLocaleKey;
  }
}

/** 本插件字典命名空间（宿主 locale 服务注册用）。 */
const NS = "settings.lanProxy";

var CONFIG_ROUTE = "/api/dsh-lan-proxy/config";
  var STYLE_ID = "dsh-lan-proxy-style";
  var CSS_VERSION = "4";

  /** i18n 翻译函数（apply 时由 ctx.locale.bind(NS) 装配；未装配回落 key 本体，行为零变化）。 */
  var t: any = function (key: string, params?: any) {
    if (params === undefined) return key;
    return String(key); // 未装配时占位插值忽略（正常路径早已装配）
  };

  /** 展示缺省值（与宿主 DEFAULT_OPTIONS 同构；用户层未保存的键回落这些值）。 */
  var DEFAULTS: Record<string, any> = {
    enabled: true,
    port: 3081,
    httpsEnabled: true,
    httpsPort: 3443,
    tlsCertFile: "",
    tlsKeyFile: "",
    printBanner: true,
    wsCompressEnabled: true,
    wsCompressPaths: ["/api/remote.mux"],
    httpCompressEnabled: true,
    httpCompressLevel: 1,
    injectToken: true,
  };

  var disposed = false;

  // ------------------------------------------------------------ 设置卡片

  /** 增量 diff 的键值比较：路径白名单数组按元素逐一比较，其余严格相等。 */
  function sameSetting(key: string, a: any, b: any): boolean {
    if (key === "wsCompressPaths") {
      var la = Array.isArray(a) ? a : [];
      var lb = Array.isArray(b) ? b : [];
      if (la.length !== lb.length) return false;
      for (var i = 0; i < la.length; i++) {
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
    var stats = c.httpCompressStats || {};
    return t("compressOn", { neg: stats.compressed || 0, pass: stats.passthrough || 0 });
  }

  /**
   * 设置面板插件项：启用 / LAN 端口 / HTTPS / 证书文件 / 启动横幅。
   * 改动只在点「保存」后生效：经 loopback HTTP 路由写入官方 settings 存储，
   * 宿主 scope.watch 立即重建转发器。
   */
  function SettingsCard() {
    var ReactHooks = React;
    var useState = ReactHooks.useState;
    var useEffect = ReactHooks.useEffect;
    var draft = useState(null);
    var settings = draft[0];
    var setSettings = draft[1];
    // 保存反馈（i18n 重构：msg + err 结构化状态，不能用文案内容判断错误态）
    var savedDraft = useState(null);
    var saved = savedDraft[0];
    var setSaved = function (msg: string, err?: boolean) { savedDraft[1](msg ? { msg: msg, err: err === true } : null); };
    var openState = useState(false);
    var open = openState[0];
    var setOpen = openState[1];
    // HTTP 压缩运行快照（issue #33 子项 3）：GET 快照附带，底部轻量状态行展示。
    var compressDraft = useState(null);
    var compress = compressDraft[0];
    var setCompress = compressDraft[1];
    // 加载基线（issue #33 子项 2）：保存时只提交与基线不同的键（增量 diff），
    // 未改动的键不提交——组合层 base 设值不会被客户端默认值静默覆盖回写。
    var baseline: Record<string, any> | null = null;
    // 乐观并发凭据（官方 descriptor.revision）：PUT 时回传，冲突时提示刷新。
    var revision: any = null;

    function loadCard(alive: { value: boolean }) {
      fetch(CONFIG_ROUTE, { headers: { accept: "application/json" } })
        .then(function (r: any) { return r.json(); })
        .then(function (v: any) {
          if (!alive.value) return;
          var merged: Record<string, any> = {};
          // 展示校准（issue #33 子项 2）：DEFAULTS 兜底 → 宿主生效值（组合层
          // base 设值的键显示实际生效值）→ 用户层（上次在本卡片保存的内容，
          // 作为编辑基线；descriptor.user 的键存在即用户设过值）。
          for (var key in DEFAULTS) merged[key] = DEFAULTS[key];
          var effective = (v && v.effective) || {};
          for (var ek in DEFAULTS) {
            if (effective[ek] !== undefined && effective[ek] !== null) merged[ek] = effective[ek];
          }
          var user = (v && v.user) || {};
          for (var pk in user) merged[pk] = user[pk];
          baseline = Object.assign({}, merged);
          revision = (v && v.revision) || null;
          setCompress((v && v.compress) || null);
          setSettings(merged);
        })
        .catch(function (e: any) {
          if (!alive.value) return;
          setSaved(t("loadFail", { msg: (e && e.message) || e }), true);
        });
    }

    useEffect(function () {
      var alive = { value: true };
      loadCard(alive);
      return function () { alive.value = false; };
    }, []);

    if (!settings) {
      return React.createElement("li", { className: "lp-set-card" }, t("settingsLoading"));
    }

    function patch(p: any) {
      setSettings(Object.assign({}, settings, p));
      setSaved("");
    }

    function save() {
      // 本地预校验（issue #33 子项 1）：数字键先归一化，非法值在提交前就
      // 指明字段与合法范围——不依赖宿主整体拒绝后才报错。
      var portValue = Number(settings.port);
      if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
        setSaved(t("portRangeFail"), true);
        return;
      }
      var httpsPortValue = Number(settings.httpsPort);
      if (!Number.isInteger(httpsPortValue) || httpsPortValue < 1 || httpsPortValue > 65535) {
        setSaved(t("httpsPortRangeFail"), true);
        return;
      }
      var levelValue = Number(settings.httpCompressLevel);
      if (!Number.isInteger(levelValue) || levelValue < 0 || levelValue > 3) {
        setSaved(t("levelRangeFail"), true);
        return;
      }
      // 增量提交（issue #33 子项 2）：只发送与加载基线不同的键，未改动的键
      // 不提交——组合层 base 设值不会被客户端默认值静默覆盖回写；宿主端把
      // patch 经 scope.update 增量合并进官方设置存储的用户层。
      var normalized: Record<string, any> = { port: portValue, httpsPort: httpsPortValue, httpCompressLevel: levelValue };
      var payload: Record<string, any> = {};
      for (var key in DEFAULTS) {
        var cur = key in normalized ? normalized[key] : settings[key];
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
      }).then(function (r: any) {
        return r.json().then(function (body: any) {
          if (!r.ok) {
            var err = (body && body.error) || {};
            throw new Error(err.details || err.code || ("HTTP " + r.status));
          }
          return body;
        });
      }).then(function (body: any) {
        baseline = Object.assign({}, settings);
        revision = (body && body.revision) || revision;
        setSaved(t("savedOk"));
        setTimeout(function () { setSaved(""); }, 2200);
      }).catch(function (e: any) {
        var msg = (e && e.message) || e;
        setSaved(String(msg).indexOf("已被其他窗口修改") >= 0
          ? t("saveFailConflict", { msg: msg })
          : t("saveFail", { msg: msg }), true);
      });
    }

    return React.createElement("li", { className: "lp-set-card" + (open ? " lp-set-cardOpen" : "") },
      React.createElement("button", {
        type: "button",
        className: "lp-set-head",
        "aria-expanded": open,
        onClick: function () { setOpen(!open); },
      },
        React.createElement("span", { className: "lp-set-headText" },
          React.createElement("span", { className: "lp-set-name" }, t("settingsName")),
          React.createElement("span", { className: "lp-set-description" }, t("settingsDescription")),
        ),
        React.createElement("svg", {
          className: "lp-set-chevron" + (open ? " lp-set-chevronOpen" : ""),
          width: 14,
          height: 14,
          viewBox: "0 0 14 14",
          fill: "none",
          xmlns: "http://www.w3.org/2000/svg",
          "aria-hidden": "true",
        },
          React.createElement("path", {
            d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
            fill: "currentColor",
          }),
        ),
      ),
      open ? React.createElement("div", { className: "lp-set-body" },
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-enabled" }, t("enable")),
          React.createElement("input", {
            id: "lp-set-enabled",
            type: "checkbox",
            checked: settings.enabled,
            onChange: function (e: any) { patch({ enabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-port" }, t("lanPort")),
          React.createElement("input", {
            id: "lp-set-port",
            className: "lp-set-input",
            type: "number",
            inputMode: "numeric",
            min: 1,
            max: 65535,
            value: settings.port,
            onChange: function (e: any) { patch({ port: e.target.value }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-https-enabled" }, t("httpsCoexist")),
          React.createElement("input", {
            id: "lp-set-https-enabled",
            type: "checkbox",
            checked: settings.httpsEnabled,
            onChange: function (e: any) { patch({ httpsEnabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-https-port" }, t("httpsPort")),
          React.createElement("input", {
            id: "lp-set-https-port",
            className: "lp-set-input",
            type: "number",
            inputMode: "numeric",
            min: 1,
            max: 65535,
            value: settings.httpsPort,
            onChange: function (e: any) { patch({ httpsPort: e.target.value }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-cert" }, t("certFile")),
          React.createElement("input", {
            id: "lp-set-cert",
            className: "lp-set-input",
            type: "text",
            placeholder: t("certPlaceholder"),
            value: settings.tlsCertFile,
            onChange: function (e: any) { patch({ tlsCertFile: e.target.value }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-key" }, t("keyFile")),
          React.createElement("input", {
            id: "lp-set-key",
            className: "lp-set-input",
            type: "text",
            placeholder: t("keyPlaceholder"),
            value: settings.tlsKeyFile,
            onChange: function (e: any) { patch({ tlsKeyFile: e.target.value }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-banner" }, t("printBanner")),
          React.createElement("input", {
            id: "lp-set-banner",
            type: "checkbox",
            checked: settings.printBanner,
            onChange: function (e: any) { patch({ printBanner: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-ws-compress" }, t("wsCompress")),
          React.createElement("input", {
            id: "lp-set-ws-compress",
            type: "checkbox",
            checked: settings.wsCompressEnabled,
            onChange: function (e: any) { patch({ wsCompressEnabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-ws-paths" }, t("wsPaths")),
          React.createElement("input", {
            id: "lp-set-ws-paths",
            className: "lp-set-input",
            type: "text",
            placeholder: "/api/remote.mux",
            value: (settings.wsCompressPaths || []).join(", "),
            onChange: function (e: any) {
              const parts = e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean);
              patch({ wsCompressPaths: parts });
            },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-http-compress" }, t("httpCompress")),
          React.createElement("input", {
            id: "lp-set-http-compress",
            type: "checkbox",
            checked: settings.httpCompressEnabled,
            onChange: function (e: any) { patch({ httpCompressEnabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-level" }, t("compressLevel")),
          React.createElement("select", {
            id: "lp-set-level",
            className: "lp-set-input",
            value: String(settings.httpCompressLevel),
            onChange: function (e: any) { patch({ httpCompressLevel: Number(e.target.value) }); },
          },
            React.createElement("option", { value: "0" }, t("level0")),
            React.createElement("option", { value: "1" }, t("level1")),
            React.createElement("option", { value: "2" }, t("level2")),
            React.createElement("option", { value: "3" }, t("level3")),
          ),
        ),
        // injectToken（issue #380）：默认开启——LAN 设备免 token 直入；开启态
        // 持久显示安全警示（评审要求：横幅一次性警示不足，卡片常驻提醒）。
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-inject-token" }, t("injectToken")),
          React.createElement("input", {
            id: "lp-set-inject-token",
            type: "checkbox",
            checked: settings.injectToken,
            onChange: function (e: any) { patch({ injectToken: e.target.checked }); },
          }),
        ),
        settings.injectToken ? React.createElement("div", { className: "lp-set-warn" }, t("injectTokenOnHint")) : null,
        React.createElement("div", { className: "lp-set-hint" }, t("bodyHint")),
        (function () {
          var compressLine = compressStatusLine(compress);
          return compressLine ? React.createElement("div", { className: "lp-set-status" }, compressLine) : null;
        })(),
        React.createElement("div", { className: "lp-set-foot" },
          saved ? React.createElement("span", { className: saved.err ? "lp-set-error" : "lp-set-saved" }, saved.msg) : null,
          React.createElement("button", { type: "button", className: "lp-set-save", onClick: save }, t("save")),
        ),
      ) : null,
    );
  }

  // ------------------------------------------------------------ 装配

export function apply(ctx: any) {
    try {
      var slots = ctx.get("slots");
      if (!slots) {
        console.warn("[dsh-lan-proxy] 缺少 slots 服务，设置面板未挂载");
        return;
      }

      ensureStyle({ id: STYLE_ID, cssText: STYLE, version: CSS_VERSION });

      // i18n（issue #348）：注册本插件字典；t 绑定官方 locale 服务（未装配回落 key 本体）。
      var locale: any = ctx.get("locale");
      var unsubLocale: any = null;
      if (locale && typeof locale.register === "function") {
        try {
          locale.register(NS, { zh: zh, en: en });
          t = locale.bind(NS);
          if (typeof locale.subscribe === "function" && typeof locale.getSnapshot === "function") {
            unsubLocale = locale.subscribe(function () {
              try { t = locale.bind(NS); } catch (e) { /* 忽略 */ }
            });
          }
        } catch (e) {
          console.warn("[dsh-lan-proxy] locale 注册失败：", e);
        }
      }

      // 设置面板插件项。
      // ⚠️ rc.7 起 settings.plugin.item 由 list(id) 改为 keyed(key)：
      //   - 旧版（<=rc.6）只看 `id`；
      //   - rc.7 只看 `key`，且要求与宿主端 serve 的命名空间一致（dsh-lan-proxy）。
      // 社区一致范式（见 ysr666/dsh-vision-router#165/#162）：**id 与 key 双写**，
      // 让新旧两代 slot 运行时都接受（多余字段被忽略）。key 必须等于宿主端
      // 注册进 settings 服务的命名空间，才会被 configurable 面板派发。
      slots.inject("settings.plugin.item", function () {
        return slots.register(
          { name: "settings.plugin.item", id: "dsh-lan-proxy", key: "dsh-lan-proxy", order: 50, locale: NS },
          function () {
            return React.createElement(SettingsCard, null);
          }
        );
      });

      // ⚠️ 清理必须写在 ctx.effect 返回的 disposer 里。
      ctx.effect(function () {
        return function () {
          disposed = true;
          if (unsubLocale) unsubLocale();
          var style = document.getElementById(STYLE_ID);
          if (style) style.remove();
        };
      }, "dsh-lan-proxy");
    } catch (e) {
      console.warn("[dsh-lan-proxy] 挂载失败：", e);
    }
  }

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块，React externals）----
// 设置卡片是 React 组件（settings.plugin.item 插槽由宿主 React 渲染）。
export const inject: string[] = ["slots", "locale"];
