// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 客户端产物契约族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的客户端产物契约 it 族整块迁入本文件
// （name/inject/ROUTES 关键路径、client source/product contract、宿主路径字面量锚、
// canonical identity、#362 工具级禁用 checkbox 与 scope 分组、i18n 接线哨兵、
// 无游离 css）。fullName 与断言逐字保留（顶层 it 原名，不新增 describe 层级）。
//
// import 实例纪律（与原文件一致，不得改动）：lib/index.js 是自包含 bundle、有自己一份已装配的
// 六张静态端口单例；本文件同时从 src 域门面取符号，故按同实参、同顺序手装组合根端口
// （重复装配会抛，故 beforeAll 只装一次、afterAll 逆序释放）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { name, inject, ROUTES } from "../../lib/index.js";
import {
  assertClientProductContract,
  assertClientSourceContract,
} from "../../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

it("name = mcp-manager", () => expect(name).toBe("mcp-manager"));
it("inject 包含 tools / webServer / systemPrompt", () => {
  expect(inject).toEqual(["tools", "webServer", "systemPrompt"]);
});
it("ROUTES 关键路径存在", () => {
  expect(ROUTES.servers).toBe("/api/dsh-mcp/servers");
  expect(ROUTES.importJson).toBe("/api/dsh-mcp/import/json");
});
it("client bundle 的 /api/ 路径与 host ROUTES 完全一致（防漂移）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  const clientPaths = [...clientSrc.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]).sort();
  const hostPaths = [...new Set(Object.values(ROUTES))].sort();
  expect(
    clientPaths,
    `两端路由漂移：client=${clientPaths.join(",")} host=${hostPaths.join(",")}`,
  ).toEqual(hostPaths);
});
it("client source contract（load id/IIFE/use strict/load once）", () =>
  assertClientSourceContract(pkgDir));
it("client product contract（执行断言：arrive 可解析/apply/inject）", () =>
  assertClientProductContract(pkgDir));

// （<项目>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json）随项目走，是合法展示，不在本轮降级面内。
const hostPathLiteralHits = (code: string) => code.match(/~\/\.dsh/g) ?? [];
it("client 产物不含宿主路径字面量 ~/.dsh（#767 A12 存储布局迁移）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  const hits = hostPathLiteralHits(clientSrc);
  expect(hits, `client 产物泄漏宿主路径字面量 ~/.dsh：${hits.length} 处`).toEqual([]);
});
it("宿主路径断言锚点有效性（反例：含 ~/.dsh 的产物必须被判出）", () => {
  expect(hostPathLiteralHits('scopeGlobalOpt: "全局（~/.dsh/dsh-mcp.json）"')).toHaveLength(1);
  expect(
    hostPathLiteralHits(
      'scopeProjectOpt: "项目级（<项目>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json）"',
    ),
  ).toEqual([]);
});
it("client 产物包含 0.1.7-rc.2 plugins.row.config canonical identity 契约", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc, "客户端产物注册 plugins.row.config").toContain("plugins.row.config");
  expect(clientSrc, "canonical bundle package 已入产物").toContain("@wingsky-1/dsh-mcp-manager");
  expect(clientSrc, "canonical row id 已入产物").toContain("dsh-mcp-manager");
  expect(clientSrc, "客户端产物声明 configForms 注入面").toContain("configForms");
});

it("#362 客户端：工具级禁用 checkbox + scope 分组 + 全局组工具开关（#767 笔 2：模式下拉已删）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // 工具 checkbox 经 tool-disable API 持久化。
  expect(clientSrc.includes("tool-disable"), "客户端含 tool-disable API 调用").toBeTruthy();
  expect(clientSrc.includes('type: "checkbox"'), "工具开关为 checkbox").toBeTruthy();
  expect(clientSrc.includes("dm-float-tools"), "浮窗折叠式工具清单存在").toBeTruthy();
  // #767 笔 2：全局组与项目组同权渲染工具开关（`tools: true`），模式下拉与「切 all」提示已删。
  expect(
    clientSrc.includes("{ tools: true, openTools }"),
    "项目组与全局组一律渲染工具开关",
  ).toBeTruthy();
  expect(clientSrc.includes("dm-set-middleware"), "设置页模式下拉已删").toBe(false);
  expect(clientSrc.includes("globalToolHint"), "全局工具提示 key 已删").toBe(false);
  // 浮窗与管理面板均按 scope 分组。
  expect(clientSrc.includes("dm-float-group-title"), "浮窗 scope 分组标题存在").toBeTruthy();
  expect(
    clientSrc.includes("项目级") && clientSrc.includes("全局"),
    "scope 分组文案存在",
  ).toBeTruthy();
  // #401 勾选 = 禁用：勾选态自绘为红色 ×（非原生蓝色 ✓），工具名同步标红。
  expect(
    // CSS 形态归 Prettier（style.css 在格式化面内），声明两侧的空白不作判据
    /appearance\s*:\s*none/.test(clientSrc),
    "工具 checkbox 自绘（appearance:none）",
  ).toBeTruthy();
  expect(clientSrc.includes("input:checked::after"), "勾选态用 ::after 绘制 ×").toBeTruthy();
  expect(clientSrc.includes("state-error-primary"), "勾选态使用错误红主题变量").toBeTruthy();
  expect(clientSrc.includes(":has(input:checked)"), "已禁用工具名同步标红").toBeTruthy();
});
it("client i18n 接线哨兵（issue #348 → #378 抽取 shared）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes('"mcpManager"'), "i18n 命名空间 NS 进产物").toBeTruthy();
  expect(clientSrc.includes("locale.register"), "locale.register（字典注册）进产物").toBeTruthy();
  expect(clientSrc.includes("bindLocale"), "bindLocale（t 活绑定装配）进产物").toBeTruthy();
  // 防重复 apply 后旧订阅持续重绑已停用实例（对齐 provider-usage 范式）。
  expect(
    clientSrc.includes("unsubLocale = locale.subscribe"),
    "subscribe 返回值保存（unsubLocale）进产物",
  ).toBeTruthy();
  expect(
    /unsubLocale!=null&&unsubLocale\(\)|unsubLocale\(\)/.test(clientSrc),
    "卸载调用 unsubLocale() 进产物",
  ).toBeTruthy();
  expect(clientSrc.includes("locale: NS"), "slots.register locale 参数进产物").toBeTruthy();
  expect(
    clientSrc.includes("Running") && clientSrc.includes("stConnected"),
    "en/zh 双语字典 + STATUS_TEXT key 化进产物",
  ).toBeTruthy();
});
it("#362 无游离 css：style.css 全部内联进 client.js（无独立样式请求）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../src/client/style.css", import.meta.url), "utf8");
  const probe =
    css
      .split("\n")
      .filter((line) => line.trim() !== "")
      .pop() ?? "";
  // 样式文件末尾规则应整体出现在 client.js 产物中（text-loader 原样内联）。
  expect(
    clientSrc.includes(probe.slice(0, 40)),
    "style.css 尾部规则已内联进 client.js",
  ).toBeTruthy();
  expect(!clientSrc.includes('rel="stylesheet"'), "无独立样式表请求").toBeTruthy();
});
