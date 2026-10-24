/**
 * dsh-mcp-manager — client-dom：quick-add 拆分文件的共享假件与生命周期。
 *
 * 环境声明仍必须落在每个测试文件里；这里只承载原文件的 fetch/actions/alert/locale
 * fixture、真实构建的表单 state，以及八个微任务的 settle。
 */

import { createState as actualCreateState } from "../../src/client/core/state.ts";
import type { McpServerListEntry, McpState, UiActions } from "../../src/client/core/state.ts";
import { buildQuickAdd } from "../../src/client/float/quick-add.ts";

/** 假译函数用到的模板：只列拆分后断言真正读到文案的键。 */
export const FAKE_ZH: Record<string, string> = {
  saveFail: "保存失败：{msg}",
  importFail: "导入失败：{msg}",
  importedOk: "已导入：{names}",
  importedNone: "（无）",
  importSkipped: "跳过（已存在）：{names}",
  editServer: "编辑服务器：{name}",
  addServer: "添加服务器",
};

export function createState(): ReturnType<typeof actualCreateState> {
  return actualCreateState();
}

export const entry = (raw: Partial<McpServerListEntry> = {}): McpServerListEntry =>
  ({
    name: "ctx7",
    transport: "stdio",
    status: "connected",
    scope: "global",
    enabled: true,
    ...raw,
  }) as McpServerListEntry;

/** 手写 fetch 假件：记录 (url, method, body)，回放固定 JSON 响应。 */
export class FetchFake {
  calls: Array<{ url: string; method: string; body: unknown }> = [];
  /** 下一次响应的 body；setFail 切成非 2xx。 */
  payload: unknown = {};
  private failNext = false;
  private readonly realFetch: typeof globalThis.fetch;

  constructor() {
    this.realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      this.calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
      if (this.failNext) {
        this.failNext = false;
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async (): Promise<unknown> => ({ error: "boom" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async (): Promise<unknown> => this.payload,
      });
    }) as unknown as typeof globalThis.fetch;
  }

  failOnce(): void {
    this.failNext = true;
  }

  restore(): void {
    globalThis.fetch = this.realFetch;
  }
}

/** 手写 actions 记录器：满足 UiActions 全部成员，只记调用名。 */
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
    switchTab: (tab: string): void => {
      calls.push("switchTab:" + tab);
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

export function builtState(raw: Partial<McpState> = {}): McpState {
  const state = createState();
  Object.assign(state, raw);
  const page = buildQuickAdd(state, makeActions().actions);
  document.body.appendChild(page);
  return state;
}
