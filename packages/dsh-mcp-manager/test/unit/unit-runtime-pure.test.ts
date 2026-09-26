/**
 * dsh-mcp-manager — unit：#732 复杂度整改为 runtime / dispatch / pipeline / config
 * 新拆纯函数补的直接单测。覆盖短路与就绪裁决、禁用判定、参数解包、路由一致性、
 * 图片准入计数与六态投影尾段。
 */
import { describe, expect, it, vi } from "vitest";
import {
  connectableServer,
  disposePreviousGeneration,
  shortCircuitsOnState,
  virtualUnitState,
} from "../../src/server/connection/runtime/middleware.ts";
import {
  judgeEntryReadiness,
  notReadyError,
} from "../../src/server/servers/dispatch/impl/call/index.ts";
import { deniedInScope } from "../../src/server/pipeline/impl/authorize/index.ts";
import { classifyParsedJson, jsonHeadKind } from "../../src/server/pipeline/impl/args/index.ts";
import {
  countRemoteImages,
  errorText,
  routedConfigOf,
} from "../../src/server/inject/impl/image-admission/index.ts";
import {
  globalScopeToolDisabled,
  splitRegisteredName,
} from "../../src/server/inject/middleware-register.ts";
import { workspaceMismatchError } from "../../src/server/api/routes-controllers.ts";
import { settledState } from "../../src/server/servers/lifecycle/impl/state/index.ts";
import {
  normalizeDescription,
  normalizeToolCallTimeoutMs,
} from "../../src/server/config/normalize.ts";
import type { ConnectionEntry } from "../../src/server/connection/runtime/interface.ts";

const entry = (raw: Partial<ConnectionEntry>): ConnectionEntry =>
  ({
    server: { name: "s", transport: "stdio" },
    id: "id-1",
    handle: undefined,
    status: "connected",
    error: undefined,
    connectedAt: undefined,
    readySettled: true,
    everConnected: true,
    disposed: false,
    ...raw,
  }) as ConnectionEntry;

describe("中间层：连接短路与代际处置", () => {
  it("shortCircuitsOnState：非 force 时三种在途/已连态都短路，force 一律不短路", () => {
    expect(shortCircuitsOnState("connected", false)).toBe(true);
    expect(shortCircuitsOnState("connecting", false)).toBe(true);
    expect(shortCircuitsOnState("reconnecting", false)).toBe(true);
    expect(shortCircuitsOnState("failed", false)).toBe(false);
    expect(shortCircuitsOnState("connected", true)).toBe(false);
  });

  it("connectableServer：缺省与已禁用都判不可连", () => {
    expect(connectableServer(undefined, "a")).toBeUndefined();
    expect(
      connectableServer([{ name: "a", transport: "stdio", enabled: false }], "a"),
    ).toBeUndefined();
    expect(connectableServer([{ name: "a", transport: "stdio" }], "a")?.name).toBe("a");
  });

  it("disposePreviousGeneration：虚拟单元与无 id 条目只置废弃位，官方实例等结算", async () => {
    const disposeServer = vi.fn();
    await disposePreviousGeneration(undefined, disposeServer);
    expect(disposeServer).not.toHaveBeenCalled();
    const virtual = entry({ server: { name: "s", transport: "stdio", toolDefinitions: [] } });
    await disposePreviousGeneration(virtual, disposeServer);
    expect(virtual.disposed).toBe(false);
    expect(disposeServer).not.toHaveBeenCalled();
    const remote = entry({});
    await disposePreviousGeneration(remote, disposeServer);
    expect(remote.disposed).toBe(true);
    expect(disposeServer).toHaveBeenCalledWith("id-1");
  });

  it("virtualUnitState：禁用优先于拆除，拆除优先于已连（#413 契约）", () => {
    expect(
      virtualUnitState(entry({ server: { name: "s", transport: "stdio", enabled: false } }), false),
    ).toBe("disabled");
    expect(virtualUnitState(entry({}), true)).toBe("disabled");
    expect(virtualUnitState(entry({ disposed: true }), false)).toBe("stopped");
    expect(virtualUnitState(entry({}), false)).toBe("connected");
  });
});

describe("dispatch：调用就绪裁决", () => {
  it("notReadyError：用户禁用 > 后台重连中 > 其余未就绪", () => {
    expect(notReadyError("@r/s", "failed", true).message).toContain("已被用户禁用");
    expect(notReadyError("@r/s", "reconnecting", false).message).toContain("正在后台重连");
    expect(notReadyError("@r/s", "stopped", false).message).toContain("未连接或连接失败");
  });

  it("judgeEntryReadiness：六态未就绪集 + connecting 都拒，connected 才放行", () => {
    expect(judgeEntryReadiness("@r/s", "s", false, undefined).ready).toBe(false);
    for (const status of ["failed", "reconnecting", "stopped", "disabled"] as const) {
      expect(judgeEntryReadiness("@r/s", "s", false, entry({ status })).ready).toBe(false);
    }
    // ReadinessVerdict 是判别联合：error 只存在于 ready:false 分支，先窄化再取。
    const connecting = judgeEntryReadiness("@r/s", "s", false, entry({ status: "connecting" }));
    expect(connecting.ready).toBe(false);
    expect(connecting.ready === false ? connecting.error.message : "").toContain("连接仍在进行");
    const ok = judgeEntryReadiness("@r/s", "s", false, entry({ status: "connected" }));
    expect(ok.ready).toBe(true);
    expect(ok.ready && ok.entry.status).toBe("connected");
  });
});

describe("pipeline：禁用与参数解包", () => {
  it("deniedInScope：集合存在、非空且命中才算禁用", () => {
    const map = new Map([["/r", new Map([["s", new Set(["t"])]])]]);
    expect(deniedInScope(map, "/r", "s", "t")).toBe(true);
    expect(deniedInScope(map, "/r", "s", "x")).toBe(false);
    expect(deniedInScope(new Map([["/r", new Map([["s", new Set()]])]]), "/r", "s", "t")).toBe(
      false,
    );
    expect(deniedInScope(undefined, "/r", "s", "t")).toBe(false);
  });

  it("jsonHeadKind：容器首字符与引用串首字符分开判定", () => {
    expect(jsonHeadKind('{"a":1}').container).toBe(true);
    expect(jsonHeadKind("[1]").container).toBe(true);
    expect(jsonHeadKind('"{\"a\":1}"').quoted).toBe(true);
    expect(jsonHeadKind("plain")).toEqual({ container: false, quoted: false });
  });

  it("classifyParsedJson：对象直得、数组归空态、引用串剥一层、其余不可解", () => {
    expect(classifyParsedJson({ a: 1 }, false)).toEqual({ kind: "result", result: { a: 1 } });
    expect(classifyParsedJson([1, 2], false)).toEqual({ kind: "result", result: {} });
    expect(classifyParsedJson('{"a":1}', true).kind).toBe("next");
    expect(classifyParsedJson('{"a":1}', false).kind).toBe("bail");
    expect(classifyParsedJson("plain", true).kind).toBe("bail");
    expect(classifyParsedJson(7, true).kind).toBe("bail");
  });
});

describe("inject：注册名反解、图片准入与路由一致性", () => {
  it("splitRegisteredName：无分隔或空工具名不归本守卫管", () => {
    expect(splitRegisteredName("mcp__abc")).toBeUndefined();
    expect(splitRegisteredName("mcp____")).toBeUndefined();
    expect(splitRegisteredName("mcp__id__tool")).toEqual({ segment: "id", tool: "tool" });
  });

  it("globalScopeToolDisabled：仅查 @global 共享记录", () => {
    const map = new Map([["@global", new Map([["s", new Set(["t"])]])]]);
    expect(globalScopeToolDisabled(map, "s", "t")).toBe(true);
    expect(globalScopeToolDisabled(map, "s", "x")).toBe(false);
    expect(globalScopeToolDisabled(undefined, "s", "t")).toBe(false);
  });

  it("routedConfigOf：requestHeader 抛错按无快照处理（须带 receiver 调用）", () => {
    expect(routedConfigOf(undefined)).toBeUndefined();
    expect(routedConfigOf({ requestHeader: () => ({ config: { provider: "p" } }) })).toEqual({
      provider: "p",
    });
    const withThis = {
      marker: 1,
      requestHeader(this: { marker: number }) {
        return { config: { model: `m${this.marker}` } };
      },
    };
    expect(routedConfigOf(withThis)).toEqual({ model: "m1" });
    expect(
      routedConfigOf({
        requestHeader: () => {
          throw new Error("no snapshot");
        },
      }),
    ).toBeUndefined();
  });

  it("countRemoteImages：只数远端原始图片块（模型面 attachment 形态不计）", () => {
    expect(
      countRemoteImages([
        { type: "image", data: "AAA" },
        { type: "image", attachment: "ref" },
        { type: "text", text: "x" },
      ]),
    ).toBe(1);
  });

  it("errorText：Error 取 message，其余按 String", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("boom")).toBe("boom");
  });

  it("workspaceMismatchError：@global 或当前会话 root 放行，否则给一致性文案", () => {
    expect(workspaceMismatchError("@global", "/r", "@global/s")).toBeNull();
    expect(workspaceMismatchError("/r", "/r", "@/r/s")).toBeNull();
    expect(workspaceMismatchError("/other", "/r", "@/other/s")).toContain("不属于当前工作空间");
  });
});

describe("lifecycle/config：六态尾段与配置归一", () => {
  it("settledState：工具面命中即 connected，否则 failed / reconnecting", () => {
    const base = {
      enabled: true,
      userDisabled: false,
      tornDown: false,
      disposed: false,
      mountStarted: true,
      readySettled: true,
      everConnected: true,
      reconnectEnabled: true,
      windowExpired: false,
      hasTools: () => true,
    };
    expect(settledState(base, "id")).toBe("connected");
    const noTools = { ...base, hasTools: () => false };
    expect(settledState(noTools, "id")).toBe("reconnecting");
    expect(settledState({ ...noTools, reconnectEnabled: false }, "id")).toBe("failed");
    expect(settledState({ ...noTools, everConnected: false }, "id")).toBe("failed");
  });

  it("normalizeToolCallTimeoutMs：正数向下取整，非正 / 非数回落缺省", () => {
    expect(normalizeToolCallTimeoutMs(2.7)).toBe(2);
    expect(normalizeToolCallTimeoutMs(0)).toBe(normalizeToolCallTimeoutMs(Number.NaN));
    expect(normalizeToolCallTimeoutMs(0)).toBeGreaterThan(0);
  });

  it("normalizeDescription：去首尾空白，空串与非字符串判缺省", () => {
    expect(normalizeDescription("  hi  ")).toBe("hi");
    expect(normalizeDescription("   ")).toBeUndefined();
    expect(normalizeDescription(5)).toBeUndefined();
  });
});
