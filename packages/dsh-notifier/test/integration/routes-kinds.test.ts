// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 tsconfig 编译）
/**
 * dsh-notifier — e2e（/test /status /kinds 域）：测试通知收敛 service 管线、
 * /status 终态落盘、/kinds 清单与确认全链路、确认 CAS 循环（冲突重试/耗尽 409/
 * base 层回退）、settings 缺失时 kinds 确认 503。
 *
 * 拆法：原 routes.test.ts 按功能域拆分，本文件承载「通知中心服务面」域。
 * 边界依据：这些块围绕 wingsky.notifier 服务 + settings allowKinds 写面展开，
 * 与 config/history/SSE 域无共享状态；CAS 三个子场景各自独立实例重放。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, makeFakeCtx, fakeReq, makeRes } from "../helpers.ts";
import { ROUTES, apply } from "../../src/index.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-routes-kinds-"));
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

/** POST body req（带 data/end 事件）。 */
function postReq(payload) {
  const text = JSON.stringify(payload);
  return {
    method: "POST",
    url: "/",
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    on(event, cb) {
      if (event === "data") setTimeout(() => cb(Buffer.from(text)), 0);
      else if (event === "end") setTimeout(cb, 1);
      return this;
    },
    destroy() {},
  };
}

/** 轮询 /status 直到某频道终态 == expected（异步终态断言防 flake）。 */
async function pollStatus(route, channelId, expected, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    const { rec, res } = makeRes();
    await route.handler(fakeReq({}), res);
    let channels: any = {};
    try { channels = JSON.parse(rec.text).channels || {}; } catch { /* 下一轮 */ }
    if (channels[channelId]?.lastStatus === expected) return;
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ===== /test 收敛 service 管线 + /status + /kinds =====
describe("/test 收敛 service 管线 + /status + /kinds 全链路", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-route.jsonl") });
    const { routes, settings, ctx } = main;
    const statusRoute = routes.find((r) => r.path === ROUTES.status);
    const testRoute = routes.find((r) => r.path === ROUTES.test);
    const kindsRoute = routes.find((r) => r.path === ROUTES.kinds);
    c = {};

    // GET /status 初始空表
    const st1 = await call(statusRoute, fakeReq({}));
    const st1Body = JSON.parse(st1.text);
    c.st1Status = st1.status;
    c.st1Ok = st1Body.ok;
    c.st1Channels = st1Body.channels;

    // POST /test（无 body）：收敛后返回受理 results（内置频道按开关）
    const t1 = await call(testRoute, postReq({}));
    const t1Body = JSON.parse(t1.text);
    c.t1Status = t1.status;
    c.t1Ok = t1Body.ok;
    c.t1ResultsArray = Array.isArray(t1Body.results);
    c.t1BrowserOk = t1Body.results.some((x) => x.channelId === "browser" && x.status === "ok");

    // 投递终态落盘：browser 同步终态即时可见；system 为异步终态
    // （SystemNotifier.notify 返回 Promise——spawn 完成走事件循环）→ 轮询等待
    const st2Body = JSON.parse((await call(statusRoute, fakeReq({}))).text);
    c.st2Browser = st2Body.channels.browser?.lastStatus;
    await pollStatus(statusRoute, "system", "ok");

    // GET /kinds 初始空 + POST 未注册 kind → 404
    const k1 = await call(kindsRoute, fakeReq({}));
    c.kindsEmpty = JSON.parse(k1.text).kinds;
    const k2 = await call(kindsRoute, postReq({ kind: "nope:x", confirmed: true }));
    c.k2Status = k2.status;
    const k3 = await call(kindsRoute, postReq({ kind: "bad" }));
    c.k3Status = k3.status;

    // 全链路：插件注册 kind → 待确认 → POST 确认 → user 层 allowKinds 落盘
    const notifier = ctx.get("wingsky.notifier", false);
    c.notifier = notifier;
    notifier.registerKind({ id: "e2e:due", label: "E2E 到期" });
    const kinds1 = JSON.parse((await call(kindsRoute, fakeReq({}))).text).kinds;
    c.kinds1 = kinds1;
    const k5 = await call(kindsRoute, postReq({ kind: "e2e:due", confirmed: true }));
    const k5Body = JSON.parse(k5.text);
    c.k5Status = k5.status;
    c.k5Confirmed = k5Body.kinds.find((k) => k.id === "e2e:due").confirmed;
    c.allowKinds = settings.getUser().allowKinds;
    // 确认后 send 放行（suppressed 解除）
    c.send1 = await notifier.send({ source: "e2e", kind: "e2e:due", severity: "info", body: "到期提醒" });
  });

  it("/status 初始返回 200", () => {
    expect(c.st1Status).toBe(200);
  });

  it("/status ok=true", () => {
    expect(c.st1Ok).toBe(true);
  });

  it("初始状态空表", () => {
    expect(c.st1Channels).toEqual({});
  });

  it("测试通知成功", () => {
    expect(c.t1Status).toBe(200);
  });

  it("/test 响应 ok=true", () => {
    expect(c.t1Ok).toBe(true);
  });

  it("收敛后响应含受理 results", () => {
    expect(c.t1ResultsArray).toBeTruthy();
  });

  it("test kind 走 service 管线投递", () => {
    expect(c.t1BrowserOk).toBeTruthy();
  });

  it("/test 后 browser 频道状态 ok", () => {
    expect(c.st2Browser).toBe("ok");
  });

  it("初始动态 kind 清单空", () => {
    expect(c.kindsEmpty).toEqual([]);
  });

  it("未注册 kind 确认 404", () => {
    expect(c.k2Status).toBe(404);
  });

  it("非法 body 400", () => {
    expect(c.k3Status).toBe(400);
  });

  it("fake ctx 可读取 wingsky.notifier 服务", () => {
    expect(c.notifier).toBeTruthy();
  });

  it("注册后待确认", () => {
    expect(c.kinds1.some((k) => k.id === "e2e:due" && k.confirmed === false)).toBeTruthy();
  });

  it("确认成功", () => {
    expect(c.k5Status).toBe(200);
  });

  it("响应内确认态即时可见", () => {
    expect(c.k5Confirmed).toBe(true);
  });

  it("确认态持久化到配置 allowKinds（重启保持）", () => {
    expect(c.allowKinds).toEqual(["e2e:due"]);
  });

  it("确认后动态 kind 正常投递", () => {
    expect(c.send1.some((x) => x.status === "ok")).toBeTruthy();
  });
});

// ===== kinds 确认 CAS 循环（read-modify-write + 冲突重试 + 兜底）=====
describe("kinds CAS 1：无冲突确认 200 响应带新 revision", () => {
  let c: { status: number; revisionType: string; revisionMatches: boolean };

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-cas0.jsonl") });
    const kindsRoute = main.routes.find((r) => r.path === ROUTES.kinds);
    const notifier = main.ctx.get("wingsky.notifier", false);
    // 1. 无冲突确认：200 响应带新 revision（客户端 confirmOne 同步 meta 的依据）
    notifier.registerKind({ id: "e2e:cas0", label: "CAS 0" });
    const c0 = await call(kindsRoute, postReq({ kind: "e2e:cas0", confirmed: true }));
    const c0Body = JSON.parse(c0.text);
    c = {
      status: c0.status,
      revisionType: typeof c0Body.revision,
      revisionMatches: c0Body.revision === main.settings.getRevision(),
    };
  });

  it("#405：无冲突确认 200", () => {
    expect(c.status).toBe(200);
  });

  it("#405：POST /kinds 200 响应带 revision", () => {
    expect(c.revisionType).toBe("number");
  });

  it("#405：响应 revision 为最新服务端 revision", () => {
    expect(c.revisionMatches).toBe(true);
  });
});

describe("kinds CAS 2：确认期间另一端写入 → 内部重拉重算后重试成功", () => {
  let c: { status: number; allowed: string[] };

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-cas1.jsonl") });
    const kindsRoute = main.routes.find((r) => r.path === ROUTES.kinds);
    const notifier = main.ctx.get("wingsky.notifier", false);
    const settings = main.settings;
    // 2. CAS 冲突自动重试：确认期间另一端先写入推进 revision → 首次 update 冲突 →
    //    内部重拉重算（读到另一端 allowKinds）→ 重试成功，两端确认都保留
    notifier.registerKind({ id: "e2e:cas1", label: "CAS 1" });
    notifier.registerKind({ id: "e2e:cas2", label: "CAS 2" });
    // 另一端先确认 cas2（user 层 allowKinds 推进）
    await kindsRoute.handler(postReq({ kind: "e2e:cas2", confirmed: true }), makeRes().res);
    // 包装 service.update：本次确认（cas1）的首次 update 前先空写推进 revision，
    // 使 confirmKindToConfig 已读到的 revision 过期 → SETTINGS_CONFLICT → 自动重试
    const origUpdate = settings.service.update.bind(settings.service);
    let sabotage = true;
    settings.service.update = async (ns, patch, expectedRevision) => {
      if (sabotage) {
        sabotage = false;
        // 空写推进 revision（不改 user）→ 使调用方持有的 expectedRevision 过期
        await origUpdate(ns, {}, undefined);
      }
      return origUpdate(ns, patch, expectedRevision);
    };
    try {
      const c1 = await call(kindsRoute, postReq({ kind: "e2e:cas1", confirmed: true }));
      c = { status: c1.status, allowed: settings.getUser().allowKinds || [] };
    } finally {
      settings.service.update = origUpdate;
    }
  });

  it("CAS 冲突一次后自动重试成功", () => {
    expect(c.status).toBe(200);
  });

  it("#405：重试后本次确认生效", () => {
    expect(c.allowed.includes("e2e:cas1")).toBeTruthy();
  });

  it("#405：重试读最新 user 层——另一端确认不丢失（无读-改-写覆盖）", () => {
    expect(c.allowed.includes("e2e:cas2")).toBeTruthy();
  });
});

describe("kinds CAS 3：重试耗尽 → handler 兜底 409", () => {
  let c: { status: number; code: string; allowed: string[] };

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-cas3.jsonl") });
    const kindsRoute = main.routes.find((r) => r.path === ROUTES.kinds);
    const notifier = main.ctx.get("wingsky.notifier", false);
    const settings = main.settings;
    // 3. CAS 耗尽 → handler 兜底 409（rejection 不冒泡成宿主未处理）
    notifier.registerKind({ id: "e2e:cas3", label: "CAS 3" });
    const origUpdate = settings.service.update.bind(settings.service);
    settings.service.update = async (ns, patch, expectedRevision) => {
      // 每次 update 前都空写推进 revision → 调用方持有的 revision 恒过期 → 3 次重试耗尽
      await origUpdate(ns, {}, undefined);
      return origUpdate(ns, patch, expectedRevision);
    };
    try {
      const c3 = await call(kindsRoute, postReq({ kind: "e2e:cas3", confirmed: true }));
      c = { status: c3.status, code: JSON.parse(c3.text).error.code, allowed: settings.getUser().allowKinds || [] };
    } finally {
      settings.service.update = origUpdate;
    }
  });

  it("CAS 重试耗尽 → 409", () => {
    expect(c.status).toBe(409);
  });

  it("409 带 code=SETTINGS_CONFLICT", () => {
    expect(c.code).toBe("SETTINGS_CONFLICT");
  });

  it("耗尽后确认未写入（拒绝语义）", () => {
    expect(!c.allowed.includes("e2e:cas3")).toBeTruthy();
  });
});

describe("kinds CAS 4：base 层 allowKinds 回退不被空集覆盖", () => {
  let c: { status: number; allowed: string[] };

  beforeAll(async () => {
    // 4. base 层 allowKinds 回退：user 层未接管（无 allowKinds 键）时，
    //    确认写入不得以空集整键覆盖组合层 base 配置的豁免项
    const baseInst = makeNotifier(work, { allowKinds: ["base:k0"], historyFile: join(work, "history-kinds-base.jsonl") });
    try {
      const bKindsRoute = baseInst.routes.find((r) => r.path === ROUTES.kinds);
      const bNotifier = baseInst.ctx.get("wingsky.notifier", false);
      bNotifier.registerKind({ id: "e2e:base1", label: "BASE 1" });
      const b0 = await call(bKindsRoute, postReq({ kind: "e2e:base1", confirmed: true }));
      c = { status: b0.status, allowed: baseInst.settings.getUser().allowKinds || [] };
    } finally {
      baseInst.dispose();
    }
  });

  it("base 回退场景确认 200", () => {
    expect(c.status).toBe(200);
  });

  it("确认的新 kind 已写入 user 层", () => {
    expect(c.allowed.includes("e2e:base1")).toBeTruthy();
  });

  it("#405：base 层豁免项未被空集覆盖（user 未接管时回退解析值合并）", () => {
    expect(c.allowed.includes("base:k0")).toBeTruthy();
  });
});

// settings 服务缺失（未 attach）→ POST /kinds 503（与 PUT /config 服务缺失语义一致，
// 非笼统 500——对抗评审发现的行为回归锁死）
describe("settings 缺失时 kinds 确认 503", () => {
  let rec: any;

  beforeAll(async () => {
    const { ctx, routes } = makeFakeCtx({});
    const svcBox: any = {};
    const origProvide = ctx.provide.bind(ctx);
    ctx.provide = (name, svc) => {
      if (name === "wingsky.notifier") svcBox.svc = svc;
      origProvide(name, svc);
    };
    apply(ctx, { enabled: true, configFile: join(work, "kinds-nosettings-cfg.json"), historyFile: join(work, "kinds-nosettings-hist.jsonl") });
    svcBox.svc.registerKind({ id: "e2e:nosvc", label: "NO SVC" });
    const kindsRouteNs = routes.find((r) => r.path === ROUTES.kinds);
    rec = await call(kindsRouteNs, postReq({ kind: "e2e:nosvc", confirmed: true }));
  });

  it("settings 缺失 → kinds 确认 503（与 PUT 通道一致）", () => {
    expect(rec.status).toBe(503);
  });

  it("503 带 code=settings-unavailable", () => {
    expect(JSON.parse(rec.text).error.code).toBe("settings-unavailable");
  });
});
