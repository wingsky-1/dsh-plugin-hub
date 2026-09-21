/**
 * dsh-mcp-manager — client-unit：只读投影回写 guard 纯逻辑（#770-A3）。
 *
 * I8① 分层：test/unit 不得值引 src/client，故 isProjectionValue 的两形态锁由本层
 * 直连 src/client/float/quick-add.ts 断言（client-unit 即客户端纯逻辑层，node 环境）。
 * 与 unit-summary-a3.test.ts 的宿主回写链（stripProjectionPatch / update / add）同源：
 * 客户端省略占位符 URL + 宿主丢弃占位符，两侧同判 [REDACTED] / %5BREDACTED%5D。
 *
 * 离线，无落盘。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isProjectionValue, saveForm } from "../../src/client/float/quick-add.ts";
import { bindLocale } from "../../../../shared/client/i18n.js";

describe("#770-A3 客户端 guard 识别占位符", () => {
  it("isProjectionValue 识别两形态、放行正常值", () => {
    expect(isProjectionValue("https://[REDACTED]@example.com/mcp")).toBe(true);
    expect(isProjectionValue("https://%5BREDACTED%5D@example.com/mcp")).toBe(true);
    expect(isProjectionValue("Bearer [REDACTED]")).toBe(true);
    expect(isProjectionValue("https://example.com/mcp?token=abc")).toBe(false);
    expect(isProjectionValue("")).toBe(false);
    expect(isProjectionValue(undefined)).toBe(false);
  });
});

describe("#770-L2 迁移丢秘密大声失败", () => {
  const origFetch = globalThis.fetch;
  const origWindow = (globalThis as Record<string, unknown>).window;
  const origDocument = (globalThis as Record<string, unknown>).document;

  afterEach(() => {
    globalThis.fetch = origFetch;
    (globalThis as Record<string, unknown>).window = origWindow;
    (globalThis as Record<string, unknown>).document = origDocument;
    // 恢复 t 回落（下组 fake locale 只在本 describe 内生效，不污染他组）。
    bindLocale({ bind: () => (key: string) => key }, "dsh-mcp-manager");
    vi.restoreAllMocks();
  });

  /** 装配透传 msg 的 fake locale，使 alert 文案可断言（t 回落时 params 被吞）。 */
  function installMsgCaptureT(): void {
    bindLocale(
      {
        bind: () => (key: string, params?: Record<string, unknown>) =>
          `${key}::${String((params as { msg?: unknown } | undefined)?.msg ?? "")}`,
      },
      "dsh-mcp-manager",
    );
  }

  function makeStdioState(editingName: string | undefined, editing: unknown): any {
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

  it("migrated && editing.hasSecrets 时 alert 中止且不发请求（文案指引手动路径）", async () => {
    installMsgCaptureT();
    const alert = vi.fn();
    (globalThis as Record<string, unknown>).window = { alert };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const state = makeStdioState("old-name", {
      name: "old-name",
      scope: "global",
      hasSecrets: true,
    });
    // readForm 读出 new-name，与 editingName old-name 分叉即 migrated。
    state.formName.value = "new-name";
    const actions = { refresh: vi.fn(async () => {}), switchTab: vi.fn() };
    await saveForm(state as never, actions as never);
    expect(alert).toHaveBeenCalledTimes(1);
    const shown = String(alert.mock.calls[0]?.[0] ?? "");
    expect(shown.startsWith("saveFail")).toBe(true);
    // L2 文案锁：指引手动路径（新建同名条目填真值后删旧条目），不得承诺“重填后保存”
    // （无条件拦截下该后续路径不存在，旧文案误导）。
    expect(shown).toContain("新建同名条目");
    expect(shown).toContain("真实凭据");
    expect(shown).toContain("删除旧条目");
    expect(shown).not.toContain("后再保存");
    expect(fetchMock).not.toHaveBeenCalled();
    // 中止即保留编辑态（不 resetForm）。
    expect(state.editingName).toBe("old-name");
  });

  it("无条件拦截：表单已填真值仍中止（payload 完整值放行本次不做，fail-closed）", async () => {
    installMsgCaptureT();
    const alert = vi.fn();
    (globalThis as Record<string, unknown>).window = { alert };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const state = makeStdioState("old-name", {
      name: "old-name",
      scope: "global",
      hasSecrets: true,
    });
    state.formName.value = "new-name";
    // 用户已在表单填入自认的真值——仍须拦截（有无填值不改变 hasSecrets 判定）。
    state.formEnv.value = "MY_TOKEN=user-filled-real-value";
    const actions = { refresh: vi.fn(async () => {}), switchTab: vi.fn() };
    await saveForm(state as never, actions as never);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(alert.mock.calls[0]?.[0] ?? "")).toContain("新建同名条目");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.editingName).toBe("old-name");
  });

  it("migrated 但无秘密时正常走 POST+DELETE（不误拦）", async () => {
    const alert = vi.fn();
    (globalThis as Record<string, unknown>).window = { alert };
    (globalThis as Record<string, unknown>).document = {
      getElementById: () => null,
      querySelector: () => null,
    };
    const fetchMock = vi.fn(async (_input: unknown) => ({
      ok: true,
      json: async () => ({}),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const state = makeStdioState("old-name", {
      name: "old-name",
      scope: "global",
      hasSecrets: false,
    });
    state.formName.value = "new-name";
    const actions = { refresh: vi.fn(async () => {}), switchTab: vi.fn() };
    await saveForm(state as never, actions as never);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toBe("/api/dsh-mcp/servers");
  });
});
