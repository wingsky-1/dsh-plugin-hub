/**
 * dsh-mcp-manager — client-unit：#732 复杂度整改为客户端新拆纯函数补的直接单测。
 * 只覆盖不触 DOM 的判定与描述符（DOM 装配面由 client-dom 层与既有 e2e 覆盖）。
 * t() 未装配时回落 key 本体，故断言用 key 形态。
 */
import { describe, expect, it } from "vitest";
import {
  anchorsLeft,
  bucketServersByStatus,
  disableRowAction,
  floatPositionOf,
  isBlankSession,
  needsAttention,
  nextStagger,
  pillAnchors,
  pillDotColor,
  pillHints,
  pillPlacement,
  primaryRowAction,
  rowRequestInit,
  transformOriginFor,
  usesComposerSeat,
} from "../../src/client/float/float.ts";
import {
  bucketByStatus,
  jsonPatchInit,
  serverCardClass,
  statusActions,
} from "../../src/client/float/servers.ts";
import {
  controlText,
  formTransportValue,
  isMigratedEdit,
  isServerTransport,
  urlPlaceholderBlocks,
} from "../../src/client/float/quick-add.ts";
import type {
  McpClientContext,
  McpServerListEntry,
  McpState,
  UiActions,
} from "../../src/client/core/state.ts";
import type { ClientUiConfig } from "../../src/shared/interface.ts";

const state = (raw: Record<string, unknown>): McpState => raw as unknown as McpState;
// McpClientContext 的最小可用面：get 返回 undefined（无 i18n/slots），effect 空实现。
const ctx = (): McpClientContext => ({ get: () => undefined, effect: () => {} });
const actions = {} as unknown as UiActions;
const cfg = (raw: Partial<ClientUiConfig>): ClientUiConfig =>
  ({
    position: "top-right",
    offsetX: 8,
    offsetY: 8,
    blankY: 40,
    zIndexBase: 10,
    ...raw,
  }) as ClientUiConfig;
const server = (raw: Partial<McpServerListEntry> = {}): McpServerListEntry =>
  ({
    name: "s",
    transport: "stdio",
    status: "connected",
    scope: "global",
    enabled: true,
    ...raw,
  }) as McpServerListEntry;

describe("float：胶囊与提示", () => {
  it("pillDotColor：失败红 / 有连接绿 / 否则中性灰", () => {
    expect(pillDotColor(true, 3)).toContain("state-error");
    expect(pillDotColor(false, 1)).toContain("state-success");
    expect(pillDotColor(false, 0)).toContain("label-tertiary");
  });

  it("pillHints：无失败走「已连/总数」，有失败追加失败计数", () => {
    expect(pillHints(3, 0, 2).aria).toBe("floatAriaLabel · 2/3");
    expect(pillHints(3, 2, 1).title).toBe("floatTitle · healthFailed");
    expect(pillHints(0, 0, 0).title).toBe("floatTitle");
  });
});

describe("float：分组与行序", () => {
  it("bucketServersByStatus：未知状态归 stopped 桶而不丢行", () => {
    const byStatus = bucketServersByStatus([
      server({ status: "connected" }),
      server({ name: "u", status: "weird" }),
    ]);
    expect(byStatus.get("connected")).toHaveLength(1);
    expect(byStatus.get("stopped")).toHaveLength(1);
  });

  it("nextStagger：动画关闭返回 undefined 且不推进序号", () => {
    const base = { n: 0 };
    expect(nextStagger(base, false)).toBeUndefined();
    expect(base.n).toBe(0);
    expect(nextStagger(base, true)).toBe(0);
    expect(nextStagger(base, true)).toBe(1);
  });

  it("needsAttention：失败与重连中置顶", () => {
    expect(needsAttention(server({ status: "failed" }))).toBe(true);
    expect(needsAttention(server({ status: "reconnecting" }))).toBe(true);
    expect(needsAttention(server({ status: "connected" }))).toBe(false);
  });
});

describe("float：锚点与终坐标", () => {
  it("anchorsLeft / transformOriginFor：left-* 贴左缘，展开原点取锚点所在角", () => {
    expect(anchorsLeft("top-left")).toBe(true);
    expect(anchorsLeft("bottom-left")).toBe(true);
    expect(anchorsLeft("top-right")).toBe(false);
    expect(anchorsLeft(undefined)).toBe(false);
    expect(transformOriginFor(true, true)).toBe("bottom left");
    expect(transformOriginFor(false, false)).toBe("top right");
  });

  it("floatPositionOf：白名单外（含缺省）回落 top-right", () => {
    expect(floatPositionOf(cfg({ position: "bottom-left" }))).toBe("bottom-left");
    // 白名单外的历史串（设置文件手写）按缺省处理。
    expect(floatPositionOf(cfg({ position: "middle" as never }))).toBe("top-right");
  });

  it("pillAnchors：锚点与偏移取自配置（越界偏移回落缺省）", () => {
    // offsetX 取自配置入参，offsetY 取自 state.mcpUiConfig（垂直偏移按会话形态，见 floatTopOffset）。
    const st = state({ mcpUiConfig: cfg({ position: "bottom-right", offsetX: 3, offsetY: 7 }) });
    const anchors = pillAnchors(
      cfg({ position: "bottom-right", offsetX: 3, offsetY: 7 }),
      ctx(),
      st,
    );
    expect(anchors).toEqual({ isLeft: false, isBottom: true, offsetX: 3, offsetY: 7 });
    // 会话面取不到时按非空白会话回落 y 缺省 8。
    expect(pillAnchors(cfg({ position: "top-left" }), ctx(), state({})).offsetY).toBe(8);
  });

  it("usesComposerSeat：仅底部锚点 + 非 wide 断点才换下边界", () => {
    expect(usesComposerSeat(true, "narrow")).toBe(true);
    expect(usesComposerSeat(true, "wide")).toBe(false);
    expect(usesComposerSeat(false, "narrow")).toBe(false);
  });

  it("pillPlacement：left/top 贴容器左上；bottom 从下边界上推并 clamp 上缘", () => {
    const base = {
      rect: { top: 100, bottom: 200, left: 10, right: 110 },
      width: 40,
      height: 20,
      offsetX: 8,
      offsetY: 8,
      bottomEdge: 200,
      viewportW: 1000,
      viewportH: 800,
    };
    expect(pillPlacement({ ...base, isLeft: true, isBottom: false })).toEqual({ x: 18, y: 108 });
    expect(pillPlacement({ ...base, isLeft: false, isBottom: true })).toEqual({ x: 62, y: 172 });
    // 下边界过高时 clamp 到视口上缘 6px。
    expect(pillPlacement({ ...base, isLeft: true, isBottom: true, bottomEdge: 0 }).y).toBe(6);
  });

  it("isBlankSession：取不到会话面判非空白", () => {
    expect(isBlankSession({} as never)).toBe(false);
    const blank = {
      sessions: { list: { getSnapshot: () => ({ current: "a", byId: { a: { blank: true } } }) } },
    };
    expect(isBlankSession(blank as never)).toBe(true);
  });
});

describe("float：行内动作描述符", () => {
  const st = state({ API: { disconnect: "/d", connect: "/c", servers: "/s" }, currentCwd: "/w" });

  it("rowRequestInit：带载荷才补 content-type（纯 POST 不带头）", () => {
    expect(
      rowRequestInit({ className: "", label: "", url: "/x", method: "POST", tag: "t" }),
    ).toEqual({
      method: "POST",
    });
    const init = rowRequestInit({
      className: "",
      label: "",
      url: "/x",
      method: "PATCH",
      tag: "t",
      body: "{}",
    });
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });

  it("primaryRowAction：connected 断开 / disabled 启用 / 其余连接，三口不串", () => {
    expect(primaryRowAction(server({ status: "connected" }), st, "&cwd=%2Fw").url).toBe(
      "/d?name=s&scope=global&cwd=%2Fw",
    );
    expect(primaryRowAction(server({ status: "disabled" }), st, "").url).toBe(
      "/s?name=s&scope=global",
    );
    expect(primaryRowAction(server({ status: "stopped" }), st, "").url).toBe(
      "/c?name=s&scope=global",
    );
    expect(primaryRowAction(server({ status: "connected" }), st, "").method).toBe("POST");
    // body 只在 PATCH 动作（disabled→enable）上存在；connected 的断开动作是纯 POST。
    expect(primaryRowAction(server({ status: "disabled" }), st, "").body).toBe('{"enabled":true}');
    expect(primaryRowAction(server({ status: "connected" }), st, "").body).toBeUndefined();
  });

  it("disableRowAction：URL 不带 cwd（历史形状）", () => {
    // 本 describe 自带 st：disableRowAction 读 state.API.servers，故该键必须齐。
    const st = state({ API: { disconnect: "/d", connect: "/c", servers: "/s" }, currentCwd: "" });
    const spec = disableRowAction(server(), st);
    expect(spec.url).toBe("/s?name=s&scope=global");
    expect(spec.body).toBe('{"enabled":false}');
  });
});

describe("servers 卡片：类名与状态动作", () => {
  it("serverCardClass：失败 / 重连中加 --fail 修饰", () => {
    expect(serverCardClass(server({ status: "failed" }))).toBe("dm-server dm-server--fail");
    expect(serverCardClass(server({ status: "connected" }))).toBe("dm-server");
  });

  it("jsonPatchInit：enabled 载荷", () => {
    expect(jsonPatchInit(true).body).toBe('{"enabled":true}');
  });

  it("statusActions：connected 两键、disabled 一键、其余一键", () => {
    const st = state({
      API: { disconnect: "/d", connect: "/c", servers: "/s", reconnect: "/r" },
      currentCwd: "",
    });
    expect(
      statusActions(server({ status: "connected" }), st, actions, "&scope=global", "").map(
        (a) => a.label,
      ),
    ).toHaveLength(2);
    expect(
      statusActions(server({ status: "connected" }), st, actions, "&scope=global", "").map(
        (a) => a.label,
      ),
    ).toEqual(["disconnect", "reconnect"]);
    expect(
      statusActions(server({ status: "disabled" }), st, actions, "&scope=global", "").map(
        (a) => a.label,
      ),
    ).toEqual(["enableAndConnect"]);
    expect(
      statusActions(server({ status: "stopped" }), st, actions, "&scope=global", "").map(
        (a) => a.label,
      ),
    ).toEqual(["connect"]);
  });

  it("bucketByStatus：与浮窗同口径（未知状态归 stopped）", () => {
    const byStatus = bucketByStatus([
      server({ status: "failed" }),
      server({ name: "u", status: "weird" }),
    ]);
    expect(byStatus.get("failed")).toHaveLength(1);
    expect(byStatus.get("stopped")).toHaveLength(1);
  });
});

describe("quick-add：表单读取与写路径 guard", () => {
  it("controlText：未构建的控件回落空串", () => {
    expect(controlText(undefined)).toBe("");
    expect(controlText({ value: "x" })).toBe("x");
  });

  it("isServerTransport / formTransportValue：越界 transport 判 stdio", () => {
    expect(isServerTransport("stdio")).toBe(true);
    expect(isServerTransport("sse")).toBe(false);
    expect(formTransportValue(state({ formTransport: { value: "streamable-http" } }))).toBe(
      "streamable-http",
    );
    expect(formTransportValue(state({ formTransport: { value: "sse" } }))).toBe("stdio");
    expect(formTransportValue(state({}))).toBe("stdio");
  });

  it("isMigratedEdit：改名或改 scope 才算迁移，未在编辑态不算", () => {
    const editing = state({ editingName: "a", editing: { scope: "global" } });
    expect(isMigratedEdit(editing, { name: "a", transport: "stdio" }, { scope: "global" })).toBe(
      false,
    );
    expect(isMigratedEdit(editing, { name: "a", transport: "stdio" }, { scope: "project" })).toBe(
      true,
    );
    expect(isMigratedEdit(editing, { name: "b", transport: "stdio" }, { scope: "global" })).toBe(
      true,
    );
    expect(isMigratedEdit(state({}), { name: "a", transport: "stdio" }, { scope: "global" })).toBe(
      false,
    );
  });

  it("urlPlaceholderBlocks：新建与迁移一律中止，同名同 scope 的编辑才省略字段", () => {
    const server = { name: "a", transport: "stdio" } as const;
    expect(urlPlaceholderBlocks(state({}), server, { scope: "global" })).toBe(true);
    const editing = state({ editingName: "a", editing: { scope: "global" } });
    expect(urlPlaceholderBlocks(editing, server, { scope: "global" })).toBe(false);
    expect(urlPlaceholderBlocks(editing, server, { scope: "project" })).toBe(true);
  });
});
