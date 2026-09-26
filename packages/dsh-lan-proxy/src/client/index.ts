/**
 * dsh-lan-proxy — 浏览器端（自包含）。
 *
 * 行为：在插件管理页的 dsh-lan-proxy 行详情中渲染配置卡片
 * （plugins.row.config 插槽，idle 插件同款风格）：
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
import { DEFAULTS } from "./shared/interface.ts";
import { LAN_PROXY_IDENTITY } from "../shared/interface.ts";
import {
  evaluateHostTrust,
  hostTrustAlert,
  readHostTrustSignals,
  type HostTrustSignals,
  type RemoteLike,
} from "./host-trust-status.ts";
// 显式类型导入，先把 @deepseek-ai/dsh-client-ui-slots 拉进模块解析图：上游发布物
// lib/types/*.d.ts 相对导入保留 .ts 后缀，declare module 增强的模块名解析会判
// TS2664（microsoft/TypeScript#63960 同类；上游修复发布物后此行可删）。

import type { LocaleNamespaceMap as _LocaleNamespaceMap } from "@deepseek-ai/dsh-client-ui-slots";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** dsh-lan-proxy 设置卡文案。 */
    "settings.lanProxy": LanProxyLocaleKey;
  }
}

/** 本插件字典命名空间（宿主 locale 服务注册用）。 */
const NS = "settings.lanProxy";
const ROW_CONFIG_SLOT = "plugins.row.config";

const STYLE_ID = "dsh-lan-proxy-style";
const CSS_VERSION = "4";

// ------------------------------------------------------------ 装配

/**
 * 浏览器端上下文的窄面（本包实际使用的面：remote/get/effect），与 inject 声明的
 * ["slots", "configForms", "locale", "remote"] 对齐；slots 与 configForms 的读形态
 * 见下方窄接口。多用一个服务却忘了声明会在类型层先露出来。
 */
interface ClientContext {
  readonly remote?: unknown;
  get: (name: string) => unknown;
  effect: (execute: () => () => void, label?: string) => unknown;
}

/** 0.1.7-rc.2 目标的 row entry owner props；form 由宿主提供，当前卡片仍保留既有 HTTP 写面。 */
interface RowConfigEntryProps {
  readonly view: "summary" | "page";
  readonly form?: unknown;
}

/** 宿主插槽读形态；缺失即页面不挂载。 */
interface SlotsView {
  inject: (name: string, setup: () => () => void) => () => void;
  register: (
    item: Record<string, unknown>,
    render: (owner: RowConfigEntryProps) => unknown,
  ) => () => void;
}

/** 0.1.7-rc.2 settings 配置服务的目标签名；页面注册只在 Host 服务 watched namespace 时存活。 */
interface ConfigFormsView {
  whileServed: (
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => () => void,
  ) => () => void;
}

/** locale 服务的窄读面（与 inject 声明的 ["slots", "configForms", "locale", "remote"] 对齐）。 */
interface LocalePort {
  register?: (ns: string, dict: { zh: unknown; en: unknown }) => void;
  subscribe?: (listener: () => void) => () => void;
  getSnapshot?: () => unknown;
}

/**
 * 故障态告警（P1-1）：配置页受 Host authority 与 settings namespace 投影约束，
 * compat-off / contract-drift 下可能不可达。故在 apply 最前面独立告警一次（每页一次，
 * 不在渲染期重复、不刷屏），且刻意排在 slots / configForms 读取之前：告警不依赖配置面。
 * 整段防御式读取，异常绝不外抛（观测失败不得打断页面启动）。
 */
function warnHostTrustOnce(hostTrustSignals: () => HostTrustSignals): void {
  try {
    const alert = hostTrustAlert(evaluateHostTrust(hostTrustSignals()));
    if (alert !== null) console.warn(`[dsh-lan-proxy] ${alert}`);
  } catch {
    /* 观测失败不得影响页面启动 */
  }
}

/**
 * locale 接缝：注册字典 → 绑翻译函数 → 订阅 locale 变化重绑，返回取消订阅（无订阅时 null）。
 *
 * 与 host trust 告警、页面注册是三处独立接缝，各有各的降级口径：这一处失败只回落 key 本体，
 * 页面注册失败则是配置页没挂上。
 */
function bindClientLocale(ctx: ClientContext): (() => void) | null {
  const locale = ctx.get("locale") as LocalePort | null | undefined;
  let unsubLocale: (() => void) | null = null;
  if (locale && typeof locale.register === "function") {
    try {
      locale.register(NS, { zh: zh, en: en });
      bindLocale(locale, NS);
      if (typeof locale.subscribe === "function" && typeof locale.getSnapshot === "function") {
        unsubLocale = locale.subscribe(function () {
          try {
            bindLocale(locale, NS);
          } catch {
            /* 忽略 */
          }
        });
      }
    } catch (e) {
      console.warn("[dsh-lan-proxy] locale 注册失败：", e);
    }
  }
  return unsubLocale;
}

export function apply(ctx: ClientContext): void {
  try {
    // host trust 观测（issue #856）：只交出信号读取器，判定在卡片渲染期做——
    // 缓存判定结果会让「兼容开关刚被保存但页面未重载」这类中间态显示错。
    const hostTrustSignals = () => readHostTrustSignals(ctx.remote as RemoteLike | undefined);

    // 告警排在 slots / configForms 读取之前：告警不依赖配置面。
    warnHostTrustOnce(hostTrustSignals);

    const slots = ctx.get("slots") as SlotsView | null | undefined;
    const configForms = ctx.get("configForms") as ConfigFormsView | null | undefined;
    if (!slots || !configForms) {
      console.warn("[dsh-lan-proxy] 缺少 slots/configForms 服务，插件配置页未挂载");
      return;
    }

    ensureStyle({ id: STYLE_ID, cssText: STYLE, version: CSS_VERSION });

    // i18n（issue #348）：注册本插件字典；t 绑定官方 locale 服务（未装配回落 key 本体）。
    const unsubLocale = bindClientLocale(ctx);

    // 页面只在 Host 服务 canonical settings namespace 时注册；namespace 撤下时，
    // whileServed 会调用这个返回值，移除 slot 注入及其注册 disposer。
    ctx.effect(
      () =>
        configForms.whileServed([LAN_PROXY_IDENTITY.settingsNamespace], () =>
          slots.inject(ROW_CONFIG_SLOT, () =>
            slots.register(
              {
                name: ROW_CONFIG_SLOT,
                key: LAN_PROXY_IDENTITY.rowConfigKey,
                locale: NS,
              },
              (owner) =>
                React.createElement(SettingsCard, {
                  view: owner.view,
                  form: owner.form,
                  defaults: DEFAULTS,
                  hostTrustSignals,
                }),
            ),
          ),
        ),
      "dsh-lan-proxy: row config page",
    );

    // ⚠️ 清理必须写在 ctx.effect 返回的 disposer 里。
    ctx.effect(function () {
      return function () {
        if (unsubLocale) unsubLocale();
        const style = document.getElementById(STYLE_ID);
        if (style) style.remove();
      };
    }, "dsh-lan-proxy");
  } catch (e) {
    console.warn("[dsh-lan-proxy] 挂载失败：", e);
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块，React externals）----
// 设置卡片是 React 组件（plugins.row.config 插槽由宿主 React 渲染）。
// "remote" 用于读取公开事实 ctx.remote.$host.isLoopback（host trust 观测的第三段
// 信号）；官方 dsh-client-ui-chat / model-selection 同款直接属性访问。
export const inject: string[] = ["slots", "configForms", "locale", "remote"];
