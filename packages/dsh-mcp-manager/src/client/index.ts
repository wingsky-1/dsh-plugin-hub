/**
 * dsh-mcp-manager — 浏览器端客户端入口（装配层）。
 *
 * 仅含装配逻辑，不含业务实现。业务实现在 constants/dom/servers/quick-add/
 * panel/float/session/settings-card 各模块中。
 *
 * 挂载浏览器端：注入样式 + 右上角浮窗（会话跟随）+ 管理面板 + 设置页插件卡。
 * 失败策略：只 warn 不抛，绝不让 GUI 启动失败。
 *
 * 客户端干净模块：只导出 apply/inject，契约外壳（IIFE/load/Symbol.toStringTag 装配）
 * 由 scripts/build/build-client.ts 统一生成——源码不写任何 loader 痕迹。
 * 样式：独立 style.css（见同目录），build-client 的 .css text-loader 构建期内联为字符串。
 *
 * React 由 dsh web 的 factory require("react") 注入（build-client externals 路径）；
 * 设置页 `settings.plugin.item` 卡由宿主 React 渲染，故客户端必须提供 React 组件。
 */

import STYLE from "./style.css";
import * as React from "react";

import { createState, type McpState, type UiActions } from "./state.js";
import { api } from "./dom.js";
import { refresh, switchTab, close, showPanel } from "./panel.js";
import { resetForm, beginEdit } from "./quick-add.js";
import { toggleFloat, mountFloat } from "./float.js";
import { bindSession } from "./session.js";
import { SettingsCard } from "./settings-card.js";

export function apply(ctx: any): void {
  const state: McpState = createState();
  const actions: UiActions = {
    refresh: () => refresh(state, actions),
    switchTab: (tab: string) => switchTab(state, actions, tab),
    close: () => close(state),
    showPanel: () => showPanel(state, actions),
    toggleFloat: (force?: boolean) => toggleFloat(state, actions, force),
    resetForm: () => resetForm(state),
    beginEdit: (server: any) => beginEdit(state, actions, server),
  };

  try {
    // 注入样式（仅首次；容错：重复 apply 不重复创建）
    if (document.querySelector('style[data-dsh-mcp-manager-style]') === null) {
      const style = document.createElement("style");
      style.dataset.dshMcpManagerStyle = "";
      style.textContent = STYLE;
      document.head.appendChild(style);
    }

    const disposers: any[] = [];

    // 设置页插件卡（settings.plugin.item）：rc.7 起由 list(id) 改为 keyed(key)，
    // 需 id 与 key 双写且 key = 宿主端 installSettingsNamespace 注册的命名空间
    //（dsh-mcp-manager），才会被 configurable 面板派发（对照 dsh-lan-proxy）。
    const slots = ctx.get("slots");
    if (slots && typeof slots.inject === "function") {
      slots.inject("settings.plugin.item", () => slots.register(
        { name: "settings.plugin.item", id: "dsh-mcp-manager", key: "dsh-mcp-manager", order: 60 },
        () => React.createElement(SettingsCard, null),
      ));
    }

    disposers.push(mountFloat(ctx, state, actions));
    disposers.push(bindSession(ctx, state, actions));

    // 读取 settings.yaml 中的 UI 配置（右上/右下 + 偏移量），不依赖设置页。
    api(state.API.config).then((cfg: any) => {
      if (cfg !== null && typeof cfg === "object") state.mcpUiConfig = cfg;
      state.updateFloatState?.();
    }).catch(() => {});

    // 首次刷新：立即执行，失败按 500ms/1s/2s 退避重试（宿主路由可能尚未就绪，
    // 不依赖固定延迟猜测）。
    let retryTimer: any = undefined;
    const attemptRefresh = (attempt: number) => {
      refresh(state, actions).then((ok) => {
        if (!ok && attempt < 3) {
          retryTimer = setTimeout(() => attemptRefresh(attempt + 1), 500 * 2 ** attempt);
        }
      }).catch((error: any) => {
        // 防御：refresh 永不 reject（内部 try/catch），但兜底避免 unhandled rejection。
        console.warn("[dsh-mcp-manager] 首刷失败：", error);
      });
    };
    attemptRefresh(0);

    // 状态推送（SSE）：宿主状态变化（连接/重连/失败）→ 节流刷新；SSE 真正
    // 关闭（非自动重连）才降级为 10s 轮询兜底。
    let es: any = undefined;
    let refreshTimer: any = undefined;
    let esFailures = 0;
    let pollTimer: any = undefined;
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh(state, actions).catch(() => {});
      }, 500);
    };
    const startPolling = () => {
      if (pollTimer !== undefined) return;
      const tick = () => {
        pollTimer = setTimeout(() => {
          void refresh(state, actions).catch(() => {});
          tick();
        }, 10_000);
      };
      tick();
    };
    try {
      es = new EventSource(state.API.events);
      es.onmessage = (ev: MessageEvent) => {
        let msg: any;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          msg = undefined;
        }
        if (msg !== undefined && msg.type === "ui-config-changed") {
          // 配置变更（设置页保存 position/offset）→ 重新 GET /config 就地更新浮窗位置，
          // 非仅刷新 /servers；更新 mcpUiConfig 后重新定位胶囊与（若展开的）面板。
          void api(state.API.config).then((cfg: any) => {
            if (cfg !== null && typeof cfg === "object") state.mcpUiConfig = cfg;
            state.updateFloatState?.();
          }).catch(() => {});
        } else {
          scheduleRefresh();
        }
      };
      es.onerror = () => {
        // 宿主重启/热重载/网络抖动会主动断开旧连接，浏览器随即自动重连
        // （readyState 回到 CONNECTING）——这种瞬时断连不是失败，不累计。
        // 只有连接真正关闭（如路由 404）才计数，3 次后放弃 SSE 改轮询。
        if (es !== undefined && es.readyState === EventSource.CLOSED) {
          esFailures += 1;
          if (esFailures >= 3) {
            es.close();
            es = undefined;
            startPolling();
          }
        }
      };
    } catch {
      // EventSource 不可用：直接轮询兜底。
      startPolling();
    }

    // 切回本标签页/窗口时兜底刷新：隐藏期间错过的 SSE 广播不会重放，
    // 恢复可见后主动拉一次，避免 UI 停留在过期状态（如项目级显示未连接）。
    const onVisible = () => {
      if (!document.hidden) void refresh(state, actions).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);

    ctx.effect(() => () => {
      clearTimeout(retryTimer);
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      if (es !== undefined) es.close();
      document.removeEventListener("visibilitychange", onVisible);
      for (const dispose of disposers.splice(0)) dispose();
      if (state.overlay !== undefined && state.overlay.parentElement !== null) state.overlay.remove();
      // 重置全部模块级状态，但保留 mcpUiConfig（原始 dispose 不重置它，避免
      // HMR 重复 apply 期间浮窗位置瞬态跳回默认再被 api(API.config) 拉回）。
      const savedUiConfig = state.mcpUiConfig;
      Object.assign(state, createState());
      state.mcpUiConfig = savedUiConfig;
    }, "dsh-mcp-manager: ui");
  } catch (error) {
    console.warn("[dsh-mcp-manager] mount failed:", error);
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块）----
// 注入 sessions 服务以跟随当前会话（cwd 切换项目级 MCP）；slots 服务用于
// 注册设置页插件卡（settings.plugin.item）。
export const inject: string[] = ["sessions", "slots"];