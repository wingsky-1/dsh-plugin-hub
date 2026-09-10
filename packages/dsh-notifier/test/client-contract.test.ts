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
import vm from "node:vm";
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
  const src = readFileSync(new URL("../src/client/index.tsx", import.meta.url), "utf8");
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
  const src = readFileSync(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const locales = readFileSync(new URL("../src/client/locales.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // 第 5 条：settings.section label 为 thunk（源码级 includes 断言——esbuild 产物文本
  // 形态对 minify 脆弱，thunk 行为交浏览器实测「切语言 tab 文案跟随」锁定）
  assert.ok(src.includes('label: () => t("tabLabel")'), "#402：notifier settings.section label 为 thunk（切语言跟随）");
  assert.ok(!src.includes('label: t("tabLabel")'), "#402：不再注册求值快照 label");
  // 第 1 条：频道卡 details 折叠形态（key 含 enabled —— 非受控 + key remount）
  // #584 分片 a：createElement → TSX 纯语法迁移，源码锚点随形态演进（语义不变：
  // 仍断言「频道卡为 details 可折叠」，JSX 内联 details 即目标形态）
  assert.ok(src.includes("<details"), "#402：频道卡为 details 可折叠（TSX 形态）");
  assert.ok(src.includes('failBadge('), "#402：投递失败徽标上提卡头（收起可见）");
  // 第 2 条：卡内双 tab + kind 徽标（关键 class 进产物）
  assert.ok(src.includes("dn-set-tabs") && src.includes("dn-set-tabActive"), "#402：卡内双 tab 结构");
  assert.ok(src.includes("dn-set-tabBadge"), "#402：待确认 kind 的 tab 徽标");
  assert.ok(client.includes("dn-set-tabs"), "#402：tab class 进产物");
  // 第 4 条：设置卡 title/副标题移除（源码与字典两侧）
  assert.ok(!src.includes("settingsName") && !src.includes("settingsDescription"), "#402：设置卡 title/副标题渲染已删");
  assert.ok(!locales.includes("settingsName:") && !locales.includes("settingsDescription:"), "#402：locales 字典 settingsName/settingsDescription 已删");
  // 第 2 条配套：术语统一（「通知频道」/「选择频道」，消除与旧「投递频道」混用）
  assert.ok(locales.includes('secChannels: "通知频道"') && locales.includes('routePick: "选择频道"'), "#402：tab 术语统一为「通知频道」");
}

// ---- issue #418：设置面板布局收敛（去重复保存 / 权限入浏览器卡 / 动作并入历史区）----
{
  const src = readFileSync(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const locales = readFileSync(new URL("../src/client/locales.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // 1. 频道 tab 去就近保存：单一保存入口（foot），且源码/产物/样式三处无 dn-ch-saveRow
  //    ——#418 移除的是「双份全量保存」的旧行（dn-ch-saveRow）；#405 后按方案定稿
  //    引入的域保存行 class 为 dn-ch-domainSave（仅提交 channels 键，语义 ≠ 全量），
  //    属 #418 原文预留的「域级拆分后按域重排按钮位置」兑现，不构成该回归。
  assert.ok(!src.includes("dn-ch-saveRow"), "#418：旧就近保存行 class 未回归");
  assert.ok(!client.includes("dn-ch-saveRow"), "#418：产物无旧就近保存 class");
  assert.ok(!src.includes("tabSave"), "#418：tabSave 变量未回归");
  // 2. 浏览器通知权限状态行移入浏览器频道卡（browserPermLine 只挂在 browser 卡）
  assert.ok(src.includes("browserPermLine"), "#418：浏览器权限状态行归入频道卡");
  assert.ok(src.includes('channelId === "browser" ? browserPermLine()'), "#418：权限行只渲染于浏览器卡");
  assert.ok(src.includes("dn-ch-perm"), "#418：权限行 class 进源码");
  assert.ok(client.includes("dn-ch-perm"), "#418：权限行 class 进产物");
  // 权限状态行不再出现在全局降级区（perm 三态文案仅存于 browserPermLine 分支）；
  // 带相邻特征串锚定，避免注释里出现 key: "perm" 即误伤
  assert.ok(!src.includes('className: "dn-set-note", key: "perm"'), "#418：全局降级区不再渲染权限状态");
  // 3. 动作并入历史区（清理/发送测试在 historyTools 内与刷新并排）；「动作」分区标题移除
  assert.ok(src.includes("dn-set-historyTools"), "#418：历史区工具行（动作+刷新）");
  assert.ok(!src.includes('t("secActions")'), "#418：源码无「动作」分区标题引用");
  assert.ok(!locales.includes("secActions:"), "#418：locales 字典已删 secActions 键");
}

// ---- issue #421：免打扰豁免扩至全部内置事件（候选 6 项 + 跟随已启用 + 恢复默认）----
{
  const src = readFileSync(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const locales = readFileSync(new URL("../src/client/locales.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // 单一事实源：EVENT_KIND_MAP 覆盖全部 6 个内置事件 kind（notifyKey → kind）
  assert.ok(src.includes("EVENT_KIND_MAP"), "#421：事件开关键→kind 映射（单一事实源）");
  for (const [notifyKey, kind] of [["notifyAsk", "ask"], ["notifyQuestion", "question"], ["notifyTaskDone", "done"], ["notifySubagentDone", "subagent-done"], ["notifyTaskError", "error"], ["notifyTurnEnd", "turn-end"]]) {
    assert.ok(src.includes(`${notifyKey}: "${kind}"`), `#421：${notifyKey} → ${kind}`);
  }
  // 候选由 EVENT_KEYS 派生（不新建平行表 ALLOW_CHOICES）
  assert.ok(!src.includes("ALLOW_CHOICES"), "#421：旧 3 项硬编码 ALLOW_CHOICES 已移除");
  // 快捷按钮 + 未启用弱化（关键 class/函数进源码与产物）
  assert.ok(src.includes("dn-set-allowDim"), "#421：未启用事件弱化样式");
  assert.ok(src.includes("allowFollowEnabled") && src.includes("allowResetDefault"), "#421：跟随已启用/恢复默认按钮");
  assert.ok(src.includes("dn-set-allowActions"), "#421：快捷按钮行 class");
  assert.ok(client.includes("dn-set-allowDim") && client.includes("dn-set-allowActions"), "#421：豁免区新 class 进产物");
  // 文案键：新增三个（中英双语）
  assert.ok(locales.includes('allowFollowEnabled: "跟随已启用事件"') && locales.includes('allowFollowEnabled: "Follow enabled events"'), "#421：跟随已启用文案双语");
  assert.ok(locales.includes('allowResetDefault:') && locales.includes("allowResetDefault:"), "#421：恢复默认文案双语");
  // 旧 allowXxx 豁免 label 键移除（候选复用 KIND_KEYS 事件文案）
  assert.ok(!locales.includes("allowAsk:") && !locales.includes("allowQuestion:") && !locales.includes("allowError:"), "#421：旧 allowXxx 豁免 label 键已删");
}

// ---- issue #508：通知中心 UI/UX 现代化（三 tab / switch / chips / 脏状态栏 / webhook 卡）----
{
  const src = readFileSync(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const locales = readFileSync(new URL("../src/client/locales.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // 1. 三 tab：通知记录 tab 加入（activeTab 联合类型收窄为三值，secHistory 分区标题）
  assert.ok(src.includes("events\" | \"channels\" | \"history\""), "#508：activeTab 联合类型含 history（三 tab）");
  assert.ok(src.includes('t("secHistory")'), "#508：通知记录 tab 引用 secHistory 分区标题");
  assert.ok(locales.includes('secHistory: "通知记录"') && locales.includes('secHistory: "History"'), "#508：secHistory 文案双语");
  // 2. switch 无障碍：原生 checkbox 改 switch 开关，无内联文本必须靠 aria-label 提供可访问名
  // #584 分片 a：createElement → TSX 迁移，源码锚点随语法形态演进（aria-label 可访问名语义不变）
  assert.ok(src.includes('className="dn-switch"') && src.includes("aria-label="), "#508：switch 开关依赖 aria-label 可访问名（TSX 形态）");
  assert.ok(client.includes("dn-switch-track"), "#508：dn-switch-track 开关轨道 class 进产物");
  // 3. 路由 chips：直点切换 + aria-pressed 开/关态 + 状态标签 + stale 虚线 chip
  assert.ok(src.includes("aria-pressed=") && src.includes("dn-route-state") && src.includes("is-stale"), "#508：路由 chips 含 aria-pressed/状态标签/stale 形态（TSX 形态）");
  assert.ok(locales.includes("routeDefaultState:") && locales.includes("routeCustomState:"), "#508：chips 状态标签文案键双语存在");
  // 4. 动态 kind 确认行带路由提示（r4 拍板）
  assert.ok(src.includes("dn-kind-routeHint") && locales.includes("kindRouteHint:"), "#508：动态 kind 确认行路由提示（源码+文案）");
  // 5. 底部脏状态保存栏：脏计数 + 放弃更改入口
  assert.ok(src.includes("dn-dirty") && src.includes("discardChanges"), "#508：脏状态保存栏（dn-dirty + discardChanges）");
  assert.ok(locales.includes("dirtySome:") && locales.includes("discardChanges:"), "#508：脏状态/放弃更改文案键双语存在");
  // 6. webhook 频道卡：预设常量 + 认证字段区 + 添加入口；双语键平衡由 tsc 编译期
  //    锁（Record<NotifierLocaleKey, string>），此处只断言关键键出现一次以上（中英各一）
  assert.ok(src.includes("webhookCard") && src.includes("WEBHOOK_PRESETS") && src.includes("dn-authFields"), "#508：webhook 频道卡（webhookCard/WEBHOOK_PRESETS/dn-authFields）");
  assert.ok(locales.split("chAddWebhook:").length > 2, "#508：chAddWebhook 文案键在 locales 出现一次以上（中英双语各一）");
  // 7. 频道卡头类型图标（iconEl → dn-ch-icon）
  assert.ok(client.includes("dn-ch-icon"), "#508：频道卡头类型图标 class 进产物");
  // 8. 负向断言：旧 checkbox 豁免 label class 已移除——用引号闭合精确串防误伤
  //    dn-set-allowDim/allowHint/allows/allowActions（它们仍是 #421 有效锚点）
  assert.ok(!src.includes('className: "dn-set-allow"'), "#508：旧 checkbox 豁免 label class dn-set-allow 已移除");
  assert.ok(!src.includes('"bark:" + String(ch.id)'), "#508：channelId 前缀 hardcode 已收敛为 channelIdFor");
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

// ---- issue #469：visibilitychange 匿名监听无卸载 → 具名 handler + disposer 移除 ----
// 分三层：① 源码级成对哨兵（注册/移除同现、订阅取消函数保存——防回归，源码名稳定）；
// ② 产物级负向哨兵（匿名注册形态绝迹——esbuild 会把 apply 内具名函数重命名，
//    产物文本不断言具体名字，只断不变量）；③ vm 沙箱执行真实产物 lib/client.js，
//    事件计数级断言验收语义（apply→dispose→重复 apply 全程至多一份监听）。
{
  const src = readFileSync(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // ① 源码级哨兵（源码名稳定，产物对 esbuild 重命名脆弱）：
  // - 匿名 visibilitychange 注册绝迹（旧泄漏根因：无引用可移除）
  assert.ok(!src.includes('addEventListener("visibilitychange", function'),
    "#469：源码不再有匿名 visibilitychange 注册");
  // - 具名 handler + apply 内注册 + disposer 移除成对
  assert.ok(src.includes('function onVisibilityChange()'),
    "#469：具名 onVisibilityChange handler 存在");
  assert.ok(src.includes('addEventListener("visibilitychange", onVisibilityChange)'),
    "#469：具名 handler 注册进 apply");
  assert.ok(src.includes('removeEventListener("visibilitychange", onVisibilityChange)'),
    "#469：disposer 移除 visibilitychange 监听");
  // - locale.subscribe 取消函数保存并在 disposer 调用（T4 范式）
  assert.ok(src.includes("unsubLocale = locale.subscribe("),
    "#469：locale.subscribe 取消函数已保存");
  assert.ok(src.includes("unsubLocale()"),
    "#469：disposer 调用 locale 取消函数");
  // - unsubLocale 守卫对齐 undefined 形态（P1-2：防官方 locale.subscribe 返回
  //   null 时 null 初始化守卫失效——provider-usage/mcp-manager 同款范式）
  assert.ok(src.includes("var unsubLocale: (() => void) | undefined;"),
    "#469 P1-2：unsubLocale 声明为 undefined 形态（非 null 初始化）");
  assert.ok(src.includes("if (unsubLocale !== undefined) {"),
    "#469 P1-2：disposer unsubLocale 守卫为 !== undefined");
  // - disposer 卸载即恢复标题（P1-1：标题恢复不能只依赖已摘除的 visibilitychange 监听）
  assert.ok(/removeEventListener\("visibilitychange", onVisibilityChange\);[\s\S]*?restoreTitle\(\);/.test(src),
    "#469 P1-1：disposer 内移除监听后调用 restoreTitle()");

  // ② 产物级负向哨兵：匿名注册形态绝迹（源码哨兵防改动，此哨兵防构建链丢配对）
  assert.ok(!client.includes('addEventListener("visibilitychange", function'),
    "#469：产物不再有匿名 visibilitychange 注册");
  assert.ok(client.includes('removeEventListener("visibilitychange",'),
    "#469：产物 disposer 含 visibilitychange 移除");
  // 具名注册与移除必须引用同一 handler 标识符（esbuild 重命名后 add/remove 同源）
  const reg = client.match(/document\.addEventListener\("visibilitychange",\s*([A-Za-z_$][\w$]*)/);
  const rem = client.match(/document\.removeEventListener\("visibilitychange",\s*([A-Za-z_$][\w$]*)/);
  assert.ok(reg && rem && reg[1] === rem[1],
    "#469：产物 add/remove visibilitychange 引用同一具名 handler（reg=" + (reg && reg[1]) + " rem=" + (rem && rem[1]) + "）");
  // P2-①：remove 必须位于 disposer（ctx.effect 返回函数）内——取 effect 返回函数
  // 体做结构定位，remove 不得出现在 apply 直落路径（防「注册配对但清理不在卸载期」）。
  const effectRet = client.match(/ctx\.effect\(function\(\)\s*\{\s*return function\(\)\s*\{([\s\S]*?)\n\s*\}\s*;\s*\}\s*,/);
  assert.ok(effectRet && effectRet[1].includes('removeEventListener("visibilitychange",'),
    "#469 P2：产物 removeEventListener(visibilitychange) 位于 disposer（effect 返回函数）内");
  // disposer 内须含 restoreTitle 调用（P1-1：标题恢复不能只依赖已摘除的监听）
  assert.ok(effectRet && effectRet[1].includes("restoreTitle()"),
    "#469 P1-1：产物 disposer 内含 restoreTitle()（卸载即恢复标题）");
  // unsubLocale 守卫为 undefined 形态（P1-2：对齐 provider-usage 范式，防
  // locale.subscribe 返回 null 时守卫失效——产物 null 折叠为 null 字面量需双形态）
  assert.ok(effectRet && /unsubLocale\s*!==\s*(?:void 0|undefined|null)/.test(effectRet[1]),
    "#469 P1-2：产物 disposer unsubLocale 守卫为 undefined 形态");
}

// ---- issue #469 ② vm 沙箱执行真实产物：事件计数级验收 ----
{
  const PKG = "@wingsky-1/dsh-notifier";
  const clientCode = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // 最小 document stub：对 add/removeEventListener 记账；其余惰性 no-op。
  // listenerCounts 按事件类型计数（remove 才减）——浏览器语义近似，足以断言
  // 「重复 apply 后仅一份」「disposer 后归零」且不依赖真 DOM。
  const byType = new Map(); // type -> Set<fn>
  const listeners = {
    addEventListener(type, fn) {
      let s = byType.get(type);
      if (!s) { s = new Set(); byType.set(type, s); }
      s.add(fn);
    },
    removeEventListener(type, fn) {
      const s = byType.get(type);
      if (s) s.delete(fn);
    },
  };
  const styleEl = {
    id: "",
    textContent: "",
    dataset: {},
    remove() {},
  };
  const documentStub = {
    ...listeners,
    visibilityState: "visible",
    title: "",
    hidden: false,
    getElementById() { return null; }, // injectStyle：无旧 style → 新建
    createElement(tag) {
      if (tag === "style") return styleEl;
      // 其它标签（banner 等）惰性 no-op
      return { appendChild() {}, remove() {}, set textContent(_v) {}, style: {}, dataset: {} };
    },
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  // EventSource stub：实例可赋 handler/close；每次构造/close 计数供可见重建断言。
  // 实例列表供测试手动投递 notify 帧（驱动 flashTitle 降级链）。
  let sourceCount = 0;
  let closeCount = 0;
  const sources = [];
  class EventSourceStub {
    constructor() { sourceCount += 1; this.onmessage = null; this.onerror = null; this.onopen = null; sources.push(this); }
    close() { closeCount += 1; }
  }
  const fakeReact = { createElement: () => ({}) };
  const warnings = [];
  const storage = new Map();
  const sandbox = {
    console: { ...console, warn: (...a) => warnings.push(a.join(" ")) },
    Symbol, Object, Array, JSON, Math, Date, Promise,
    setTimeout, clearTimeout,
    EventSource: EventSourceStub,
    Notification: function () {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: documentStub,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  };
  sandbox.window = sandbox;
  sandbox.window.__ModuleLoader__ = {
    load(handoff) {
      if (handoff.id !== PKG) throw new Error(`unexpected load id: ${handoff.id}`);
      loadedFactory = handoff.factory;
    },
  };
  let loadedFactory = null;
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox);
  assert.ok(loadedFactory !== null, "#469：产物 load 已注册 factory");

  // materialize（同 client-contract-lib）：factory(require stub) → module.exports
  const requireStub = (spec) => {
    if (spec === "react") return fakeReact;
    throw new Error(`unexpected require: ${spec}`);
  };
  const mod = loadedFactory(requireStub);
  assert.equal(typeof mod.apply, "function", "#469：materialize 后 exports.apply 为函数");

  // 卸载-重挂序列（宿主生命周期：旧实例 disposer 先于新 apply）：
  // apply1 → 监听 1；dispose1 → 0；apply2 → 1（重复 apply 后仅一份）；dispose2 → 0。
  // 监听注册/移除与 apply/disposer 严格配对，任意时刻至多一份。
  const disposers = [];
  // locale 服务记账：subscribe 返回取消函数，调用计数 +1；重绑回调被调用计数。
  let localeSubscribes = 0;
  let localeUnsubs = 0;
  const makeLocale = () => ({
    register() {},
    bind() { return () => ""; },
    getSnapshot() { return {}; },
    subscribe() { localeSubscribes += 1; return () => { localeUnsubs += 1; }; },
  });
  const makeCtx = (opts = {}) => ({
    get(name) {
      if (name === "locale" && opts.locale) return opts.locale;
      // 无 locale/slots 服务：字典注册/tab 挂载跳过（通知半区照常）
      return undefined;
    },
    effect(fn) {
      const d = fn();
      disposers.push(d);
      return d;
    },
  });
  const visCount = () => (byType.get("visibilitychange") || new Set()).size;

  mod.apply(makeCtx({ locale: makeLocale() }));
  assert.equal(visCount(), 1, "#469：首次 apply 后 visibilitychange 监听一份");
  assert.equal(localeSubscribes, 1, "#469：首次 apply 建立一条 locale 订阅");
  disposers.shift()();
  assert.equal(visCount(), 0, "#469：disposer 卸载后监听归零");
  assert.equal(localeUnsubs, 1, "#469：disposer 卸载取消 locale 订阅");

  // 重复 apply（宿主热更/重挂载：旧实例已卸）→ 仍只一份，不累积
  mod.apply(makeCtx({ locale: makeLocale() }));
  assert.equal(visCount(), 1, "#469：重复 apply 后 visibilitychange 监听仅一份");
  assert.equal(localeSubscribes, 2, "#469：重复 apply 建立新订阅");
  assert.equal(localeUnsubs, 1, "#469：旧订阅已取消、无残留重绑");
  assert.equal(disposers.length, 1, "#469：重复 apply 只新增一个 disposer");

  // 触发可见事件：监听应作用于当前句柄（重建 SSE——source 计数增加且旧源被关）。
  // 先显式翻转 visibilityState="hidden" → "visible"（不依赖 stub 默认值巧合）。
  const sourcesBefore = sourceCount;
  documentStub.visibilityState = "hidden";
  documentStub.title = "原始标题";
  documentStub.visibilityState = "visible";
  for (const fn of byType.get("visibilitychange") || []) fn();
  assert.ok(sourceCount > sourcesBefore, "#469：可见事件触发 SSE 重建（监听仍活）");
  assert.ok(closeCount >= sourcesBefore, "#469：重建前旧 SSE 句柄已关（不操作已置 null 句柄）");

  // P1-1 回归直测：hidden 后台收到 notify 帧 → flashTitle 置闪烁标题 → disposer
  // 卸载必须 restoreTitle（标题恢复 + savedTitle 缓存清除）——不能等
  // visibilitychange 触发（监听已被 disposer 摘除，标题会永久卡死 = 评审复现）。
  // 当前活跃实例 = 最后创建的 source（apply2 的 disposer 尚未执行、其 SSE 未关）。
  const activeSource = sources[sources.length - 1];
  documentStub.visibilityState = "hidden";
  documentStub.title = "原始标题";
  assert.ok(typeof activeSource.onmessage === "function",
    "#469 P1-1：当前 SSE 实例已接 onmessage（可投递通知帧）");
  activeSource.onmessage({ data: JSON.stringify({ type: "notify", kind: "done", title: "T", message: "m", seq: 1 }) });
  assert.ok(documentStub.title.startsWith("🔔"),
    "#469 P1-1：hidden 帧驱动 flashTitle 后标题为闪烁态（实际 " + documentStub.title + "）");
  // 卸载当前实例 → 监听归零 + 标题恢复（disposer restoreTitle）
  disposers.shift()();
  assert.equal(visCount(), 0, "#469：disposer 卸载后 visibilitychange 监听归零");
  assert.equal(localeUnsubs, 2, "#469：两次实例的 locale 订阅全部取消");
  assert.equal(documentStub.title, "原始标题",
    "#469 P1-1：disposer 卸载 restoreTitle 恢复标题（评审复现：卸载后标题卡死）");
  // disposer 幂等：二次调用不报错、标题仍恢复态、监听仍零
  for (const d of disposers.splice(0)) d();
  assert.equal(visCount(), 0, "#469：disposer 二次调用后仍无监听");
  assert.equal(documentStub.title, "原始标题", "#469 P1-1：disposer 二次调用标题不复发闪烁");
}

// ---- issue #470 复核 P1-2：client diffSettingsPayload 真实产物直测 ----
// 用 vm materialize 出的 mod.apply.diffSettingsPayload（apply 挂载的模块级纯函数）
// 验证「真链」：以 GET effective（含未知键）为基线 → 只改已知键 → diff 不含
// 未知键 →（PUT 行为在 routes.test.ts 全链断言）。不再允许测试手写近似 diff。
{
  const clientCode = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const sandbox = {
    console: { ...console, warn: () => {} },
    Symbol, Object, Array, JSON, Math, Date, Promise,
    setTimeout, clearTimeout,
    EventSource: function () {},
    Notification: function () {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: {
      visibilityState: "visible", title: "", hidden: false,
      addEventListener() {}, removeEventListener() {},
      getElementById: () => null,
      createElement: () => ({ appendChild() {}, remove() {}, style: {}, dataset: {} }),
      head: { appendChild() {} }, body: { appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    window: {},
  };
  sandbox.window = sandbox;
  let loadedFactory = null;
  sandbox.window.__ModuleLoader__ = { load(handoff) { loadedFactory = handoff.factory; } };
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox);
  assert.ok(loadedFactory !== null, "#470 P1-2：产物 load 已注册 factory");
  const fakeReactForDiff = { createElement: () => ({}) };
  const mod = loadedFactory((spec) => {
    if (spec === "react") return fakeReactForDiff;
    throw new Error(`unexpected require: ${spec}`);
  });
  assert.equal(typeof mod.apply, "function", "#470 P1-2：materialize 后 exports.apply 为函数");
  // 挂载赋值在 apply 函数体首行——先跑一次 apply（最小 ctx）才可读属性；
  // 随后立即 disposer 卸载（停 SSE/监听，防句柄残留）。
  const disposers2 = [];
  mod.apply({
    get() { return undefined; },
    effect(fn) { const d = fn(); disposers2.push(d); return d; },
  });
  const diffFn = mod.apply.diffSettingsPayload;
  assert.equal(typeof diffFn, "function", "#470 P1-2：apply 挂载 diffSettingsPayload 纯函数");
  for (const d of disposers2.splice(0)) d();

  // 基线含未知键：只改已知键 → payload 仅含变更已知键（不含未知键）
  const effective = { notifyTaskDone: true, notifyAsk: true, futureKey: { k: 1 }, quietHours: { enabled: false, start: "22:00", end: "08:00" } };
  const settingsView = JSON.parse(JSON.stringify(effective));
  settingsView.notifyTaskDone = false;
  const payload = diffFn(settingsView, effective);
  // vm 沙箱 realm 对象原型与测试 realm 不同，deepStrictEqual 跨 realm 不等——用
  // JSON 归一比对（diff 语义本就 JSON 序列化级）
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), { notifyTaskDone: false }, "#470 P1-2：diff 只含变更已知键（不含未知键 futureKey）");

  // 未知键值被 UI 改动 → diff 会包含它（未来 UI 编辑未知键时透传可写）
  const view2 = JSON.parse(JSON.stringify(effective));
  view2.futureKey = { k: 2 };
  const payload2 = diffFn(view2, effective);
  assert.deepEqual(JSON.parse(JSON.stringify(payload2)), { futureKey: { k: 2 } }, "#470 P1-2：diff 含改动未知键（PUT 可透传写入）");

  // 全等 → 空 payload（save 判定 unchanged）
  assert.deepEqual(JSON.parse(JSON.stringify(diffFn(JSON.parse(JSON.stringify(effective)), effective))), {}, "#470 P1-2：全等基线 diff 为空");

  // baseline 为 null（加载未完成）→ 空 payload（不误存）
  assert.deepEqual(JSON.parse(JSON.stringify(diffFn(settingsView, null))), {}, "#470 P1-2：baseline null → 空 payload");

  // ---- issue #614：channels 提交面空串可选字段剥除（真产物直测）----

  // 存量 0.2.2 空串残留形态：UI 改 enabled 一字段 → 整组提交被 strip 成合法形态
  // （否则 token:"" 等残留随组提交 → 服务端 400，UI 无法解锁修复）
  const legacy = {
    notifyTaskDone: true,
    channels: [
      { id: "webhook-1", type: "webhook", url: "https://ntfy.sh/t", auth: "bearer", token: "tk614", enabled: false, username: "", password: "", headerName: "", headerValue: "", template: "" },
      { id: "bark-1", type: "bark", baseUrl: "https://api.day.app", deviceKey: "k614", enabled: false, sound: "", group: "" },
    ],
  };
  const edited = JSON.parse(JSON.stringify(legacy));
  edited.channels[0].enabled = true;
  const stripped = diffFn(edited, legacy);
  assert.ok(stripped.channels !== undefined, "#614：channels 变更整组入 diff");
  assert.equal(JSON.stringify(stripped.channels), JSON.stringify([
    { id: "webhook-1", type: "webhook", url: "https://ntfy.sh/t", auth: "bearer", token: "tk614", enabled: true },
    { id: "bark-1", type: "bark", baseUrl: "https://api.day.app", deviceKey: "k614", enabled: false },
  ]), "#614：空串可选字段剥除、非空值与必填字段保留");

  // 无空串的常规 diff 不受影响（strip 幂等，非空全保留）
  const clean = { channels: [{ id: "webhook-1", type: "webhook", url: "https://ntfy.sh/t", auth: "none", enabled: false }] };
  const cleanEdited = JSON.parse(JSON.stringify(clean));
  cleanEdited.channels[0].enabled = true;
  assert.equal(JSON.stringify(diffFn(cleanEdited, clean).channels), JSON.stringify(cleanEdited.channels), "#614：无空串形态 diff 原样通过");

  // 防御：channels 含非对象成员（null/字符串）不炸、原样透传（服务端校验兜底）
  const junk = { channels: [null, "x"] };
  const junkEdited = JSON.parse(JSON.stringify(junk));
  junkEdited.channels[1] = "y";
  assert.equal(JSON.stringify(diffFn(junkEdited, junk).channels), JSON.stringify([null, "y"]), "#614：非对象成员原样透传不炸");

  // #614 纯函数直测：assignChannelFields（空串/undefined 删键）与 stripChannelEmpties
  const assignFn = mod.apply.assignChannelFields;
  const stripFn = mod.apply.stripChannelEmpties;
  assert.equal(typeof assignFn, "function", "#614：apply 挂载 assignChannelFields");
  assert.equal(typeof stripFn, "function", "#614：apply 挂载 stripChannelEmpties");
  // 空串输入 → 删键（清空 token 输入框 = 回到未配置态）
  assert.equal("token" in assignFn({ id: "w", token: "old" }, { token: "" }), false, "#614：空串输入删键");
  // undefined 输入 → 删键（bark level 清除路径传 undefined）
  assert.equal("level" in assignFn({ id: "b", level: "critical" }, { level: undefined }), false, "#614：undefined 输入删键");
  // 非空值正常覆盖；无关键不新增
  const assigned = assignFn({ id: "w", token: "old", auth: "none" }, { token: "new", url: "" });
  assert.equal(JSON.stringify(assigned), JSON.stringify({ id: "w", token: "new", auth: "none" }), "#614：非空覆盖 + 空串 url 删键（不存在则不新增）");
  // stripChannelEmpties：剥空串可选键（url 属 bark 可选位），非对象原样
  assert.equal(JSON.stringify(stripFn({ id: "w", url: "", token: "", name: "n", enabled: false })), JSON.stringify({ id: "w", name: "n", enabled: false }), "#614：strip 剥可选空串（含 url）");
  assert.equal(stripFn(null), null, "#614：strip 非对象输入原样返回");
}

// ---- issue #405 PR2/PR3：客户端保存模型演进源码级契约锚点 ----
{
  const src = readFileSync(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const locales = readFileSync(new URL("../src/client/locales.ts", import.meta.url), "utf8");

  // PR3：confirmOne 同步服务端 revision（修「确认 kind 后同窗口保存必 409」版本链断点）
  assert.ok(src.includes("freshRevision"), "#405：confirmOne 读取响应新 revision");
  assert.ok(src.includes("metaRef.current = nextMeta"), "#405：confirmOne 同步 metaRef.revision");
  // PR2：频道域保存行（新 class，非 #418 回归的 dn-ch-saveRow）+ 域入口
  assert.ok(src.includes('className="dn-ch-domainSave"'), "#405：频道 tab 域保存行 class（TSX 形态）");
  assert.ok(src.includes('saveFor("channels")'), "#405：域保存走 channels 入口");
  assert.ok(src.includes('saveFor("all")'), "#405：foot 保存走 all 入口");
  assert.ok(src.includes("dn-conflict"), "#405：409 冲突横幅 class 进源码");
  assert.ok(locales.includes("conflictOverwrite:"), "#405：冲突覆盖动作文案进 zh/en 字典");
  assert.ok(locales.includes("saveChannels:"), "#405：域保存按钮文案进 zh/en 字典");
}

// ---- issue #405 PR1：client createSaveGuard（保存串行）真实产物直测 ----
// 同一时刻仅一个在途保存（tryBegin 在途返回 false 不占用）；在途期间的再次点击
// 记 pending，由 end() 返回 true 通知调用方补发一次；end 幂等释放、无 pending 时
// 返回 false（不产生补发风暴）。guard 是模块级纯工厂（无 React 依赖），经
// apply 挂载面直测——「测试即产品实现」。
{
  const clientCode = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const sandbox = {
    console: { ...console, warn: () => {} },
    Symbol, Object, Array, JSON, Math, Date, Promise,
    setTimeout, clearTimeout,
    EventSource: function () {},
    Notification: function () {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: {
      visibilityState: "visible", title: "", hidden: false,
      addEventListener() {}, removeEventListener() {},
      getElementById: () => null,
      createElement: () => ({ appendChild() {}, remove() {}, style: {}, dataset: {} }),
      head: { appendChild() {} }, body: { appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    window: {},
  };
  sandbox.window = sandbox;
  let loadedFactory = null;
  sandbox.window.__ModuleLoader__ = { load(handoff) { loadedFactory = handoff.factory; } };
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox);
  assert.ok(loadedFactory !== null, "#405：产物 load 已注册 factory");
  const mod = loadedFactory((spec) => {
    if (spec === "react") return { createElement: () => ({}) };
    throw new Error(`unexpected require: ${spec}`);
  });
  const disposers3 = [];
  mod.apply({
    get() { return undefined; },
    effect(fn) { const d = fn(); disposers3.push(d); return d; },
  });
  const guardFactory = mod.apply.createSaveGuard;
  const domainFn = mod.apply.domainPayload;
  const rebaseFn = mod.apply.rebaseSettings;
  assert.equal(typeof guardFactory, "function", "#405：apply 挂载 createSaveGuard 纯工厂");
  assert.equal(typeof domainFn, "function", "#405：apply 挂载 domainPayload 纯函数");
  assert.equal(typeof rebaseFn, "function", "#405：apply 挂载 rebaseSettings 纯函数");
  for (const d of disposers3.splice(0)) d();

  // rebaseSettings：键级 last-write-wins——最新 effective 为基底，本地变更键覆盖；
  // 远端新键保留、本地未改键取远端值
  assert.deepEqual(
    JSON.parse(JSON.stringify(rebaseFn(
      { notifyAsk: false, channels: [1] },
      { notifyAsk: true, notifySound: true, channels: [9], kindRoutes: { ask: ["browser"] } },
    ))),
    { notifyAsk: false, notifySound: true, channels: [1], kindRoutes: { ask: ["browser"] } },
    "#405：rebase 键级合并——本地变更覆盖、远端未冲突键保留"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(rebaseFn({}, { notifyAsk: true }))),
    { notifyAsk: true },
    "#405：无本地变更 → rebase 结果即远端最新"
  );

  // domainPayload：域过滤语义（#405 PR2）——channels 域只提 channels 键；
  // all 原样；未知入口空对象
  assert.deepEqual(
    JSON.parse(JSON.stringify(domainFn({ channels: [1], notifyAsk: false, quietHours: {} }, "channels"))),
    { channels: [1] },
    "#405：channels 域只提交 channels 键（事件/参数草稿不随域保存提交）"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(domainFn({ notifyAsk: false }, "channels"))),
    {},
    "#405：无 channels 变更时 channels 域提交为空"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(domainFn({ channels: [1], notifyAsk: false }, "all"))),
    { channels: [1], notifyAsk: false },
    "#405：all 入口原样全量提交"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(domainFn({ channels: [1] }, "unknown"))),
    {},
    "#405：未知入口保守返回空（不提交）"
  );

  // 1. 单飞行：首次占用成功；在途期间再 tryBegin 返回 false（记 pending），不占用
  const g1 = guardFactory();
  assert.equal(g1.isBusy(), false, "#405：初始空闲");
  assert.equal(g1.tryBegin("all"), true, "#405：首次 tryBegin 占用成功");
  assert.equal(g1.isBusy(), true, "#405：占用后在途");
  assert.equal(g1.tryBegin("all"), false, "#405：在途期间 tryBegin 被拒（单飞行）");
  assert.equal(g1.isBusy(), true, "#405：被拒不改变在途态");

  // 2. trailing 补发入口：在途期间积累过点击 → end() 返回该入口（应同入口补发一次）
  assert.equal(g1.end(), "all", "#405：在途期间有 pending → end 返回补发入口");
  assert.equal(g1.isBusy(), false, "#405：end 后释放空闲");

  // 3. 无 pending：end 返回 null（不产生补发/风暴）
  const g2 = guardFactory();
  assert.equal(g2.tryBegin("all"), true, "#405：g2 占用成功");
  assert.equal(g2.end(), null, "#405：无 pending → end 返回 null（不补发）");

  // 4. 域入口保真：被拒的是 "channels" → end 返回 "channels"（域保存不被升级成全量）
  const g3 = guardFactory();
  g3.tryBegin("all");
  assert.equal(g3.tryBegin("channels"), false, "#405：在途期间域保存被拒");
  assert.equal(g3.end(), "channels", "#405：end 返回最后一次被拒入口 channels");
  assert.equal(g3.end(), null, "#405：再次 end（无 pending）返回 null");
  assert.equal(g3.isBusy(), false, "#405：重复 end 幂等释放");

  // 5. 多次不同入口点击：记最后一次意图
  const g4 = guardFactory();
  g4.tryBegin("all");
  g4.tryBegin("channels");
  g4.tryBegin("all");
  assert.equal(g4.end(), "all", "#405：多次被拒记最后一次入口");
  assert.equal(g4.end(), null, "#405：清空后再 end 返回 null");
}

// ---- issue #527：未启用频道/事件 chips 置灰禁点（通知事件路由 + 免打扰豁免）----
{
  const src = readFileSync(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const locales = readFileSync(new URL("../src/client/locales.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/style.css", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // 1. 路由 chips：routeOptions 带 enabled 标志；未启用 chip 渲染 disabled + is-off
  assert.ok(src.includes("enabled: c.enabled === true"), "#527：路由候选带实例频道 enabled 标志");
  assert.ok(src.includes("enabled: prev.browserNotify === true") && src.includes("enabled: prev.systemNotify === true"), "#527：内置频道 enabled 判定跟随开关");
  assert.ok(src.includes("disabled={!o.enabled}"), "#527：未启用路由 chip 原生 disabled 禁点（TSX 形态）");
  assert.ok(src.includes('" is-off"') && src.includes('"dn-route-chip"'), "#527：未启用路由 chip 带 is-off 弱化 class");
  assert.ok(src.includes("routeDisabledHint"), "#527：路由未启用 title 提示引用文案键");

  // 2. 免打扰豁免 chips：未启用事件 disabled 禁点（保留 dn-set-allowDim 弱化）
  assert.ok(src.includes("disabled={!c.enabled}"), "#527：未启用豁免事件 chip 原生 disabled 禁点（TSX 形态）");
  assert.ok(src.includes("dn-set-allowDim"), "#527：#421 弱化样式保留（与 disabled 叠加）");

  // 3. 文案键双语 + 产物
  assert.ok(locales.includes('routeDisabledHint: "频道未启用：先在上方「通知频道」启用后才能配置投递"'), "#527：routeDisabledHint 中文文案");
  assert.ok(locales.includes("routeDisabledHint: \"Channel not enabled"), "#527：routeDisabledHint 英文文案");
  assert.ok(client.includes("is-off") && client.includes("routeDisabledHint"), "#527：置灰逻辑与文案键进产物");
  assert.ok(css.includes("dn-route-chip.is-off"), "#527：is-off 置灰样式进 CSS");
}

// ---- issue #640/#641：每通道声音 UI（帧级 sound / 三态 / 声音行 / 试听 / 弃写锚）----
{
  const src = readFileSync(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const locales = readFileSync(new URL("../src/client/locales.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/client/style.css", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // A5：UI 不再写全局 notifySound（废弃只读别名）——产物不得含旧声音行开关
  assert.ok(!src.includes('switchControl("notifySound"'), "#640/A5：客户端源码不再有 switchControl(\"notifySound\")");
  assert.ok(!client.includes('switchControl("notifySound"'), "#640/A5：产物不含 switchControl(\"notifySound\")");
  // 新声音行走 browserSound/systemSound 键
  assert.ok(src.includes('builtinCard("browserNotify", "browserSound"'), "#640：browser 卡接 browserSound");
  assert.ok(src.includes('builtinCard("systemNotify", "systemSound"'), "#640：system 卡接 systemSound");
  // C1：帧级 sound 权威——showNotification 吃帧内 sound 策略对象
  assert.ok(src.includes("showNotification(payload.kind, payload.title, payload.message, { sound: payload.sound"), "#640/C1：帧级 sound 传入 showNotification（取代布尔快照）");
  assert.ok(src.includes("playOnly: payload.playOnly === true"), "#640/C1：只响不弹 playOnly 帧标记");
  // C2：统一播放节流覆盖全部自播（playGate）+ 多标签租约前置（claimMaster 先于自播）
  assert.ok(src.includes("function playGate()"), "#640/C2：统一播放节流函数");
  assert.ok(src.includes("if (selfPlay && playGate()) playTone(tone)"), "#640/C2：自播路径统一过 playGate");
  // C3：builtinCard 三态（状态徽标 + dn-ch-sound 半启用类 + open = on || soundOn）
  assert.ok(src.includes("dn-ch-sound"), "#640/C3：仅声音半启用态 class");
  assert.ok(src.includes("open={on || soundOn}"), "#640/C3：卡展开条件 = 弹窗开 || 声音开");
  assert.ok(src.includes("chStateSound"), "#640/C3：仅声音状态文案键引用");
  // C5/C6：试听按钮 + 音色下拉 + 显式 unlockAudio；4 音色选项
  assert.ok(src.includes("dn-tonePreview"), "#640/C6：试听按钮 class");
  assert.ok(src.includes("playPreview("), "#640/C6：试听调用 playPreview");
  assert.ok(src.includes('"ding", "bell", "chime", "pop"'), "#640/C6：客户端 SOUND_IDS 4 音色（与服务端同源复制）");
  assert.ok(src.includes("unlockAudio()"), "#640/C5：声音交互显式 unlockAudio（含试听）");
  // C7：宿主平台提示消费 /health platform
  assert.ok(src.includes("hostPlatform"), "#640/C7：宿主平台状态（/health platform 拉取）");
  assert.ok(src.includes("sysPlatformWin") && src.includes("sysPlatformMac") && src.includes("sysPlatformLinux"), "#640/C7：三平台提示文案键");
  // 文案双语 + 产物锚点
  assert.ok(locales.includes('chSoundFollow: "跟随系统默认"') && locales.includes('chSoundFollow: "Follow system default"'), "#640：跟随系统默认文案双语");
  assert.ok(locales.includes('toneDing: "叮（Ding）"') && locales.includes("toneDing: \"Ding\""), "#640：音色文案双语");
  assert.ok(locales.includes("sysPlatformLinux:") && locales.includes("sysPlatformLinux:"), "#640：平台提示双语存在");
  assert.ok(client.includes("dn-ch-sound") && client.includes("dn-tonePreview"), "#640：三态与试听 class 进产物");
  assert.ok(css.includes("dn-ch-sound") && css.includes("dn-tonePreview"), "#640：三态与试听样式进 CSS");
  // locales zh/en 平衡由 tsc 编译期锁（Record<NotifierLocaleKey, string>），此处锚关键键
  console.log("#640/#641 客户端声音 UI 契约锚点: OK");
}

// ---- issue #640/#641：vm 沙箱真链——帧级 sound 驱动自播/静音（C1/C4 行为层）----
{
  const clientCode = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const byType = new Map();
  const listeners = {
    addEventListener(type, fn) { let s = byType.get(type); if (!s) { s = new Set(); byType.set(type, s); } s.add(fn); },
    removeEventListener(type, fn) { const s = byType.get(type); if (s) s.delete(fn); },
  };
  const documentStub = {
    ...listeners,
    visibilityState: "hidden",
    title: "",
    hidden: true,
    getElementById: () => null,
    createElement: () => ({ appendChild() {}, remove() {}, style: {}, dataset: {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  let sourceCount = 0;
  let notifCount = 0;
  let notifSilent = [];
  const sources = [];
  class EventSourceStub { constructor() { sourceCount += 1; this.onmessage = null; this.onerror = null; sources.push(this); } close() {} }
  const sandbox = {
    console: { ...console, warn: () => {} },
    Symbol, Object, Array, JSON, Math, Date, Promise,
    setTimeout, clearTimeout,
    EventSource: EventSourceStub,
    Notification: Object.assign(function (title, opts) { notifCount += 1; notifSilent.push(opts.silent === true); this.close = () => {}; }, { permission: "granted" }),
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: documentStub,
    localStorage: { getItem: (k) => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.isSecureContext = true;
  let loadedFactory = null;
  sandbox.window.__ModuleLoader__ = { load(handoff) { loadedFactory = handoff.factory; } };
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox);
  const mod = loadedFactory((spec) => {
    if (spec === "react") return { createElement: () => ({}) };
    throw new Error(`unexpected require: ${spec}`);
  });
  const disposers = [];
  mod.apply({
    get() { return undefined; },
    effect(fn) { const d = fn(); disposers.push(d); return d; },
  });
  const activeSource = sources[sources.length - 1];
  // AudioContext stub：沙箱 window.AudioContext 缺失 → unlockAudio 静默失败 → playTone
  // 空转（沙箱无音频）；此处只验证「帧级 sound 不弹 + silent 标记」决策面。
  let seq = 0;
  const deliver = (payload) => { seq += 1; activeSource.onmessage({ data: JSON.stringify({ type: "notify", seq, ...payload }) }); };
  // 弹窗帧 + sound silent：仍弹实体（silent=true），不自播（沙箱无声无妨）
  deliver({ kind: "done", title: "T", message: "m", sound: { mode: "silent", tone: undefined } });
  assert.equal(notifCount, 1, "#640：silent 帧仍弹系统通知实体");
  assert.equal(notifSilent[0], true, "#640：silent 帧 → Notification silent:true");
  // playOnly 帧：不弹实体（只响不弹）
  deliver({ kind: "done", title: "T", message: "m", playOnly: true, sound: { mode: "selfplay", tone: "pop" } });
  assert.equal(notifCount, 1, "#640：playOnly 帧不弹系统通知实体");
  // system 模式帧：弹且不 silent（交给 OS 发声）
  deliver({ kind: "done", title: "T", message: "m", sound: { mode: "system", tone: undefined } });
  assert.equal(notifCount, 2, "#640：system 模式帧弹通知");
  assert.equal(notifSilent[1], false, "#640：system 模式帧 → Notification 不 silent");
  for (const d of disposers.splice(0)) d();
  console.log("#640/#641 vm 帧级 sound 决策面: OK");
}

// ---- 复核 P1-1：playOnly + mode:"selfplay" 帧 → 客户端真实自播（振荡器启动计数）----
// 回归「弹窗关 + browserSound=true 纯静默断链」：帧 sound 必须驱动 playTone，
// 且 mode 为 selfplay 时即使 tone undefined 也播默认旋律（旧 playChime 双音）。
{
  const clientCode = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const byType = new Map();
  const listeners = {
    addEventListener(type, fn) { let s = byType.get(type); if (!s) { s = new Set(); byType.set(type, s); } s.add(fn); },
    removeEventListener(type, fn) { const s = byType.get(type); if (s) s.delete(fn); },
  };
  const documentStub = {
    ...listeners,
    visibilityState: "visible",
    title: "",
    hidden: false,
    getElementById: () => null,
    createElement: (tag) => {
      if (tag === "style") return { id: "", textContent: "", dataset: {}, remove() {} };
      return { appendChild() {}, remove() {}, style: {}, dataset: {} };
    },
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  const sources = [];
  let oscStarts = 0;
  // AudioContext stub：解锁后 running；振荡器 start() 计数（真实自播证据）
  class AudioCtxStub {
    constructor() { this.state = "suspended"; this.currentTime = 0; }
    resume() { this.state = "running"; }
    createBuffer() { return {}; }
    createBufferSource() { return { buffer: null, connect() {}, start() { oscStarts += 1; } }; }
    createOscillator() { return { type: "", frequency: { value: 0 }, connect() {}, start() { oscStarts += 1; }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  const sandbox = {
    console: { ...console, warn: () => {} },
    Symbol, Object, Array, JSON, Math, Date, Promise,
    setTimeout, clearTimeout,
    EventSource: class { constructor() { this.onmessage = null; this.onerror = null; sources.push(this); } close() {} },
    Notification: Object.assign(function () { this.close = () => {}; }, { permission: "granted" }),
    AudioContext: AudioCtxStub,
    webkitAudioContext: undefined,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: documentStub,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.isSecureContext = true;
  let loadedFactory = null;
  sandbox.window.__ModuleLoader__ = { load(handoff) { loadedFactory = handoff.factory; } };
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox);
  const mod = loadedFactory((spec) => {
    if (spec === "react") return { createElement: () => ({}) };
    throw new Error(`unexpected require: ${spec}`);
  });
  const disposers = [];
  mod.apply({
    get() { return undefined; },
    effect(fn) { const d = fn(); disposers.push(d); return d; },
  });
  const activeSource = sources[sources.length - 1];
  // 先模拟用户手势解锁（首次点击 unlockAudio）
  for (const fn of byType.get("click") || []) fn();
  let seq = 0;
  const deliver = (payload) => { seq += 1; activeSource.onmessage({ data: JSON.stringify({ type: "notify", seq, ...payload }) }); };
  // 页面 visible + 连发两个只响不弹帧（selfplay 新帧 + 旧服务端 system 残留帧）：
  // 不弹实体（playOnly 豁免可见性）+ 至少一次默认旋律自播（1.5s 节流合并连发为
  // 一次播放属预期；旧 bug 形态两帧皆 0 播 → 断言失败即抓住断链）
  deliver({ kind: "done", title: "T", message: "m", playOnly: true, sound: { mode: "selfplay", tone: undefined } });
  deliver({ kind: "done", title: "T", message: "m", playOnly: true, sound: { mode: "system", tone: undefined } });
  assert.ok(oscStarts > 0, "P1-1：playOnly 帧（selfplay 新帧/旧 system 残留帧）驱动振荡器自播（默认旋律）");
  // 对照：playOnly 帧不弹系统通知实体（无实体降级展示 → 标题不闪烁）
  assert.equal(documentStub.title, "", "P1-1：playOnly 帧不触发标题闪烁（无实体降级展示）");
  for (const d of disposers.splice(0)) d();
  console.log("P1-1 vm playOnly 帧自播（振荡器计数）回归: OK");
}

// ---- S3-12/N-23：maxConnections 清空守卫（clampMaxConnections 真产物直测）----
// 空串 → undefined → diff 键被 JSON 序列化丢弃 → 不提交保持原值；非空值软
// clamp（1-1024，服务端写面 min=1，0 会 400——唯一有 400 风险的顶层数值键）。
// 模块级纯函数经 apply 挂载面直测（与 diffSettingsPayload 同先例）。
{
  const clientCode = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const sandbox = {
    console: { ...console, warn: () => {} },
    Symbol, Object, Array, JSON, Math, Date, Promise,
    setTimeout, clearTimeout,
    EventSource: function () {},
    Notification: function () {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: {
      visibilityState: "visible", title: "", hidden: false,
      addEventListener() {}, removeEventListener() {},
      getElementById: () => null,
      createElement: () => ({ appendChild() {}, remove() {}, style: {}, dataset: {} }),
      head: { appendChild() {} }, body: { appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    window: {},
  };
  sandbox.window = sandbox;
  let loadedFactory = null;
  sandbox.window.__ModuleLoader__ = { load(handoff) { loadedFactory = handoff.factory; } };
  vm.createContext(sandbox);
  vm.runInContext(clientCode, sandbox);
  assert.ok(loadedFactory !== null, "S3-12：产物 load 已注册 factory");
  const mod = loadedFactory((spec) => {
    if (spec === "react") return { createElement: () => ({}) };
    throw new Error(`unexpected require: ${spec}`);
  });
  const disposers = [];
  mod.apply({
    get() { return undefined; },
    effect(fn) { const d = fn(); disposers.push(d); return d; },
  });
  const clampFn = mod.apply.clampMaxConnections;
  const diffFn = mod.apply.diffSettingsPayload;
  assert.equal(typeof clampFn, "function", "S3-12：apply 挂载 clampMaxConnections 纯函数");
  for (const d of disposers.splice(0)) d();

  // 直接值断言：空/非有限 → undefined（不提交）；0/-5 钳到 1；2000 钳到 1024；
  // 1-1024 内四舍五入整数（与 whTimeout clamp 同款 round 语义）
  assert.equal(clampFn(undefined), undefined, "S3-12：undefined → undefined（空串形态不提交）");
  assert.equal(clampFn(NaN), undefined, "S3-12：NaN → undefined（type=number 防御）");
  assert.equal(clampFn(0), 1, "S3-12：0 → clamp 1（防 400 死锁）");
  assert.equal(clampFn(-5), 1, "S3-12：-5 → clamp 1");
  assert.equal(clampFn(2000), 1024, "S3-12：2000 → clamp 1024");
  assert.equal(clampFn(16.4), 16, "S3-12：16.4 → round 16");
  assert.equal(clampFn(16.5), 17, "S3-12：16.5 → round 17");
  assert.equal(clampFn(16), 16, "S3-12：16 在界内原样");

  // diff 语义：清空输入（undefined）→ diff 不含 maxConnections 键（PUT 不提交
  // → 服务端保持原值）；输入 0 → clamp 后 diff 含 1（合法提交，不再 400）
  const baseline = { maxConnections: 16, notifyTaskDone: true };
  const cleared = JSON.parse(JSON.stringify(baseline));
  cleared.maxConnections = undefined;
  const clearedPayload = JSON.parse(JSON.stringify(diffFn(cleared, baseline)));
  assert.ok(!("maxConnections" in clearedPayload), "S3-12：清空 maxConnections → diff 不含该键（保持原值）");
  const clampedView = JSON.parse(JSON.stringify(baseline));
  clampedView.maxConnections = 0; // type=number 输入 0 的原始形态
  const clampedPayload = JSON.parse(JSON.stringify(diffFn({ ...clampedView, maxConnections: clampFn(0) }, baseline)));
  assert.equal(clampedPayload.maxConnections, 1, "S3-12：输入 0 → clamp 后 diff 提交 1（服务端 200）");
  console.log("S3-12/N-23 clampMaxConnections 真产物直测: OK");
}
