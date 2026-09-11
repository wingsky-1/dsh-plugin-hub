// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — contract：vm 沙箱执行真实产物 lib/client.js 的行为级验收。
 *
 * 覆盖：#469 apply/dispose 生命周期（visibilitychange 监听与 locale 订阅配对）、
 * #470 P1-2 diffSettingsPayload 真链 + #614 channels 空串剥除（assignChannelFields
 * / stripChannelEmpties）、#405 createSaveGuard/domainPayload/rebaseSettings 直测、
 * #640 帧级 sound 决策面（silent/playOnly/system）、P1-1 playOnly 帧驱动真实自播、
 * S3-12 clampMaxConnections 真产物直测。
 *
 * 拆法：与 client-contract.test.ts（字符串级源码/产物锚点）按观测面拆分；
 * 形态纪律：保持「读 lib 产物字符串 + vm 执行」形态（验证的正是构建产物），
 * 不改为直连 src/client/**；前置条件是 `pnpm build` 已产出 lib/。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const readClient = () => readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");

/** 通用 vm 沙箱装载：返回 load 注入的 factory 与沙箱句柄。 */
function loadFactory(sandbox: Record<string, unknown>) {
  sandbox.window = sandbox;
  let loadedFactory: any = null;
  (sandbox.window as any).__ModuleLoader__ = { load(handoff: any) { loadedFactory = handoff.factory; } };
  vm.createContext(sandbox);
  vm.runInContext(readClient(), sandbox);
  return () => loadedFactory;
}

/** 最小沙箱（document/localStorage/EventSource/Notification 全 no-op）。 */
function minimalSandbox() {
  return {
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
}

/** 最小沙箱 + materialize + 跑一次 apply（挂载模块级纯函数），返回挂载面与 mod。 */
function materializeMinimal() {
  const getFactory = loadFactory(minimalSandbox());
  const loadedFactory = getFactory();
  const mod = loadedFactory((spec: string) => {
    if (spec === "react") return { createElement: () => ({}) };
    throw new Error(`unexpected require: ${spec}`);
  });
  const disposers: Array<() => void> = [];
  mod.apply({
    get() { return undefined; },
    effect(fn) { const d = fn(); disposers.push(d); return d; },
  });
  return { loadedFactory, mod, disposers };
}

// ---- #469：vm 沙箱执行真实产物：事件计数级验收 ----
describe("#469 vm 沙箱：apply/dispose 生命周期事件计数验收", () => {
  let c: Record<string, any>;

  beforeAll(() => {
    const PKG = "@wingsky-1/dsh-notifier";
    // 最小 document stub：对 add/removeEventListener 记账；其余惰性 no-op。
    // listenerCounts 按事件类型计数（remove 才减）——浏览器语义近似，足以断言
    // 「重复 apply 后仅一份」「disposer 后归零」且不依赖真 DOM。
    const byType = new Map<string, Set<() => void>>();
    const listeners = {
      addEventListener(type: string, fn: () => void) { let s = byType.get(type); if (!s) { s = new Set(); byType.set(type, s); } s.add(fn); },
      removeEventListener(type: string, fn: () => void) { const s = byType.get(type); if (s) s.delete(fn); },
    };
    const styleEl = { id: "", textContent: "", dataset: {}, remove() {} };
    const documentStub: any = {
      ...listeners,
      visibilityState: "visible",
      title: "",
      hidden: false,
      getElementById() { return null; }, // injectStyle：无旧 style → 新建
      createElement(tag: string) {
        if (tag === "style") return styleEl;
        // 其它标签（banner 等）惰性 no-op
        return { appendChild() {}, remove() {}, set textContent(_v: string) {}, style: {}, dataset: {} };
      },
      head: { appendChild() {} },
      body: { appendChild() {} },
    };
    // EventSource stub：实例可赋 handler/close；每次构造/close 计数供可见重建断言。
    // 实例列表供测试手动投递 notify 帧（驱动 flashTitle 降级链）。
    let sourceCount = 0;
    let closeCount = 0;
    const sources: Array<{ onmessage: ((ev: { data: string }) => void) | null }> = [];
    class EventSourceStub {
      onmessage: ((ev: { data: string }) => void) | null;
      onerror: (() => void) | null;
      onopen: (() => void) | null;
      constructor() { sourceCount += 1; this.onmessage = null; this.onerror = null; this.onopen = null; sources.push(this); }
      close() { closeCount += 1; }
    }
    const fakeReact = { createElement: () => ({}) };
    const warnings: string[] = [];
    const storage = new Map<string, string>();
    const sandbox: any = {
      console: { ...console, warn: (...a: unknown[]) => warnings.push(a.join(" ")) },
      Symbol, Object, Array, JSON, Math, Date, Promise,
      setTimeout, clearTimeout,
      EventSource: EventSourceStub,
      Notification: function () {},
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
      document: documentStub,
      localStorage: {
        getItem: (k: string) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k: string, v: string) => storage.set(k, String(v)),
        removeItem: (k: string) => storage.delete(k),
      },
    };
    sandbox.window = sandbox;
    let loadedFactory: any = null;
    sandbox.window.__ModuleLoader__ = {
      load(handoff: any) {
        if (handoff.id !== PKG) throw new Error(`unexpected load id: ${handoff.id}`);
        loadedFactory = handoff.factory;
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(readClient(), sandbox);
    c = {};
    c.loaded = loadedFactory !== null;

    // materialize（同 client-contract-lib）：factory(require stub) → module.exports
    const mod = loadedFactory((spec: string) => {
      if (spec === "react") return fakeReact;
      throw new Error(`unexpected require: ${spec}`);
    });
    c.applyType = typeof mod.apply;

    // 卸载-重挂序列（宿主生命周期：旧实例 disposer 先于新 apply）：
    // apply1 → 监听 1；dispose1 → 0；apply2 → 1（重复 apply 后仅一份）；dispose2 → 0。
    // 监听注册/移除与 apply/disposer 严格配对，任意时刻至多一份。
    const disposers: Array<() => void> = [];
    // locale 服务记账：subscribe 返回取消函数，调用计数 +1；重绑回调被调用计数。
    let localeSubscribes = 0;
    let localeUnsubs = 0;
    const makeLocale = () => ({
      register() {},
      bind() { return () => ""; },
      getSnapshot() { return {}; },
      subscribe() { localeSubscribes += 1; return () => { localeUnsubs += 1; }; },
    });
    const makeCtx = (opts: any = {}) => ({
      get(name: string) {
        if (name === "locale" && opts.locale) return opts.locale;
        // 无 locale/slots 服务：字典注册/tab 挂载跳过（通知半区照常）
        return undefined;
      },
      effect(fn: () => () => void) {
        const d = fn();
        disposers.push(d);
        return d;
      },
    });
    const visCount = () => (byType.get("visibilitychange") || new Set()).size;

    mod.apply(makeCtx({ locale: makeLocale() }));
    c.afterApply1Vis = visCount();
    c.afterApply1Subs = localeSubscribes;
    disposers.shift()!();
    c.afterDispose1Vis = visCount();
    c.afterDispose1Unsubs = localeUnsubs;

    // 重复 apply（宿主热更/重挂载：旧实例已卸）→ 仍只一份，不累积
    mod.apply(makeCtx({ locale: makeLocale() }));
    c.afterApply2Vis = visCount();
    c.afterApply2Subs = localeSubscribes;
    c.afterApply2Unsubs = localeUnsubs;
    c.afterApply2Disposers = disposers.length;

    // 触发可见事件：监听应作用于当前句柄（重建 SSE——source 计数增加且旧源被关）。
    // 先显式翻转 visibilityState="hidden" → "visible"（不依赖 stub 默认值巧合）。
    const sourcesBefore = sourceCount;
    documentStub.visibilityState = "hidden";
    documentStub.title = "原始标题";
    documentStub.visibilityState = "visible";
    for (const fn of byType.get("visibilitychange") || []) fn();
    c.sseRebuilt = sourceCount > sourcesBefore;
    c.oldSourceClosed = closeCount >= sourcesBefore;

    // P1-1 回归直测：hidden 后台收到 notify 帧 → flashTitle 置闪烁标题 → disposer
    // 卸载必须 restoreTitle（标题恢复 + savedTitle 缓存清除）——不能等
    // visibilitychange 触发（监听已被 disposer 摘除，标题会永久卡死 = 评审复现）。
    // 当前活跃实例 = 最后创建的 source（apply2 的 disposer 尚未执行、其 SSE 未关）。
    const activeSource = sources[sources.length - 1];
    documentStub.visibilityState = "hidden";
    documentStub.title = "原始标题";
    c.onmessageType = typeof activeSource.onmessage;
    activeSource.onmessage!({ data: JSON.stringify({ type: "notify", kind: "done", title: "T", message: "m", seq: 1 }) });
    c.titleFlashed = documentStub.title.startsWith("🔔");
    // 卸载当前实例 → 监听归零 + 标题恢复（disposer restoreTitle）
    disposers.shift()!();
    c.afterDispose2Vis = visCount();
    c.afterDispose2Unsubs = localeUnsubs;
    c.titleRestored = documentStub.title;
    // disposer 幂等：二次调用不报错、标题仍恢复态、监听仍零
    for (const d of disposers.splice(0)) d();
    c.afterDoubleDisposeVis = visCount();
    c.afterDoubleDisposeTitle = documentStub.title;
  });

  it("#469：产物 load 已注册 factory", () => {
    expect(c.loaded).toBe(true);
  });

  it("#469：materialize 后 exports.apply 为函数", () => {
    expect(c.applyType).toBe("function");
  });

  it("#469：首次 apply 后 visibilitychange 监听一份", () => {
    expect(c.afterApply1Vis).toBe(1);
  });

  it("#469：首次 apply 建立一条 locale 订阅", () => {
    expect(c.afterApply1Subs).toBe(1);
  });

  it("#469：disposer 卸载后监听归零", () => {
    expect(c.afterDispose1Vis).toBe(0);
  });

  it("#469：disposer 卸载取消 locale 订阅", () => {
    expect(c.afterDispose1Unsubs).toBe(1);
  });

  it("#469：重复 apply 后 visibilitychange 监听仅一份", () => {
    expect(c.afterApply2Vis).toBe(1);
  });

  it("#469：重复 apply 建立新订阅", () => {
    expect(c.afterApply2Subs).toBe(2);
  });

  it("#469：旧订阅已取消、无残留重绑", () => {
    expect(c.afterApply2Unsubs).toBe(1);
  });

  it("#469：重复 apply 只新增一个 disposer", () => {
    expect(c.afterApply2Disposers).toBe(1);
  });

  it("#469：可见事件触发 SSE 重建（监听仍活）", () => {
    expect(c.sseRebuilt).toBe(true);
  });

  it("#469：重建前旧 SSE 句柄已关（不操作已置 null 句柄）", () => {
    expect(c.oldSourceClosed).toBe(true);
  });

  it("#469 P1-1：当前 SSE 实例已接 onmessage（可投递通知帧）", () => {
    expect(c.onmessageType).toBe("function");
  });

  it("#469 P1-1：hidden 帧驱动 flashTitle 后标题为闪烁态", () => {
    expect(c.titleFlashed).toBe(true);
  });

  it("#469：disposer 卸载后 visibilitychange 监听归零", () => {
    expect(c.afterDispose2Vis).toBe(0);
  });

  it("#469：两次实例的 locale 订阅全部取消", () => {
    expect(c.afterDispose2Unsubs).toBe(2);
  });

  it("#469 P1-1：disposer 卸载 restoreTitle 恢复标题（评审复现：卸载后标题卡死）", () => {
    expect(c.titleRestored).toBe("原始标题");
  });

  it("#469：disposer 二次调用后仍无监听", () => {
    expect(c.afterDoubleDisposeVis).toBe(0);
  });

  it("#469 P1-1：disposer 二次调用标题不复发闪烁", () => {
    expect(c.afterDoubleDisposeTitle).toBe("原始标题");
  });
});

// ---- 复核 P1-2：client diffSettingsPayload 真实产物直测 ----
// 用 vm materialize 出的 mod.apply.diffSettingsPayload（apply 挂载的模块级纯函数）
// 验证「真链」：以 GET effective（含未知键）为基线 → 只改已知键 → diff 不含
// 未知键 →（PUT 行为在 routes 域测试全链断言）。不再允许测试手写近似 diff。
describe("#470 P1-2 / #614：diffSettingsPayload 与 channels 空串剥除真链", () => {
  let c: Record<string, any>;

  beforeAll(() => {
    const { loadedFactory, mod, disposers: disposers2 } = materializeMinimal();
    c = { loaded: loadedFactory !== null, applyType: typeof mod.apply };
    const diffFn = mod.apply.diffSettingsPayload;
    c.diffType = typeof diffFn;
    for (const d of disposers2.splice(0)) d();

    // 基线含未知键：只改已知键 → payload 仅含变更已知键（不含未知键）
    const effective = { notifyTaskDone: true, notifyAsk: true, futureKey: { k: 1 }, quietHours: { enabled: false, start: "22:00", end: "08:00" } };
    const settingsView = JSON.parse(JSON.stringify(effective));
    settingsView.notifyTaskDone = false;
    const payload = diffFn(settingsView, effective);
    // vm 沙箱 realm 对象原型与测试 realm 不同，deepStrictEqual 跨 realm 不等——用
    // JSON 归一比对（diff 语义本就 JSON 序列化级）
    c.payload = JSON.parse(JSON.stringify(payload));

    // 未知键值被 UI 改动 → diff 会包含它（未来 UI 编辑未知键时透传可写）
    const view2 = JSON.parse(JSON.stringify(effective));
    view2.futureKey = { k: 2 };
    c.payload2 = JSON.parse(JSON.stringify(diffFn(view2, effective)));

    // 全等 → 空 payload（save 判定 unchanged）
    c.payloadEqual = JSON.parse(JSON.stringify(diffFn(JSON.parse(JSON.stringify(effective)), effective)));

    // baseline 为 null（加载未完成）→ 空 payload（不误存）
    c.payloadNullBaseline = JSON.parse(JSON.stringify(diffFn(settingsView, null)));

    // ---- #614：channels 提交面空串可选字段剥除（真产物直测）----
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
    c.strippedHasChannels = stripped.channels !== undefined;
    c.strippedChannels = JSON.stringify(stripped.channels);

    // 无空串的常规 diff 不受影响（strip 幂等，非空全保留）
    const clean = { channels: [{ id: "webhook-1", type: "webhook", url: "https://ntfy.sh/t", auth: "none", enabled: false }] };
    const cleanEdited = JSON.parse(JSON.stringify(clean));
    cleanEdited.channels[0].enabled = true;
    c.cleanChannels = JSON.stringify(diffFn(cleanEdited, clean).channels);
    c.cleanExpected = JSON.stringify(cleanEdited.channels);

    // 防御：channels 含非对象成员（null/字符串）不炸、原样透传（服务端校验兜底）
    const junk = { channels: [null, "x"] };
    const junkEdited = JSON.parse(JSON.stringify(junk));
    junkEdited.channels[1] = "y";
    c.junkChannels = JSON.stringify(diffFn(junkEdited, junk).channels);

    // 纯函数直测：assignChannelFields（空串/undefined 删键）与 stripChannelEmpties
    const assignFn = mod.apply.assignChannelFields;
    const stripFn = mod.apply.stripChannelEmpties;
    c.assignType = typeof assignFn;
    c.stripType = typeof stripFn;
    // 空串输入 → 删键（清空 token 输入框 = 回到未配置态）
    c.emptyTokenIn = "token" in assignFn({ id: "w", token: "old" }, { token: "" });
    // undefined 输入 → 删键（bark level 清除路径传 undefined）
    c.undefLevelIn = "level" in assignFn({ id: "b", level: "critical" }, { level: undefined });
    // 非空值正常覆盖；无关键不新增
    c.assigned = JSON.stringify(assignFn({ id: "w", token: "old", auth: "none" }, { token: "new", url: "" }));
    // stripChannelEmpties：剥空串可选键（url 属 bark 可选位），非对象原样
    c.stripStr = JSON.stringify(stripFn({ id: "w", url: "", token: "", name: "n", enabled: false }));
    c.stripNull = stripFn(null);
  });

  it("#470 P1-2：产物 load 已注册 factory", () => {
    expect(c.loaded).toBe(true);
  });

  it("#470 P1-2：materialize 后 exports.apply 为函数", () => {
    expect(c.applyType).toBe("function");
  });

  it("#470 P1-2：apply 挂载 diffSettingsPayload 纯函数", () => {
    expect(c.diffType).toBe("function");
  });

  it("#470 P1-2：diff 只含变更已知键（不含未知键 futureKey）", () => {
    expect(c.payload).toEqual({ notifyTaskDone: false });
  });

  it("#470 P1-2：diff 含改动未知键（PUT 可透传写入）", () => {
    expect(c.payload2).toEqual({ futureKey: { k: 2 } });
  });

  it("#470 P1-2：全等基线 diff 为空", () => {
    expect(c.payloadEqual).toEqual({});
  });

  it("#470 P1-2：baseline null → 空 payload", () => {
    expect(c.payloadNullBaseline).toEqual({});
  });

  it("#614：channels 变更整组入 diff", () => {
    expect(c.strippedHasChannels).toBe(true);
  });

  it("#614：空串可选字段剥除、非空值与必填字段保留", () => {
    expect(c.strippedChannels).toBe(JSON.stringify([
      { id: "webhook-1", type: "webhook", url: "https://ntfy.sh/t", auth: "bearer", token: "tk614", enabled: true },
      { id: "bark-1", type: "bark", baseUrl: "https://api.day.app", deviceKey: "k614", enabled: false },
    ]));
  });

  it("#614：无空串形态 diff 原样通过", () => {
    expect(c.cleanChannels).toBe(c.cleanExpected);
  });

  it("#614：非对象成员原样透传不炸", () => {
    expect(c.junkChannels).toBe(JSON.stringify([null, "y"]));
  });

  it("#614：apply 挂载 assignChannelFields", () => {
    expect(c.assignType).toBe("function");
  });

  it("#614：apply 挂载 stripChannelEmpties", () => {
    expect(c.stripType).toBe("function");
  });

  it("#614：空串输入删键", () => {
    expect(c.emptyTokenIn).toBe(false);
  });

  it("#614：undefined 输入删键", () => {
    expect(c.undefLevelIn).toBe(false);
  });

  it("#614：非空覆盖 + 空串 url 删键（不存在则不新增）", () => {
    expect(c.assigned).toBe(JSON.stringify({ id: "w", token: "new", auth: "none" }));
  });

  it("#614：strip 剥可选空串（含 url）", () => {
    expect(c.stripStr).toBe(JSON.stringify({ id: "w", name: "n", enabled: false }));
  });

  it("#614：strip 非对象输入原样返回", () => {
    expect(c.stripNull).toBe(null);
  });
});

// ---- #405：client createSaveGuard（保存串行）真实产物直测 ----
// 同一时刻仅一个在途保存（tryBegin 在途返回 false 不占用）；在途期间的再次点击
// 记 pending，由 end() 返回 true 通知调用方补发一次；end 幂等释放、无 pending 时
// 返回 false（不产生补发风暴）。guard 是模块级纯工厂（无 React 依赖），经
// apply 挂载面直测——「测试即产品实现」。
describe("#405：createSaveGuard / domainPayload / rebaseSettings 真产物直测", () => {
  let c: Record<string, any>;

  beforeAll(() => {
    const { loadedFactory, mod, disposers: disposers3 } = materializeMinimal();
    c = { loaded: loadedFactory !== null };
    const guardFactory = mod.apply.createSaveGuard;
    const domainFn = mod.apply.domainPayload;
    const rebaseFn = mod.apply.rebaseSettings;
    c.guardType = typeof guardFactory;
    c.domainType = typeof domainFn;
    c.rebaseType = typeof rebaseFn;
    for (const d of disposers3.splice(0)) d();

    // rebaseSettings：键级 last-write-wins——最新 effective 为基底，本地变更键覆盖；
    // 远端新键保留、本地未改键取远端值
    c.rebase1 = JSON.parse(JSON.stringify(rebaseFn(
      { notifyAsk: false, channels: [1] },
      { notifyAsk: true, notifySound: true, channels: [9], kindRoutes: { ask: ["browser"] } },
    )));
    c.rebase2 = JSON.parse(JSON.stringify(rebaseFn({}, { notifyAsk: true })));

    // domainPayload：域过滤语义——channels 域只提 channels 键；
    // all 原样；未知入口空对象
    c.domainChannels = JSON.parse(JSON.stringify(domainFn({ channels: [1], notifyAsk: false, quietHours: {} }, "channels")));
    c.domainChannelsEmpty = JSON.parse(JSON.stringify(domainFn({ notifyAsk: false }, "channels")));
    c.domainAll = JSON.parse(JSON.stringify(domainFn({ channels: [1], notifyAsk: false }, "all")));
    c.domainUnknown = JSON.parse(JSON.stringify(domainFn({ channels: [1] }, "unknown")));

    // 1. 单飞行：首次占用成功；在途期间再 tryBegin 返回 false（记 pending），不占用
    const g1 = guardFactory();
    c.g1Idle0 = g1.isBusy();
    c.g1Begin = g1.tryBegin("all");
    c.g1Busy = g1.isBusy();
    c.g1BeginAgain = g1.tryBegin("all");
    c.g1BusyAfterReject = g1.isBusy();

    // 2. trailing 补发入口：在途期间积累过点击 → end() 返回该入口（应同入口补发一次）
    c.g1End = g1.end();
    c.g1IdleAfterEnd = g1.isBusy();

    // 3. 无 pending：end 返回 null（不产生补发/风暴）
    const g2 = guardFactory();
    c.g2Begin = g2.tryBegin("all");
    c.g2End = g2.end();

    // 4. 域入口保真：被拒的是 "channels" → end 返回 "channels"（域保存不被升级成全量）
    const g3 = guardFactory();
    g3.tryBegin("all");
    c.g3Reject = g3.tryBegin("channels");
    c.g3End = g3.end();
    c.g3End2 = g3.end();
    c.g3Idle = g3.isBusy();

    // 5. 多次不同入口点击：记最后一次意图
    const g4 = guardFactory();
    g4.tryBegin("all");
    g4.tryBegin("channels");
    g4.tryBegin("all");
    c.g4End = g4.end();
    c.g4End2 = g4.end();
  });

  it("#405：产物 load 已注册 factory", () => {
    expect(c.loaded).toBe(true);
  });

  it("#405：apply 挂载 createSaveGuard 纯工厂", () => {
    expect(c.guardType).toBe("function");
  });

  it("#405：apply 挂载 domainPayload 纯函数", () => {
    expect(c.domainType).toBe("function");
  });

  it("#405：apply 挂载 rebaseSettings 纯函数", () => {
    expect(c.rebaseType).toBe("function");
  });

  it("#405：rebase 键级合并——本地变更覆盖、远端未冲突键保留", () => {
    expect(c.rebase1).toEqual({ notifyAsk: false, notifySound: true, channels: [1], kindRoutes: { ask: ["browser"] } });
  });

  it("#405：无本地变更 → rebase 结果即远端最新", () => {
    expect(c.rebase2).toEqual({ notifyAsk: true });
  });

  it("#405：channels 域只提交 channels 键（事件/参数草稿不随域保存提交）", () => {
    expect(c.domainChannels).toEqual({ channels: [1] });
  });

  it("#405：无 channels 变更时 channels 域提交为空", () => {
    expect(c.domainChannelsEmpty).toEqual({});
  });

  it("#405：all 入口原样全量提交", () => {
    expect(c.domainAll).toEqual({ channels: [1], notifyAsk: false });
  });

  it("#405：未知入口保守返回空（不提交）", () => {
    expect(c.domainUnknown).toEqual({});
  });

  it("#405：初始空闲", () => {
    expect(c.g1Idle0).toBe(false);
  });

  it("#405：首次 tryBegin 占用成功", () => {
    expect(c.g1Begin).toBe(true);
  });

  it("#405：占用后在途", () => {
    expect(c.g1Busy).toBe(true);
  });

  it("#405：在途期间 tryBegin 被拒（单飞行）", () => {
    expect(c.g1BeginAgain).toBe(false);
  });

  it("#405：被拒不改变在途态", () => {
    expect(c.g1BusyAfterReject).toBe(true);
  });

  it("#405：在途期间有 pending → end 返回补发入口", () => {
    expect(c.g1End).toBe("all");
  });

  it("#405：end 后释放空闲", () => {
    expect(c.g1IdleAfterEnd).toBe(false);
  });

  it("#405：g2 占用成功", () => {
    expect(c.g2Begin).toBe(true);
  });

  it("#405：无 pending → end 返回 null（不补发）", () => {
    expect(c.g2End).toBe(null);
  });

  it("#405：在途期间域保存被拒", () => {
    expect(c.g3Reject).toBe(false);
  });

  it("#405：end 返回最后一次被拒入口 channels", () => {
    expect(c.g3End).toBe("channels");
  });

  it("#405：再次 end（无 pending）返回 null", () => {
    expect(c.g3End2).toBe(null);
  });

  it("#405：重复 end 幂等释放", () => {
    expect(c.g3Idle).toBe(false);
  });

  it("#405：多次被拒记最后一次入口", () => {
    expect(c.g4End).toBe("all");
  });

  it("#405：清空后再 end 返回 null", () => {
    expect(c.g4End2).toBe(null);
  });
});

// ---- #640/#641：vm 沙箱真链——帧级 sound 驱动自播/静音（C1/C4 行为层）----
describe("#640 vm：帧级 sound 决策面（silent / playOnly / system）", () => {
  let c: Record<string, any>;

  beforeAll(() => {
    const byType = new Map<string, Set<() => void>>();
    const listeners = {
      addEventListener(type: string, fn: () => void) { let s = byType.get(type); if (!s) { s = new Set(); byType.set(type, s); } s.add(fn); },
      removeEventListener(type: string, fn: () => void) { const s = byType.get(type); if (s) s.delete(fn); },
    };
    const documentStub: any = {
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
    const notifSilent: boolean[] = [];
    const sources: Array<{ onmessage: ((ev: { data: string }) => void) | null }> = [];
    class EventSourceStub {
      onmessage: ((ev: { data: string }) => void) | null;
      onerror: (() => void) | null;
      constructor() { sourceCount += 1; this.onmessage = null; this.onerror = null; sources.push(this); }
      close() {}
    }
    const sandbox: any = {
      console: { ...console, warn: () => {} },
      Symbol, Object, Array, JSON, Math, Date, Promise,
      setTimeout, clearTimeout,
      EventSource: EventSourceStub,
      Notification: Object.assign(function (this: { close: () => void }, title: string, opts: { silent?: boolean }) { notifCount += 1; notifSilent.push(opts.silent === true); this.close = () => {}; }, { permission: "granted" }),
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
      document: documentStub,
      localStorage: { getItem: (k: string) => null, setItem: () => {}, removeItem: () => {} },
    };
    sandbox.window = sandbox;
    sandbox.isSecureContext = true;
    const getFactory = loadFactory(sandbox);
    const mod = getFactory()((spec: string) => {
      if (spec === "react") return { createElement: () => ({}) };
      throw new Error(`unexpected require: ${spec}`);
    });
    const disposers: Array<() => void> = [];
    mod.apply({
      get() { return undefined; },
      effect(fn) { const d = fn(); disposers.push(d); return d; },
    });
    const activeSource = sources[sources.length - 1];
    // AudioContext stub：沙箱 window.AudioContext 缺失 → unlockAudio 静默失败 → playTone
    // 空转（沙箱无音频）；此处只验证「帧级 sound 不弹 + silent 标记」决策面。
    let seq = 0;
    const deliver = (payload: Record<string, unknown>) => { seq += 1; activeSource.onmessage!({ data: JSON.stringify({ type: "notify", seq, ...payload }) }); };
    c = {};
    // 弹窗帧 + sound silent：仍弹实体（silent=true），不自播（沙箱无声无妨）
    deliver({ kind: "done", title: "T", message: "m", sound: { mode: "silent", tone: undefined } });
    c.silentNotifCount = notifCount;
    c.silentFlag = notifSilent[0];
    // playOnly 帧：不弹实体（只响不弹）
    deliver({ kind: "done", title: "T", message: "m", playOnly: true, sound: { mode: "selfplay", tone: "pop" } });
    c.playOnlyNotifCount = notifCount;
    // system 模式帧：弹且不 silent（交给 OS 发声）
    deliver({ kind: "done", title: "T", message: "m", sound: { mode: "system", tone: undefined } });
    c.systemNotifCount = notifCount;
    c.systemSilentFlag = notifSilent[1];
    for (const d of disposers.splice(0)) d();
  });

  it("#640：silent 帧仍弹系统通知实体", () => {
    expect(c.silentNotifCount).toBe(1);
  });

  it("#640：silent 帧 → Notification silent:true", () => {
    expect(c.silentFlag).toBe(true);
  });

  it("#640：playOnly 帧不弹系统通知实体", () => {
    expect(c.playOnlyNotifCount).toBe(1);
  });

  it("#640：system 模式帧弹通知", () => {
    expect(c.systemNotifCount).toBe(2);
  });

  it("#640：system 模式帧 → Notification 不 silent", () => {
    expect(c.systemSilentFlag).toBe(false);
  });
});

// ---- P1-1：playOnly + mode:"selfplay" 帧 → 客户端真实自播（振荡器启动计数）----
// 回归「弹窗关 + browserSound=true 纯静默断链」：帧 sound 必须驱动 playTone，
// 且 mode 为 selfplay 时即使 tone undefined 也播默认旋律（旧 playChime 双音）。
describe("P1-1 vm：playOnly 帧驱动真实自播", () => {
  let c: Record<string, any>;

  beforeAll(() => {
    const byType = new Map<string, Set<() => void>>();
    const listeners = {
      addEventListener(type: string, fn: () => void) { let s = byType.get(type); if (!s) { s = new Set(); byType.set(type, s); } s.add(fn); },
      removeEventListener(type: string, fn: () => void) { const s = byType.get(type); if (s) s.delete(fn); },
    };
    const documentStub: any = {
      ...listeners,
      visibilityState: "visible",
      title: "",
      hidden: false,
      getElementById: () => null,
      createElement: (tag: string) => {
        if (tag === "style") return { id: "", textContent: "", dataset: {}, remove() {} };
        return { appendChild() {}, remove() {}, style: {}, dataset: {} };
      },
      head: { appendChild() {} },
      body: { appendChild() {} },
    };
    const sources: Array<{ onmessage: ((ev: { data: string }) => void) | null }> = [];
    let oscStarts = 0;
    // AudioContext stub：解锁后 running；振荡器 start() 计数（真实自播证据）
    class AudioCtxStub {
      state: string;
      currentTime: number;
      constructor() { this.state = "suspended"; this.currentTime = 0; }
      resume() { this.state = "running"; }
      createBuffer() { return {}; }
      createBufferSource() { return { buffer: null, connect() {}, start() { oscStarts += 1; } }; }
      createOscillator() { return { type: "", frequency: { value: 0 }, connect() {}, start() { oscStarts += 1; }, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    }
    const sandbox: any = {
      console: { ...console, warn: () => {} },
      Symbol, Object, Array, JSON, Math, Date, Promise,
      setTimeout, clearTimeout,
      EventSource: class {
        onmessage: ((ev: { data: string }) => void) | null;
        onerror: (() => void) | null;
        constructor() { this.onmessage = null; this.onerror = null; sources.push(this); }
        close() {}
      },
      Notification: Object.assign(function (this: { close: () => void }) { this.close = () => {}; }, { permission: "granted" }),
      AudioContext: AudioCtxStub,
      webkitAudioContext: undefined,
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
      document: documentStub,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    sandbox.window = sandbox;
    sandbox.isSecureContext = true;
    const getFactory = loadFactory(sandbox);
    const mod = getFactory()((spec: string) => {
      if (spec === "react") return { createElement: () => ({}) };
      throw new Error(`unexpected require: ${spec}`);
    });
    const disposers: Array<() => void> = [];
    mod.apply({
      get() { return undefined; },
      effect(fn) { const d = fn(); disposers.push(d); return d; },
    });
    const activeSource = sources[sources.length - 1];
    // 先模拟用户手势解锁（首次点击 unlockAudio）
    for (const fn of byType.get("click") || []) fn();
    let seq = 0;
    const deliver = (payload: Record<string, unknown>) => { seq += 1; activeSource.onmessage!({ data: JSON.stringify({ type: "notify", seq, ...payload }) }); };
    // 页面 visible + 连发两个只响不弹帧（selfplay 新帧 + 旧服务端 system 残留帧）：
    // 不弹实体（playOnly 豁免可见性）+ 至少一次默认旋律自播（1.5s 节流合并连发为
    // 一次播放属预期；旧 bug 形态两帧皆 0 播 → 断言失败即抓住断链）
    deliver({ kind: "done", title: "T", message: "m", playOnly: true, sound: { mode: "selfplay", tone: undefined } });
    deliver({ kind: "done", title: "T", message: "m", playOnly: true, sound: { mode: "system", tone: undefined } });
    c = { oscStarted: oscStarts > 0, title: documentStub.title };
    for (const d of disposers.splice(0)) d();
  });

  it("P1-1：playOnly 帧（selfplay 新帧/旧 system 残留帧）驱动振荡器自播（默认旋律）", () => {
    expect(c.oscStarted).toBe(true);
  });

  it("P1-1：playOnly 帧不触发标题闪烁（无实体降级展示）", () => {
    // 对照：playOnly 帧不弹系统通知实体（无实体降级展示 → 标题不闪烁）
    expect(c.title).toBe("");
  });
});

// ---- S3-12：maxConnections 清空守卫（clampMaxConnections 真产物直测）----
// 空串 → undefined → diff 键被 JSON 序列化丢弃 → 不提交保持原值；非空值软
// clamp（1-1024，服务端写面 min=1，0 会 400——唯一有 400 风险的顶层数值键）。
// 模块级纯函数经 apply 挂载面直测（与 diffSettingsPayload 同先例）。
describe("S3-12：clampMaxConnections 真产物直测", () => {
  let c: Record<string, any>;

  beforeAll(() => {
    const { loadedFactory, mod, disposers } = materializeMinimal();
    c = { loaded: loadedFactory !== null };
    const clampFn = mod.apply.clampMaxConnections;
    const diffFn = mod.apply.diffSettingsPayload;
    c.clampType = typeof clampFn;
    for (const d of disposers.splice(0)) d();

    // 直接值断言：空/非有限 → undefined（不提交）；0/-5 钳到 1；2000 钳到 1024；
    // 1-1024 内四舍五入整数（与 whTimeout clamp 同款 round 语义）
    c.undef = clampFn(undefined);
    c.nan = clampFn(NaN);
    c.zero = clampFn(0);
    c.neg = clampFn(-5);
    c.big = clampFn(2000);
    c.round16_4 = clampFn(16.4);
    c.round16_5 = clampFn(16.5);
    c.inRange = clampFn(16);

    // diff 语义：清空输入（undefined）→ diff 不含 maxConnections 键（PUT 不提交
    // → 服务端保持原值）；输入 0 → clamp 后 diff 含 1（合法提交，不再 400）
    const baseline = { maxConnections: 16, notifyTaskDone: true };
    const cleared = JSON.parse(JSON.stringify(baseline));
    cleared.maxConnections = undefined;
    const clearedPayload = JSON.parse(JSON.stringify(diffFn(cleared, baseline)));
    c.clearedHasKey = "maxConnections" in clearedPayload;
    const clampedView = JSON.parse(JSON.stringify(baseline));
    clampedView.maxConnections = 0; // type=number 输入 0 的原始形态
    const clampedPayload = JSON.parse(JSON.stringify(diffFn({ ...clampedView, maxConnections: clampFn(0) }, baseline)));
    c.clampedValue = clampedPayload.maxConnections;
  });

  it("S3-12：产物 load 已注册 factory", () => {
    expect(c.loaded).toBe(true);
  });

  it("S3-12：apply 挂载 clampMaxConnections 纯函数", () => {
    expect(c.clampType).toBe("function");
  });

  it("S3-12：undefined → undefined（空串形态不提交）", () => {
    expect(c.undef).toBe(undefined);
  });

  it("S3-12：NaN → undefined（type=number 防御）", () => {
    expect(c.nan).toBe(undefined);
  });

  it("S3-12：0 → clamp 1（防 400 死锁）", () => {
    expect(c.zero).toBe(1);
  });

  it("S3-12：-5 → clamp 1", () => {
    expect(c.neg).toBe(1);
  });

  it("S3-12：2000 → clamp 1024", () => {
    expect(c.big).toBe(1024);
  });

  it("S3-12：16.4 → round 16", () => {
    expect(c.round16_4).toBe(16);
  });

  it("S3-12：16.5 → round 17", () => {
    expect(c.round16_5).toBe(17);
  });

  it("S3-12：16 在界内原样", () => {
    expect(c.inRange).toBe(16);
  });

  it("S3-12：清空 maxConnections → diff 不含该键（保持原值）", () => {
    expect(!c.clearedHasKey).toBeTruthy();
  });

  it("S3-12：输入 0 → clamp 后 diff 提交 1（服务端 200）", () => {
    expect(c.clampedValue).toBe(1);
  });
});
