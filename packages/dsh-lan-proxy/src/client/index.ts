/**
 * dsh-lan-proxy — 浏览器端（自包含）。
 *
 * 行为：在「设置 → 插件」面板渲染 dsh-lan-proxy 配置卡片（settings.plugin.item
 * 插槽，idle 插件同款风格）：
 * - 启用开关 / LAN 端口 / HTTPS 开关与端口 / 证书与私钥文件 / 启动横幅开关；
 * - 点「保存」经宿主 RPC 通道写插件目录 config.json，宿主 watch 后立即重建
 *   转发器（保存即热更新，无需重启 dsh web）。
 *
 * 持久化与生效配置在宿主（~/.dsh/lan-proxy/config.json），多标签页共享。
 */

// 浏览器半区干净模块：只导出 apply/inject；React 由构建期 external 注入（经 factory
// 注入的 require("react") 解析，dsh web 不暴露全局 React）。契约外壳（IIFE/load/
// Symbol.toStringTag 装配）由 scripts/build-client.ts 统一生成——源码不写任何 loader。
// 样式：独立 style.css（见同目录），build-client 的 .css text-loader 构建期内联为字符串
import STYLE from "./style.css";
import * as React from "react";

var CHANNEL = "/dsh-lan-proxy";
  var STYLE_ID = "dsh-lan-proxy-style";
  var CSS_VERSION = "1";

  /** 展示缺省值（与宿主 DEFAULT_OPTIONS 同构；持久化层未保存的键回落这些值）。 */
  var DEFAULTS: Record<string, any> = {
    enabled: true,
    port: 3081,
    httpsEnabled: true,
    httpsPort: 3443,
    tlsCertFile: "",
    tlsKeyFile: "",
    printBanner: true,
  };

  var rpc: any = null;
  var disposed = false;

  // ------------------------------------------------------------ 样式

  /** 注入卡片样式（显式版本号，热更新时旧 <style> 移除重建）。 */
  function injectStyle() {
    var existing = document.getElementById(STYLE_ID);
    if (existing && existing.dataset.version === CSS_VERSION) return;
    if (existing) existing.remove();
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.dataset.version = CSS_VERSION;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------ 设置卡片

  /**
   * 设置面板插件项：启用 / LAN 端口 / HTTPS / 证书文件 / 启动横幅。
   * 改动只在点「保存」后生效：宿主原子写 config.json 并立即重建转发器。
   */
  function SettingsCard() {
    var ReactHooks = React;
    var useState = ReactHooks.useState;
    var useEffect = ReactHooks.useEffect;
    var draft = useState(null);
    var settings = draft[0];
    var setSettings = draft[1];
    var saved = useState("");
    var setSaved = saved[1];
    var openState = useState(false);
    var open = openState[0];
    var setOpen = openState[1];

    useEffect(function () {
      var alive = true;
      rpc("state", {}).then(function (v: any) {
        if (!alive) return;
        var merged: Record<string, any> = {};
        for (var key in DEFAULTS) merged[key] = DEFAULTS[key];
        var persisted = (v && v.settings) || {};
        for (var key2 in persisted) merged[key2] = persisted[key2];
        setSettings(merged);
      }).catch(function (e: any) {
        if (!alive) return;
        setSaved("设置加载失败：" + ((e && e.message) || e));
      });
      return function () { alive = false; };
    }, []);

    if (!settings) {
      return React.createElement("li", { className: "lp-set-card" }, "局域网访问：加载中…");
    }

    function patch(p: any) {
      setSettings(Object.assign({}, settings, p));
      setSaved("");
    }

    function save() {
      var payload: Record<string, any> = {};
      for (var key in DEFAULTS) {
        var value = settings[key];
        if (key === "port" || key === "httpsPort") value = Number(value);
        payload[key] = value;
      }
      rpc("config", { settings: payload }).then(function () {
        setSaved("已保存，已热更新");
        setTimeout(function () { setSaved(""); }, 2200);
      }).catch(function (e: any) {
        setSaved("保存失败：" + (((e && e.details) || (e && e.message)) || e));
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
          React.createElement("span", { className: "lp-set-name" }, "局域网访问（dsh-lan-proxy）"),
          React.createElement("span", { className: "lp-set-description" }, "LAN 端口 / HTTPS / 证书 / 启动横幅"),
        ),
        React.createElement("span", { className: "lp-set-chevron" + (open ? " lp-set-chevronOpen" : "") }, "▾"),
      ),
      open ? React.createElement("div", { className: "lp-set-body" },
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", null, "启用"),
          React.createElement("input", {
            type: "checkbox",
            checked: settings.enabled,
            onChange: function (e: any) { patch({ enabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", null, "LAN 端口（HTTP）"),
          React.createElement("input", {
            className: "lp-set-input",
            type: "number",
            min: 1,
            max: 65535,
            value: settings.port,
            onChange: function (e: any) { patch({ port: e.target.value }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", null, "HTTPS 并存"),
          React.createElement("input", {
            type: "checkbox",
            checked: settings.httpsEnabled,
            onChange: function (e: any) { patch({ httpsEnabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", null, "HTTPS 端口"),
          React.createElement("input", {
            className: "lp-set-input",
            type: "number",
            min: 1,
            max: 65535,
            value: settings.httpsPort,
            onChange: function (e: any) { patch({ httpsPort: e.target.value }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", null, "证书文件（PEM）"),
          React.createElement("input", {
            className: "lp-set-input",
            type: "text",
            placeholder: "留空 = 自动生成自签名证书",
            value: settings.tlsCertFile,
            onChange: function (e: any) { patch({ tlsCertFile: e.target.value }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", null, "私钥文件（PEM）"),
          React.createElement("input", {
            className: "lp-set-input",
            type: "text",
            placeholder: "与证书文件成对",
            value: settings.tlsKeyFile,
            onChange: function (e: any) { patch({ tlsKeyFile: e.target.value }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", null, "启动时打印访问地址"),
          React.createElement("input", {
            type: "checkbox",
            checked: settings.printBanner,
            onChange: function (e: any) { patch({ printBanner: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-hint" },
          "保存即热更新（写入 ~/.dsh/lan-proxy/config.json，无需重启 dsh web）。" +
          "修改后内网设备访问新端口，旧端口立即失效。"),
        React.createElement("div", { className: "lp-set-foot" },
          saved ? React.createElement("span", { className: saved.indexOf("失败") >= 0 ? "lp-set-error" : "lp-set-saved" }, saved) : null,
          React.createElement("button", { type: "button", className: "lp-set-save", onClick: save }, "保存"),
        ),
      ) : null,
    );
  }

  // ------------------------------------------------------------ 装配

export function apply(ctx: any) {
    try {
      var connection = ctx.get("connection");
      var slots = ctx.get("slots");
      if (!connection || !slots) {
        console.warn("[dsh-lan-proxy] 缺少 connection/slots 服务，设置面板未挂载");
        return;
      }

      rpc = function (endpoint: any, payload: any) {
        return connection.rpc.call(CHANNEL, endpoint, payload || {}).then(function (result: any) {
          if (!result.ok) throw new Error((result.error && (result.error.details || result.error.code)) || "rpc failed");
          return result.value;
        });
      };

      injectStyle();

      // 设置面板插件项。
      slots.inject("settings.plugin.item", function () {
        return slots.register({ name: "settings.plugin.item", id: "dsh-lan-proxy", order: 50 }, function () {
          return React.createElement(SettingsCard, null);
        });
      });

      // ⚠️ 清理必须写在 ctx.effect 返回的 disposer 里。
      ctx.effect(function () {
        return function () {
          disposed = true;
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
export const inject: string[] = ["slots"];
