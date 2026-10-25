/**
 * dsh-notifier — 组合根（`src/index.ts`）的真实 cordis Context 集成测试。
 *
 * 面口径：这里测的是**宿主看见的那一面**——`apply` 收窄宿主上下文、按序装配八个域、卸载逆序释放；
 * 「按序」里唯一在运行期无观测量的那一段（升级链 await 跑完才轮到读文件的域）以源码文本先后锁定。
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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import type { Events, Fiber, ThisType as EventThis } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionAnswer } from "@deepseek-ai/dsh-user-questions";

import { jsonReq, makeRes, pollUntil, tempDshHome } from "../helpers.ts";

// DSH_HOME 必须先于被测模块求值：三个单例的落盘路径在构造时定下，而静态 import 会在任何语句
// 之前执行——顺序反了，本节全部落盘就写进真实 `~/.dsh`。
export const home = tempDshHome();
export const notifier = await import("../../src/index.ts");
const apiApi = await import("../../src/server/api/interface.ts");
export const configApi = await import("../../src/server/config/interface.ts");
export const sdkApi = await import("../../src/server/sdk/interface.ts");
const storesApi = await import("../../src/server/stores/interface.ts");
export const sharedApi = await import("../../src/server/shared/interface.ts");

/** 本插件的落盘位置（新布局：包私有目录，见 `shared/paths.ts`）。 */
export const storageDir = join(home.dir, "@wingsky-1", "dsh-notifier");
export const configFile = sharedApi.notifierFile(sharedApi.CONFIG_FILE_NAME);
export const historyFile = sharedApi.notifierFile(sharedApi.HISTORY_FILE_NAME);
const seqFile = sharedApi.notifierFile(sharedApi.SEQ_FILE_NAME);
export const versionFile = sharedApi.notifierFile(sharedApi.VERSION_FILE_NAME);

/** 种下的那份配置的原文：否定判据用它比对「一个字节都没动过」。 */
export function seededConfig(): string {
  return `${JSON.stringify(BASE_SETTINGS, null, 2)}\n`;
}

/** 宿主契约冻结的 8 条浏览器端点（客户端锁定，独立抄写才守得住改路径）。 */
export const ROUTE_PATHS: readonly string[] = [
  "/api/dsh-notifier/config",
  "/api/dsh-notifier/history",
  "/api/dsh-notifier/status",
  "/api/dsh-notifier/kinds",
  "/api/dsh-notifier/test",
  "/api/dsh-notifier/health",
  "/api/dsh-notifier/diagnostics",
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
export const BASE_SETTINGS = {
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
  title?: string;
  message?: string;
  suppressed?: string;
  channels?: ReadonlyArray<{ channelId: string; status: string }>;
}

/** 磁盘上的历史记录。 */
export function historyLines(): HistoryLine[] {
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
export function countKind(kind: string): number {
  return historyLines().filter((line) => line.kind === kind).length;
}

/** 磁盘上第一条某一种通知：`beforeEach` 清过历史，所以不受上一个用例干扰。 */
export function kindLine(kind: string): HistoryLine | undefined {
  return historyLines().find((line) => line.kind === kind);
}

/** 同一 kind 的第 N 条记录：动态 locale 用例要在同一次装配里比较前后两份文案。 */
export function kindLines(kind: string): HistoryLine[] {
  return historyLines().filter((line) => line.kind === kind);
}

/** 界碑用的种类名：只出现在界碑行里，任何通知判据都不会撞上它。 */
export const SENTINEL_KIND = "itest-sentinel";

/**
 * 排一次界碑并等它落盘，用来给**否定**判据划界。
 *
 * 写队列串行，界碑在磁盘上可见即此前排队的写入全部落盘；没有界碑的「没有新记录」只是抢跑得来的
 * ——它证明的是「还没写完」，不是「不会写」。
 */
export async function settleHistory(): Promise<void> {
  storesApi.appendHistory({ ts: Date.now(), kind: SENTINEL_KIND, title: "界碑", message: "-" });
  await pollUntil(() => historyLines().some((line) => line.kind === SENTINEL_KIND), "界碑落盘");
}

/** 浏览器出口的序号：`seq.json` 前进一格 = 帧真的走完了 FrameBus → api 域 → 流。 */
export function seqValue(): number {
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
export let seqAnchor = 0;

function seedSeqAnchor(): void {
  seqAnchor += 1000;
  mkdirSync(dirname(seqFile), { recursive: true });
  writeFileSync(seqFile, `${seqAnchor}\n`);
}

/** 写一份设置文件（组合根装配时同步读它，故必须用同步写）。 */
export function seed(settings: Record<string, unknown>): void {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(settings, null, 2)}\n`);
}

/** 假会话日志条目：本块只读 `type` 与 `data`（与 events 域单测同一口径）。 */
export function turnEndEvent(turn: number, kind: string): SessionEvent {
  return { type: "turn/end", data: { turn, reason: { kind } } } as unknown as SessionEvent;
}

/** 假 agent：只露出 events 域真的会读的几处（`id` 与 `session` 的 header / 日志快照）。 */
export function fakeAgent(
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
export function fakeSession(id: string): Session {
  return { id } as unknown as Session;
}

/**
 * 宿主按作用域派发时传的 `this`：`agent/*` 声明的是 `Scoped<Agent>`、`session/event` 是
 * `Scoped<Session>`，而那个 brand 不是本包的依赖，故从事件签名上取 `this` 位。测试要造的正是
 * `{ [Context.filter]: … }` 这一个成员——直接抄 `Scoped<…>` 会把它变成第二份事实源。
 */
type ScopedThis<K extends keyof Events> = EventThis<Events[K]>;

/** 作用域收紧的派发载体：filter 恒假，于是**只有** `{ global: true }` 的订阅能收到。 */
export function scopeRejecting<K extends keyof Events>(): ScopedThis<K> {
  return { [Context.filter]: () => false } as unknown as ScopedThis<K>;
}

/**
 * 假 settings 服务只提供 describe 低优先级兜底；正式历史来源由 upgrade 域直接读取 DSH_HOME 双文件。
 * `describe()` 在真实宿主里只列**已注册**的命名空间，所以这里的 `user` 用三种取值对应三种真实形态：
 * `undefined` = 没注册这条命名空间（新架构的常态，服务面读不到）；`{}` = 注册了但 user 层为空；有键 = 注册且用户设过。
 */
export function fakeSettings(
  user: Record<string, unknown> | undefined,
  locale?: () => { readonly value?: unknown },
): { describe: () => unknown[] } {
  return {
    describe: () => {
      const entries = user === undefined ? [] : [{ ns: "dsh-notifier", value: user, user }];
      if (locale === undefined) return entries;
      return [
        ...entries,
        {
          ns: "locale",
          value: locale().value,
          user: { preference: "zh" },
        },
      ];
    },
  };
}

/**
 * 假宿主 webServer：只实现组合根够得着的那一面（`register`），并记下摘除时的现场。
 *
 * `failAt` 让第 N 条摘除器抛错——宿主摘路由失败是真实会发生的（路由已被别人摘掉、宿主换实现），
 * 组合根的释放壳对它的承诺是「不阻断其余」。
 */
export function fakeWebServer(
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
export function fakeAgents(parent: Agent, child: Agent): Context["agents"] {
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
export function captureWarnings(root: Context): string[] {
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
export const mounted: { live: Fiber | null } = { live: null };

/**
 * 按宿主的真实挂载顺序装配：先 provide 宿主服务，再 `ctx.plugin(插件)`。
 *
 * `settings` 是本插件的**显式依赖**（组合根的 `inject`）：宿主保证它在插件装配前就绪，所以这里
 * 总是先 provide 一个假的；`settings` 的值就是那份 0.2.3 存量命名空间的 user 层（缺省 = 有服务
 * 但没存量）。「服务没来」这条分支已不属于本插件——它变成 cordis 的 inject 门（见 inject 门用例）。
 * `services` 是其余宿主服务（如 `agents`）——装与不装是两条不同的判定路径。
 */
export async function mount(options: {
  config?: { enabled?: boolean };
  settings?: Record<string, unknown>;
  locale?: () => { readonly value?: unknown };
  services?: Record<string, unknown>;
}): Promise<Mounted> {
  const root = new Context();
  root.provide("settings", fakeSettings(options.settings, options.locale));
  for (const [name, value] of Object.entries(options.services ?? {})) root.provide(name, value);
  const warns = captureWarnings(root);
  const host = fakeWebServer(() => ({
    configDays: configApi.readConfig().historyMaxAgeDays,
    serviceAlive: root.get("wingsky.notifier", false) !== undefined,
  }));
  root.provide("webServer", host.service);
  const fiber = await root.plugin(notifier, options.config);
  mounted.live = fiber;
  return {
    root,
    fiber,
    host,
    warns,
    unmount: async () => {
      mounted.live = null;
      await fiber.dispose();
    },
  };
}

/** 走组合根实际注册的路由，验证测试按钮端点也使用按请求现读的 locale。 */
export async function postTestNotification(routes: readonly WebRoute[]): Promise<void> {
  const path = "/api/dsh-notifier/test";
  const route = routes.find((item) => item.path === path);
  if (route === undefined) throw new Error(`路由未注册: ${path}`);
  const request = jsonReq({ method: "POST", url: path, body: {} }) as IncomingMessage;
  const captured = makeRes();
  route.handler(request, captured.res);
  await pollUntil(() => captured.rec.headersSent, `${path} 未写出响应`);
  expect(captured.rec.status).toBe(200);
}

/**
 * 模拟宿主内置 answerer：链上**更早注册**的那一个，它给出的判定就是这次请求的最终结果。
 * 它不调 `next()`——宿主自己的应答者拿到判定后即短路，这正是本插件必须 prepend 的理由。
 */
export async function mountApprovalAnswerer(
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
export async function mountQuestionAnswerer(
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

/** session/title 的官方数据形状（dsh-session-title：title / messageSeqs / source）。 */
export function titleEvent(title: string): SessionEvent {
  return {
    type: "session/title",
    data: { title, messageSeqs: [], source: { kind: "fallback" } },
  } as unknown as SessionEvent;
}

beforeEach(() => {
  // 单例的落盘路径跨用例不变，能重置的只有文件：不重置的话上一个用例的配置/历史就是本用例的起点。
  rmSync(historyFile, { force: true });
  rmSync(configFile, { force: true });
  // 正式历史来源也落在这个共享的临时 DSH_HOME 里；清掉双文件，避免上个用例的存量进入下个用例。
  rmSync(join(home.dir, "settings.yaml.imported"), { force: true });
  rmSync(join(home.dir, "settings.yaml"), { force: true });
  seedSeqAnchor();
  seed(BASE_SETTINGS);
});

afterEach(async () => {
  vi.useRealTimers();
  if (mounted.live) {
    const fiber = mounted.live;
    mounted.live = null;
    await fiber.dispose();
  }
  // 无条件补一次 api 域收尾：域释放幂等，正常用例上是空转。不放在用例里是因为用例前面任何一条
  // 断言红了就会跳过补偿（路由/心跳会漏到下一个用例，症状是「上一条用例弄脏了这条」）。
  apiApi.releaseApi();
});

afterAll(() => {
  home.dispose();
});
