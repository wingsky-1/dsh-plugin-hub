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
// Symbol.toStringTag 装配）由 scripts/build/build-client.ts 统一生成——源码不写任何 loader。
// 样式：独立 style.css（见同目录），build-client 的 .css text-loader 构建期内联为字符串
import STYLE from "./style.css";
import * as React from "react";

var CHANNEL = "/dsh-lan-proxy";
  var STYLE_ID = "dsh-lan-proxy-style";
  var CSS_VERSION = "2";

  /** 展示缺省值（与宿主 DEFAULT_OPTIONS 同构；持久化层未保存的键回落这些值）。 */
  var DEFAULTS: Record<string, any> = {
    enabled: true,
    port: 3081,
    httpsEnabled: true,
    httpsPort: 3443,
    tlsCertFile: "",
    tlsKeyFile: "",
    printBanner: true,
    wsCompressEnabled: true,
    wsCompressPaths: ["/api/events.mux", "/api/events.host"],
    httpCompressEnabled: true,
    httpCompressLevel: 1,
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
    if (c.httpCompressEnabled === false) return "HTTP 响应压缩：已关闭";
    if (c.httpCompressMounted !== true) return "HTTP 响应压缩：未生效";
    var stats = c.httpCompressStats || {};
    return "HTTP 响应压缩：已启用 · 协商 " + (stats.compressed || 0) + " 次 · 直通 " + (stats.passthrough || 0) + " 次";
  }

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
    // HTTP 压缩运行快照（issue #33 子项 3）：state 响应附带，底部轻量状态行展示。
    var compressDraft = useState(null);
    var compress = compressDraft[0];
    var setCompress = compressDraft[1];
    // 加载基线（issue #33 子项 2）：保存时只提交与基线不同的键（增量 diff），
    // 未改动的键不提交——组合层设值不会被客户端默认值静默覆盖回写。
    var baseline: Record<string, any> | null = null;

    useEffect(function () {
      var alive = true;
      rpc("state", {}).then(function (v: any) {
        if (!alive) return;
        var merged: Record<string, any> = {};
        // 展示校准（issue #33 子项 2）：DEFAULTS 兜底 → 宿主生效值（组合层
        // cordis.patch.yml 设值的键显示实际生效值，而非默认值）→ 持久化层
        // （用户上次在本卡片保存的内容，作为编辑基线）。
        for (var key in DEFAULTS) merged[key] = DEFAULTS[key];
        var effective = (v && v.effective) || {};
        for (var ek in DEFAULTS) {
          if (effective[ek] !== undefined && effective[ek] !== null) merged[ek] = effective[ek];
        }
        var persisted = (v && v.settings) || {};
        for (var pk in persisted) merged[pk] = persisted[pk];
        baseline = Object.assign({}, merged);
        setCompress((v && v.compress) || null);
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
      // 本地预校验（issue #33 子项 1）：数字键先归一化，非法值在提交前就
      // 指明字段与合法范围——不依赖宿主整体拒绝后才报错。
      var portValue = Number(settings.port);
      if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
        setSaved("保存失败：LAN 端口（HTTP）需为 1-65535 的整数");
        return;
      }
      var httpsPortValue = Number(settings.httpsPort);
      if (!Number.isInteger(httpsPortValue) || httpsPortValue < 1 || httpsPortValue > 65535) {
        setSaved("保存失败：HTTPS 端口需为 1-65535 的整数");
        return;
      }
      var levelValue = Number(settings.httpCompressLevel);
      if (!Number.isInteger(levelValue) || levelValue < 0 || levelValue > 3) {
        setSaved("保存失败：压缩档位需为 0-3 的整数");
        return;
      }
      // 增量提交（issue #33 子项 2）：只发送与加载基线不同的键，未改动的键
      // 不提交——组合层设值不会被客户端默认值静默覆盖回写；宿主端把 diff
      // 合并进 config.json 现有内容。
      var normalized: Record<string, any> = { port: portValue, httpsPort: httpsPortValue, httpCompressLevel: levelValue };
      var payload: Record<string, any> = {};
      for (var key in DEFAULTS) {
        var cur = key in normalized ? normalized[key] : settings[key];
        if (baseline === null || !sameSetting(key, cur, baseline[key])) payload[key] = cur;
      }
      if (Object.keys(payload).length === 0) {
        setSaved("未修改");
        return;
      }
      rpc("config", { settings: payload }).then(function () {
        baseline = Object.assign({}, settings);
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
          React.createElement("span", { className: "lp-set-description" }, "LAN 端口 / HTTPS / 证书 / 响应压缩 / 启动横幅"),
        ),
        React.createElement("span", { className: "lp-set-chevron" + (open ? " lp-set-chevronOpen" : "") }, "▾"),
      ),
      open ? React.createElement("div", { className: "lp-set-body" },
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-enabled" }, "启用"),
          React.createElement("input", {
            id: "lp-set-enabled",
            type: "checkbox",
            checked: settings.enabled,
            onChange: function (e: any) { patch({ enabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-port" }, "LAN 端口（HTTP）"),
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
          React.createElement("label", { htmlFor: "lp-set-https-enabled" }, "HTTPS 并存"),
          React.createElement("input", {
            id: "lp-set-https-enabled",
            type: "checkbox",
            checked: settings.httpsEnabled,
            onChange: function (e: any) { patch({ httpsEnabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-https-port" }, "HTTPS 端口"),
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
          React.createElement("label", { htmlFor: "lp-set-cert" }, "证书文件（PEM）"),
          React.createElement("input", {
            id: "lp-set-cert",
            className: "lp-set-input",
            type: "text",
            placeholder: "留空 = 自动生成自签名证书",
            value: settings.tlsCertFile,
            onChange: function (e: any) { patch({ tlsCertFile: e.target.value }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-key" }, "私钥文件（PEM）"),
          React.createElement("input", {
            id: "lp-set-key",
            className: "lp-set-input",
            type: "text",
            placeholder: "与证书文件成对",
            value: settings.tlsKeyFile,
            onChange: function (e: any) { patch({ tlsKeyFile: e.target.value }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-banner" }, "启动时打印访问地址"),
          React.createElement("input", {
            id: "lp-set-banner",
            type: "checkbox",
            checked: settings.printBanner,
            onChange: function (e: any) { patch({ printBanner: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-ws-compress" }, "WebSocket 压缩（事件流）"),
          React.createElement("input", {
            id: "lp-set-ws-compress",
            type: "checkbox",
            checked: settings.wsCompressEnabled,
            onChange: function (e: any) { patch({ wsCompressEnabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-ws-paths" }, "压缩路径（逗号分隔）"),
          React.createElement("input", {
            id: "lp-set-ws-paths",
            className: "lp-set-input",
            type: "text",
            placeholder: "/api/events.mux, /api/events.host",
            value: (settings.wsCompressPaths || []).join(", "),
            onChange: function (e: any) {
              const parts = e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean);
              patch({ wsCompressPaths: parts });
            },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-http-compress" }, "HTTP 响应压缩（Brotli/gzip）"),
          React.createElement("input", {
            id: "lp-set-http-compress",
            type: "checkbox",
            checked: settings.httpCompressEnabled,
            onChange: function (e: any) { patch({ httpCompressEnabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "lp-set-row" },
          React.createElement("label", { htmlFor: "lp-set-level" }, "压缩档位"),
          React.createElement("select", {
            id: "lp-set-level",
            className: "lp-set-input",
            value: String(settings.httpCompressLevel),
            onChange: function (e: any) { patch({ httpCompressLevel: Number(e.target.value) }); },
          },
            React.createElement("option", { value: "0" }, "默认（gzip 6 / br 4）"),
            React.createElement("option", { value: "1" }, "低（最快：gzip 1 / br 2）"),
            React.createElement("option", { value: "2" }, "中（均衡：gzip 5 / br 5）"),
            React.createElement("option", { value: "3" }, "高（最高压缩比：gzip 9 / br 9）"),
          ),
        ),
        React.createElement("div", { className: "lp-set-hint" },
          "保存即热更新（写入 ~/.dsh/lan-proxy/config.json，无需重启 dsh web）。" +
          "修改后内网设备访问新端口，旧端口立即失效。"),
        (function () {
          var compressLine = compressStatusLine(compress);
          return compressLine ? React.createElement("div", { className: "lp-set-status" }, compressLine) : null;
        })(),
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
      // ⚠️ rc.7 起 settings.plugin.item 由 list(id) 改为 keyed(key)：
      //   - 旧版（<=rc.6）只看 `id`；
      //   - rc.7 只看 `key`，且要求与宿主 serve 的命名空间一致（dsh-lan-proxy）。
      // 社区一致范式（见 ysr666/dsh-vision-router#165/#162）：**id 与 key 双写**，
      // 让新旧两代 slot 运行时都接受（多余字段被忽略）。key 必须等于宿主端
      // installSettingsNamespace 注册的命名空间，才会被 configurable 面板派发。
      slots.inject("settings.plugin.item", function () {
        return slots.register(
          { name: "settings.plugin.item", id: "dsh-lan-proxy", key: "dsh-lan-proxy", order: 50 },
          function () {
            return React.createElement(SettingsCard, null);
          }
        );
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
