// @ts-nocheck
/**
 * dsh-notifier — e2e：客户端契约与两端路由一致性。
 *
 * 覆盖：assertClientSourceContract / assertClientProductContract（共享
 * smoke-lib，与 contract-check 同源）；lib/client.js 中出现的路由字面量
 * 与宿主 ROUTES 常量双向一致；issue #76 客户端清理契约（B1-B6 移除侧边栏
 * 入口/浮层/角标、C 组通知半区保留——SSE/租约/看门狗/音频解锁仍存在且不
 * 依赖任何插件 DOM）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert } from "./helpers.ts";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";
import { ROUTES } from "../lib/index.js";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

{
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 客户端契约（共享 smoke-lib：源形态 + 执行契约，与 contract-check 同源）
  assertClientSourceContract(pkgDir);
  assertClientProductContract(pkgDir);
  const literals = [...client.matchAll(/\/api\/dsh-notifier\/[a-z-]+/g)].map((m) => m[0]);
  const expected = Object.values(ROUTES);
  for (const literal of literals) assert.ok(expected.includes(literal), `client 出现未知路由: ${literal}`);
  for (const route of expected) assert.ok(literals.includes(route), `client 缺少路由: ${route}`);
}

// ---- issue #76：客户端清理契约（B1-B6 / C 组）----
{
  const src = readFileSync(new URL("../src/client/index.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // B1-B6：侧边栏入口/浮层/角标/拖拽全部移除（源码无对应符号）
  for (const banned of ["createSidebarEntry", "renderPanel", "attachDrag", "restorePanelPos", "bumpUnread", "initUnread", "data-dsh-notifier-badge", "dsh-notifier-panel", "data-dsh-notifier-entry"]) {
    assert.ok(!src.includes(banned), `B 组：客户端源码不得出现 ${banned}`);
    assert.ok(!client.includes(banned), `B 组：客户端产物不得含 ${banned}`);
  }
  // B6：客户端 entry 不再引用侧边栏注册（DOM 定位锚点移除）
  assert.ok(!src.includes("sidebarCol"), "B6：无侧边栏 DOM 锚点");
  // 未读/角标相关 storage 键不再写入（B4：localStorage 'dsh-notifier:panel:pos' 不再写）
  assert.ok(!src.includes("panel:pos"), "B4：拖拽位置持久化已移除");

  // C1-C9：通知半区保留（SSE/租约/看门狗/音频解锁/事件展示），不依赖任何插件 DOM
  for (const kept of ["startEvents", "WATCHDOG_MS", "claimMaster", "unlockAudio", "EventSource", "new Notification", "showNotification"]) {
    assert.ok(src.includes(kept), `C 组：通知半区保留 ${kept}`);
    assert.ok(client.includes(kept), `C 组：产物保留 ${kept}`);
  }
  // C6：SSE 启动不依赖任何插件 DOM（apply 直接 startEvents，无 mount 等待）
  assert.ok(src.includes("startEvents()"), "C6：apply 直接启动 SSE（不依赖侧边栏挂载）");
  // 独立 tab 挂载经 slots（官方设置页 settings.section 插槽，issue #366 M1；
  // 参照 provider-usage「用量统计」tab，不双注册 plugin.item 卡片）
  assert.ok(src.includes("settings.section"), "A 组：设置注册到官方设置页独立 tab 插槽");
  assert.ok(!src.includes('inject("settings.plugin.item"'), "A 组：不双注册 plugin.item 卡片（评审 B P0）");
  // i18n 接入哨兵（issue #348）：NS / register / bind / slots locale 参数 / 双语字典进产物
  assert.ok(client.includes('"notifier"'), "i18n 命名空间 NS 进产物");
  assert.ok(client.includes("locale.register"), "locale.register（字典注册）进产物");
  assert.ok(client.includes("locale.bind"), "locale.bind（t 装配）进产物");
  assert.ok(client.includes("locale: NS"), "slots.register locale 参数进产物");
  assert.ok(client.includes("Approval pending") && client.includes("evtAsk"), "en/zh 双语字典进产物");
}

// ---- issue #402：设置页 UI/UX 打磨（折叠 / 双 tab / 去 title / label thunk / 就近保存）----
{
  const src = readFileSync(new URL("../src/client/index.ts", import.meta.url), "utf8");
  const locales = readFileSync(new URL("../src/client/locales.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // 第 5 条：settings.section label 为 thunk（源码级 includes 断言——esbuild 产物文本
  // 形态对 minify 脆弱，thunk 行为交浏览器实测「切语言 tab 文案跟随」锁定）
  assert.ok(src.includes('label: () => t("tabLabel")'), "#402：notifier settings.section label 为 thunk（切语言跟随）");
  assert.ok(!src.includes('label: t("tabLabel")'), "#402：不再注册求值快照 label");
  // 第 1 条：频道卡 details 折叠形态（key 含 enabled —— 非受控 + key remount）
  assert.ok(src.includes('React.createElement("details"'), "#402：频道卡为 details 可折叠");
  assert.ok(src.includes('failBadge('), "#402：投递失败徽标上提卡头（收起可见）");
  // 第 2 条：卡内双 tab + kind 徽标 + 就近保存（关键 class 进产物）
  assert.ok(src.includes("dn-set-tabs") && src.includes("dn-set-tabActive"), "#402：卡内双 tab 结构");
  assert.ok(src.includes("dn-set-tabBadge"), "#402：待确认 kind 的 tab 徽标");
  assert.ok(src.includes("dn-ch-saveRow"), "#402：「通知频道」tab 就近保存");
  assert.ok(client.includes("dn-set-tabs") && client.includes("dn-ch-saveRow"), "#402：tab/保存 class 进产物");
  // 第 4 条：设置卡 title/副标题移除（源码与字典两侧）
  assert.ok(!src.includes("settingsName") && !src.includes("settingsDescription"), "#402：设置卡 title/副标题渲染已删");
  assert.ok(!locales.includes("settingsName:") && !locales.includes("settingsDescription:"), "#402：locales 字典 settingsName/settingsDescription 已删");
  // 第 2 条配套：术语统一（「通知频道」/「选择频道」，消除与旧「投递频道」混用）
  assert.ok(locales.includes('secChannels: "通知频道"') && locales.includes('routePick: "选择频道"'), "#402：tab 术语统一为「通知频道」");
}

// lib/toast.ps1 发布物完整性（issue #238）：必须带 UTF-8 BOM 且与源文件逐字节一致。
// pwsh 7 在 CI 上解析通过抓不住 5.1 的 ANSI 码页问题，字节级断言是唯一机器兜底；
// 构建期 copyClientResources 已强制补写，此处防回归（编辑器去 BOM / 复制链变更）。
{
  const stripBom = (buf) => (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf);
  const libBuf = readFileSync(new URL("../lib/toast.ps1", import.meta.url));
  assert.ok(libBuf[0] === 0xef && libBuf[1] === 0xbb && libBuf[2] === 0xbf, "lib/toast.ps1 必须带 UTF-8 BOM（PS 5.1 按 ANSI 解码无 BOM 文件）");
  const srcBuf = readFileSync(new URL("../src/toast.ps1", import.meta.url));
  assert.deepEqual(stripBom(libBuf), stripBom(srcBuf), "lib/toast.ps1 剥离 BOM 后应与 src 源文件逐字节一致");
}
