/**
 * dsh-mem0 — 浏览器端客户端装配入口。
 */

import React from "react";
import STYLE from "./style.css";
import { ensureStyle } from "../../../../shared/client/ensure-style.js";
import { bindLocale, t } from "../../../../shared/client/i18n.js";
import { zh, en, type Mem0LocaleKey } from "./locales.ts";
import { MemoryCenter } from "./MemoryCenter.ts";
import type { LocaleNamespaceMap } from "@deepseek-ai/dsh-client-ui-slots";

const NS = "dshMem0";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    dshMem0: Mem0LocaleKey;
  }
}

export const inject = ["slots", "locale"];

export function apply(ctx: any): void {
  // 1. 注册 i18n 字典
  const locale: any = ctx.get("locale");
  if (locale && typeof locale.register === "function") {
    try {
      locale.register(NS, { zh, en });
      bindLocale(locale, NS);
      if (typeof locale.subscribe === "function") {
        locale.subscribe(() => {
          bindLocale(locale, NS);
        });
      }
    } catch (err) {
      console.warn("[dsh-mem0] locale register failed:", err);
    }
  }

  // 2. 注入样式
  ensureStyle({ id: "dsh-mem0-style", cssText: STYLE });

  // 3. 注册设置页独立 Tab「记忆中心」（settings.section）
  const slots = ctx.get("slots");
  if (slots && typeof slots.inject === "function") {
    slots.inject("settings.section", () =>
      slots.register(
        {
          name: "settings.section",
          id: "dsh-mem0",
          order: 75,
          label: () => t("tabLabel"),
          locale: NS,
        },
        () => React.createElement(MemoryCenter, null),
      ),
    );
  }
}
