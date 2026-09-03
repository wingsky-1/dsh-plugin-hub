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
  const src = readFileSync(new URL("../src/client/index.ts", import.meta.url), "utf8");
  const locales = readFileSync(new URL("../src/client/locales.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // 1. 频道 tab 去就近保存：单一保存入口（foot），且源码/产物/样式三处无 dn-ch-saveRow
  assert.ok(!src.includes("dn-ch-saveRow"), "#418：频道 tab 就近保存行已移除");
  assert.ok(!client.includes("dn-ch-saveRow"), "#418：产物无就近保存 class");
  assert.ok(!src.includes("tabSave"), "#418：tabSave 变量已移除");
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
  const src = readFileSync(new URL("../src/client/index.ts", import.meta.url), "utf8");
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
  const src = readFileSync(new URL("../src/client/index.ts", import.meta.url), "utf8");
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
  let sourceCount = 0;
  let closeCount = 0;
  class EventSourceStub {
    constructor() { sourceCount += 1; this.onmessage = null; this.onerror = null; this.onopen = null; }
    close() { closeCount += 1; }
  }
  const fakeReact = { createElement: () => ({}) };
  const warnings = [];
  const sandbox = {
    console: { ...console, warn: (...a) => warnings.push(a.join(" ")) },
    Symbol, Object, Array, JSON, Math, Date, Promise,
    setTimeout, clearTimeout,
    EventSource: EventSourceStub,
    Notification: function () {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: documentStub,
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

  // 触发可见事件：监听应作用于当前句柄（重建 SSE——source 计数增加且旧源被关）
  const sourcesBefore = sourceCount;
  for (const fn of byType.get("visibilitychange") || []) fn();
  assert.ok(sourceCount > sourcesBefore, "#469：可见事件触发 SSE 重建（监听仍活）");
  assert.ok(closeCount >= sourcesBefore, "#469：重建前旧 SSE 句柄已关（不操作已置 null 句柄）");

  // 卸载当前实例 → 监听归零；disposer 幂等：二次调用不报错、监听仍零
  disposers.shift()();
  assert.equal(visCount(), 0, "#469：disposer 卸载后 visibilitychange 监听归零");
  assert.equal(localeUnsubs, 2, "#469：两次实例的 locale 订阅全部取消");
  for (const d of disposers.splice(0)) d();
  assert.equal(visCount(), 0, "#469：disposer 二次调用后仍无监听");
}
