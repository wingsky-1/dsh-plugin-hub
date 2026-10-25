/** 真实 Context 的完成证据、settings 割接与释放；隔离和清理沿用原专属夹具。 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { DEFAULT_CONFIG } from "../../src/server/config/impl/model/index.ts";
import { pollUntil, settleMicrotasks } from "../helpers.ts";
import {
  BASE_SETTINGS,
  ROUTE_PATHS,
  SENTINEL_KIND,
  configApi,
  configFile,
  countKind,
  fakeAgent,
  fakeAgents,
  fakeSession,
  fakeSettings,
  fakeWebServer,
  historyFile,
  historyLines,
  home,
  kindLine,
  mount,
  mounted,
  notifier,
  seed,
  seededConfig,
  seqAnchor,
  seqValue,
  settleHistory,
  sharedApi,
  storageDir,
  titleEvent,
  turnEndEvent,
  versionFile,
} from "./real-context-support.ts";

/**
 * 新增会话事件（job/registered、job/settled、working-directory/change）的官方 payload 形状
 * （来源：dsh-jobs-local / dsh-working-directory 的 session.append(...) 调用；notifier 只读事件
 * type，这里保留可核验的字段以便对照官方产物）。
 */
function jobRegisteredEvent(owner: string): SessionEvent {
  return {
    type: "job/registered",
    data: { jobId: "job-done", owner, kind: "bash", label: "sleep 5", startedAt: 1 },
  } as unknown as SessionEvent;
}

function jobSettledEvent(owner: string): SessionEvent {
  return {
    type: "job/settled",
    data: {
      jobId: "job-done",
      owner,
      kind: "bash",
      label: "sleep 5",
      startedAt: 1,
      finishedAt: 2,
      status: "completed",
      cause: "producer",
      producerReported: true,
    },
  } as unknown as SessionEvent;
}

function workingDirectoryChangeEvent(cwd: string): SessionEvent {
  return { type: "working-directory/change", data: { cwd } } as unknown as SessionEvent;
}

/**
 * 事件链契约：**顺序**与**会话日志里的新增事件类型**是本节唯一的判据面。
 *
 * 事件顺序取自宿主生产代码，不是推测：
 * 1. dsh-agent-loop 的 turn() 在普通结束路径上先 serial("agent/turn-stopping")，再在 finally
 *    里 session.append("turn/end")；kick() 的最后才把 phase 置回 idle 并派发 agent/status: idle。
 *    所以真实顺序是 turn-stopping → turn/end → idle。
 * 2. 失败/取消路径不派发 turn-stopping（异常在 turn() 的 catch 分支直接落到 finally 的
 *    turn/end），因此失败链只有 agent/error（失败时）+ turn/end + idle。
 * 3. dsh-session.append() 在把事件推入日志的同一同步段派发 session/event，所以 turn/end 的
 *    推送证据一定先于 idle 到达。
 * 4. job/registered、job/settled、working-directory/change 也会进入会话日志词汇；
 *    dsh-session-title 的标题是**异步追加**的，可以落在 turn/end 之后。
 *
 * 下面的用例只钉这些组合下的完成判定与通知行为；单点判定（去重、快照冻结、子代理归属）
 * 仍由 test/unit/events/* 负责。
 */
function registerCompletionEvidence(): void {
  it("正常完成：turn-stopping → turn/end → idle 产出 turn-end 与 done，标题取自 session/title", async () => {
    seed({ ...BASE_SETTINGS, notifyTurnEnd: true });
    const { root, unmount } = await mount({});
    const signal = new AbortController().signal;
    const events: SessionEvent[] = [];
    const agent = fakeAgent("itest-complete", events);
    const session = fakeSession("itest-complete");

    root.emit("agent/status", { agent, status: "running" });
    // 标题既经 session/event 推送、也必须真的在日志快照里：任务名是从日志读的，不是从推送读的。
    const title = titleEvent("任务标题");
    events.push(title);
    root.emit("session/event", session, title);
    // turn-stopping 先于 turn/end 追加。
    root.emit("agent/turn-stopping", { agent, turn: 1, signal });
    events.push(turnEndEvent(1, "completed"));
    root.emit("session/event", session, turnEndEvent(1, "completed"));
    root.emit("agent/status", { agent, status: "idle" });

    await pollUntil(() => countKind("done") === 1, "完成通知落史");
    // 界碑：历史写队列串行，界碑可见 = 此前排队的行都已落盘，顺序判据才不是抢跑得来的。
    await settleHistory();
    const kindOrder = historyLines()
      .map((line) => line.kind)
      .filter((kind) => kind !== SENTINEL_KIND);
    // 顺序本身就是契约：turn-end 在 idle 结算（done）之前就已经产生。
    expect(kindOrder).toEqual(["turn-end", "done"]);
    expect(kindLine("done")?.message).toContain("任务标题");
    expect(countKind("done")).toBe(1);
    await unmount();
  });

  it("尾随的新增会话事件（job/*、working-directory/change）不改写完成判定与标题", async () => {
    const { root, unmount } = await mount({});
    const events: SessionEvent[] = [titleEvent("带尾随事件的任务"), turnEndEvent(1, "completed")];
    // header.cwd 是**原始项目目录**；working-directory/change 的 cwd 是当前目录。两者不是同一字段，
    // 本插件也不读它——判据是「切换目录后标题与结束证据的读取不变」，不是把两个字段当成一个。
    const agent = fakeAgent("itest-tail-events", events, { cwd: "/proj/original" });
    const session = fakeSession("itest-tail-events");

    root.emit("agent/status", { agent, status: "running" });
    root.emit("session/event", session, turnEndEvent(1, "completed"));
    // 这些事件会与 turn/end 交错追加进同一份日志，且可以落在 idle 之前。
    events.push(
      jobRegisteredEvent("itest-tail-events"),
      workingDirectoryChangeEvent("/proj/moved"),
      jobSettledEvent("itest-tail-events"),
    );
    root.emit("agent/status", { agent, status: "idle" });

    await pollUntil(() => countKind("done") === 1, "尾随新事件下的完成通知");
    await settleHistory();
    expect(countKind("done")).toBe(1);
    expect(kindLine("done")?.message).toContain("带尾随事件的任务");
    // 新事件本身不是通知：日志里没有以它们为 kind 的历史行。
    const kinds = historyLines().map((line) => line.kind ?? "");
    expect(
      kinds.some((kind) => kind.startsWith("job/") || kind === "working-directory/change"),
    ).toBe(false);
    // fixture 前提：两个目录字段确实不同（否则上面的「不读 header.cwd」判据没有意义）。
    expect(agent.session.header.cwd).toBe("/proj/original");
    await unmount();
  });

  it("turn/end 之后才追加的 session/title 仍被完成通知读到（标题异步追加）", async () => {
    const { root, unmount } = await mount({});
    const events: SessionEvent[] = [turnEndEvent(2, "completed")];
    const agent = fakeAgent("itest-late-title", events);
    const session = fakeSession("itest-late-title");

    root.emit("agent/status", { agent, status: "running" });
    root.emit("session/event", session, turnEndEvent(2, "completed"));
    // 官方 session-title 的 provider/fallback 都是异步追加：标题可能比 turn/end 更晚落日志。
    events.push(titleEvent("后到的标题"));
    root.emit("agent/status", { agent, status: "idle" });

    await pollUntil(() => countKind("done") === 1, "后到标题下的完成通知");
    expect(kindLine("done")?.message).toContain("后到的标题");
    await unmount();
  });
}

function registerFailureCancellationAndReplay(): void {
  it("失败链：agent/error → turn/end(error) → idle 只报 error，不改报 done", async () => {
    const { root, warns, unmount } = await mount({});
    const events: SessionEvent[] = [titleEvent("会失败的任务")];
    const agent = fakeAgent("itest-error-chain", events);
    const session = fakeSession("itest-error-chain");

    root.emit("agent/status", { agent, status: "running" });
    root.emit("agent/error", { agent, turn: 2, step: 1, error: new Error("模型调用失败") });
    events.push(turnEndEvent(2, "error"));
    root.emit("session/event", session, turnEndEvent(2, "error"));
    root.emit("agent/status", { agent, status: "idle" });

    await pollUntil(() => countKind("error") === 1, "错误通知落史");
    await settleHistory();
    expect(countKind("error")).toBe(1);
    // 失败绝不能被误报成完成：这就是完成判定只看 kind 的那条分支。
    expect(countKind("done")).toBe(0);
    // 这里刻意不断言 turn-end：本链从未派发 agent/turn-stopping，而 turn-end 只由该事件的翻译
    // 产出，计数恒为 0 与失败链判定无关；写了反而会被误读成这条链的 turn-end 语义已有覆盖。
    expect(kindLine("error")?.message).toContain("模型调用失败");
    expect(warns.some((line) => line.includes("完成判定跳过") && line.includes("kind=error"))).toBe(
      true,
    );
    await unmount();
  });

  it("取消链：turn/end(aborted) → idle 不产出 done 或 error，并留下跳过诊断", async () => {
    const { root, warns, unmount } = await mount({});
    const events: SessionEvent[] = [];
    const agent = fakeAgent("itest-abort-chain", events);
    const session = fakeSession("itest-abort-chain");

    root.emit("agent/status", { agent, status: "running" });
    // 取消不派发 agent/error：turn() 的 catch 认出 abortedCancelCause 后直接以 turn/end 收尾。
    events.push(turnEndEvent(3, "aborted"));
    root.emit("session/event", session, turnEndEvent(3, "aborted"));
    root.emit("agent/status", { agent, status: "idle" });

    await settleHistory();
    expect(countKind("done")).toBe(0);
    expect(countKind("error")).toBe(0);
    expect(
      warns.some((line) => line.includes("完成判定跳过") && line.includes("kind=aborted")),
    ).toBe(true);
    await unmount();
  });

  it("重放/重复事件：完成后重新进入 running 再重放同一 turn/end，完成通知仍只有一条", async () => {
    const { root, warns, unmount } = await mount({});
    const events: SessionEvent[] = [];
    const agent = fakeAgent("itest-replay", events);
    const session = fakeSession("itest-replay");
    const completed = turnEndEvent(4, "completed");

    root.emit("agent/status", { agent, status: "running" });
    events.push(completed);
    root.emit("session/event", session, completed);
    // 重放同一条证据（断线补拉/重复读取的语义）：记录的是同一 turn，不能被当成第二次完成。
    root.emit("session/event", session, completed);
    root.emit("agent/status", { agent, status: "idle" });
    root.emit("agent/status", { agent, status: "idle" });
    await pollUntil(() => countKind("done") === 1, "重放下的完成通知");

    // 首次 done 之后重新进入 running，再重放同一条 completed：这一轮 running 标记重新置位，
    // 必然进入结算，唯一能挡住第二条 done 的就是「turn 不比记忆里的新」这条去重判据。
    root.emit("agent/status", { agent, status: "running" });
    root.emit("session/event", session, completed);
    root.emit("agent/status", { agent, status: "idle" });

    await settleHistory();
    expect(countKind("done")).toBe(1);
    // 诊断能证伪「没进结算」：重放那一轮确实结算过，并被同一 turn 挡下（而不是被 running 标记跳过）。
    expect(
      warns.some(
        (line) =>
          line.includes("完成判定跳过") &&
          line.includes("推送turn=4") &&
          line.includes("记忆turn=4"),
      ),
    ).toBe(true);
    await unmount();
  });

  it("子代理与主代理事件交错：子代理完成落 subagent-done，不覆盖主任务完成", async () => {
    const parentEvents: SessionEvent[] = [];
    const parent = fakeAgent("itest-main", parentEvents, {});
    const childEvents: SessionEvent[] = [];
    const child = fakeAgent("itest-main-child", childEvents, {
      parentSession: "itest-main",
      origin: "subagent",
    });
    const { root, unmount } = await mount({ services: { agents: fakeAgents(parent, child) } });

    // 交错到达：父任务 running 期间子代理先完成，然后父任务才完成。
    root.emit("agent/status", { agent: parent, status: "running" });
    root.emit("agent/status", { agent: child, status: "running" });
    childEvents.push(titleEvent("子任务"), turnEndEvent(1, "completed"));
    root.emit("session/event", fakeSession("itest-main-child"), turnEndEvent(1, "completed"));
    root.emit("agent/status", { agent: child, status: "idle" });
    await pollUntil(() => countKind("subagent-done") === 1, "子代理完成通知");

    parentEvents.push(turnEndEvent(1, "completed"));
    root.emit("session/event", fakeSession("itest-main"), turnEndEvent(1, "completed"));
    root.emit("agent/status", { agent: parent, status: "idle" });

    await pollUntil(() => countKind("done") === 1, "主任务完成通知");
    expect(countKind("subagent-done")).toBe(1);
    expect(countKind("done")).toBe(1);
    await unmount();
  });
}

describe("新增会话事件下的完成证据与生命周期契约", () => {
  registerCompletionEvidence();
  registerFailureCancellationAndReplay();
});

describe("宿主 settings 服务：装配期同步割接存量配置", () => {
  /**
   * 链跑完之后磁盘上两条内置条目的形态（0.2.4 割接 + 0.2.9 形态清理的**终态**）。
   *
   * 逐字取自默认表而不是手抄：0.2.9 的补齐值就是默认表的值（#1016 P1-1），同源由 steps.test.ts 钉住。
   * `over` 用来表达「用户当年在旧顶层键上表过态」的字段——它必须是**用户那个值**而不是默认值，
   * 否则这条用例就分不出「搬了旧键」与「补了默认」。
   */
  function builtinEntries(over: Record<string, unknown>): unknown[] {
    return DEFAULT_CONFIG.channels.map((channel) => ({ ...channel, ...over }));
  }

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
    // 两条内置条目被割接出来，旧的全局音效键摊到各自的 `sound` 上；其余字段由 0.2.9 的形态清理
    // 按默认表补齐（#1016 P1-1）——所以这里是**链的终态**，不是 0.2.4 那一步的中间形态。
    expect(stored.channels).toEqual(builtinEntries({ sound: false }));
    // 装配键（configFile）不进新配置：它在旧格式里就属于组合层的启动参数。
    expect("configFile" in stored).toBe(false);
    await unmount();
  });

  it("命名空间未注册时也能割接：存量只在 DSH_HOME 正式 settings.yaml 里", async () => {
    rmSync(versionFile, { force: true });
    rmSync(configFile, { force: true });
    writeFileSync(
      join(home.dir, "settings.yaml"),
      "dsh-notifier:\n  notifyTaskDone: false\n  notifySound: false\n",
      "utf8",
    );
    // `settings` 缺省 = 服务面里没有这条命名空间（新架构不注册它）：正式文件仍直接提供存量。
    const { unmount } = await mount({});

    const stored = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    expect(stored.notifyTaskDone).toBe(false);
    // 旧键搬完即删，且装配键不进新配置。
    expect("notifySound" in stored).toBe(false);
    expect(stored.channels).toEqual(builtinEntries({ sound: false }));
    await unmount();
  });

  it("服务缺席即不装配：缺 settings 的 inject 门一步都不走，配置原样躺着；就绪后同一次装配里割接", async () => {
    rmSync(versionFile, { force: true });
    const root = new Context();
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    root.provide("webServer", host.service);
    const fiber = await root.plugin(notifier);
    mounted.live = fiber;
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
    const written = await configApi.writeConfig({ historyMaxAgeDays: 5 });
    expect(written.ok).toBe(true);
    const stored = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    expect("notifyTaskDone" in stored).toBe(false);
    expect(stored.historyMaxAgeDays).toBe(5);
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
    mounted.live = fiber;
    expect(host.routes).toHaveLength(ROUTE_PATHS.length);

    // 宿主收回服务：依赖它的 fiber 必须自己卸载——挂着不走的症状是「宿主已经换了 webServer，
    // 旧路由还挂在新服务器上」，而插件看起来一切正常。
    await webServer();
    mounted.live = null;
    expect(host.removals.map((removal) => removal.path).sort()).toEqual([...ROUTE_PATHS].sort());
    expect(root.get("wingsky.notifier", false)).toBeUndefined();
  });

  it("单个域释放失败不阻断其余：一条路由摘除抛错，卸载链照样走完", async () => {
    const root = new Context();
    // 第 3 条摘除器抛错：宿主摘不掉路由是真实会发生的（路由已被别人摘掉、宿主换实现），
    // 组合根的安全释放壳必须继续走完 sdk / events / pipeline / stores / config——否则一次清理
    // 失败就拖垮整条卸载链。
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }), { failAt: 3 });
    root.provide("webServer", host.service);
    root.provide("settings", fakeSettings({}));
    const fiber = await root.plugin(notifier);
    mounted.live = fiber;

    await fiber.dispose();
    mounted.live = null;
    // 两层隔离都在这里看得见：**域内**逐条摘除互不阻断（8 条路由全摘，抛错那条自己已记账），
    // **组合根**的释放壳也不被这个失败拖住（下面两个凭据）。缺了域内那层，这里会是 3。
    expect(host.removals.map((removal) => removal.path).sort()).toEqual([...ROUTE_PATHS].sort());
    // 链走完的两个凭据：服务面收回（sdk 域放过了）与设置回落默认（config 域也放过了）。
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
