/**
 * dsh-jev-decide — 浏览器端（自包含干净模块，React externals）。
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
import { t } from "./locale.ts";
import { JevCard } from "./settings/card.tsx";

const STYLE_ID = "dsh-jev-decide-style";
const CSS_VERSION = "1";

/** 宿主插槽读形态（本包只用 settings.section 的 inject/register；缺失即 tab 不挂载）。 */
interface SlotsView {
  inject: (name: string, setup: () => unknown) => unknown;
  register: (item: Record<string, unknown>, render: () => unknown) => unknown;
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
      console.warn("[dsh-jev-decide] 缺少 slots 服务，设置 tab 未挂载");
      return;
    }
    // 设置面板独立 tab（settings.section）：旧运行时无此插槽即回调不执行，
    // tab 不挂载——不做 plugin.item 双插槽重复展示。
    try {
      slots.inject("settings.section", function () {
        return slots.register(
          {
            name: "settings.section",
            id: "dsh-jev-decide",
            order: 80,
            label: () => t("tabLabel"),
          },
          function () {
            return <JevCard />;
          },
        );
      });
    } catch (e) {
      console.warn("[dsh-jev-decide] 设置 tab 注册失败：", e);
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
    }, "dsh-jev-decide");
  } catch (e) {
    console.warn("[dsh-jev-decide] 挂载失败：", e);
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块，React externals） ----
export const inject: string[] = ["slots"];
