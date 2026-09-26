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
import { bindTranslate, t, unbindTranslate, type DecisionTextKey } from "./locale.ts";
import { en, zh } from "./locales.ts";
import { DecisionCard } from "./settings/card.tsx";
// 宿主服务面一律取官方类型（rc.2 起本地不再自建镜像 interface）：ctx 经 cordis Context 派生，
// locale / slots 经官方服务类 Pick 出本包用到的最小面。上游改名或改签名即 tsc 判红。
// 仅 import type，编译期擦除，产物零运行时依赖。
import type { Context } from "@deepseek-ai/cordis";
import type { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";

// 字典命名空间并入官方 LocaleNamespaceMap：locale.register 的 typed 重载据此按声明键面校验
// zh/en 两份字典（实测：字典缺键编译期判红 TS2741；多键属结构兼容不报，键面由 locale.ts 的
// DecisionTextKey = keyof typeof zh 单一锁死），并让 bind 返回键面正确的官方 Translate。
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** dsh-decision-gateway 设置页全部文案。 */
    "decision-gateway": DecisionTextKey;
  }
}

const STYLE_ID = "dsh-decision-gateway-style";
const CSS_VERSION = "1";
/** 宿主 locale 字典命名空间（register/bind/subscribe 同名；notifier 同款）。 */
const NS = "decision-gateway";

/**
 * 宿主 locale 服务读面 = 官方 LocaleRuntime 的最小派生：只取本包用到的 register / bind /
 * subscribe / getSnapshot 四个成员，签名与返回值一律官方原样（含 register 的 typed 重载
 * 与 bind 的 Translate 形态），不收窄、不丢 disposer。自建镜像 interface 已删。
 */
type LocaleServiceView = Pick<LocaleRuntime, "register" | "bind" | "subscribe" | "getSnapshot">;

/**
 * 宿主插槽读面 = 官方 SlotRegistry 的最小派生（本包只用 settings.section 的 inject /
 * register，官方声明两者的回调与返回值都带 disposer 语义；缺失即 tab 不挂载）。
 */
type SlotsView = Pick<SlotRegistry, "inject" | "register">;

/**
 * 浏览器端上下文窄面 = cordis Context 的最小派生（实际使用的面：get + effect；与 inject 对齐）。
 * get 走官方重载：ctx.get("locale") / ctx.get("slots") 直接带出官方服务类型，无需断言。
 */
type ClientContext = Pick<Context, "get" | "effect">;

/**
 * 装配 i18n 绑定（独立于 slots 挂载：两者的失败面不同——slots 缺席是「tab 不挂载」，
 * locale 缺席只是回落本地字典）。
 *
 * 返回取消函数供 disposer 调用；宿主未装配 locale 服务时回 undefined（不订阅）。
 * 收窄后的别名：嵌套回调内 narrowing 会重置，别名本身即非空类型，回调内照常可用。
 */
function mountLocale(ctx: ClientContext): (() => void) | undefined {
  // ctx.get 走官方重载，locale 的类型即官方 LocaleRuntime（取到的是全服务面，赋给下面的
  // 最小派生面 Pick<…, …> 是官方面到官方面的收窄，不是断言）。
  const locale: LocaleServiceView | null | undefined = ctx.get("locale");
  if (locale === null || locale === undefined || typeof locale.register !== "function") {
    return undefined;
  }
  const localeService = locale;
  // bind/subscribe 必须带接收者调用：宿主实现依赖 this，detached 摘出即抛，失败被
  // catch 兜住后回落本地字典（notifier 同款注释，防后人"简化"成 detached 调用）。
  // 重绑单点：初装与订阅回调共用——bind 抛错/返回非函数同样回落本地字典
  // （bindTranslate 内二次守住）；初绑失败不订阅（与重构前语义一致）。
  // ns 形参声明为 string（非字面量）：bind 取官方非 typed 重载 bind(ns: string): Translate，
  // 键面即 Translate<string>，与 locale.ts 的 HostTranslate 同形，装配无需断言；字典键面仍由
  // register 的 typed 重载锁死（上面 LocaleNamespaceMap 声明合并）。调用保持带接收者。
  const rebind = (ns: string): boolean => {
    // next 的类型 = 官方 bind 的返回面（ReturnType 取重载集的返回类型），不经 unknown。
    let next: ReturnType<LocaleServiceView["bind"]>;
    try {
      next = localeService.bind(ns);
    } catch (e) {
      console.warn("[dsh-decision-gateway] locale 重绑失败：", e);
      return false;
    }
    if (typeof next !== "function") {
      console.warn("[dsh-decision-gateway] locale bind 返回非函数，已回落本地字典");
      return false;
    }
    bindTranslate(next);
    return true;
  };
  let unsubLocale: (() => void) | undefined;
  try {
    localeService.register(NS, { zh: zh, en: en });
    const boundOk = rebind(NS);
    if (
      boundOk &&
      typeof localeService.subscribe === "function" &&
      typeof localeService.getSnapshot === "function"
    ) {
      unsubLocale = localeService.subscribe(function () {
        rebind(NS);
      });
    }
  } catch (e) {
    console.warn("[dsh-decision-gateway] locale 注册失败：", e);
  }
  return unsubLocale;
}

export function apply(ctx: ClientContext): void {
  try {
    const disposeStyle = ensureStyle({ id: STYLE_ID, cssText: STYLE, version: CSS_VERSION });
    let styleDisposed = false;
    const slots: SlotsView | null | undefined = ctx.get("slots");
    if (slots === null || slots === undefined || typeof slots.inject !== "function") {
      console.warn("[dsh-decision-gateway] 缺少 slots 服务，设置 tab 未挂载");
      return;
    }
    const unsubLocale = mountLocale(ctx);
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
