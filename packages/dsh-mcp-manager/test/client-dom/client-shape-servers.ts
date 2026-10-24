/**
 * dsh-mcp-manager — client-dom：servers 拆分文件的共享假件与生命周期。
 *
 * 环境声明仍落在每个测试文件里；这里承载原文件的手写 fetch/actions/alert/confirm、
 * locale fixture 与 6 个微任务的 settle。
 */

import { createState as actualCreateState } from "../../src/client/core/state.ts";
import type { McpServerListEntry, UiActions } from "../../src/client/core/state.ts";

export const entry = (raw: Partial<McpServerListEntry> = {}): McpServerListEntry =>
  ({
    name: "ctx7",
    transport: "stdio",
    status: "connected",
    scope: "global",
    enabled: true,
    ...raw,
  }) as McpServerListEntry;

export function createState(): ReturnType<typeof actualCreateState> {
  return actualCreateState();
}

/** 手写 fetch 假件：记录 (url, method, body)，回放固定 JSON 响应。 */
export class FetchFake {
  calls: Array<{ url: string; method: string; body: unknown }> = [];
  private failNext = false;
  private readonly realFetch: typeof globalThis.fetch;

  constructor() {
    this.realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      this.calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      if (this.failNext) {
        this.failNext = false;
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async (): Promise<unknown> => ({ error: "boom" }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async (): Promise<unknown> => ({}) });
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
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

export const FAKE_ZH: Record<string, string> = {
  actionFail: "操作失败：{msg}",
};
