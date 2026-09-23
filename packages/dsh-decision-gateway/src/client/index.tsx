/**
 * dsh-decision-gateway — 浏览器端（自包含干净模块，React externals）。
 *
 * 在「设置」面板注册独立 tab「JEV 决策」（settings.section 插槽，order 80；
 * 缺插槽即 tab 不挂载）。React 由构建期 external 注入（经 factory 注入的
 * require("react") 解析，dsh web 不暴露全局 React）。契约外壳由
 * scripts/build/build-client.ts 统一生成——源码不写任何 loader 痕迹。
 * 样式独立 style.css，经 .css text-loader 构建期内联。卸载清理进 ctx.effect。
 */
import STYLE from "./style.css";
import { ensureStyle } from "../../../../shared/client/ensure-style.js";
import * as React from "react";
import { bindTranslate, t, unbindTranslate, type HostTranslate } from "./locale.ts";
import { en, zh } from "./locales.ts";
import { DecisionCard } from "./settings/card.tsx";

const STYLE_ID = "dsh-decision-gateway-style";
const CSS_VERSION = "1";
/** 宿主 locale 字典命名空间（register/bind/subscribe 同名；notifier 同款）。 */
const NS = "decision-gateway";

/** 宿主插槽读形态（本包只用 settings.section 的 inject/register；缺失即 tab 不挂载）。 */
interface SlotsView {
  inject: (name: string, setup: () => unknown) => unknown;
  register: (item: Record<string, unknown>, render: () => unknown) => unknown;
}

/** 宿主 locale 服务读形态（本包只用 register/bind/subscribe/getSnapshot；缺失即回落本地字典）。 */
interface LocaleServiceView {
  register: (ns: string, dict: { zh: unknown; en: unknown }) => void;
  bind: (ns: string) => unknown;
  // subscribe 可返回 undefined（provider-usage/mcp-manager 同款形态）：调用方一律按
  // undefined 守卫登记卸载，不预设返回非空——类型与守卫、测试三方对齐，防名实不符。
  subscribe?: (listener: () => void) => (() => void) | undefined;
  getSnapshot?: () => unknown;
}

/** 浏览器端上下文窄面（实际使用的面：get + effect；与 inject 对齐）。 */
interface ClientContext {
  get: (name: string) => unknown;
  effect: (execute: () => () => void, label?: string) => unknown;
}

export function apply(ctx: ClientContext): void {
  try {
    const disposeStyle = ensureStyle({ id: STYLE_ID, cssText: STYLE, version: CSS_VERSION });
    let styleDisposed = false;
    const slots = ctx.get("slots") as SlotsView | null | undefined;
    if (slots === null || slots === undefined || typeof slots.inject !== "function") {
      console.warn("[dsh-decision-gateway] 缺少 slots 服务，设置 tab 未挂载");
      return;
    }
    // i18n：注册本插件字典；t 绑定宿主 locale 服务（notifier 同款），订阅回调重绑，
    // 切语言免刷新跟随；未装配（旧运行时）回落本地字典，界面照常渲染。
    // 订阅取消函数供 disposer 卸载调用（守卫对齐 notifier 的 undefined 形态——不预设
    // subscribe 返回 null，防其返回 null 时 null 初始化遮蔽导致守卫失效）。
    let unsubLocale: (() => void) | undefined;
    const locale = ctx.get("locale") as LocaleServiceView | null | undefined;
    if (locale !== null && locale !== undefined && typeof locale.register === "function") {
      // 收窄后的别名：嵌套回调内 narrowing 会重置，别名本身即非空类型，回调内照常可用。
      const localeService = locale;
      // bind/subscribe 必须带接收者调用：宿主实现依赖 this，detached 摘出即抛，失败被
      // catch 兜住后回落本地字典（notifier 同款注释，防后人“简化”成 detached 调用）。
      // 重绑单点：初装与订阅回调共用——bind 抛错/返回非函数同样回落本地字典
      // （bindTranslate 内二次守住）；初绑失败不订阅（与重构前语义一致）。
      const rebind = (): boolean => {
        let next: unknown;
        try {
          next = localeService.bind(NS);
        } catch (e) {
          console.warn("[dsh-decision-gateway] locale 重绑失败：", e);
          return false;
        }
        if (typeof next !== "function") {
          console.warn("[dsh-decision-gateway] locale bind 返回非函数，已回落本地字典");
          return false;
        }
        bindTranslate(next as HostTranslate);
        return true;
      };
      try {
        localeService.register(NS, { zh: zh, en: en });
        const boundOk = rebind();
        if (
          boundOk &&
          typeof localeService.subscribe === "function" &&
          typeof localeService.getSnapshot === "function"
        ) {
          unsubLocale = localeService.subscribe(function () {
            rebind();
          });
        }
      } catch (e) {
        console.warn("[dsh-decision-gateway] locale 注册失败：", e);
      }
    }
    // 设置面板独立 tab（settings.section）：旧运行时无此插槽即回调不执行，
    // tab 不挂载——不做 plugin.item 双插槽重复展示。
    // label 传 thunk：宿主 nav 每次读取经 thunk 求值 + shell 订阅 locale 重渲染，
    // 切语言即跟随（注册期求值字符串快照是旧行为）；thunk 内只调 t(key)，不包抛错逻辑。
    try {
      slots.inject("settings.section", function () {
        return slots.register(
          {
            name: "settings.section",
            id: "dsh-decision-gateway",
            order: 80,
            label: () => t("tabLabel"),
          },
          function () {
            return <DecisionCard />;
          },
        );
      });
    } catch (e) {
      console.warn("[dsh-decision-gateway] 设置 tab 注册失败：", e);
    }
    if (unsubLocale !== undefined) {
      const unsubscribe = unsubLocale;
      ctx.effect(function () {
        return function () {
          try {
            unsubscribe();
          } catch {
            /* 卸载期静默 */
          }
          // 摘除模块级宿主绑定：否则 bound 残留 stale 宿主实现，卸载后 t() 不再回落。
          unbindTranslate();
        };
      }, "dsh-decision-gateway-locale");
    }
    ctx.effect(function () {
      return function () {
        if (styleDisposed) return;
        styleDisposed = true;
        try {
          disposeStyle();
        } catch {
          /* 卸载期静默 */
        }
      };
    }, "dsh-decision-gateway");
  } catch (e) {
    console.warn("[dsh-decision-gateway] 挂载失败：", e);
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块，React externals） ----
export const inject: string[] = ["slots", "locale"];
