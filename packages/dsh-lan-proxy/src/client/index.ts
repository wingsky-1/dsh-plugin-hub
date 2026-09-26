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
// 宿主服务面一律取官方类型（仅 import type，编译期擦除、零运行时依赖）：cordis 的
// Context 提供按服务名解析的 get 签名，下方四个窄面全部由它派生，不再自建镜像 interface。
import type { Context } from "@deepseek-ai/cordis";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ConfigForms } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";

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
 * ["slots", "configForms", "locale", "remote"] 对齐。多用一个服务却忘了声明会在类型层先露出来。
 *
 * get 取官方 cordis Context 的同名方法（Pick 保留其 `this` 绑定），故 ctx.get("slots")
 * 直接得出官方 SlotRegistry | undefined，而不是本包自造的 unknown——服务面改名/改形状判红。
 * remote 不在本包依赖图内（官方 ClientRemote 由 dsh-api-remotes 声明），仍是最小 unknown 面，
 * 由 host-trust-status.ts 的 RemoteLike 单独收窄。
 *
 * effect 的 execute 形参取自官方 Fiber["effect"]，返回值不取（官方返回
 * Disposable<Promise<void>>，本包只把 execute 交出去、清理写在 execute 内部），故返回值放宽
 * 到 unknown。按方法语法声明（与官方 cordis 一致）：方法位是双变检查，测试替身那类
 * 「只收 () => () => void」的窄形参仍可赋值，而形参类型本身始终是官方的。
 */
interface ClientContext extends Pick<Context, "get"> {
  readonly remote?: unknown;
  effect(execute: Parameters<Context["effect"]>[0], label?: string): unknown;
}

/** 宿主插槽读形态；缺失即页面不挂载。官方 SlotRegistry 的本包最小面。 */
type SlotsView = Pick<SlotRegistry, "inject" | "register">;

/**
 * 0.1.7-rc.2 settings 配置服务的目标签名；页面注册只在 Host 服务 watched namespace 时存活。
 * 官方 ConfigForms.whileServed 的本包最小面。
 */
type ConfigFormsView = Pick<ConfigForms, "whileServed">;

/**
 * locale 服务的窄读面（与 inject 声明的 ["slots", "configForms", "locale", "remote"] 对齐）：
 * 官方 LocaleRuntime 的本包最小面。四个成员都是官方类上的必选方法，服务本体缺失由
 * ctx.get("locale") 的 | undefined 表达；调用点既有的 typeof 守卫是运行时防御，原样保留。
 *
 * 成员集与 shared/client/i18n.ts 的 bindLocale 形参一致（含 bind）——本包把整个 locale
 * 读面交给 bindLocale，少一个成员即在该调用点判红。
 *
 * 已知瑕疵（按任务边界保持丢弃，不新增清理逻辑）：官方 register 两组重载都返回 disposer
 * () => void，本包沿用既有调用形态不接返回值——字典注册的清理仍由第二个 effect 的 disposer
 * 统一管，只有 subscribe 的 unsub 被存下并在卸载时调用。
 */
type LocalePort = Pick<LocaleRuntime, "register" | "bind" | "subscribe" | "getSnapshot">;

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
  // 官方 get 已按服务名给出 LocaleRuntime | undefined，窄面只是本包经 bindLocale 消费的那几个成员。
  const locale: LocalePort | null | undefined = ctx.get("locale");
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

    // 官方 get 按服务名给出 SlotRegistry / ConfigForms，窄面是本包消费的那几个成员。
    const slots: SlotsView | null | undefined = ctx.get("slots");
    const configForms: ConfigFormsView | null | undefined = ctx.get("configForms");
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
