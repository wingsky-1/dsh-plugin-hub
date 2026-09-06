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
import { bindLocale } from "../../../../shared/client/i18n.js";
import { SettingsCard } from "./settings-card.tsx";
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

var STYLE_ID = "dsh-lan-proxy-style";
var CSS_VERSION = "4";

  /** 展示缺省值（与宿主 DEFAULT_OPTIONS 同构；用户层未保存的键回落这些值）。 */
  var DEFAULTS: Record<string, any> = {
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

var disposed = false;

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
        bindLocale(locale, NS);
        if (typeof locale.subscribe === "function" && typeof locale.getSnapshot === "function") {
          unsubLocale = locale.subscribe(function () {
            try { bindLocale(locale, NS); } catch (e) { /* 忽略 */ }
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
          return React.createElement(SettingsCard, { defaults: DEFAULTS });
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
