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

import { createState, type McpState, type UiActions } from "./state.ts";
import { api } from "./dom.ts";
import { refresh, switchTab, close, showPanel } from "./panel.ts";
import { resetForm, beginEdit } from "./quick-add.ts";
import { toggleFloat, mountFloat } from "./float.ts";
import { bindSession } from "./session.ts";
import { SettingsCard } from "./settings-card.ts";

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

    // 状态推送（SSE）：宿主状态变化（连接/重连/失败）→ 节流刷新；SSE 放弃
    // （连续 CLOSED 3 次）才降级为 10s 轮询兜底。
    //
    // 半开连接防护（#268，移植 dsh-notifier 0.1.8 方案）：移动端切后台系统
    // 冻结 JS 并静默掐断 TCP，两端均收不到 FIN/RST，onerror/close 都不触发。
    // 三路防线：
    //   - 服务端 30s data ping 心跳（routes.ts SSE_HEARTBEAT_MS）供失活信号；
    //   - 60s watchdog：超时无帧判定半开，关旧建新；
    //   - visibilitychange 回前台：强制关旧 EventSource 重建。
    let es: any = undefined;
    let refreshTimer: any = undefined;
    let esFailures = 0;
    let pollTimer: any = undefined;
    // watchdog 状态：收到任意数据帧即喂狗；超时 → 受控重建。
    const WATCHDOG_MS = 60_000;
    let lastActivity = 0;
    let lastReconnectAt = 0;
    let watchdog: any = undefined;
    // SSE 已放弃 → 轮询接管，禁止任何路径再建 EventSource。
    let eventsRetired = false;
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh(state, actions).catch(() => {});
      }, 500);
    };
    const startPolling = () => {
      eventsRetired = true;
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
      }
      if (pollTimer !== undefined) return;
      const tick = () => {
        pollTimer = setTimeout(() => {
          void refresh(state, actions).catch(() => {});
          tick();
        }, 10_000);
      };
      tick();
    };
    // 关旧连接：所有重建路径共用此入口——覆盖 source 引用不 close 会逐步
    // 耗尽浏览器同源并发连接、其余请求全部 pending（dsh-notifier 0.1.8 同款
    // 事故），故 new EventSource 前必先关旧。
    const closeEvents = () => {
      if (es === undefined) return;
      try {
        es.close();
      } catch (error) {
        console.warn("[dsh-mcp-manager] 关闭旧 SSE 连接失败：", error);
      }
      es = undefined;
    };
    /** SSE 半开连接看门狗：60s 无任何帧（summary/ui-config-changed/ping）→ 主动重建。 */
    const armWatchdog = () => {
      if (watchdog !== undefined) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (Date.now() - lastActivity > WATCHDOG_MS) {
          forceReconnect();
        } else {
          armWatchdog(); // 期间有活动，续期再查
        }
      }, WATCHDOG_MS + 5000);
    };
    const connectEvents = () => {
      closeEvents();
      try {
        es = new EventSource(state.API.events);
        lastActivity = Date.now();
        es.onmessage = (ev: MessageEvent) => {
          // 收到任意数据帧即喂狗（含心跳 ping 帧）：链路活性证明。
          lastActivity = Date.now();
          let msg: any;
          try {
            msg = JSON.parse(String(ev.data));
          } catch {
            msg = undefined;
          }
          // 心跳帧：仅喂狗即早退——若落入下方 else 触发 scheduleRefresh，SSE
          // 会退化为隐性 30s 轮询（对齐 notifier 语义：ping 不驱动业务刷新）。
          if (msg?.type === "ping") return;
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
          // 只有连接真正关闭（如路由 404）才计数，3 次后放弃 SSE 改轮询；
          // 未达阈值时 CLOSED 后浏览器不再自动重连，交 watchdog 受控重建兜底。
          if (es !== undefined && es.readyState === EventSource.CLOSED) {
            esFailures += 1;
            if (esFailures >= 3) {
              closeEvents();
              startPolling();
            }
          }
        };
        armWatchdog();
      } catch {
        // EventSource 不可用：直接轮询兜底。
        startPolling();
      }
    };
    // 受控重建入口（关旧 + 5s 节流）：visibilitychange / watchdog 两路共用，
    // 避免赤裸 connect 重复建连。
    const forceReconnect = () => {
      if (eventsRetired) return;
      const now = Date.now();
      if (now - lastReconnectAt < 5000) return;
      lastReconnectAt = now;
      connectEvents();
    };

    // 首次建连（后续重建一律走 forceReconnect 受控入口）。
    connectEvents();

    // 切回本标签页/窗口时兜底刷新 + 强制重建 SSE（#268）：隐藏期间错过的
    // SSE 广播不会重放需补拉一次；后台期间连接可能已被静默掐断成半开，
    // onerror/close 均不触发，重建代价低（服务端首帧即全量 summary），换推送
    // 链路确定性复活。5s 节流挡快速切换的重复建连。
    const onVisible = () => {
      if (!document.hidden) {
        forceReconnect();
        void refresh(state, actions).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    ctx.effect(() => () => {
      clearTimeout(retryTimer);
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      if (watchdog !== undefined) clearTimeout(watchdog);
      closeEvents();
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