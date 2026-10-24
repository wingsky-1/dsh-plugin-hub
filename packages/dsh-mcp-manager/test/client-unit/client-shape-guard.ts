/**
 * dsh-mcp-manager — client-unit：#770 guard 用例的环境与最小 state 假件。
 *
 * 保留原 vi.fn 手工赋值风格；restore 钩子仍注册在原 suite 内，保持 hook 层级与资源顺序。
 */
import { bindLocale } from "../../../../shared/client/i18n.js";

export function installGuardCleanup(): {
  fetch: typeof globalThis.fetch;
  window: unknown;
  document: unknown;
} {
  return {
    fetch: globalThis.fetch,
    window: (globalThis as Record<string, unknown>).window,
    document: (globalThis as Record<string, unknown>).document,
  };
}

/** 装配透传 msg 的 fake locale，使 alert 文案可断言（t 回落时 params 被吞）。 */
export function installMsgCaptureT(): void {
  bindLocale(
    {
      bind: () => (key: string, params?: Record<string, unknown>) =>
        `${key}::${String((params as { msg?: unknown } | undefined)?.msg ?? "")}`,
    },
    "dsh-mcp-manager",
  );
}

/** makeStdioState 最小内联 fake 面（刻意保留的 fake 缝：调用处 3× as never 不动，见 PR 正文 G7-4）。 */
export interface StdioStateFake {
  formName: { value: string };
  formScope: { value: string };
  formTransport: { value: string; dispatchEvent: () => void };
  formCommand: { value: string };
  formArgs: { value: string };
  formEnv: { value: string };
  formCwd: { value: string };
  formUrl: { value: string };
  formHeaders: { value: string };
  formEnabled: { checked: boolean };
  editingName: string | undefined;
  editing: unknown;
  API: { servers: string };
  projectRoot: string;
  currentCwd: string;
}

export function makeStdioState(editingName: string | undefined, editing: unknown): StdioStateFake {
  return {
    formName: { value: editingName === "old-name" ? "new-name" : "new-name" },
    formScope: { value: "global" },
    formTransport: { value: "stdio", dispatchEvent: () => {} },
    formCommand: { value: "echo" },
    formArgs: { value: "" },
    formEnv: { value: "" },
    formCwd: { value: "" },
    formUrl: { value: "" },
    formHeaders: { value: "" },
    formEnabled: { checked: true },
    editingName,
    editing,
    API: { servers: "/api/dsh-mcp/servers" },
    projectRoot: "",
    currentCwd: "",
  };
}
