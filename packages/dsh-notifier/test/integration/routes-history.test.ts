// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e（history 域）：测试通知落盘可查、并发写入串行不丢、
 * DELETE 清空、historyMaxAgeDays 按天清理、免打扰 suppressed:quiet 标记、
 * 200 条滚动上限、settings 服务消失后 current 回落形态。
 *
 * 拆法：原 routes.test.ts 按功能域拆分，本文件承载「历史存储与配置回落」域。
 * 边界依据：这些块各自持有独立 history 文件（或独立 apply 实例），不依赖
 * 主实例 settings user 层的累计状态。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, makeFakeCtx, makeFakeSettings, fakeReq, makeRes, waitForHistory, turnPair, quietWindowNow } from "../helpers.ts";
import { ROUTES, apply } from "../../src/index.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-routes-history-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** 单次路由调用（回收 rec）。 */
async function call(route, req) {
  const { rec, res } = makeRes();
  await route.handler(req, res);
  return rec;
}

// history：测试通知已落盘，GET 可查（独立 history 文件，无跨块串扰）
describe("history：测试通知落盘后 GET 可查", () => {
  let records: any[];

  beforeAll(async () => {
    const n = makeNotifier(work, { historyFile: join(work, "history-get.jsonl") });
    try {
      const h = n.routes.find((r) => r.path === ROUTES.history);
      const t = n.routes.find((r) => r.path === ROUTES.test);
      await call(t, fakeReq({ method: "POST" }));
      // appendHistory 是 fire-and-forget；轮询直到落盘，不再依赖固定 sleep 的时序假设
      records = await waitForHistory(h, (rs) => rs.length >= 1 && rs[rs.length - 1]?.kind === "test");
    } finally {
      n.dispose();
    }
  });

  it("历史记录非空", () => {
    expect(Array.isArray(records) && records.length >= 1).toBeTruthy();
  });

  it("最近一条为测试通知", () => {
    expect(records[records.length - 1].kind).toBe("test");
  });

  it("记录含测试文案", () => {
    expect(records[records.length - 1].message).toMatch(/通知链路工作正常/);
  });
});

// 并发历史写入：写队列串行化，不丢记录（模拟真实多事件同时触发）
describe("history：并发写入串行化不丢记录", () => {
  const concurrent = 20;
  let statuses: number[];
  let testCount: number;

  beforeAll(async () => {
    const n = makeNotifier(work, { historyFile: join(work, "history-concurrent.jsonl") });
    try {
      const h = n.routes.find((r) => r.path === ROUTES.history);
      const t = n.routes.find((r) => r.path === ROUTES.test);
      statuses = await Promise.all(Array.from({ length: concurrent }, async () => {
        const { rec, res } = makeRes();
        await t.handler(fakeReq({ method: "POST" }), res);
        return rec.status;
      }));
      // 轮询直到并发写入全部落盘（独立 history 文件，单写链串行，末尾恒为 test）
      const records = await waitForHistory(h, (rs) => rs.filter((r) => r.kind === "test").length >= concurrent);
      testCount = records.filter((r) => r.kind === "test").length;
    } finally {
      n.dispose();
    }
  });

  it("并发 test 路由均返回 200", () => {
    for (const status of statuses) expect(status).toBe(200);
  });

  it("并发写不丢记录", () => {
    expect(testCount >= concurrent).toBeTruthy();
  });
});

// history：DELETE 清空 + historyMaxAgeDays 按天清理（独立上下文）
describe("history：按天清理与 DELETE 清空", () => {
  let c: { length: number; kind: string; delOk: boolean; removed: number; afterEmpty: number };

  beforeAll(async () => {
    const hfile = join(work, "history-clean.jsonl");
    const { routes, dispose: disposeClean } = makeNotifier(work, { historyFile: hfile, historyMaxAgeDays: 7 });
    try {
      const h = routes.find((r) => r.path === ROUTES.history);
      const t = routes.find((r) => r.path === ROUTES.test);
      // 预置一条 10 天前的旧记录
      writeFileSync(hfile, JSON.stringify({ ts: Date.now() - 10 * 86400000, kind: "done", title: "旧记录", message: "10 天前" }) + "\n");
      // 触发一条新通知（test 路由 → 落盘；写时会按 7 天 cutoff 剔除旧行）
      await call(t, fakeReq({ method: "POST" }));
      // 轮询历史直到新记录落盘（写队列异步排空；替代固定 sleep 等写队列）
      const records = await waitForHistory(h, (recs) => recs.length === 1 && recs[0]?.kind === "test");
      // DELETE 清空
      const recDel = await call(h, fakeReq({ method: "DELETE" }));
      const del = JSON.parse(recDel.text);
      const recEmpty = await call(h, fakeReq({}));
      c = {
        length: records.length,
        kind: records[0].kind,
        delOk: del.ok,
        removed: del.removed,
        afterEmpty: JSON.parse(recEmpty.text).records.length,
      };
    } finally {
      disposeClean(); // 停心跳
    }
  });

  it("historyMaxAgeDays=7：10 天前旧记录被清理，只留新记录", () => {
    expect(c.length).toBe(1);
  });

  it("保留的是新记录", () => {
    expect(c.kind).toBe("test");
  });

  it("DELETE ok=true", () => {
    expect(c.delOk).toBe(true);
  });

  it("DELETE 返回被清空条数", () => {
    expect(c.removed >= 1).toBeTruthy();
  });

  it("清空后 GET 为空", () => {
    expect(c.afterEmpty).toBe(0);
  });
});

// 被免打扰拦截（suppressed: "quiet"）的记录在历史中标记（独立上下文）
describe("history：免打扰拦截记录带 suppressed:quiet 标记", () => {
  let records: any[];

  beforeAll(async () => {
    // 动态窗口：写死 "00:00"/"23:59" 在半开区间镜下 23:59 这一分钟不命中
    // （UTC 边缘必炸，run 33282203798 同源隐患）；围绕当前时间 ±2 分钟恒命中。
    const qhAll = quietWindowNow();
    const { routes, listeners } = makeNotifier(work, { quietHours: { ...qhAll, allowKinds: ["ask"] }, historyFile: join(work, "history-quiet.jsonl") });
    const h = routes.find((r) => r.path === ROUTES.history);
    const status = listeners.get("agent/status")[0];
    // 两态时序：running=上一轮（首轮无 closure），idle=本轮 turn 1 completed
    const pair = turnPair("q-1", "免打扰完成", {}, { turn: 1 });
    status({ agent: pair.running, status: "running" });
    status({ agent: pair.idle, status: "idle" });
    records = await waitForHistory(h, (rs) => rs.some((e) => e.kind === "done" && e.suppressed === "quiet"));
  });

  it("免打扰拦截记录带 suppressed:quiet 标记", () => {
    expect(records.some((e) => e.kind === "done" && e.suppressed === "quiet")).toBeTruthy();
  });
});

// 200 条滚动上限（独立上下文，预置 210 条 → 读取只保留最近 200）
describe("history：200 条滚动上限", () => {
  let records: any[];

  beforeAll(async () => {
    const hfile = join(work, "history-limit.jsonl");
    const lines = Array.from({ length: 210 }, (_, i) => JSON.stringify({ ts: Date.now() + i, kind: "test", title: "t", message: `m${i}` })).join("\n") + "\n";
    writeFileSync(hfile, lines);
    const { routes } = makeNotifier(work, { historyFile: hfile });
    const h = routes.find((r) => r.path === ROUTES.history);
    const rec = await call(h, fakeReq({}));
    records = JSON.parse(rec.text).records;
  });

  it("滚动上限 200：读取最多 200 条", () => {
    expect(records.length <= 200).toBeTruthy();
  });

  it("保留的是最新记录", () => {
    expect(records[records.length - 1].message).toBe("m209");
  });
});

// settings 服务消失 → 回落 current 与初始形态一致（same-shape）。entry 只给
// maxConnections（缺 notifySound/askRemindMin 等默认键）：回落若不经
// normalizeConfig 会退回裸 entry（notifySound=true → undefined、askRemindMin
// 缺失）——与初始 normalizeConfig(entry) 形态不对称。
// 观测面 = GET /config 的 effective（redactConfigView(resolve()) = current 全量
// 视图，含 askRemindMin）。捕获 shared 的回落 disposer 手动触发（模拟服务消失
// 但插件存活，isUnloading=false 不短路）。
describe("settings 服务消失 → current 回落 same-shape", () => {
  let before: any;
  let after: any;
  let fallbackDisposer: any;

  beforeAll(async () => {
    const entry = { maxConnections: 64 };
    const fakeSettings = makeFakeSettings({ base: entry });
    const { ctx, routes } = makeFakeCtx({
      inject(serviceNames, fn) {
        if (Array.isArray(serviceNames) && serviceNames.includes("settings")) {
          fn({
            settings: fakeSettings.service,
            effect(f2) {
              const d = f2();
              return (fallbackDisposer = typeof d === "function" ? d : () => {});
            },
          });
        }
      },
    });
    apply(ctx, {
      enabled: true,
      maxConnections: 64,
      configFile: join(work, "p24-cfg.json"),
      historyFile: join(work, "p24-hist.jsonl"),
    });
    const cfgRoute = routes.find((r) => r.path === ROUTES.config);
    const getEffective = async () => {
      const rec = await call(cfgRoute, fakeReq({}));
      return JSON.parse(rec.text).effective;
    };
    before = await getEffective();
    fallbackDisposer(); // 模拟 settings 服务消失（插件存活）→ 回落
    after = await getEffective();
  });

  it("attach 态 current 反映 entry 值", () => {
    expect(before.maxConnections).toBe(64);
  });

  it("attach 态 notifySound 默认值兜底", () => {
    expect(before.notifySound).toBe(true);
  });

  it("attach 态 askRemindMin 默认值兜底", () => {
    expect(before.askRemindMin).toBe(5);
  });

  it("shared 回落 disposer 已捕获（服务消失回落路径可达）", () => {
    expect(fallbackDisposer).toBeTruthy();
  });

  it("回落 current 与初始形态 same-shape（同键同值、默认值兜底一致）", () => {
    expect(after).toEqual(before);
  });
});
