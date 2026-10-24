import { el } from "../../src/client/core/dom.ts";
import { createState as actualCreateState } from "../../src/client/core/state.ts";
import type { McpServerListEntry, McpState, UiActions } from "../../src/client/core/state.ts";

const BASE_FAKE_ZH: Record<string, string> = {
  floatTitle: "MCP 管理器",
  floatAriaLabel: "MCP 管理器",
  floatEmptyTitle: "还没有 MCP 服务器",
  floatEmptyCta: "去添加",
  floatGlobalSession: "全局会话",
  healthRunning: "运行中 {n}",
};

export const entry = (raw: Partial<McpServerListEntry> = {}): McpServerListEntry =>
  ({
    name: "ctx7",
    transport: "stdio",
    status: "connected",
    scope: "global",
    enabled: true,
    ...raw,
  }) as McpServerListEntry;

export const FLOAT_RENDER_FAKE_ZH: Record<string, string> = {
  ...BASE_FAKE_ZH,
  floatManage: "管理",
  groupProject: "项目级",
  groupGlobal: "全局",
  groupAttention: "需关注（{n}）",
  statusGroupCount: "{status}（{n}）",
  healthConnecting: "连接中 {n}",
  healthStopped: "未连接 {n}",
  healthFailed: "失败 {n}",
  serverMeta: "{status} · {tools} 工具",
  toolsCount: "工具（{n}）",
  stConnected: "运行中",
  stConnecting: "连接中",
  stReconnecting: "重连中",
  stStopped: "未连接",
  stDisabled: "已停用",
  stFailed: "失败",
  disconnect: "断开",
  reconnect: "重连",
  connect: "连接",
  enable: "启用",
  disable: "禁用",
};

export function createState(): ReturnType<typeof actualCreateState> {
  return actualCreateState();
}

export function makeActions(): { actions: UiActions; calls: string[] } {
  const calls: string[] = [];
  const actions: UiActions = {
    refresh: async (): Promise<boolean> => {
      calls.push("refresh");
      return true;
    },
    resetForm: (): void => {
      calls.push("resetForm");
    },
    beginEdit: (): void => {
      calls.push("beginEdit");
    },
    switchTab: (): void => {
      calls.push("switchTab");
    },
    close: (): void => {
      calls.push("close");
    },
    showPanel: (): void => {
      calls.push("showPanel");
    },
    toggleFloat: (): void => {
      calls.push("toggleFloat");
    },
  };
  return { actions, calls };
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** 供拆分文件 flush 自己文件里注册的 rAF 队列。 */
export function flushRafInto(queue: Map<number, (time: number) => void>): void {
  const q = [...queue.values()];
  queue.clear();
  for (const cb of q) cb(0);
}

/** 给元素打上确定尺寸与位置（happy-dom 默认全 0，会让定位算式整条不执行）。 */
export function stubRect(
  node: HTMLElement,
  rect: { top: number; bottom: number; left: number; right: number; width: number; height: number },
): void {
  node.getBoundingClientRect = (): DOMRect =>
    ({
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: (): Record<string, number> => ({}),
    }) as DOMRect;
  Object.defineProperty(node, "offsetWidth", { value: rect.width, configurable: true });
  Object.defineProperty(node, "offsetHeight", { value: rect.height, configurable: true });
}

/** 装一对已挂载的胶囊 + 面板，带确定尺寸。 */
export function panelState(
  raw: Partial<McpState> = {},
  rect = { top: 100, bottom: 140, left: 900, right: 940, width: 40, height: 40 },
): McpState {
  const state = createState();
  Object.assign(state, raw);
  const pill = el("button", { class: "dm-float" });
  const panel = el("div", { class: "dm-float-panel" });
  panel.hidden = true;
  stubRect(pill, rect);
  stubRect(panel, { top: 0, bottom: 200, left: 0, right: 200, width: 200, height: 200 });
  document.body.appendChild(pill);
  document.body.appendChild(panel);
  state.floatPill = pill;
  state.floatPanel = panel;
  return state;
}

export class FetchFake {
  calls: Array<{ url: string; method: string; body: unknown }> = [];
  private readonly realFetch: typeof globalThis.fetch;

  constructor() {
    this.realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      this.calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
      return Promise.resolve({ ok: true, status: 200, json: async (): Promise<unknown> => ({}) });
    }) as unknown as typeof globalThis.fetch;
  }

  restore(): void {
    globalThis.fetch = this.realFetch;
  }
}

export function mountedState(
  raw: Partial<ReturnType<typeof createState>> = {},
): ReturnType<typeof createState> {
  const state = createState();
  Object.assign(state, raw);
  const pill = el("button", { class: "dm-float" });
  const panel = el("div", { class: "dm-float-panel" });
  panel.hidden = true;
  document.body.appendChild(pill);
  document.body.appendChild(panel);
  state.floatPill = pill;
  state.floatPanel = panel;
  return state;
}

export const FAKE_ZH: Record<string, string> = {
  ...FLOAT_RENDER_FAKE_ZH,
};
