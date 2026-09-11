// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e：用户提问通知（userQuestions 包装）与轮结束通知。
 *
 * 覆盖：internal/service 事件后包装 ask（this 绑定回归、返回值透传）、
 * 热重载解包重包不叠层、notifyQuestion=false 不通知；turn-stopping 默认关、
 * 开启后同一 (agent,turn) 去重、新轮次正常通知（serial 事件无 next 不抛错）。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier } from "../helpers.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-e2e-question-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const agentWithTitle = { id: "session-1", session: { snapshotEvents: () => [{ type: "session/title", data: { title: "提问测试" } }] } };

/**
 * 提问包装夹具：makeNotifier（userQuestions 读取面经覆盖 get 注入）+ 注册 service。
 * 每实例独立 history 文件（默认同路径会跨用例串写）。
 */
async function questionNotifier(tag: string, config: Record<string, unknown> = {}) {
  const infos: string[] = [];
  let fakeService: any = null;
  const { listeners } = await makeNotifier(work, { historyFile: join(work, `history-q-${tag}.jsonl`), ...config }, {
    logger: { warn: () => {}, info: (t) => infos.push(t) },
    get: (name) => (name === "userQuestions" ? fakeService : undefined),
  });
  const serviceHandler = listeners.get("internal/service")[0];
  return { infos, listeners, serviceHandler, getService: () => fakeService, setService: (s: any) => { fakeService = s; } };
}

/** 已包装的一次 ask（this 绑定回归用：ask 是依赖 this 的类方法风格）。 */
function makeService() {
  return {
    marker: "svc-marker",
    ask: async function () {
      return { answers: [this.marker] };
    },
  };
}

describe("用户提问通知：启动时未注册 → internal/service 到达后包装 ask", () => {
  it("internal/service 监听器已注册", async () => {
    const f = await questionNotifier("a");
    expect(f.serviceHandler).toBeTruthy();
  });

  it("包装不改变原 ask 返回值，且 this 正确绑定", async () => {
    const f = await questionNotifier("a");
    f.setService(makeService());
    f.serviceHandler("userQuestions", f.getService());
    const result = await f.getService().ask({ agent: agentWithTitle, questions: [{ question: "今天吃了吗？" }] });
    expect(result).toEqual({ answers: ["svc-marker"] });
  });

  it("提问触发通知", async () => {
    const f = await questionNotifier("a");
    f.setService(makeService());
    f.serviceHandler("userQuestions", f.getService());
    await f.getService().ask({ agent: agentWithTitle, questions: [{ question: "今天吃了吗？" }] });
    expect(f.infos.some((t) => /question/.test(t))).toBeTruthy();
  });

  it("提问通知带任务标题", async () => {
    const f = await questionNotifier("a");
    f.setService(makeService());
    f.serviceHandler("userQuestions", f.getService());
    await f.getService().ask({ agent: agentWithTitle, questions: [{ question: "今天吃了吗？" }] });
    expect(f.infos.some((t) => /任务「提问测试」需要你回答/.test(t))).toBeTruthy();
  });

  it("提问通知带问题摘要", async () => {
    const f = await questionNotifier("a");
    f.setService(makeService());
    f.serviceHandler("userQuestions", f.getService());
    await f.getService().ask({ agent: agentWithTitle, questions: [{ question: "今天吃了吗？" }] });
    expect(f.infos.some((t) => /问题：今天吃了吗？/.test(t))).toBeTruthy();
  });

  it("提问通知不暴露会话 id", async () => {
    const f = await questionNotifier("a");
    f.setService(makeService());
    f.serviceHandler("userQuestions", f.getService());
    await f.getService().ask({ agent: agentWithTitle, questions: [{ question: "今天吃了吗？" }] });
    expect(f.infos.some((t) => !t.includes("session-1"))).toBeTruthy();
  });
});

describe("用户提问通知：热重载安全（重复 internal/service 时解包重包）", () => {
  /** 序列：注册 + 首次 ask → 重复注册（解包重包）→ 二次 ask。 */
  async function rewrapped() {
    const f = await questionNotifier("b");
    f.setService(makeService());
    f.serviceHandler("userQuestions", f.getService());
    await f.getService().ask({ agent: agentWithTitle, questions: [{ question: "今天吃了吗？" }] });
    const askRef = f.getService().ask;
    f.serviceHandler("userQuestions", f.getService());
    const rewrappedFlag = f.getService().ask !== askRef;
    const infoCountBefore = f.infos.length;
    const result2 = await f.getService().ask({ agent: agentWithTitle, questions: [{ question: "再问一次？" }] });
    return { f, rewrappedFlag, infoCountBefore, result2 };
  }

  it("重复注册重新包装（解包旧包装）", async () => {
    expect((await rewrapped()).rewrappedFlag).toBe(true);
  });

  it("解包重包后 ask 返回值不变，this 绑定正确", async () => {
    expect((await rewrapped()).result2).toEqual({ answers: ["svc-marker"] });
  });

  it("解包重包不叠层，通知只发一次", async () => {
    const r = await rewrapped();
    expect(r.f.infos.length).toBe(r.infoCountBefore + 1);
  });
});

describe("用户提问通知：notifyQuestion=false 不通知", () => {
  it("notifyQuestion=false 不通知", async () => {
    // 用独立的 service 实例，避免闭包捕获上一实例的配置
    const f = await questionNotifier("c", { notifyQuestion: false });
    f.setService({ ask: async () => ({ answers: [] }) });
    f.serviceHandler("userQuestions", f.getService());
    await f.getService().ask({ agent: { id: "session-2" }, questions: [{ question: "hi" }] });
    expect(f.infos.length).toBe(0);
  });
});

/**
 * turn-stopping 夹具：默认配置实例（notifyTurnEnd 缺省关） + agent/turn-stopping 监听器。
 * config 覆盖 notifyTurnEnd 时得到对照实例。
 */
async function turnStopNotifier(tag: string, config: Record<string, unknown> = {}) {
  const infos: string[] = [];
  const { listeners } = await makeNotifier(work, { historyFile: join(work, `history-t-${tag}.jsonl`), ...config }, { logger: { warn: () => {}, info: (t) => infos.push(t) } });
  return { infos, turnStop: listeners.get("agent/turn-stopping")[0] };
}

// turn-stopping：serial 事件签名 cb(payload) 无 next——必须不抛错
describe("turn-stopping：默认不通知 + serial 事件无 next 不抛错", () => {
  it("turn-stopping 监听器已注册", async () => {
    expect((await turnStopNotifier("d")).turnStop).toBeTruthy();
  });

  it("serial 事件（无 next 参数）下监听器不抛错", async () => {
    const f = await turnStopNotifier("d");
    let threw = false;
    try {
      await f.turnStop({ agent: { id: "session-1" }, turn: 4 });
    } catch (error) {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("turn-stopping 默认不通知", async () => {
    const f = await turnStopNotifier("d");
    await f.turnStop({ agent: { id: "session-1" }, turn: 4 });
    expect(f.infos.length).toBe(0);
  });
});

describe("turn-stopping：notifyTurnEnd 开启后通知（配置经组合层 entry 生效）", () => {
  const agentWithEvents = { id: "session-1", session: { snapshotEvents: () => [{ type: "session/title", data: { title: "优化 notifier 插件" } }] } };

  async function firstTurnNotified() {
    const f = await turnStopNotifier("e", { notifyTurnEnd: true });
    await f.turnStop({ agent: agentWithEvents, turn: 4 });
    return f;
  }

  it("notifyTurnEnd 开启后 turn-stopping 触发通知", async () => {
    expect((await firstTurnNotified()).infos.some((t) => /turn-end/.test(t))).toBeTruthy();
  });

  it("轮次完成通知带任务标题与轮次号", async () => {
    expect((await firstTurnNotified()).infos.some((t) => /任务「优化 notifier 插件」第 4 轮工作已完成/.test(t))).toBeTruthy();
  });

  it("轮次完成通知不暴露会话 id", async () => {
    expect((await firstTurnNotified()).infos.some((t) => !t.includes("session-1"))).toBeTruthy();
  });
});

describe("turn-stopping：同轮去重 + 新轮次正常通知", () => {
  const agentWithEvents = { id: "session-1", session: { snapshotEvents: () => [{ type: "session/title", data: { title: "优化 notifier 插件" } }] } };

  /** 序列：首轮 emit(4)（计基线）→ 同轮重复 emit ×2 → 新轮 emit(5)。 */
  async function dedupRun() {
    const f = await turnStopNotifier("f", { notifyTurnEnd: true });
    await f.turnStop({ agent: agentWithEvents, turn: 4 });
    const countAfterFirst = f.infos.filter((t) => t.includes("turn-end")).length;
    // 同轮重复 emit（模拟事件被反复触发/热重载叠加）不重复通知——防「日志一堆」
    await f.turnStop({ agent: agentWithEvents, turn: 4 });
    await f.turnStop({ agent: agentWithEvents, turn: 4 });
    const countAfterRepeat = f.infos.filter((t) => t.includes("turn-end")).length;
    // 新的一轮（turn 5）仍正常通知
    await f.turnStop({ agent: agentWithEvents, turn: 5 });
    const countAfterNewTurn = f.infos.filter((t) => t.includes("turn-end")).length;
    return { countAfterFirst, countAfterRepeat, countAfterNewTurn };
  }

  it("同一 (agent,turn) 重复 turn-stopping 只通知一次", async () => {
    const r = await dedupRun();
    expect(r.countAfterRepeat).toBe(r.countAfterFirst);
  });

  it("新轮次仍正常通知", async () => {
    const r = await dedupRun();
    expect(r.countAfterNewTurn).toBe(r.countAfterFirst + 1);
  });
});
