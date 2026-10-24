// dsh-mcp-manager 冒烟测试（vitest e2e project）—— SSE 帧与 panel 定位纯函数族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的 frames/panel 纯函数 it 族整块迁入本文件
// （uiConfigChangedFrame、sseData 非导出锚、broadcastFrame 向全部连接写帧、
// panelAnchorForPosition、#128 断点判定、#128 终坐标视口 clamp、#128 zIndexBase clamp、
// F1 bottom 锚点重定位、panelTopForAnchor）。fullName 与断言逐字保留（顶层 it 原名，不新增 describe 层级）。
import { sseData } from "../../../../shared/host-utils.js";
import {
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  Z_INDEX_BASE_MAX,
  Z_INDEX_BASE_MIN,
  Z_INDEX_PANEL_DELTA,
  bottomAnchorEdge,
  breakpointForWidth,
  clampPointToViewport,
  clampZIndexBase,
  composerDockedAtBottom,
  panelAnchorForPosition,
  panelTopForAnchor,
  panelZIndexFor,
} from "../../src/shared/interface.ts";
import { broadcastFrame, uiConfigChangedFrame } from "../../lib/index.js";
import { expect, it } from "vitest";

it("uiConfigChangedFrame 写出一帧 ui-config-changed", () => {
  expect(uiConfigChangedFrame()).toBe('data: {"type":"ui-config-changed"}\n\n');
  expect(sseData({ type: "ui-config-changed" }), "与 sseData 同构").toBe(uiConfigChangedFrame());
});
// 任何人再写一次 sseData 的 re-export，本条立刻红。判据更严，不是放宽。
it("lib/index.js 不导出仓级 shared 接缝 sseData（#472 收敛锚 · 反转）", async () => {
  const lib = await import("../../lib/index.js");
  expect(lib, "sseData 不得回到本包导出面").not.toHaveProperty("sseData");
});
it("broadcastFrame 向全部连接写帧（掉线忽略）", () => {
  const written: string[] = [];
  const conn = {
    write: (chunk: string) => {
      written.push(chunk);
    },
  };
  const dead = {
    write: () => {
      throw new Error("closed");
    },
  };
  broadcastFrame(
    new Set([conn, dead] as unknown as ServerResponse[]),
    'data: {"type":"summary"}\n\n',
  );
  expect(written).toEqual(['data: {"type":"summary"}\n\n']);
  broadcastFrame(undefined, "x"); // 无连接不抛
});

it("panelAnchorForPosition：bottom-* → bottom，top-* / 缺省 → top（#128 四角化）", () => {
  expect(panelAnchorForPosition("bottom-right")).toBe("bottom");
  expect(panelAnchorForPosition("bottom-left"), "#128 左下也是底部锚点").toBe("bottom");
  expect(panelAnchorForPosition("top-right")).toBe("top");
  expect(panelAnchorForPosition("top-left"), "#128 左上是顶部锚点").toBe("top");
  expect(panelAnchorForPosition(undefined), "缺省按顶部锚点（历史行为）").toBe("top");
});
it("#128 断点判定纯函数分支翻转（基准=conversationHost rect 宽度）", () => {
  expect(breakpointForWidth(320), "手机竖屏 narrow").toBe("narrow");
  expect(breakpointForWidth(BREAKPOINT_NARROW_MAX), "480 边界归 narrow").toBe("narrow");
  expect(breakpointForWidth(BREAKPOINT_NARROW_MAX + 1), "481 翻转 tablet").toBe("tablet");
  expect(breakpointForWidth(768), "平板竖屏 tablet").toBe("tablet");
  expect(breakpointForWidth(BREAKPOINT_TABLET_MAX), "834 边界归 tablet").toBe("tablet");
  expect(breakpointForWidth(BREAKPOINT_TABLET_MAX + 1), "835 翻转 wide").toBe("wide");
  expect(breakpointForWidth(Number.NaN), "异常宽度按 wide 兜底").toBe("wide");
});
it("#128 终坐标视口 clamp 纯函数（safe-area inset 恒 0 自然退化）", () => {
  expect(clampPointToViewport(-30, -50, 100, 80, 375, 667), "负坐标钳回视口原点").toEqual({
    x: 0,
    y: 0,
  });
  expect(clampPointToViewport(400, 700, 100, 80, 375, 667), "右/下溢出钳回视口内").toEqual({
    x: 275,
    y: 587,
  });
  expect(clampPointToViewport(10, 20, 100, 80, 375, 667), "视口内坐标不改变（桌面零回归）").toEqual(
    { x: 10, y: 20 },
  );
  expect(clampPointToViewport(-30, -50, 100, 80, 375, 667, 10), "safeInset>0 按安全区内缩").toEqual(
    { x: 10, y: 10 },
  );
  expect(clampPointToViewport(0, 0, 9999, 9999, 375, 667), "元素大于视口时钳到原点不倒挂").toEqual({
    x: 0,
    y: 0,
  });
});
it("#128 重开：zIndexBase clamp 边界、主面板与胶囊同值、composer seat 贴底纯函数", () => {
  expect(clampZIndexBase(5000, 10), "合法值透传").toBe(5000);
  expect(clampZIndexBase(0, 10), "低于下界压到 1").toBe(Z_INDEX_BASE_MIN);
  expect(clampZIndexBase(-99, 10), "负数压到 1").toBe(Z_INDEX_BASE_MIN);
  expect(clampZIndexBase(9001, 10), "超上界压到 9000").toBe(Z_INDEX_BASE_MAX);
  expect(clampZIndexBase("junk", 10), "非数字回退默认").toBe(10);
  expect(clampZIndexBase(7.6, 10), "小数四舍五入").toBe(8);
  // B1/B2：主面板与胶囊同取配置值（不再派生 +30，维护者 2026-08-28 要求）
  expect(panelZIndexFor(10), "子浮层派生扩展点 base+30（B5，不占主面板预算）").toBe(40);
  expect(Z_INDEX_PANEL_DELTA, "子浮层派生量约定值").toBe(30);
  // D1-D4：composerDockedAtBottom / bottomAnchorEdge 矩阵
  const container = { top: 0, bottom: 844 };
  expect(
    composerDockedAtBottom({ top: 670, bottom: 844 }, container),
    "seat 贴底 → docked=true",
  ).toBe(true);
  expect(
    composerDockedAtBottom({ top: 670, bottom: 843 }, { top: 0, bottom: 844 }),
    "距底缘 1px 未贴底 → false",
  ).toBe(false);
  expect(
    composerDockedAtBottom({ top: 300, bottom: 500 }, { top: 0, bottom: 844 }),
    "seat 居中未贴底 → false",
  ).toBe(false);
  expect(composerDockedAtBottom(null, container), "seat null → false").toBe(false);
  expect(composerDockedAtBottom({ top: 670, bottom: 844 }, null), "container null → false").toBe(
    false,
  );
  expect(bottomAnchorEdge(844, 670, true), "docked → seatTop").toBe(670);
  expect(bottomAnchorEdge(844, 670, false), "未 docked → containerBottom").toBe(844);
  expect(bottomAnchorEdge(844, null, true), "seatTop=null → containerBottom").toBe(844);
  expect(
    bottomAnchorEdge(844, Number.NaN, true),
    "seatTop 非有限数 → containerBottom（无 NaN）",
  ).toBe(844);
});
it("F1（qa 实测 #128）：bottom 锚点首开小高度→数据撑高→重定位后不溢出", () => {
  // 375x667 视口、bottom-right、胶囊 offsetY(blankY 同构取 8)/高 26px → 上缘 633。
  const vw = 375;
  const vh = 667;
  const pillTop = vh - 26 - 8; // 633
  const gap = 6;
  const h1 = 40; // 打开瞬间小高度
  const h2 = 500; // SSE 刷新撑高后
  const p1 = clampPointToViewport(0, Math.max(6, pillTop - h1 - gap), 340, h1, vw, vh);
  expect(p1.y + h1 <= vh, "阶段1 小高度定位在视口内").toBeTruthy();
  expect(p1.y + h2 > vh, "对照：缺重定位时同坐标撑高必溢出（锁定 F1 根因）").toBeTruthy();
  const p2 = clampPointToViewport(0, Math.max(6, pillTop - h2 - gap), 340, h2, vw, vh);
  expect(p2.y + h2 <= vh, "阶段2 内容更新后重定位，底缘不出视口").toBeTruthy();
  expect(p2.y >= 6 && p2.y < pillTop, "阶段2 保持底部锚点上弹语义").toBeTruthy();
});
it("panelTopForAnchor：底部锚点向上弹出 / 顶部锚点向下弹出", () => {
  // 底部锚点（pill 在视口下部）：面板向上，下缘贴近 pill 上缘（pTop - panelHeight - gap）
  expect(panelTopForAnchor("bottom", 600, 640, 200, 6), "底部锚点上弹").toBe(394);
  // 顶部锚点（pill 在视口上部）：面板向下（pillBottom + gap），历史行为不变
  expect(panelTopForAnchor("top", 40, 80, 200, 6), "顶部锚点下弹").toBe(86);
  // clamp：底部锚点面板过高时钳到视口上缘（不溢出）
  expect(panelTopForAnchor("bottom", 30, 70, 2000, 6), "底部锚点上弹 clamp 到视口内").toBe(6);
});
