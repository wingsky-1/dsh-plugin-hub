// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — contract：客户端「源码锚点 + 构建产物锚点」契约。
 *
 * 覆盖：assertClientSourceContract / assertClientProductContract（共享 smoke-lib，
 * 与 contract-check 同源）；lib/client.js 路由字面量与宿主 ROUTES 常量双向一致；
 * 客户端清理契约（B1-B6 移除侧边栏入口/浮层/角标、C 组通知半区保留）；设置页
 * UI/UX 各期锚点（#402/#418/#421/#508/#527/#640/#405 保存模型）。
 *
 * 拆法：原 client-contract.test.ts（982 行 / 202 断言）按观测面拆为两个文件——
 * 本文件承载「字符串级源码/产物契约」（读 src/client/** 与 lib/client.js 产物
 * 文本），client-behavior.test.ts 承载「vm 沙箱执行真实产物」的行为验收。
 * 形态纪律：**保持读 lib 产物 + vm 的既有形态**（验证的正是构建产物形态），
 * 不改为直连 src/client/**；前置条件是 `pnpm build` 已产出 lib/。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { assertClientProductContract, assertClientSourceContract } from "../../../../test/smoke-lib.ts";
import { ROUTES } from "../../lib/index.js";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
const readSrc = () => readFileSync(new URL("../../src/client/index.tsx", import.meta.url), "utf8");
const readLocales = () => readFileSync(new URL("../../src/client/locales.ts", import.meta.url), "utf8");
const readCss = () => readFileSync(new URL("../../src/client/style.css", import.meta.url), "utf8");
const readClient = () => readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");

// ---- 客户端契约与两端路由一致性 ----
describe("客户端契约（源形态 + 执行契约）与路由双向一致", () => {
  it("客户端源码契约（assertClientSourceContract，与 contract-check 同源）", () => {
    assertClientSourceContract(pkgDir);
  });

  it("客户端产物契约（assertClientProductContract，与 contract-check 同源）", () => {
    assertClientProductContract(pkgDir);
  });

  const literals = [...readClient().matchAll(/\/api\/dsh-notifier\/[a-z-]+/g)].map((m) => m[0]);
  const expected = Object.values(ROUTES);

  for (const literal of [...new Set(literals)]) {
    it(`client 出现未知路由: ${literal}`, () => {
      expect(expected.includes(literal)).toBeTruthy();
    });
  }

  for (const route of expected) {
    it(`client 缺少路由: ${route}`, () => {
      expect(literals.includes(route)).toBeTruthy();
    });
  }
});

// ---- 客户端清理契约（B1-B6 / C 组）----
describe("客户端清理契约 B1-B6（侧边栏/浮层/角标/拖拽全部移除）", () => {
  const src = readSrc();
  const client = readClient();

  for (const banned of ["createSidebarEntry", "renderPanel", "attachDrag", "restorePanelPos", "bumpUnread", "initUnread", "data-dsh-notifier-badge", "dsh-notifier-panel", "data-dsh-notifier-entry"]) {
    it(`B 组：客户端源码不得出现 ${banned}`, () => {
      expect(!src.includes(banned)).toBeTruthy();
    });

    it(`B 组：客户端产物不得含 ${banned}`, () => {
      expect(!client.includes(banned)).toBeTruthy();
    });
  }

  it("B6：无侧边栏 DOM 锚点", () => {
    // B6：客户端 entry 不再引用侧边栏注册（DOM 定位锚点移除）
    expect(!src.includes("sidebarCol")).toBeTruthy();
  });

  it("B4：拖拽位置持久化已移除", () => {
    // 未读/角标相关 storage 键不再写入（B4：localStorage 'dsh-notifier:panel:pos' 不再写）
    expect(!src.includes("panel:pos")).toBeTruthy();
  });
});

describe("客户端清理契约 C1-C9（通知半区保留，不依赖插件 DOM）", () => {
  const src = readSrc();
  const client = readClient();

  for (const kept of ["startEvents", "WATCHDOG_MS", "claimMaster", "unlockAudio", "EventSource", "new Notification", "showNotification"]) {
    it(`C 组：通知半区保留 ${kept}`, () => {
      expect(src.includes(kept)).toBeTruthy();
    });

    it(`C 组：产物保留 ${kept}`, () => {
      expect(client.includes(kept)).toBeTruthy();
    });
  }

  it("C6：apply 直接启动 SSE（不依赖侧边栏挂载）", () => {
    // C6：SSE 启动不依赖任何插件 DOM（apply 直接 startEvents，无 mount 等待）
    expect(src.includes("startEvents()")).toBeTruthy();
  });

  it("A 组：设置注册到官方设置页独立 tab 插槽", () => {
    // 独立 tab 挂载经 slots（官方设置页 settings.section 插槽；
    // 参照 provider-usage「用量统计」tab，不双注册 plugin.item 卡片）
    expect(src.includes("settings.section")).toBeTruthy();
  });

  it("A 组：不双注册 plugin.item 卡片（评审 B P0）", () => {
    expect(!src.includes('inject("settings.plugin.item"')).toBeTruthy();
  });

  it("i18n 命名空间 NS 进产物", () => {
    // i18n 接入哨兵：NS / register / bind / slots locale 参数 / 双语字典进产物
    expect(readClient().includes('"notifier"')).toBeTruthy();
  });

  it("locale.register（字典注册）进产物", () => {
    expect(readClient().includes("locale.register")).toBeTruthy();
  });

  it("locale.bind（t 装配）进产物", () => {
    expect(readClient().includes("locale.bind")).toBeTruthy();
  });

  it("slots.register locale 参数进产物", () => {
    expect(readClient().includes("locale: NS")).toBeTruthy();
  });

  it("en/zh 双语字典进产物", () => {
    const c = readClient();
    expect(c.includes("Approval pending") && c.includes("evtAsk")).toBeTruthy();
  });
});

// ---- #402：设置页 UI/UX 打磨（折叠 / 双 tab / 去 title / label thunk / 就近保存）----
describe("#402：设置页 UI/UX 打磨锚点", () => {
  let src: string;
  let locales: string;
  let client: string;

  beforeAll(() => {
    src = readSrc();
    locales = readLocales();
    client = readClient();
  });

  it("#402：notifier settings.section label 为 thunk（切语言跟随）", () => {
    // 第 5 条：settings.section label 为 thunk（源码级 includes 断言——esbuild 产物文本
    // 形态对 minify 脆弱，thunk 行为交浏览器实测「切语言 tab 文案跟随」锁定）
    expect(src.includes('label: () => t("tabLabel")')).toBeTruthy();
  });

  it("#402：不再注册求值快照 label", () => {
    expect(!src.includes('label: t("tabLabel")')).toBeTruthy();
  });

  it("#402：频道卡为 details 可折叠（TSX 形态）", () => {
    // 第 1 条：频道卡 details 折叠形态（key 含 enabled —— 非受控 + key remount）
    // createElement → TSX 纯语法迁移，源码锚点随形态演进（语义不变：
    // 仍断言「频道卡为 details 可折叠」，JSX 内联 details 即目标形态）
    expect(src.includes("<details")).toBeTruthy();
  });

  it("#402：投递失败徽标上提卡头（收起可见）", () => {
    expect(src.includes("failBadge(")).toBeTruthy();
  });

  it("#402：卡内双 tab 结构", () => {
    // 第 2 条：卡内双 tab + kind 徽标（关键 class 进产物）
    expect(src.includes("dn-set-tabs") && src.includes("dn-set-tabActive")).toBeTruthy();
  });

  it("#402：待确认 kind 的 tab 徽标", () => {
    expect(src.includes("dn-set-tabBadge")).toBeTruthy();
  });

  it("#402：tab class 进产物", () => {
    expect(client.includes("dn-set-tabs")).toBeTruthy();
  });

  it("#402：设置卡 title/副标题渲染已删", () => {
    // 第 4 条：设置卡 title/副标题移除（源码与字典两侧）
    expect(!src.includes("settingsName") && !src.includes("settingsDescription")).toBeTruthy();
  });

  it("#402：locales 字典 settingsName/settingsDescription 已删", () => {
    expect(!locales.includes("settingsName:") && !locales.includes("settingsDescription:")).toBeTruthy();
  });

  it("#402：tab 术语统一为「通知频道」且无旧「投递频道」残留", () => {
    // 第 2 条配套：术语统一（「通知频道」，消除与旧「投递频道」混用；死键 routePick 已随本次清理删除）
    expect(locales.includes('secChannels: "通知频道"') && !locales.includes('"投递频道"')).toBeTruthy();
  });
});

// ---- #418：设置面板布局收敛（去重复保存 / 权限入浏览器卡 / 动作并入历史区）----
describe("#418：设置面板布局收敛锚点", () => {
  let src: string;
  let locales: string;
  let client: string;

  beforeAll(() => {
    src = readSrc();
    locales = readLocales();
    client = readClient();
  });

  it("#418：旧就近保存行 class 未回归", () => {
    // 1. 频道 tab 去就近保存：单一保存入口（foot），且源码/产物/样式三处无 dn-ch-saveRow
    // —— 移除的是「双份全量保存」的旧行（dn-ch-saveRow）；后按方案定稿
    // 引入的域保存行 class 为 dn-ch-domainSave（仅提交 channels 键，语义 ≠ 全量），
    // 属原文预留的「域级拆分后按域重排按钮位置」兑现，不构成该回归。
    expect(!src.includes("dn-ch-saveRow")).toBeTruthy();
  });

  it("#418：产物无旧就近保存 class", () => {
    expect(!client.includes("dn-ch-saveRow")).toBeTruthy();
  });

  it("#418：tabSave 变量未回归", () => {
    expect(!src.includes("tabSave")).toBeTruthy();
  });

  it("#418：浏览器权限状态行归入频道卡", () => {
    // 2. 浏览器通知权限状态行移入浏览器频道卡（browserPermLine 只挂在 browser 卡）
    expect(src.includes("browserPermLine")).toBeTruthy();
  });

  it("#418：权限行只渲染于浏览器卡", () => {
    expect(src.includes('channelId === "browser" ? browserPermLine()')).toBeTruthy();
  });

  it("#418：权限行 class 进源码", () => {
    expect(src.includes("dn-ch-perm")).toBeTruthy();
  });

  it("#418：权限行 class 进产物", () => {
    expect(client.includes("dn-ch-perm")).toBeTruthy();
  });

  it("#418：全局降级区不再渲染权限状态", () => {
    // 权限状态行不再出现在全局降级区（perm 三态文案仅存于 browserPermLine 分支）；
    // 带相邻特征串锚定，避免注释里出现 key: "perm" 即误伤
    expect(!src.includes('className: "dn-set-note", key: "perm"')).toBeTruthy();
  });

  it("#418：历史区工具行（动作+刷新）", () => {
    // 3. 动作并入历史区（清理/发送测试在 historyTools 内与刷新并排）；「动作」分区标题移除
    expect(src.includes("dn-set-historyTools")).toBeTruthy();
  });

  it("#418：源码无「动作」分区标题引用", () => {
    expect(!src.includes('t("secActions")')).toBeTruthy();
  });

  it("#418：locales 字典已删 secActions 键", () => {
    expect(!locales.includes("secActions:")).toBeTruthy();
  });
});

// ---- #421：免打扰豁免扩至全部内置事件（候选 6 项 + 跟随已启用 + 恢复默认）----
describe("#421：免打扰豁免扩至全部内置事件锚点", () => {
  let src: string;
  let locales: string;
  let client: string;

  beforeAll(() => {
    src = readSrc();
    locales = readLocales();
    client = readClient();
  });

  it("#421：事件开关键→kind 映射（单一事实源）", () => {
    // 单一事实源：EVENT_KIND_MAP 覆盖全部 6 个内置事件 kind（notifyKey → kind）
    expect(src.includes("EVENT_KIND_MAP")).toBeTruthy();
  });

  for (const [notifyKey, kind] of [["notifyAsk", "ask"], ["notifyQuestion", "question"], ["notifyTaskDone", "done"], ["notifySubagentDone", "subagent-done"], ["notifyTaskError", "error"], ["notifyTurnEnd", "turn-end"]]) {
    it(`#421：${notifyKey} → ${kind}`, () => {
      expect(src.includes(`${notifyKey}: "${kind}"`)).toBeTruthy();
    });
  }

  it("#421：旧 3 项硬编码 ALLOW_CHOICES 已移除", () => {
    // 候选由 EVENT_KEYS 派生（不新建平行表 ALLOW_CHOICES）
    expect(!src.includes("ALLOW_CHOICES")).toBeTruthy();
  });

  it("#421：未启用事件弱化样式", () => {
    // 快捷按钮 + 未启用弱化（关键 class/函数进源码与产物）
    expect(src.includes("dn-set-allowDim")).toBeTruthy();
  });

  it("#421：跟随已启用/恢复默认按钮", () => {
    expect(src.includes("allowFollowEnabled") && src.includes("allowResetDefault")).toBeTruthy();
  });

  it("#421：快捷按钮行 class", () => {
    expect(src.includes("dn-set-allowActions")).toBeTruthy();
  });

  it("#421：豁免区新 class 进产物", () => {
    expect(client.includes("dn-set-allowDim") && client.includes("dn-set-allowActions")).toBeTruthy();
  });

  it("#421：跟随已启用文案双语", () => {
    // 文案键：新增三个（中英双语）
    expect(locales.includes('allowFollowEnabled: "跟随已启用事件"') && locales.includes('allowFollowEnabled: "Follow enabled events"')).toBeTruthy();
  });

  it("#421：恢复默认文案双语", () => {
    expect(locales.includes("allowResetDefault:") && locales.includes("allowResetDefault:")).toBeTruthy();
  });

  it("#421：旧 allowXxx 豁免 label 键已删", () => {
    // 旧 allowXxx 豁免 label 键移除（候选复用 KIND_KEYS 事件文案）
    expect(!locales.includes("allowAsk:") && !locales.includes("allowQuestion:") && !locales.includes("allowError:")).toBeTruthy();
  });
});

// ---- #508：通知中心 UI/UX 现代化（三 tab / switch / chips / 脏状态栏 / webhook 卡）----
describe("#508：通知中心 UI/UX 现代化锚点", () => {
  let src: string;
  let locales: string;
  let client: string;

  beforeAll(() => {
    src = readSrc();
    locales = readLocales();
    client = readClient();
  });

  it("#508：activeTab 联合类型含 history（三 tab）", () => {
    // 1. 三 tab：通知记录 tab 加入（activeTab 联合类型收窄为三值，secHistory 分区标题）
    expect(src.includes("events\" | \"channels\" | \"history\"")).toBeTruthy();
  });

  it("#508：通知记录 tab 引用 secHistory 分区标题", () => {
    expect(src.includes('t("secHistory")')).toBeTruthy();
  });

  it("#508：secHistory 文案双语", () => {
    expect(locales.includes('secHistory: "通知记录"') && locales.includes('secHistory: "History"')).toBeTruthy();
  });

  it("#508：switch 开关依赖 aria-label 可访问名（TSX 形态）", () => {
    // 2. switch 无障碍：原生 checkbox 改 switch 开关，无内联文本必须靠 aria-label 提供可访问名
    // createElement → TSX 迁移，源码锚点随语法形态演进（aria-label 可访问名语义不变）
    expect(src.includes('className="dn-switch"') && src.includes("aria-label=")).toBeTruthy();
  });

  it("#508：dn-switch-track 开关轨道 class 进产物", () => {
    expect(client.includes("dn-switch-track")).toBeTruthy();
  });

  it("#508：路由 chips 含 aria-pressed/状态标签/stale 形态（TSX 形态）", () => {
    // 3. 路由 chips：直点切换 + aria-pressed 开/关态 + 状态标签 + stale 虚线 chip
    expect(src.includes("aria-pressed=") && src.includes("dn-route-state") && src.includes("is-stale")).toBeTruthy();
  });

  it("#508：chips 状态标签文案键双语存在", () => {
    expect(locales.includes("routeDefaultState:") && locales.includes("routeCustomState:")).toBeTruthy();
  });

  it("#508：动态 kind 确认行路由提示（源码+文案）", () => {
    // 4. 动态 kind 确认行带路由提示（r4 拍板）
    expect(src.includes("dn-kind-routeHint") && locales.includes("kindRouteHint:")).toBeTruthy();
  });

  it("#508：脏状态保存栏（dn-dirty + discardChanges）", () => {
    // 5. 底部脏状态保存栏：脏计数 + 放弃更改入口
    expect(src.includes("dn-dirty") && src.includes("discardChanges")).toBeTruthy();
  });

  it("#508：脏状态/放弃更改文案键双语存在", () => {
    expect(locales.includes("dirtySome:") && locales.includes("discardChanges:")).toBeTruthy();
  });

  it("#508：webhook 频道卡（webhookCard/WEBHOOK_PRESETS/dn-authFields）", () => {
    // 6. webhook 频道卡：预设常量 + 认证字段区 + 添加入口；双语键平衡由 tsc 编译期
    // 锁（Record<NotifierLocaleKey, string>），此处只断言关键键出现一次以上（中英各一）
    expect(src.includes("webhookCard") && src.includes("WEBHOOK_PRESETS") && src.includes("dn-authFields")).toBeTruthy();
  });

  it("#508：chAddWebhook 文案键在 locales 出现一次以上（中英双语各一）", () => {
    expect(locales.split("chAddWebhook:").length > 2).toBeTruthy();
  });

  it("#508：频道卡头类型图标 class 进产物", () => {
    // 7. 频道卡头类型图标（iconEl → dn-ch-icon）
    expect(client.includes("dn-ch-icon")).toBeTruthy();
  });

  it("#508：旧 checkbox 豁免 label class dn-set-allow 已移除", () => {
    // 8. 负向断言：旧 checkbox 豁免 label class 已移除——用引号闭合精确串防误伤
    // dn-set-allowDim/allowHint/allows/allowActions（它们仍是有效锚点）
    expect(!src.includes('className: "dn-set-allow"')).toBeTruthy();
  });

  it("#508：channelId 前缀 hardcode 已收敛为 channelIdFor", () => {
    expect(!src.includes('"bark:" + String(ch.id)')).toBeTruthy();
  });
});

// lib/toast.ps1 发布物完整性：必须带 UTF-8 BOM 且与源文件逐字节一致。
// pwsh 7 在 CI 上解析通过抓不住 5.1 的 ANSI 码页问题，字节级断言是唯一机器兜底；
// 构建期 copyClientResources 已强制补写，此处防回归（编辑器去 BOM / 复制链变更）。
describe("lib/toast.ps1 发布物完整性", () => {
  let libBuf: Buffer;
  let srcBuf: Buffer;

  beforeAll(() => {
    libBuf = readFileSync(new URL("../../lib/toast.ps1", import.meta.url));
    srcBuf = readFileSync(new URL("../../src/toast.ps1", import.meta.url));
  });

  it("lib/toast.ps1 必须带 UTF-8 BOM（PS 5.1 按 ANSI 解码无 BOM 文件）", () => {
    expect(libBuf[0] === 0xef && libBuf[1] === 0xbb && libBuf[2] === 0xbf).toBeTruthy();
  });

  it("lib/toast.ps1 剥离 BOM 后应与 src 源文件逐字节一致", () => {
    const stripBom = (buf: Buffer) => (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf);
    expect(stripBom(libBuf)).toEqual(stripBom(srcBuf));
  });
});

// ---- #469：visibilitychange 匿名监听无卸载 → 具名 handler + disposer 移除 ----
// 分三层：① 源码级成对哨兵（注册/移除同现、订阅取消函数保存——防回归，源码名稳定）；
// ② 产物级负向哨兵（匿名注册形态绝迹——esbuild 会把 apply 内具名函数重命名，
// 产物文本不断言具体名字，只断不变量）；③ vm 沙箱执行真实产物 lib/client.js，
// 事件计数级断言验收语义（见 client-behavior.test.ts）。
describe("#469：visibilitychange 源码级与产物级哨兵", () => {
  let src: string;
  let client: string;

  beforeAll(() => {
    src = readSrc();
    client = readClient();
  });

  it("#469：源码不再有匿名 visibilitychange 注册", () => {
    // ① 源码级哨兵（源码名稳定，产物对 esbuild 重命名脆弱）：
    // - 匿名 visibilitychange 注册绝迹（旧泄漏根因：无引用可移除）
    expect(!src.includes('addEventListener("visibilitychange", function')).toBeTruthy();
  });

  it("#469：具名 onVisibilityChange handler 存在", () => {
    expect(src.includes("function onVisibilityChange()")).toBeTruthy();
  });

  it("#469：具名 handler 注册进 apply", () => {
    expect(src.includes('addEventListener("visibilitychange", onVisibilityChange)')).toBeTruthy();
  });

  it("#469：disposer 移除 visibilitychange 监听", () => {
    expect(src.includes('removeEventListener("visibilitychange", onVisibilityChange)')).toBeTruthy();
  });

  it("#469：locale.subscribe 取消函数已保存", () => {
    expect(src.includes("unsubLocale = locale.subscribe(")).toBeTruthy();
  });

  it("#469：disposer 调用 locale 取消函数", () => {
    expect(src.includes("unsubLocale()")).toBeTruthy();
  });

  it("#469 P1-2：unsubLocale 声明为 undefined 形态（非 null 初始化）", () => {
    // - unsubLocale 守卫对齐 undefined 形态（P1-2：防官方 locale.subscribe 返回
    // null 时 null 初始化守卫失效——provider-usage/mcp-manager 同款范式）
    expect(src.includes("var unsubLocale: (() => void) | undefined;")).toBeTruthy();
  });

  it("#469 P1-2：disposer unsubLocale 守卫为 !== undefined", () => {
    expect(src.includes("if (unsubLocale !== undefined) {")).toBeTruthy();
  });

  it("#469 P1-1：disposer 内移除监听后调用 restoreTitle()", () => {
    // - disposer 卸载即恢复标题（P1-1：标题恢复不能只依赖已摘除的 visibilitychange 监听）
    expect(/removeEventListener\("visibilitychange", onVisibilityChange\);[\s\S]*?restoreTitle\(\);/.test(src)).toBeTruthy();
  });

  it("#469：产物不再有匿名 visibilitychange 注册", () => {
    // ② 产物级负向哨兵：匿名注册形态绝迹（源码哨兵防改动，此哨兵防构建链丢配对）
    expect(!client.includes('addEventListener("visibilitychange", function')).toBeTruthy();
  });

  it("#469：产物 disposer 含 visibilitychange 移除", () => {
    expect(client.includes('removeEventListener("visibilitychange",')).toBeTruthy();
  });

  it("#469：产物 add/remove visibilitychange 引用同一具名 handler", () => {
    // 具名注册与移除必须引用同一 handler 标识符（esbuild 重命名后 add/remove 同源）
    const reg = client.match(/document\.addEventListener\("visibilitychange",\s*([A-Za-z_$][\w$]*)/);
    const rem = client.match(/document\.removeEventListener\("visibilitychange",\s*([A-Za-z_$][\w$]*)/);
    expect(reg && rem && reg[1] === rem[1]).toBeTruthy();
  });

  it("#469 P2：产物 removeEventListener(visibilitychange) 位于 disposer（effect 返回函数）内", () => {
    // P2-①：remove 必须位于 disposer（ctx.effect 返回函数）内——取 effect 返回函数
    // 体做结构定位，remove 不得出现在 apply 直落路径（防「注册配对但清理不在卸载期」）。
    const effectRet = client.match(/ctx\.effect\(function\(\)\s*\{\s*return function\(\)\s*\{([\s\S]*?)\n\s*\}\s*;\s*\}\s*,/);
    expect(effectRet && effectRet[1].includes('removeEventListener("visibilitychange",')).toBeTruthy();
  });

  it("#469 P1-1：产物 disposer 内含 restoreTitle()（卸载即恢复标题）", () => {
    const effectRet = client.match(/ctx\.effect\(function\(\)\s*\{\s*return function\(\)\s*\{([\s\S]*?)\n\s*\}\s*;\s*\}\s*,/);
    expect(effectRet && effectRet[1].includes("restoreTitle()")).toBeTruthy();
  });

  it("#469 P1-2：产物 disposer unsubLocale 守卫为 undefined 形态", () => {
    // unsubLocale 守卫为 undefined 形态（P1-2：对齐 provider-usage 范式，防
    // locale.subscribe 返回 null 时守卫失效——产物 null 折叠为 null 字面量需双形态）
    const effectRet = client.match(/ctx\.effect\(function\(\)\s*\{\s*return function\(\)\s*\{([\s\S]*?)\n\s*\}\s*;\s*\}\s*,/);
    expect(effectRet && /unsubLocale\s*!==\s*(?:void 0|undefined|null)/.test(effectRet[1])).toBeTruthy();
  });
});

// ---- #405：客户端保存模型演进源码级契约锚点 ----
describe("#405：客户端保存模型源码锚点", () => {
  let src: string;
  let locales: string;

  beforeAll(() => {
    src = readSrc();
    locales = readLocales();
  });

  it("#405：confirmOne 读取响应新 revision", () => {
    // confirmOne 同步服务端 revision（修「确认 kind 后同窗口保存必 409」版本链断点）
    expect(src.includes("freshRevision")).toBeTruthy();
  });

  it("#405：confirmOne 同步 metaRef.revision", () => {
    expect(src.includes("metaRef.current = nextMeta")).toBeTruthy();
  });

  it("#405：频道 tab 域保存行 class（TSX 形态）", () => {
    // 频道域保存行（新 class，非回归的 dn-ch-saveRow）+ 域入口
    expect(src.includes('className="dn-ch-domainSave"')).toBeTruthy();
  });

  it("#405：域保存走 channels 入口", () => {
    expect(src.includes('saveFor("channels")')).toBeTruthy();
  });

  it("#405：foot 保存走 all 入口", () => {
    expect(src.includes('saveFor("all")')).toBeTruthy();
  });

  it("#405：409 冲突横幅 class 进源码", () => {
    expect(src.includes("dn-conflict")).toBeTruthy();
  });

  it("#405：冲突覆盖动作文案进 zh/en 字典", () => {
    expect(locales.includes("conflictOverwrite:")).toBeTruthy();
  });

  it("#405：域保存按钮文案进 zh/en 字典", () => {
    expect(locales.includes("saveChannels:")).toBeTruthy();
  });
});

// ---- #527：未启用频道/事件 chips 置灰禁点（通知事件路由 + 免打扰豁免）----
describe("#527：未启用 chips 置灰禁点锚点", () => {
  let src: string;
  let locales: string;
  let css: string;
  let client: string;

  beforeAll(() => {
    src = readSrc();
    locales = readLocales();
    css = readCss();
    client = readClient();
  });

  it("#527：路由候选带实例频道 enabled 标志", () => {
    // 1. 路由 chips：routeOptions 带 enabled 标志；未启用 chip 渲染 disabled + is-off
    expect(src.includes("enabled: c.enabled === true")).toBeTruthy();
  });

  it("#527：内置频道 enabled 判定跟随开关", () => {
    expect(src.includes("enabled: prev.browserNotify === true") && src.includes("enabled: prev.systemNotify === true")).toBeTruthy();
  });

  it("#527：未启用路由 chip 原生 disabled 禁点（TSX 形态）", () => {
    expect(src.includes("disabled={!o.enabled}")).toBeTruthy();
  });

  it("#527：未启用路由 chip 带 is-off 弱化 class", () => {
    expect(src.includes('" is-off"') && src.includes('"dn-route-chip"')).toBeTruthy();
  });

  it("#527：路由未启用 title 提示引用文案键", () => {
    expect(src.includes("routeDisabledHint")).toBeTruthy();
  });

  it("#527：未启用豁免事件 chip 原生 disabled 禁点（TSX 形态）", () => {
    // 2. 免打扰豁免 chips：未启用事件 disabled 禁点（保留 dn-set-allowDim 弱化）
    expect(src.includes("disabled={!c.enabled}")).toBeTruthy();
  });

  it("#527：#421 弱化样式保留（与 disabled 叠加）", () => {
    expect(src.includes("dn-set-allowDim")).toBeTruthy();
  });

  it("#527：routeDisabledHint 中文文案", () => {
    // 3. 文案键双语 + 产物
    expect(locales.includes('routeDisabledHint: "频道未启用：先在上方「通知频道」启用后才能配置投递"')).toBeTruthy();
  });

  it("#527：routeDisabledHint 英文文案", () => {
    expect(locales.includes("routeDisabledHint: \"Channel not enabled")).toBeTruthy();
  });

  it("#527：置灰逻辑与文案键进产物", () => {
    expect(client.includes("is-off") && client.includes("routeDisabledHint")).toBeTruthy();
  });

  it("#527：is-off 置灰样式进 CSS", () => {
    expect(css.includes("dn-route-chip.is-off")).toBeTruthy();
  });
});

// ---- #640/#641：每通道声音 UI（帧级 sound / 三态 / 声音行 / 试听 / 弃写锚）----
describe("#640/#641：每通道声音 UI 锚点", () => {
  let src: string;
  let locales: string;
  let css: string;
  let client: string;

  beforeAll(() => {
    src = readSrc();
    locales = readLocales();
    css = readCss();
    client = readClient();
  });

  it('#640/A5：客户端源码不再有 switchControl("notifySound")', () => {
    // A5：UI 不再写全局 notifySound（废弃只读别名）——产物不得含旧声音行开关
    expect(!src.includes('switchControl("notifySound"')).toBeTruthy();
  });

  it('#640/A5：产物不含 switchControl("notifySound")', () => {
    expect(!client.includes('switchControl("notifySound"')).toBeTruthy();
  });

  it("#640：browser 卡接 browserSound", () => {
    // 新声音行走 browserSound/systemSound 键
    expect(src.includes('builtinCard("browserNotify", "browserSound"')).toBeTruthy();
  });

  it("#640：system 卡接 systemSound", () => {
    expect(src.includes('builtinCard("systemNotify", "systemSound"')).toBeTruthy();
  });

  it("#640/C1：帧级 sound 传入 showNotification（取代布尔快照）", () => {
    // C1：帧级 sound 权威——showNotification 吃帧内 sound 策略对象
    expect(src.includes("showNotification(payload.kind, payload.title, payload.message, { sound: payload.sound")).toBeTruthy();
  });

  it("#640/C1：只响不弹 playOnly 帧标记", () => {
    expect(src.includes("playOnly: payload.playOnly === true")).toBeTruthy();
  });

  it("#640/C2：统一播放节流函数", () => {
    // C2：统一播放节流覆盖全部自播（playGate）+ 多标签租约前置（claimMaster 先于自播）
    expect(src.includes("function playGate()")).toBeTruthy();
  });

  it("#640/C2：自播路径统一过 playGate", () => {
    expect(src.includes("if (selfPlay && playGate()) playTone(tone)")).toBeTruthy();
  });

  it("#640/C3：仅声音半启用态 class", () => {
    // C3：builtinCard 三态（状态徽标 + dn-ch-sound 半启用类 + open = on || soundOn）
    expect(src.includes("dn-ch-sound")).toBeTruthy();
  });

  it("#640/C3：卡展开条件 = 弹窗开 || 声音开", () => {
    expect(src.includes("open={on || soundOn}")).toBeTruthy();
  });

  it("#640/C3：仅声音状态文案键引用", () => {
    expect(src.includes("chStateSound")).toBeTruthy();
  });

  it("#640/C6：试听按钮 class", () => {
    // C5/C6：试听按钮 + 音色下拉 + 显式 unlockAudio；4 音色选项
    expect(src.includes("dn-tonePreview")).toBeTruthy();
  });

  it("#640/C6：试听调用 playPreview", () => {
    expect(src.includes("playPreview(")).toBeTruthy();
  });

  it("#640/C6：客户端 SOUND_IDS 4 音色（与服务端同源复制）", () => {
    expect(src.includes('"ding", "bell", "chime", "pop"')).toBeTruthy();
  });

  it("#640/C5：声音交互显式 unlockAudio（含试听）", () => {
    expect(src.includes("unlockAudio()")).toBeTruthy();
  });

  it("#640/C7：宿主平台状态（/health platform 拉取）", () => {
    // C7：宿主平台提示消费 /health platform
    expect(src.includes("hostPlatform")).toBeTruthy();
  });

  it("#640/C7：三平台提示文案键", () => {
    expect(src.includes("sysPlatformWin") && src.includes("sysPlatformMac") && src.includes("sysPlatformLinux")).toBeTruthy();
  });

  it("#640：跟随系统默认文案双语", () => {
    // 文案双语 + 产物锚点
    expect(locales.includes('chSoundFollow: "跟随系统默认"') && locales.includes('chSoundFollow: "Follow system default"')).toBeTruthy();
  });

  it("#640：音色文案双语", () => {
    expect(locales.includes('toneDing: "叮（Ding）"') && locales.includes("toneDing: \"Ding\"")).toBeTruthy();
  });

  it("#640：平台提示双语存在", () => {
    expect(locales.includes("sysPlatformLinux:") && locales.includes("sysPlatformLinux:")).toBeTruthy();
  });

  it("#640：三态与试听 class 进产物", () => {
    expect(client.includes("dn-ch-sound") && client.includes("dn-tonePreview")).toBeTruthy();
  });

  it("#640：三态与试听样式进 CSS", () => {
    expect(css.includes("dn-ch-sound") && css.includes("dn-tonePreview")).toBeTruthy();
  });
});
