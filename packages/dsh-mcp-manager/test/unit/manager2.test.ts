/** Manager 方法面的自然职责测试与专属fixture。 */

import { describe, expect, it } from "vitest";

import {
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  breakpointForWidth,
  buildConfigUiPatch,
  clampPointToViewport,
  Config,
  DEFAULT_UI_CONFIG,
  normalizeServer,
  normalizeUiConfig,
  panelAnchorForPosition,
  panelTopForAnchor,
  panelZIndexFor,
  SERVER_NAME_PATTERN,
  setupManagerTestLifecycle,
  Z_INDEX_BASE_MAX,
  Z_INDEX_BASE_MIN,
} from "./manager-shape-support.ts";

const fullInput = () => ({
  name: "  web  ",
  transport: "streamable-http",
  url: "http://localhost:9/mcp ",
  headers: { A: 1 },
  toolCallTimeoutMs: 2500.9,
  description: "  custom desc  ",
  reconnect: { maxAttempts: 3 },
});

const full = () => normalizeServer(fullInput());

const stdio = () =>
  normalizeServer({
    name: "s",
    transport: "stdio",
    command: " npx ",
    args: [1, "x"],
    cwd: "/w",
    env: { K: null },
  });

const bare = () => normalizeServer({ name: "b", transport: "stdio", command: "x" });

function registerUiNormalization() {
  it("新嵌套形态归一", () => {
    expect(
      normalizeUiConfig({ ui: { position: "bottom-right", offset: { x: 1.6, y: -3, blankY: 0 } } }),
    ).toEqual({
      position: "bottom-right",
      offsetX: 2,
      offsetY: 0,
      blankY: 0,
      zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
    });
  });

  it("旧扁平 offset 形态归一", () => {
    expect(normalizeUiConfig({ position: "top-right", offset: { x: 7, y: 8, blankY: 9 } })).toEqual(
      {
        position: "top-right",
        offsetX: 7,
        offsetY: 8,
        blankY: 9,
        zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
      },
    );
  });

  it("客户端扁平 offsetX 形态优先于 offset.*", () => {
    expect(
      normalizeUiConfig({
        offsetX: 11,
        offsetY: 12,
        blankY: 13,
        offset: { x: 1, y: 2, blankY: 3 },
      }),
    ).toEqual({
      position: "top-right",
      offsetX: 11,
      offsetY: 12,
      blankY: 13,
      zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
    });
  });

  // #128 四角锚点透传 + zIndexBase clamp 边界（非法回退默认 / 越界压边界）。
  it.each(["top-left", "bottom-left"])("四角 %s 透传", (position) => {
    expect(normalizeUiConfig({ position }).position).toBe(position);
  });
}
function registerUiLayers() {
  it("合法层级基准透传", () => {
    expect(normalizeUiConfig({ zIndexBase: 5000 }).zIndexBase).toBe(5000);
  });

  it("低于下界压到 1", () => {
    expect(normalizeUiConfig({ zIndexBase: 0 }).zIndexBase).toBe(Z_INDEX_BASE_MIN);
  });

  it("超上界压到 9000", () => {
    expect(normalizeUiConfig({ zIndexBase: 99999 }).zIndexBase).toBe(Z_INDEX_BASE_MAX);
  });

  it("非数字回退默认", () => {
    expect(normalizeUiConfig({ zIndexBase: "x" }).zIndexBase).toBe(DEFAULT_UI_CONFIG.zIndexBase);
  });

  it("子浮层派生扩展点 base+30（B5）", () => {
    expect(panelZIndexFor(10)).toBe(40);
  });
}
function registerUiFallbackAndPatch() {
  it("undefined 回退默认", () => {
    expect(normalizeUiConfig(undefined)).toEqual({
      position: DEFAULT_UI_CONFIG.position,
      offsetX: DEFAULT_UI_CONFIG.offset.x,
      offsetY: DEFAULT_UI_CONFIG.offset.y,
      blankY: DEFAULT_UI_CONFIG.offset.blankY,
      zIndexBase: DEFAULT_UI_CONFIG.zIndexBase,
    });
  });

  it("字符串输入回退默认", () => {
    expect(normalizeUiConfig("junk")).toEqual({
      position: "top-right",
      offsetX: 8,
      offsetY: 8,
      blankY: 40,
      zIndexBase: 10,
    });
  });

  it("非法 position + 非有限 offset 回退默认", () => {
    expect(normalizeUiConfig({ position: "left", offsetX: Number.NaN, offsetY: Infinity })).toEqual(
      {
        position: "top-right",
        offsetX: 8,
        offsetY: 8,
        blankY: 40,
        zIndexBase: 10,
      },
    );
  });

  it("ui 非对象按顶层处理", () => {
    expect(normalizeUiConfig({ ui: 5 }).offsetX).toBe(8);
  });

  it("buildConfigUiPatch 组装嵌套 patch", () => {
    expect(
      buildConfigUiPatch({
        position: "bottom-right",
        offsetX: 4,
        offsetY: 5,
        blankY: 6,
        zIndexBase: 20,
      }),
    ).toEqual({
      position: "bottom-right",
      offset: { x: 4, y: 5, blankY: 6 },
      zIndexBase: 20,
    });
  });
}
function registerPanelAnchors() {
  it("panelAnchorForPosition bottom-right", () => {
    expect(panelAnchorForPosition("bottom-right")).toBe("bottom");
  });

  it("#128 左下也是底部锚点", () => {
    expect(panelAnchorForPosition("bottom-left")).toBe("bottom");
  });

  it("panelAnchorForPosition top-right", () => {
    expect(panelAnchorForPosition("top-right")).toBe("top");
  });

  it("#128 左上是顶部锚点", () => {
    expect(panelAnchorForPosition("top-left")).toBe("top");
  });

  it("panelAnchorForPosition undefined 回落 top", () => {
    expect(panelAnchorForPosition(undefined)).toBe("top");
  });
}
function registerViewportBreakpoints() {
  // #128 断点判定纯函数分支翻转 + 视口终 clamp（safe-area inset 恒 0 自然退化）。
  it("320 宽归 narrow", () => {
    expect(breakpointForWidth(320)).toBe("narrow");
  });

  it("480 边界归 narrow", () => {
    expect(breakpointForWidth(BREAKPOINT_NARROW_MAX)).toBe("narrow");
  });

  it("481 翻转 tablet", () => {
    expect(breakpointForWidth(BREAKPOINT_NARROW_MAX + 1)).toBe("tablet");
  });

  it("834 边界归 tablet", () => {
    expect(breakpointForWidth(BREAKPOINT_TABLET_MAX)).toBe("tablet");
  });

  it("835 翻转 wide", () => {
    expect(breakpointForWidth(BREAKPOINT_TABLET_MAX + 1)).toBe("wide");
  });

  it("异常宽度按宽档兜底", () => {
    expect(breakpointForWidth(Number.NaN)).toBe("wide");
  });
}
function registerPanelGeometry() {
  it("负坐标钳回视口原点", () => {
    expect(clampPointToViewport(-30, -50, 100, 80, 375, 667)).toEqual({ x: 0, y: 0 });
  });

  it("右/下溢出钳回视口内", () => {
    expect(clampPointToViewport(400, 700, 100, 80, 375, 667)).toEqual({ x: 275, y: 587 });
  });

  it("safeInset>0 时按安全区内缩", () => {
    expect(clampPointToViewport(-30, -50, 100, 80, 375, 667, 10)).toEqual({ x: 10, y: 10 });
  });

  it("bottom 锚点向上弹", () => {
    expect(panelTopForAnchor("bottom", 100, 120, 50, 10)).toBe(40);
  });

  it("bottom 溢出 clamp 到 6", () => {
    expect(panelTopForAnchor("bottom", 20, 30, 50, 10)).toBe(6);
  });

  it("top 锚点向下弹", () => {
    expect(panelTopForAnchor("top", 100, 120, 50, 10)).toBe(130);
  });

  it("top 锚点无安全区偏移", () => {
    expect(panelTopForAnchor("top", 100, 120, 50, 0)).toBe(120);
  });
}
setupManagerTestLifecycle();
describe("normalizeServer", () => {
  it("SERVER_NAME_PATTERN 是锚定正则", () => {
    expect(SERVER_NAME_PATTERN.source).toMatch(/\^/);
  });

  it("name trim", () => {
    expect(full().name).toBe("web");
  });

  it("transport 透传", () => {
    expect(full().transport).toBe("streamable-http");
  });

  it("url 不 trim（原样保留）", () => {
    expect(full().url).toBe("http://localhost:9/mcp ");
  });

  it("headers 值 String 化", () => {
    expect(full().headers).toEqual({ A: "1" });
  });

  it("正数 timeout floor", () => {
    expect(full().toolCallTimeoutMs).toBe(2500);
  });

  it("description trim", () => {
    expect(full().description).toBe("custom desc");
  });

  it("reconnect 透传", () => {
    expect(full().reconnect).toEqual({ maxAttempts: 3 });
  });

  it("enabled 默认 true", () => {
    expect(full().enabled).toBe(true);
  });

  it("stdio command 不 trim（保留空白）", () => {
    expect(stdio().command).toBe(" npx ");
  });

  it("stdio args String 化", () => {
    expect(stdio().args).toEqual(["1", "x"]);
  });

  it("stdio cwd 透传", () => {
    expect(stdio().cwd).toBe("/w");
  });

  it("stdio env 值 String 化", () => {
    expect(stdio().env).toEqual({ K: "null" });
  });

  it("缺省 toolCallTimeoutMs 为数字", () => {
    expect(typeof bare().toolCallTimeoutMs).toBe("number");
  });

  it("缺省 toolCallTimeoutMs 为正", () => {
    // normalizeServer 恒补齐默认超时（被测契约），此处断言存在。
    expect(bare().toolCallTimeoutMs! > 0).toBeTruthy();
  });

  it("缺省 reconnect 为空对象", () => {
    expect(bare().reconnect).toEqual({});
  });

  it("缺省 description 为 undefined", () => {
    expect(bare().description).toBeUndefined();
  });

  it("缺省 args 为 undefined", () => {
    expect(bare().args).toBeUndefined();
  });

  it("非对象入参抛 must be an object", () => {
    expect(() => normalizeServer("str")).toThrow(/must be an object/);
  });

  it("null 入参抛 must be an object", () => {
    expect(() => normalizeServer(null)).toThrow(/must be an object/);
  });

  it("缺 name 抛 server name must match", () => {
    expect(() => normalizeServer({ transport: "stdio" })).toThrow(/server name must match/);
  });

  it("非法 name 抛 server name must match", () => {
    expect(() => normalizeServer({ name: "bad name!" })).toThrow(/server name must match/);
  });

  it("缺 transport 抛 transport must be", () => {
    expect(() => normalizeServer({ name: "n" })).toThrow(/transport must be/);
  });

  it("非法 transport 抛 transport must be", () => {
    expect(() => normalizeServer({ name: "n", transport: "rpc" })).toThrow(/transport must be/);
  });

  it("stdio 缺 command 抛 requires a command", () => {
    expect(() => normalizeServer({ name: "n", transport: "stdio" })).toThrow(/requires a command/);
  });

  it("stdio 空白 command 抛 requires a command", () => {
    expect(() => normalizeServer({ name: "n", transport: "stdio", command: "   " })).toThrow(
      /requires a command/,
    );
  });

  it("http 缺 url 抛 requires a url", () => {
    expect(() => normalizeServer({ name: "n", transport: "streamable-http" })).toThrow(
      /requires a url/,
    );
  });

  it("http 非法 url 抛 invalid url", () => {
    expect(() => normalizeServer({ name: "n", transport: "streamable-http", url: "::::" })).toThrow(
      /invalid url/,
    );
  });

  // timeout 非法回退默认（0/负数/NaN）。
  it.each([0, -5, Number.NaN])("timeout 非法值 %s 回退为正数", (bad) => {
    const s = normalizeServer({
      name: "t",
      transport: "stdio",
      command: "x",
      toolCallTimeoutMs: bad,
    });
    expect(s.toolCallTimeoutMs! > 0).toBe(true);
  });

  it.each([0, -5, Number.NaN])("timeout 非法值 %s 回退为有限数", (bad) => {
    const s = normalizeServer({
      name: "t",
      transport: "stdio",
      command: "x",
      toolCallTimeoutMs: bad,
    });
    expect(Number.isFinite(s.toolCallTimeoutMs)).toBe(true);
  });
});

describe("Config schema 的可编辑边界", () => {
  const internalRootKeys = [
    "enabled",
    "announceToAgent",
    "storePath",
    "announceCatalog",
    "catalogMaxEntries",
    "debug",
  ] as const;

  it("仅 ui child 标记 volatile 且未 disabled", () => {
    const fields = Config.dict;
    if (fields === undefined) throw new Error("object Config must expose schema fields via dict");
    const volatileKeys = Object.entries(fields)
      .filter(([, schema]) => schema.meta.volatile === true)
      .map(([key]) => key);
    expect(volatileKeys).toEqual(["ui"]);
    expect(fields.ui?.meta.disabled).not.toBe(true);
  });

  it.each(internalRootKeys)("根级 %s 保持 disabled", (key) => {
    const fields = Config.dict;
    if (fields === undefined) throw new Error("object Config must expose schema fields via dict");
    expect(fields[key]?.meta.disabled).toBe(true);
  });
});
describe("normalizeUiConfig / buildConfigUiPatch / panel 定位", () => {
  registerUiNormalization();
  registerUiLayers();
  registerUiFallbackAndPatch();
  registerPanelAnchors();
  registerViewportBreakpoints();
  registerPanelGeometry();
});
