/**
 * dsh-notifier — 组合根（`src/index.ts`）的真实 cordis Context 集成测试。
 *
 * 面口径：这里测的是**宿主看见的那一面**——`apply` 收窄宿主上下文、按序装配八个域、卸载逆序释放。
 * 这些行为只有放进真实 cordis 才成立：`inject` 门（未就绪不装配）、两条 waterfall 的 `prepend`
 * 链序、`{ global: true }` 的作用域过滤、`ctx.effect` 的卸载时机、`internal/service` 的晚到通知。
 * 假宿主只提供 `webServer`（组合根唯一触碰的宿主服务）与可选的 `settings`；事件总线、落盘、
 * 裁决管线全是真的——**不 mock `@deepseek-ai/cordis`**，也不用 `vi.mock`/`vi.fn`。
 *
 * 落盘隔离（红线）：config / stores / stream 的单例在**模块加载期**就用 `notifierFile()` 定死了
 * 路径，所以必须先把 `DSH_HOME` 指到 `mkdtempSync` 出的临时目录，再用**动态 `import()`** 拉组合根。
 * 写反了本节全部落盘就进真实 `~/.dsh`——那正是正在跑的 `dsh web` 的 home。
 *
 * 写队列纪律：历史与配置的落盘是 fire-and-forget（写队列是模块级字段，`release` 不清它），故每个
 * 产生落盘的用例都要等到自己那一条在磁盘上可见才算完；需要「没有新写入」这类否定判据时，用
 * `stores` 域自己的写口排一次队当**界碑**——队列串行，界碑落盘即此前排队的全部落盘。
 *
 * 时间纪律：本文件不钉系统时钟，`pollUntil` 的 deadline 读的正是 `Date.now()`，钉住它失败会从
 * 「断言红」退化成挂死。`afterEach` 仍还原一次，防将来有人在用例里钉。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import type { Events, Fiber, ThisType as EventThis } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";

import {
  assertEventReachability,
  assertRealCordisContextSemantics,
} from "../../../../test/smoke-lib.ts";
import { pollUntil, settleMicrotasks, tempDshHome } from "../helpers.ts";

// DSH_HOME 必须先于被测模块求值：三个单例的落盘路径在构造时定下，而静态 import 会在任何语句
// 之前执行——顺序反了，本节全部落盘就写进真实 `~/.dsh`。
const home = tempDshHome();
const notifier = await import("../../src/index.ts");
const apiApi = await import("../../src/server/api/interface.ts");
const configApi = await import("../../src/server/config/interface.ts");
const sdkApi = await import("../../src/server/sdk/interface.ts");
const storesApi = await import("../../src/server/stores/interface.ts");
const sharedApi = await import("../../src/server/shared/interface.ts");

/** 本插件的落盘位置（新布局：包私有目录，见 `shared/paths.ts`）。 */
const storageDir = join(home.dir, "@wingsky-1", "dsh-notifier");
const configFile = sharedApi.notifierFile(sharedApi.CONFIG_FILE_NAME);
const historyFile = sharedApi.notifierFile(sharedApi.HISTORY_FILE_NAME);
const seqFile = sharedApi.notifierFile(sharedApi.SEQ_FILE_NAME);
const versionFile = sharedApi.notifierFile(sharedApi.VERSION_FILE_NAME);

/** 种下的那份配置的原文：否定判据用它比对「一个字节都没动过」。 */
function seededConfig(): string {
  return `${JSON.stringify(BASE_SETTINGS, null, 2)}\n`;
}

/** 宿主契约冻结的 7 条浏览器端点（客户端锁定，独立抄写才守得住改路径）。 */
const ROUTE_PATHS: readonly string[] = [
  "/api/dsh-notifier/config",
  "/api/dsh-notifier/history",
  "/api/dsh-notifier/status",
  "/api/dsh-notifier/kinds",
  "/api/dsh-notifier/test",
  "/api/dsh-notifier/health",
  "/api/dsh-notifier/events",
];

/**
 * 基础设置：系统出口整个关掉、浏览器出口只弹不响。
 *
 * 系统出口在 Linux 会真的 spawn `notify-send`——测试不该在开发机上弹通知；浏览器出口的帧则
 * 经组合根的 `FrameBus` 进 api 域的流（只写 `seq.json`），是本文件观察「帧走出去了」的唯一手段。
 * 两条内置频道的形态**显式写出来**：`enabled` 是频道唯一的投递闸门，靠 `systemNotify:false`
 * 之类的弹窗键关不掉它（那只让出口无事可做，仍会留下一条 skipped 明细）。
 * `historyMaxAgeDays` 取**非默认值**：逆序释放那条判据要一个与默认值不同的可辨读数。
 */
const BASE_SETTINGS = {
  channels: [
    {
      type: "browser",
      id: "browser",
      enabled: true,
      popup: true,
      sound: false,
      whenVisible: false,
    },
    { type: "system", id: "system", enabled: false, popup: false, sound: false },
  ],
  historyMaxAgeDays: 7,
} as const;

/** 历史行：只取本文件当判据的字段（整体比较会把域内文案变化变成假红）。 */
interface HistoryLine {
  kind?: string;
  message?: string;
  suppressed?: string;
  channels?: ReadonlyArray<{ channelId: string; status: string }>;
}

/** 磁盘上的历史记录。 */
function historyLines(): HistoryLine[] {
  let text: string;
  try {
    text = readFileSync(historyFile, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as HistoryLine];
      } catch {
        // 坏行不当判据，也不吞掉同行之外的记录
        return [];
      }
    });
}

/** 某一种通知落了几条。 */
function countKind(kind: string): number {
  return historyLines().filter((line) => line.kind === kind).length;
}

/** 磁盘上第一条某一种通知：`beforeEach` 清过历史，所以不受上一个用例干扰。 */
function kindLine(kind: string): HistoryLine | undefined {
  return historyLines().find((line) => line.kind === kind);
}

/** 界碑用的种类名：只出现在界碑行里，任何通知判据都不会撞上它。 */
const SENTINEL_KIND = "itest-sentinel";

/**
 * 排一次界碑并等它落盘，用来给**否定**判据划界。
 *
 * 写队列串行，界碑在磁盘上可见即此前排队的写入全部落盘；没有界碑的「没有新记录」只是抢跑得来的
 * ——它证明的是「还没写完」，不是「不会写」。
 */
async function settleHistory(): Promise<void> {
  storesApi.appendHistory({ ts: Date.now(), kind: SENTINEL_KIND, title: "界碑", message: "-" });
  await pollUntil(() => historyLines().some((line) => line.kind === SENTINEL_KIND), "界碑落盘");
}

/** 浏览器出口的序号：`seq.json` 前进一格 = 帧真的走完了 FrameBus → api 域 → 流。 */
function seqValue(): number {
  try {
    const parsed = Number.parseInt(readFileSync(seqFile, "utf8").trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * 本用例的序号锚点（每轮 +1000）。
 *
 * 序号是 fire-and-forget 写，「等于锚点 +1」这类判据要挡得住上一个用例迟到的那一笔——递增的锚点
 * 让迟到的值必然小于本轮的起点，于是「文件里出现了本轮的格子」只可能由本轮自己的广播产生。
 */
let seqAnchor = 0;

function seedSeqAnchor(): void {
  seqAnchor += 1000;
  mkdirSync(dirname(seqFile), { recursive: true });
  writeFileSync(seqFile, `${seqAnchor}\n`);
}

/** 写一份设置文件（组合根装配时同步读它，故必须用同步写）。 */
function seed(settings: Record<string, unknown>): void {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(settings, null, 2)}\n`);
}

/** 假会话日志条目：本块只读 `type` 与 `data`（与 events 域单测同一口径）。 */
function turnEndEvent(turn: number, kind: string): SessionEvent {
  return { type: "turn/end", data: { turn, reason: { kind } } } as unknown as SessionEvent;
}

/** 假 agent：只露出 events 域真的会读的几处（`id` 与 `session` 的 header / 日志快照）。 */
function fakeAgent(
  id: string,
  events: SessionEvent[] = [],
  header: Record<string, unknown> = {},
): Agent {
  return {
    id,
    session: { header, snapshotEvents: () => events },
  } as unknown as Agent;
}

/** 假会话：`session/event` 的载荷带整份会话对象，而本插件只用它的 `id`。 */
function fakeSession(id: string): Session {
  return { id } as unknown as Session;
}

/**
 * 宿主按作用域派发时传的 `this`：`agent/*` 声明的是 `Scoped<Agent>`、`session/event` 是
 * `Scoped<Session>`，而那个 brand 不是本包的依赖，故从事件签名上取 `this` 位。测试要造的正是
 * `{ [Context.filter]: … }` 这一个成员——直接抄 `Scoped<…>` 会把它变成第二份事实源。
 */
type ScopedThis<K extends keyof Events> = EventThis<Events[K]>;

/** 作用域收紧的派发载体：filter 恒假，于是**只有** `{ global: true }` 的订阅能收到。 */
function scopeRejecting<K extends keyof Events>(): ScopedThis<K> {
  return { [Context.filter]: () => false } as unknown as ScopedThis<K>;
}

/** 假 settings 服务：本插件只经 `describe({ redactSecrets })` 读 0.2.3 的存量命名空间。 */
function fakeSettings(user: Record<string, unknown>): { describe: () => unknown[] } {
  return {
    describe: () => [{ ns: "dsh-notifier", user }],
  };
}

/**
 * 假宿主 webServer：只实现组合根够得着的那一面（`register`），并记下摘除时的现场。
 *
 * `failAt` 让第 N 条摘除器抛错——宿主摘路由失败是真实会发生的（路由已被别人摘掉、宿主换实现），
 * 组合根的释放壳对它的承诺是「不阻断其余」。
 */
function fakeWebServer(
  observe: () => { configDays: number; serviceAlive: boolean },
  options: { failAt?: number } = {},
) {
  const routes: WebRoute[] = [];
  const removals: Array<{ path: string; configDays: number; serviceAlive: boolean }> = [];
  const service = {
    register(route: WebRoute) {
      routes.push(route);
      return () => {
        removals.push({ path: route.path, ...observe() });
        if (removals.length === options.failAt) throw new Error(`摘除失败：${route.path}`);
      };
    },
  } as unknown as Context["webServer"];
  return { service, routes, removals };
}

/** 假宿主 agent 注册表：只实现组合根读的两处（`get` 与 `isOwnedBy`）。 */
function fakeAgents(parent: Agent, child: Agent): Context["agents"] {
  return {
    get: (id: string) => (id === parent.id ? parent : undefined),
    isOwnedBy: (id: string, owner: Agent) => id === child.id && owner === parent,
  } as unknown as Context["agents"];
}

/**
 * 日志出口：`LoggerService` 的公开扩展点，用它把 warn 收进数组。
 *
 * 为什么不读内置的 `ctx.logger.buffer`：那个出口的阈值是 INFO，warn（级别 2）落在它之外，
 * buffer 里永远看不到本文件的判据文案。阈值按 `levels.default` 给——它是出口自己的约定。
 */
function captureWarnings(root: Context): string[] {
  const warnings: string[] = [];
  root.logger.exporter({
    levels: { default: 2 },
    export: (message) => {
      if (message.type === "warn") warnings.push(String(message.args[0]));
    },
  });
  return warnings;
}

/** 一次挂载的全部观测物。 */
interface Mounted {
  readonly root: Context;
  readonly fiber: Fiber;
  readonly host: ReturnType<typeof fakeWebServer>;
  /** 宿主日志出口收到的 warn 文案（组合根只经它报错）。 */
  readonly warns: string[];
  unmount(): Promise<void>;
}

/** 已挂载但用例没显式卸载的实例：`afterEach` 兜底收掉，免得路由/心跳漏到下一个用例。 */
let live: Fiber | null = null;

/**
 * 按宿主的真实挂载顺序装配：先 provide 宿主服务，再 `ctx.plugin(插件)`。
 *
 * `settings` 是本插件的**显式依赖**（组合根的 `inject`）：宿主保证它在插件装配前就绪，所以这里
 * 总是先 provide 一个假的；`settings` 的值就是那份 0.2.3 存量命名空间的 user 层（缺省 = 有服务
 * 但没存量）。「服务没来」这条分支已不属于本插件——它变成 cordis 的 inject 门（见 inject 门用例）。
 * `services` 是其余宿主服务（如 `agents`）——装与不装是两条不同的判定路径。
 */
async function mount(options: {
  config?: { enabled?: boolean };
  settings?: Record<string, unknown>;
  services?: Record<string, unknown>;
}): Promise<Mounted> {
  const root = new Context();
  root.provide("settings", fakeSettings(options.settings ?? {}));
  for (const [name, value] of Object.entries(options.services ?? {})) root.provide(name, value);
  const warns = captureWarnings(root);
  const host = fakeWebServer(() => ({
    configDays: configApi.readConfig().historyMaxAgeDays,
    serviceAlive: root.get("wingsky.notifier", false) !== undefined,
  }));
  root.provide("webServer", host.service);
  const fiber = await root.plugin(notifier, options.config);
  live = fiber;
  return {
    root,
    fiber,
    host,
    warns,
    unmount: async () => {
      live = null;
      await fiber.dispose();
    },
  };
}

/**
 * 模拟宿主内置 answerer：链上**更早注册**的那一个，它给出的判定就是这次请求的最终结果。
 * 它不调 `next()`——宿主自己的应答者拿到判定后即短路，这正是本插件必须 prepend 的理由。
 */
async function mountApprovalAnswerer(
  root: Context,
  calls: string[],
  outcome: ApprovalOutcome,
): Promise<Fiber> {
  return root.plugin((ctx) => {
    ctx.on("approval/request", () => {
      calls.push("answerer");
      return Promise.resolve(outcome);
    });
  });
}

/** 同上，提问那条链上的 answerer（两条 waterfall 同构，夹具分开写以免一条覆盖另一条）。 */
async function mountQuestionAnswerer(
  root: Context,
  calls: string[],
  answer: AskUserQuestionAnswer,
): Promise<Fiber> {
  return root.plugin((ctx) => {
    ctx.on("user-questions/request", () => {
      calls.push("answerer");
      return Promise.resolve(answer);
    });
  });
}

beforeEach(() => {
  // 单例的落盘路径跨用例不变，能重置的只有文件：不重置的话上一个用例的配置/历史就是本用例的起点。
  rmSync(historyFile, { force: true });
  rmSync(configFile, { force: true });
  seedSeqAnchor();
  seed(BASE_SETTINGS);
});

afterEach(async () => {
  vi.useRealTimers();
  if (live) {
    const fiber = live;
    live = null;
    await fiber.dispose();
  }
  // api 域的装配标记只在它自己的 release() 走完时才复位，而有一条用例刻意让摘除器抛错把它停在
  // 半释放（那是它的判据）。这里无条件补一次收尾：域释放幂等，正常用例上是空转——不放在用例里
  // 是因为用例前面任何一条断言红了就会跳过补偿，后续用例会级联红成一片。
  apiApi.releaseApi();
});

afterAll(() => {
  home.dispose();
});

describe("装配与暴露", () => {
  it("装配即暴露：服务面挂在宿主上下文上（声明合并的读法可用），登记与发送当场可用", async () => {
    const { root, fiber, unmount } = await mount({});
    // 声明合并的读法可用，而且读到的是**同一个**对象：服务面经 `ctx.provide` 挂在宿主上下文上，
    // 不是又造了一份（再造一份就会有两个 apiVersion、两套登记表）。
    const service = root.get("wingsky.notifier", false);
    expect(fiber.ctx["wingsky.notifier"]).toBe(service);
    expect(service?.apiVersion).toBe(2);
    // 管理面（清单 / 确认）不进服务面：多给一样，兄弟插件就能替用户放行自己的通知种类。
    expect("confirmKind" in (service ?? {})).toBe(false);

    service?.registerKind({ id: "itest:face", label: "集成测试" });
    expect(sdkApi.listKinds()).toContainEqual({
      id: "itest:face",
      label: "集成测试",
      confirmed: false,
    });
    // 未确认的外部种类：送进的是真管线，出去的是一条「unlisted」归档（不是静默丢弃）。
    await service?.send({ kind: "itest:face", body: "正文" });
    await pollUntil(() => countKind("itest:face") === 1, "登记后的发送落史");
    expect(kindLine("itest:face")?.suppressed).toBe("unlisted");

    await unmount();
    // 卸载后消费方按「通知中心不在」降级：`get` 拿空而不是拿到半死对象。
    expect(root.get("wingsky.notifier", false)).toBeUndefined();
  });

  it("inject 门：两条宿主服务（webServer / settings）都就绪才装配，缺一条都不跑", async () => {
    const root = new Context();
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    const fiber = await root.plugin(notifier);
    live = fiber;

    // 缺依赖时的现场：插件没跑（路由为空、服务面没上），也没有装配失败的声音。
    expect(host.routes).toHaveLength(0);
    expect(root.get("wingsky.notifier", false)).toBeUndefined();

    // 只补一条还不够：settings 是显式依赖（存量配置的读取面），缺它时装配体一步都不该走。
    root.provide("webServer", host.service);
    await settleMicrotasks();
    expect(host.routes).toHaveLength(0);
    expect(root.get("wingsky.notifier", false)).toBeUndefined();

    root.provide("settings", fakeSettings({}));
    await fiber.await();
    expect(host.routes.map((route) => route.path)).toHaveLength(7);
    expect(root.get("wingsky.notifier", false)?.apiVersion).toBe(2);
  });

  /**
   * 宿主契约 canary——**不是本插件的判据**：两个共用 helper 都只在自己临时挂的监听器上断言 cordis
   * 的语义（未注入访问抛错 / 缺位 get 安全 / effect 真实清理 / 作用域过滤只放行 global），
   * 它们不触本插件的任何代码。放在一个用例里是因为两者共用同一次装配，判据互不相干。
   */
  it("宿主契约 canary：真实 Context 语义 + `{global:true}` 的作用域过滤语义（非本插件行为判据）", async () => {
    const { fiber, unmount } = await mount({});
    // 插件 fiber 的运行时上下文才是「真实」的那一份：root 语义下未注入访问会静默给 undefined，
    // 断言①在那里恒真——历史教训（根因 A：fake-ctx 把服务当普通属性注入）正是靠这条堵住的。
    // 断恒等而非断存在：`root.fiber` 也存在，只有插件 fiber 才带 `runtime`（根为 null）。
    expect(fiber.ctx.fiber).toBe(fiber);
    assertRealCordisContextSemantics(fiber.ctx);
    assertEventReachability(fiber.ctx, Context, "agent/status", {
      agent: fakeAgent("itest-reach"),
      status: "running",
    });
    await unmount();
  });

  it("挂载点总开关 enabled:false 抵达裁决层：请求照进管线，但记的是 disabled 而不是照常投递", async () => {
    const { root, unmount } = await mount({ config: { enabled: false } });
    root.emit("agent/error", {
      agent: fakeAgent("itest-disabled"),
      turn: 1,
      step: 1,
      error: new Error("炸了"),
    });
    await pollUntil(() => countKind("error") === 1, "总开关关闭时的归档");
    expect(kindLine("error")?.suppressed).toBe("disabled");
    // 关掉的是「投递」，不是「记录」：帧的写排在归档之前，归档已在磁盘上时序号若前进过就已可见
    // ——所以这里断「没走到下一格」而不是「等于锚点」，免得受上一个用例迟到的那一笔影响。
    expect(seqValue()).not.toBe(seqAnchor + 1);
    await unmount();
  });
});

describe("宿主路由注册与摘除", () => {
  it("apply 期间宿主收到恰好 7 条 exact 路由，路径集合就是客户端锁定的那一份", async () => {
    const { host, unmount } = await mount({});
    expect(host.routes.map((route) => route.path).sort()).toEqual([...ROUTE_PATHS].sort());
    expect(host.routes.every((route) => route.kind === "exact")).toBe(true);
    expect(host.removals).toHaveLength(0);
    await unmount();
  });

  it("卸载摘除全部 7 条路由，重复卸载不再摘第二次（卸载链可能走到不止一次）", async () => {
    const { host, fiber, unmount } = await mount({});
    await unmount();
    expect(host.removals.map((removal) => removal.path).sort()).toEqual([...ROUTE_PATHS].sort());

    await fiber.dispose();
    expect(host.removals).toHaveLength(ROUTE_PATHS.length);
  });
});

describe("waterfall 契约（审批 / 提问）", () => {
  it("approval/request：链头可达，且 next() 把判定原样交还给更早注册的短路 answerer", async () => {
    const root = new Context();
    const calls: string[] = [];
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    root.provide("webServer", host.service);
    root.provide("settings", fakeSettings({}));
    // 宿主的形态：内置 answerer 在本插件之前注册，并且**不调 next()**（GUI 应答后即短路）。
    await mountApprovalAnswerer(root, calls, "rejected");
    const fiber = await root.plugin(notifier);
    live = fiber;
    // 反向固化：不带 prepend 的后来者排在这个短路 answerer 之后，整条链对它不可见。
    const control: string[] = [];
    root.on("approval/request", async () => {
      control.push("late");
      return "cancelled";
    });

    const request = { toolName: "bash", reason: "要写文件" } as unknown as ApprovalRequest;
    const outcome = await root.waterfall("approval/request", request, async () => "unavailable");

    // ② 链路结果没被吞：最终判定仍来自 answerer（插件自己返回 undefined 时这里会是 undefined）。
    expect(outcome).toBe("rejected");
    // ③ answerer 确实被调用：插件的 next() 真的把判定交了回来。
    expect(calls).toEqual(["answerer"]);
    // ① 插件的处理器被调用：可达性只有它自己的副作用能证明（审批通知落史）。
    await pollUntil(() => countKind("ask") === 1, "审批通知落史");
    // 反向固化：同一个事件、同一次派发里，后注册的无 prepend 监听器被短路挡在外面。
    // （`control` 空是**夹具前提**——answerer 短路后链不再往下走，不是本插件的判据。）
    expect(control).toEqual([]);
    await fiber.dispose();
    live = null;
  });

  it("user-questions/request：第二条 waterfall 与审批同构（同一个链头与交还契约）", async () => {
    const root = new Context();
    const calls: string[] = [];
    const answer: AskUserQuestionAnswer = { answers: [{ id: "q1", selected: ["是"] }] };
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    root.provide("webServer", host.service);
    root.provide("settings", fakeSettings({}));
    await mountQuestionAnswerer(root, calls, answer);
    const fiber = await root.plugin(notifier);
    live = fiber;

    // 只给必需的 questions：形状合法，值与文案无关（文案归 translate 域的单测）。
    const request: AskUserQuestionRequest = { questions: [{ id: "q1", question: "选哪个？" }] };
    const outcome = await root.waterfall("user-questions/request", request, async () => ({
      answers: [],
    }));

    // 交还的是 answerer 的**整份**判定，不是被本插件加工过的形状。
    expect(outcome).toEqual(answer);
    expect(calls).toEqual(["answerer"]);
    await pollUntil(() => countKind("question") === 1, "提问通知落史");
    await fiber.dispose();
    live = null;
  });

  it("guard：处理器内部抛错不向宿主抛——提问链路照旧交出判定，只留一条 warn", async () => {
    const root = new Context();
    const calls: string[] = [];
    const warns = captureWarnings(root);
    const answer: AskUserQuestionAnswer = { answers: [{ id: "q1", selected: ["是"] }] };
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    root.provide("webServer", host.service);
    root.provide("settings", fakeSettings({}));
    await mountQuestionAnswerer(root, calls, answer);
    const fiber = await root.plugin(notifier);
    live = fiber;

    // 上游形状漂移：一条缺 `question` 文本的提问。它在编译期本就被拦住，而守卫存在的理由正是
    // 编译期管不到的那一侧——载荷跨宿主边界不受信。
    const drifted = { questions: [{ id: "q1" }] } as unknown as AskUserQuestionRequest;

    // 宿主链不被打断：本插件只是旁观者，抛出去会让 next() 不被调用（症状是「提问框不弹了」）。
    const outcome = await root.waterfall("user-questions/request", drifted, async () => ({
      answers: [],
    }));
    expect(outcome).toEqual(answer);
    expect(calls).toEqual(["answerer"]);

    // 不静默：文案只此一处，吞掉之后「通知不工作」会变成查不出原因的现象。
    const guardWarn = warns.find((line) => line.includes("宿主事件处理失败"));
    expect(guardWarn?.startsWith("dsh-notifier: 宿主事件处理失败 —— ")).toBe(true);

    // 同一层壳的另一支：宿主抛出来的可以**不是** Error（官方那边失败类型本就是 unknown），
    // 文案得照样出得来，而不是把一次宿主异常消化成空字符串。
    const hostile = {
      get toolName(): string {
        throw "宿主抛出的字符串";
      },
    } as unknown as ApprovalRequest;
    const second = await root.waterfall("approval/request", hostile, async () => "unavailable");
    expect(second).toBe("unavailable");
    expect(warns.some((line) => line.endsWith("宿主抛出的字符串"))).toBe(true);
    await fiber.dispose();
    live = null;
  });
});

describe("宿主事件可达性", () => {
  it("多会话派发下本插件的订阅仍可达：漏掉 {global:true} 的表现是「有些会话不通知」", async () => {
    const { root, unmount } = await mount({});
    const control: string[] = [];
    // 对照：同一个事件、同一次派发，没有 {global:true} 的订阅会被作用域过滤掉。
    // （`control` 空是**夹具前提**——cordis 的 filter 真的在拒人，不是本插件的判据。）
    root.on("agent/error", () => {
      control.push("untagged");
    });

    // 宿主按 agent 作用域派发时传的就是这样一个 thisArg（filter 决定哪些订阅可见）。
    const scoped = scopeRejecting<"agent/error">();
    root.emit(scoped, "agent/error", {
      agent: fakeAgent("itest-scope"),
      turn: 1,
      step: 1,
      error: new Error("炸了"),
    });

    await pollUntil(() => countKind("error") === 1, "作用域收紧下仍到达管线");
    // （`control` 空是**夹具前提**——cordis 的 filter 真的在拒人，不是本插件的判据。）
    expect(control).toEqual([]);
    await unmount();
  });

  /**
   * 余下四条全局订阅**各自**可证伪：上面 `agent/error` 那条只覆盖了一条订阅，而宿主契约 canary 里
   * 的 `assertEventReachability` 测的是 cordis 的过滤语义本身（它自己临时挂监听器），都没能证明这
   * 四条带没带 `{global:true}`——**旧版同名文件是靠扫 `src/index.ts` 源码文本断言「全部 `ctx.on`
   * 注册处带 `{global:true}`」的**（还带 `// @ts-nocheck`），重写改成纯运行时行为后这块守卫缺了一
   * 个口子，下面就是它的行为版替身。四条写在同一个用例里是为了省掉四次装配，但每一段都独立成立：
   * 删掉对应那行的 `GLOBAL_LISTEN`，只有该段会红。
   */
  it("四条全局订阅各自可证伪（旧源码文本扫描的行为版替身）：收紧派发下状态 / 会话 / turn / 消亡都仍到达", async () => {
    const { root, unmount } = await mount({});
    // agent/* 共用同一个 this 位类型，会话那条在会话那一侧，故造两个载体。
    const scopedAgent = scopeRejecting<"agent/status">();
    const scopedSession = scopeRejecting<"session/event">();
    const signal = new AbortController().signal;

    // ① agent/status：两跳判定照旧产出完成通知（证据取自日志快照，与会话推送无关）。
    const statusEvents: SessionEvent[] = [];
    const statusAgent = fakeAgent("itest-scope-status", statusEvents);
    root.emit(scopedAgent, "agent/status", { agent: statusAgent, status: "running" });
    statusEvents.push(turnEndEvent(1, "completed"));
    root.emit(scopedAgent, "agent/status", { agent: statusAgent, status: "idle" });
    await pollUntil(() => countKind("done") === 1, "① 作用域收紧下 agent/status 仍产出完成通知");

    // ② session/event：这条会话的日志快照是空的，完成判定只能靠推送来的那笔证据——收不到就没有通知。
    // 用「比前一段多一条」而不是绝对值：这一段的成立与否不该被上一段的条数绑住。
    const doneBeforePush = countKind("done");
    const pushAgent = fakeAgent("itest-scope-session");
    root.emit(scopedAgent, "agent/status", { agent: pushAgent, status: "running" });
    root.emit(
      scopedSession,
      "session/event",
      fakeSession("itest-scope-session"),
      turnEndEvent(1, "completed"),
    );
    root.emit(scopedAgent, "agent/status", { agent: pushAgent, status: "idle" });
    await pollUntil(
      () => countKind("done") === doneBeforePush + 1,
      "② 作用域收紧下 session/event 的推送证据仍被记账",
    );

    // ③ agent/turn-stopping：同一 turn 只发一次（去重状态机在收紧的派发下也要吃到这两跳）。
    // 本段只证明「到达并被记账」：本例的 notifyTurnEnd 是默认的 false，所以这条 turn-end 是以
    // suppressed 落的史——它分不出「发了」与「被压制」，投递面的判据在下面那条用例里。
    const turnAgent = fakeAgent("itest-scope-turn");
    root.emit(scopedAgent, "agent/turn-stopping", { agent: turnAgent, turn: 7, signal });
    await pollUntil(() => countKind("turn-end") === 1, "③ 作用域收紧下 turn 边界仍到达状态机");
    expect(kindLine("turn-end")?.suppressed).toBe("kind-off");
    root.emit(scopedAgent, "agent/turn-stopping", { agent: turnAgent, turn: 7, signal });
    await settleHistory();
    expect(countKind("turn-end")).toBe(1);

    // ④ agent/disposed：清账把那笔去重记录抹掉，否则同一个 id 复用后这一 turn 永远不再通知。
    const disposed = scopeRejecting<"agent/disposed">();
    root.emit(disposed, "agent/disposed", { agent: turnAgent });
    root.emit(scopedAgent, "agent/turn-stopping", { agent: turnAgent, turn: 7, signal });
    await pollUntil(() => countKind("turn-end") === 2, "④ 作用域收紧下消亡事件仍清账");
    await unmount();
  });

  it("agent/error：真实 emit 到达管线，错误原文经组合根收窄成文本落进历史", async () => {
    const { root, unmount } = await mount({});
    root.emit("agent/error", {
      agent: fakeAgent("itest-error"),
      turn: 2,
      step: 3,
      error: new Error("磁盘满了"),
    });
    // 宽类型（unknown）在这里做唯一一次收窄：域内拿到的必须是可展示的文本。
    root.emit("agent/error", {
      agent: fakeAgent("itest-error"),
      turn: 2,
      step: 4,
      error: 42,
    });
    await pollUntil(() => countKind("error") === 2, "两条错误通知落史");
    const lines = historyLines().filter((line) => line.kind === "error");
    expect(lines).toHaveLength(2);
    // 收窄的两支：Error 取 `message`，非 Error 用 `String()`。判据必须咬住「取 message」这个动作——
    // 正文模板是 `…：${文本}`，而 `String(new Error("磁盘满了"))` 是 `"Error: 磁盘满了"`，
    // 只断包含「磁盘满了」的话两种写法都过（恒真），故断紧贴前缀冒号的那一段 + 反断整对象形态。
    const messages = lines.map((line) => line.message ?? "").join("\n");
    expect(messages).toContain("：磁盘满了");
    expect(messages).not.toContain("Error: 磁盘满了");
    expect(messages).toContain("42");
    await unmount();
  });

  it("agent/status：裸 idle 不发通知，running→idle 两跳且日志里有本轮新证据才产出 done", async () => {
    const { root, unmount } = await mount({});
    // 会话日志是一段可增长的快照，本轮结束的证据在 running 之后才追加进来。
    // 「进入 running 时日志里已有的 turn/end 是上一轮的、不许当成本轮完成」（`证据源=快照冻结`）
    // 有专门的主：`test/unit/events/listen.test.ts`，此处不重复覆盖。
    const events: SessionEvent[] = [];
    const agent = fakeAgent("itest-done", events);

    // 「只有 running 被看见过，idle 才算一轮结束」这条已由 test/unit/events/listen.test.ts 单测
    // 守死（那边还多断了一条「不留诊断」），这里只走本层独有的两跳：running → turn/end → idle。
    root.emit("agent/status", { agent, status: "running" });
    events.push(turnEndEvent(1, "completed"));
    root.emit("agent/status", { agent, status: "idle" });
    await pollUntil(() => countKind("done") === 1, "完成通知落史");
    await unmount();
  });

  it("session/event：推送的 turn/end 被记账，缺了它完成判定退化成不发（唯一可辨的副作用）", async () => {
    const { root, warns, unmount } = await mount({});
    // 快照里没有 turn/end：完成判定只能靠 session/event 推来的那一条证据。
    const agent = fakeAgent("itest-push");
    const session = fakeSession("itest-push");

    root.emit("agent/status", { agent, status: "running" });
    root.emit("agent/status", { agent, status: "idle" });
    await pollUntil(
      () => warns.some((line) => line.includes("完成判定跳过")),
      "无证据时的跳过诊断",
    );
    expect(countKind("done")).toBe(0);

    root.emit("agent/status", { agent, status: "running" });
    root.emit("session/event", session, turnEndEvent(1, "completed"));
    root.emit("agent/status", { agent, status: "idle" });
    await pollUntil(() => countKind("done") === 1, "推送证据驱动的完成通知");
    await unmount();
  });

  it("agent/turn-stopping 与 agent/disposed：同一 turn 只发一次，agent 消亡后清账", async () => {
    seed({ ...BASE_SETTINGS, notifyTurnEnd: true });
    const { root, unmount } = await mount({});
    const agent = fakeAgent("itest-turn");
    const signal = new AbortController().signal;

    root.emit("agent/turn-stopping", { agent, turn: 7, signal });
    await pollUntil(() => countKind("turn-end") === 1, "turn-end 落史");

    // 落史本身只证明「事件到了状态机并写了一行」：notifyTurnEnd 关着时同一条也会以 turn-end 落史，
    // 只是带 suppressed。投递面要有自己的判据——出站明细与浏览器帧的序号。
    const delivered = kindLine("turn-end");
    expect(delivered?.suppressed).toBeUndefined();
    expect(delivered?.channels).toEqual([{ channelId: "browser", status: "ok" }]);
    await pollUntil(() => seqValue() === seqAnchor + 1, "帧经 FrameBus 出去");

    // 同一 turn 再来一次：去重状态机在真实事件链上也要成立（否则每步都弹一条）。
    root.emit("agent/turn-stopping", { agent, turn: 7, signal });
    // 界碑划界：不然「没有第二条」是抢跑得来的。
    await settleHistory();
    expect(countKind("turn-end")).toBe(1);

    // 消亡事件清掉去重记录：否则同一 id 复用后这一 turn 永远不再通知。
    root.emit("agent/disposed", { agent });
    root.emit("agent/turn-stopping", { agent, turn: 7, signal });
    await pollUntil(() => countKind("turn-end") === 2, "清账后同一 turn 可再发");
    await unmount();
  });

  it("浏览器出口拿到帧：投递经组合根 FrameBus 走到 api 域，序号前进一格", async () => {
    const { root, unmount } = await mount({});
    root.emit("agent/error", {
      agent: fakeAgent("itest-frame"),
      turn: 1,
      step: 1,
      error: new Error("炸了"),
    });
    await pollUntil(() => countKind("error") === 1, "投递归档");
    // 序号只在 api 域订阅到帧之后才前进：这一格同时证明 FrameBus 的 emit 与 onFrame 两端接上了。
    await pollUntil(() => seqValue() === seqAnchor + 1, "帧经 FrameBus 出去");
    const delivered = kindLine("error")?.channels?.[0];
    expect(delivered?.channelId).toBe("browser");
    expect(delivered?.status).toBe("ok");
    await unmount();
  });
});

describe("宿主 agent 注册表（子代理归属）", () => {
  it("注册表缺位：带 parentSession 的会话按主任务处理（宁可多报一条 done，不静默用户自己的任务）", async () => {
    const { root, unmount } = await mount({});
    // header 有 parentSession，但宿主没装 agents 服务：`ctx.get("agents", false)` 必须缺位安全，
    // 而不是抛错或把「查不到」当成「是子代理」——后者会让子代理的完成通知永远发不出去。
    const events: SessionEvent[] = [];
    const child = fakeAgent("itest-orphan", events, { parentSession: "itest-gone" });

    root.emit("agent/status", { agent: child, status: "running" });
    events.push(turnEndEvent(1, "completed"));
    root.emit("agent/status", { agent: child, status: "idle" });
    await pollUntil(() => countKind("done") === 1, "查不到父 agent 时按主任务报完成");
    expect(countKind("subagent-done")).toBe(0);
    await unmount();
  });

  it("注册表有据：确由父 agent 创建的会话落 subagent-done，而不是当成主任务再报一次", async () => {
    const parent = fakeAgent("itest-parent");
    const events: SessionEvent[] = [];
    const child = fakeAgent("itest-child", events, { parentSession: "itest-parent" });
    const { root, unmount } = await mount({ services: { agents: fakeAgents(parent, child) } });

    root.emit("agent/status", { agent: child, status: "running" });
    events.push(turnEndEvent(1, "completed"));
    root.emit("agent/status", { agent: child, status: "idle" });
    // 两跳判定的产物只有 kind 能区分：`done` 会让每个子代理都伪装成用户的主任务。
    await pollUntil(() => countKind("subagent-done") === 1, "子代理完成通知落史");
    expect(countKind("done")).toBe(0);
    await unmount();
  });
});

describe("宿主 settings 服务：装配期同步割接存量配置", () => {
  it("服务先于插件就绪：装配期读到存量并割接进当前配置文件（同步，没有「等一会儿」的窗口）", async () => {
    // 0.2.4 那一步只在刻度未到的装机上跑：真实升级场景就是把刻度退回起点；而 0.2.3 的装机
    // 没有这份配置文件（配置住在宿主 settings 里），割接就落在这一份新文件上。
    rmSync(versionFile, { force: true });
    rmSync(configFile, { force: true });
    const { unmount } = await mount({
      settings: { notifyTaskDone: false, notifySound: false, configFile: "/legacy/config.json" },
    });

    // 割接在装配期同步走完：装配返回时读面已经是割接后的形态，不需要轮询。
    expect(configApi.readConfig().notifyTaskDone).toBe(false);
    const stored = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    expect(stored.notifyTaskDone).toBe(false);
    // 旧键搬完即删：文件里只留条目一处表达
    expect("notifySound" in stored).toBe(false);
    // 两条内置条目被割接出来，旧的全局音效键摊到各自的 `sound` 上。
    expect(stored.channels).toEqual([
      { type: "browser", id: "browser", sound: false },
      { type: "system", id: "system", sound: false },
    ]);
    // 装配键（configFile）不进新配置：它在旧格式里就属于组合层的启动参数。
    expect("configFile" in stored).toBe(false);
    await unmount();
  });

  it("服务缺席即不装配：缺 settings 的 inject 门一步都不走，配置原样躺着；就绪后同一次装配里割接", async () => {
    rmSync(versionFile, { force: true });
    const root = new Context();
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    root.provide("webServer", host.service);
    const fiber = await root.plugin(notifier);
    live = fiber;
    await settleMicrotasks();

    // 缺依赖：装配没跑，也就没有人去读写配置——种下的那份逐字未动。
    expect(host.routes).toHaveLength(0);
    expect(root.get("wingsky.notifier", false)).toBeUndefined();
    expect(readFileSync(configFile, "utf8")).toBe(seededConfig());

    // 服务随后就绪：装配开始，割接与它同一次走完。
    root.provide("settings", fakeSettings({ notifyTaskDone: false }));
    await fiber.await();
    expect(host.routes).toHaveLength(ROUTE_PATHS.length);
    const stored = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    expect(stored.notifyTaskDone).toBe(false);
  });

  it("名字对不上与卸载后到来的服务都不触发割接（inject 认的是服务名，不是形状）", async () => {
    rmSync(versionFile, { force: true });
    const root = new Context();
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    root.provide("webServer", host.service);
    const fiber = await root.plugin(notifier);

    // ① 名字对不上：另一个恰好也带 describe 的服务不满足 inject，装配一步都不走。
    root.provide("otherHostService", fakeSettings({ notifyTaskDone: false }));
    await settleMicrotasks();
    expect(host.routes).toHaveLength(0);

    // ② 卸载之后才来的真服务：装配体已卸载，不会再被拉起来。
    await fiber.dispose();
    root.provide("settings", fakeSettings({ notifyTaskDone: false }));
    await settleMicrotasks();
    expect(host.routes).toHaveLength(0);
    expect(root.get("wingsky.notifier", false)).toBeUndefined();

    // 否定判据要一个界碑：config 域的写队列串行，本用例自己排一次队，它的落盘即此前全部落盘。
    const written = await configApi.writeConfig({ maxConnections: 5 });
    expect(written.ok).toBe(true);
    const stored = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    expect("notifyTaskDone" in stored).toBe(false);
    expect(stored.maxConnections).toBe(5);
  });
});

describe("释放", () => {
  it("卸载逆序：api 域先放（摘路由时设置读面与服务面都还在），服务面随 sdk 域最后消失", async () => {
    const { root, host, unmount } = await mount({});
    await unmount();

    // 摘除发生在 api 域释放的那一刻。正序释放会让 config 域（先于 api 装配）已经放开入参，
    // 症状是「api 域在别人已放开的入参上继续服务」——这里读到的就是那个入参。
    expect(host.removals).toHaveLength(ROUTE_PATHS.length);
    for (const removal of host.removals) {
      expect(removal.configDays).toBe(7);
      expect(removal.serviceAlive).toBe(true);
    }
    // 全链走完之后：服务面收回、设置回落默认（config 域也释放了）。
    expect(root.get("wingsky.notifier", false)).toBeUndefined();
    expect(configApi.readConfig().historyMaxAgeDays).toBe(0);
  });

  it("卸载后事件与提交都不再进管线：没有新的历史落盘", async () => {
    const { root, warns, unmount } = await mount({});
    const payload = {
      agent: fakeAgent("itest-unload"),
      turn: 1,
      step: 1,
      error: new Error("炸了"),
    };
    root.emit("agent/error", payload);
    await pollUntil(() => countKind("error") === 1, "卸载前的归档");
    const service = root.get("wingsky.notifier", false);

    await unmount();
    root.emit("agent/error", payload);
    // 消费方可能握着卸载前的服务引用：那时 submit 必须被丢弃（不抛），而不是写进一个已释放的域。
    await service?.send({ kind: "done", body: "卸载后发送" });

    // 否定判据要界碑：重新装配一次，用 stores 域自己的写口排队，界碑落盘即此前排队的写入全部落盘
    // ——卸载后若真有人在服务且还写得动磁盘，那条 done 会排在界碑之前浮现。
    const again = await mount({});
    await settleHistory();
    expect(countKind("error")).toBe(1);
    expect(countKind("done")).toBe(0);
    // 光看历史不够：卸载后 stores 的写会被它自己的 UNINSTALLED 出口吞掉，泄漏的请求于是「写了但没
    // 落下」。投递那条路不会静默——真跑到投递层会撞上「投递块尚未装配」并出声，而界碑（pollUntil
    // 至少等过一个定时器）已保证在飞的那条链全部落定，所以这里读 warn 不是抢跑。
    expect(warns.filter((line) => line.includes("投递失败"))).toEqual([]);
    await again.unmount();
  });

  it("宿主 webServer 被收回（热重载）：本插件随之卸载，路由全部摘除、服务面收回", async () => {
    const root = new Context();
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    const webServer = root.provide("webServer", host.service);
    root.provide("settings", fakeSettings({}));
    const fiber = await root.plugin(notifier);
    live = fiber;
    expect(host.routes).toHaveLength(ROUTE_PATHS.length);

    // 宿主收回服务：依赖它的 fiber 必须自己卸载——挂着不走的症状是「宿主已经换了 webServer，
    // 旧路由还挂在新服务器上」，而插件看起来一切正常。
    await webServer();
    live = null;
    expect(host.removals.map((removal) => removal.path).sort()).toEqual([...ROUTE_PATHS].sort());
    expect(root.get("wingsky.notifier", false)).toBeUndefined();
  });

  it("单个域释放失败不阻断其余：一条路由摘除抛错，卸载链照样走完", async () => {
    const root = new Context();
    // 第 3 条摘除器抛错：宿主摘不掉路由是真实会发生的（路由已被别人摘掉、宿主换实现），
    // api 域的释放循环会停在它那里，而组合根的安全释放壳必须继续走完 sdk / events /
    // pipeline / stores / config——否则一次清理失败就拖垮整条卸载链。
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }), { failAt: 3 });
    root.provide("webServer", host.service);
    root.provide("settings", fakeSettings({}));
    const fiber = await root.plugin(notifier);
    live = fiber;

    await fiber.dispose();
    live = null;
    expect(host.removals).toHaveLength(3);
    // 链走完的两个凭据：服务面收回（sdk 域放过了）与设置回落默认（config 域也放过了）。
    // api 域停在半释放状态的收尾由 `afterEach` 无条件做（见那里的注释：用例内补偿会被断言红跳过）。
    expect(root.get("wingsky.notifier", false)).toBeUndefined();
    expect(configApi.readConfig().historyMaxAgeDays).toBe(0);
  });
});

/**
 * 隔离自证：本节全部落盘都必须住进临时 DSH_HOME。
 *
 * 它守的是本文件的**红线纪律**：单例在模块加载期定死路径，一旦动态 `import()` 排到了
 * `tempDshHome()` 之前，三个域的写入就全进真实 `~/.dsh`（正在跑的 `dsh web` 的 home），
 * 而那时下面这些读会当场落空。
 */
describe("落盘隔离", () => {
  it("历史、配置、序号三个域的文件都落在临时 DSH_HOME 的包私有目录里", async () => {
    const { root, unmount } = await mount({});
    root.emit("agent/error", {
      agent: fakeAgent("itest-home"),
      turn: 1,
      step: 1,
      error: new Error("炸了"),
    });
    await pollUntil(() => countKind("error") === 1, "归档落盘");
    await pollUntil(() => seqValue() === seqAnchor + 1, "序号落盘");

    // 路径同源：三个域名下的文件都是 `notifierFile()` 从同一个 DSH_HOME 拼出来的。
    expect(historyFile).toBe(join(storageDir, sharedApi.HISTORY_FILE_NAME));
    expect(configFile).toBe(join(storageDir, sharedApi.CONFIG_FILE_NAME));
    // 原子写会先落一个同目录临时文件（`<目标>.tmp-<pid>`），status 的防抖落盘可能正在飞：那是
    // 实现的中间物，不是布局的一部分，剔掉再比对。**要轮询**：清单在防抖窗口内本来就不齐，
    // 直接比会读到「前一个用例留下的文件」而看不出状态落盘整条坏掉（实测：把 status 的 debounce
    // 写改成永不执行，e2e 那条红、这条不轮询的版本全绿）。
    await pollUntil(() => {
      const names = readdirSync(storageDir).filter((name) => !name.includes(".tmp-"));
      return names.length === 5 && names.includes(sharedApi.STATUS_FILE_NAME);
    }, "五个存储文件落齐");
    expect(
      readdirSync(storageDir)
        .filter((name) => !name.includes(".tmp-"))
        .sort(),
    ).toEqual([
      sharedApi.CONFIG_FILE_NAME,
      sharedApi.HISTORY_FILE_NAME,
      sharedApi.SEQ_FILE_NAME,
      sharedApi.STATUS_FILE_NAME,
      sharedApi.VERSION_FILE_NAME,
    ]);
    // 内容也要对：路径存在不代表这次投递真的写进去了（status 是防抖落盘的，初值 `{}` 会先出现）。
    await pollUntil(() => {
      try {
        return readFileSync(join(storageDir, sharedApi.STATUS_FILE_NAME), "utf8").includes(
          "browser",
        );
      } catch {
        return false;
      }
    }, "状态里出现本次投递的频道");
    // 配置读的是本用例种下的那份（临时目录里的），落的历史也是本次 run 写的。
    expect(configApi.readConfig().historyMaxAgeDays).toBe(7);
    expect(readFileSync(historyFile, "utf8")).toContain('"kind":"error"');
    await unmount();
  });
});
