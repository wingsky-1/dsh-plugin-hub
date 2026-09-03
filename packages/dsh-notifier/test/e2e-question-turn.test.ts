// @ts-nocheck
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
import { assert, makeNotifier } from "./helpers.ts";

const work = mkdtempSync(join(tmpdir(), "dnotify-e2e-question-"));
try {
  // 用户提问通知：包装 ctx.userQuestions.ask（internal/service 事件 + 热重载解包重包）
  {
    const infos = [];
    let fakeService = null;
    const { listeners } = await makeNotifier(work, { }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
      get: (name) => (name === "userQuestions" ? fakeService : undefined),
    });

    // 启动时 service 未注册 → 不包装；internal/service 事件到达后包装
    const serviceHandler = listeners.get("internal/service")[0];
    assert.ok(serviceHandler, "internal/service 监听器已注册");
    // 依赖 this 的类方法风格：验证包装后 this 仍绑定 service 实例（bind 回归测试）
    fakeService = {
      marker: "svc-marker",
      ask: async function (request) {
        return { answers: [this.marker] };
      },
    };
    serviceHandler("userQuestions", fakeService);

    const agent = { id: "session-1", session: { snapshotEvents: () => [{ type: "session/title", data: { title: "提问测试" } }] } };
    const result = await fakeService.ask({ agent, questions: [{ question: "今天吃了吗？" }] });
    assert.deepEqual(result, { answers: ["svc-marker"] }, "包装不改变原 ask 返回值，且 this 正确绑定");
    assert.ok(infos.some((t) => /question/.test(t)), "提问触发通知");
    assert.ok(infos.some((t) => /任务「提问测试」需要你回答/.test(t)), "提问通知带任务标题");
    assert.ok(infos.some((t) => /问题：今天吃了吗？/.test(t)), "提问通知带问题摘要");
    assert.ok(infos.some((t) => !t.includes("session-1")), "提问通知不暴露会话 id");

    // 热重载安全：重复触发 internal/service 时解包重包（不叠层、不重复通知）
    const askRef = fakeService.ask;
    serviceHandler("userQuestions", fakeService);
    assert.notEqual(fakeService.ask, askRef, "重复注册重新包装（解包旧包装）");
    const infoCountBefore = infos.length;
    const result2 = await fakeService.ask({ agent, questions: [{ question: "再问一次？" }] });
    assert.deepEqual(result2, { answers: ["svc-marker"] }, "解包重包后 ask 返回值不变，this 绑定正确");
    assert.equal(infos.length, infoCountBefore + 1, "解包重包不叠层，通知只发一次");

    // notifyQuestion=false 不通知（用独立的 service 实例，避免闭包捕获上一实例的配置）
    let fakeService2 = null;
    const infos2 = [];
    const { listeners: listeners2 } = await makeNotifier(work, { notifyQuestion: false, historyFile: join(work, "history-q2.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos2.push(t) },
      get: (name) => (name === "userQuestions" ? fakeService2 : undefined),
    });
    const serviceHandler2 = listeners2.get("internal/service")[0];
    fakeService2 = { ask: async (request) => ({ answers: [] }) };
    serviceHandler2("userQuestions", fakeService2);
    await fakeService2.ask({ agent: { id: "session-2" }, questions: [{ question: "hi" }] });
    assert.equal(infos2.length, 0, "notifyQuestion=false 不通知");
  }

  // turn-stopping：默认不通知；serial 事件签名 cb(payload) 无 next——必须不抛错
  // （该断言依赖默认配置实例 + 开启 notifyTurnEnd 的对照实例）
  {
    const infos = [];
    const { listeners } = await makeNotifier(work, { historyFile: join(work, "history-t1.jsonl") }, { logger: { warn: () => {}, info: (t) => infos.push(t) } });
    const turnStop = listeners.get("agent/turn-stopping")[0];
    assert.ok(turnStop, "turn-stopping 监听器已注册");
    let threw = false;
    try {
      await turnStop({ agent: { id: "session-1" }, turn: 4 });
    } catch (error) {
      threw = true;
    }
    assert.equal(threw, false, "serial 事件（无 next 参数）下监听器不抛错");
    assert.equal(infos.length, 0, "turn-stopping 默认不通知");

    // 开启 notifyTurnEnd 后 turn-stopping 通知（配置经组合层 entry 生效）
    const infosOn = [];
    const { listeners: listenersOn } = await makeNotifier(work, { notifyTurnEnd: true, historyFile: join(work, "history-t2.jsonl") }, { logger: { warn: () => {}, info: (t) => infosOn.push(t) } });
    const turnStopOn = listenersOn.get("agent/turn-stopping")[0];
    const agentWithEvents = { id: "session-1", session: { snapshotEvents: () => [{ type: "session/title", data: { title: "优化 notifier 插件" } }] } };
    await turnStopOn({ agent: agentWithEvents, turn: 4 });
    assert.ok(infosOn.some((t) => /turn-end/.test(t)), "notifyTurnEnd 开启后 turn-stopping 触发通知");
    assert.ok(infosOn.some((t) => /任务「优化 notifier 插件」第 4 轮工作已完成/.test(t)), "轮次完成通知带任务标题与轮次号");
    assert.ok(infosOn.some((t) => !t.includes("session-1")), "轮次完成通知不暴露会话 id");
    const countAfterFirst = infosOn.filter((t) => t.includes("turn-end")).length;
    // 同轮重复 emit（模拟事件被反复触发/热重载叠加）不重复通知——防「日志一堆」
    await turnStopOn({ agent: agentWithEvents, turn: 4 });
    await turnStopOn({ agent: agentWithEvents, turn: 4 });
    assert.equal(infosOn.filter((t) => t.includes("turn-end")).length, countAfterFirst, "同一 (agent,turn) 重复 turn-stopping 只通知一次");
    // 新的一轮（turn 5）仍正常通知
    await turnStopOn({ agent: agentWithEvents, turn: 5 });
    assert.equal(infosOn.filter((t) => t.includes("turn-end")).length, countAfterFirst + 1, "新轮次仍正常通知");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
