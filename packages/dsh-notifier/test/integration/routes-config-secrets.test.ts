// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e（配置写面凭据与错误映射域）：Bark/webhook 凭据脱敏与掩码
 * 回填、PUT 容错（非法 JSON/超大 body）、校验失败的 400 hint、声音键写面校验、
 * 409 版本冲突、503 settings 缺失、500 写入异常固定文案。
 *
 * 拆法：原 routes.test.ts 按功能域拆分，本文件承载「写面凭据与错误映射」域。
 * 边界依据：这些块以 PUT /config 的响应与 settings user 层状态为观测面，
 * 不依赖 config GET/未知键透传/原型键等读面块的累计状态。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, makeFakeCtx, fakeReq, makeRes } from "../helpers.ts";
import { ROUTES, apply } from "../../src/index.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-routes-config-secrets-"));
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

/** PUT body req（带 data/end 事件）。 */
function bodyReq(payload) {
  const text = JSON.stringify(payload);
  return {
    method: "PUT",
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

// ===== Bark channels 凭据脱敏与掩码回填 =====
describe("Bark channels 凭据脱敏与掩码回填", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-chan.jsonl") });
    const configRoute = main.routes.find((r) => r.path === ROUTES.config);
    const settings = main.settings;
    const SECRET = "realSecretKey42";
    c = { secret: SECRET };

    // PUT 写入含 deviceKey 的 channels：user 层持明文，响应已掩码（单一出口）
    const put1 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: SECRET, enabled: false }] } }));
    const put1Body = JSON.parse(put1.text);
    c.put1Status = put1.status;
    c.put1HasPlaintext = JSON.stringify(put1Body).includes(SECRET);
    c.put1MaskedKey = put1Body.user.channels[0].deviceKey;
    c.userPlainKey = settings.getUser().channels[0].deviceKey;

    // GET：user + effective 双出口深度扫描无明文
    const get1Body = JSON.parse((await call(configRoute, fakeReq({}))).text);
    c.get1HasPlaintext = JSON.stringify(get1Body).includes(SECRET);
    c.get1UserMasked = get1Body.user.channels[0].deviceKey;
    c.get1EffectiveMasked = get1Body.effective.channels[0].deviceKey;
    c.get1BaseUrl = get1Body.effective.channels[0].baseUrl;

    // 掩码回填：同 id 实例提交掩码 → user 层 key 保持原值（先回填再校验）
    const put2 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: "********", enabled: false, group: "dsh" }] } }));
    const afterUnmask = settings.getUser().channels[0];
    c.put2Status = put2.status;
    c.unmaskedKey = afterUnmask.deviceKey;
    c.unmaskedEnabled = afterUnmask.enabled;
    c.unmaskedGroup = afterUnmask.group;

    // 乱序多实例：掩码仍按 id 对齐（防下标串凭据）
    const put3 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: SECRET, enabled: false }, { id: "pad", type: "bark", baseUrl: "https://api.day.app", deviceKey: "padKey777", enabled: false }] } }));
    c.put3Status = put3.status;
    const put4 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "pad", type: "bark", baseUrl: "https://api.day.app", deviceKey: "********", enabled: false }, { id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: "********", enabled: false }] } }));
    c.put4Status = put4.status;
    const byId = Object.fromEntries(settings.getUser().channels.map((ch) => [ch.id, ch.deviceKey]));
    c.byIdPhone = byId.phone;
    c.byIdPad = byId.pad;

    // 改 key：非掩码新值直接生效
    const put5 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: "rotatedKey9", enabled: false }, { id: "pad", type: "bark", baseUrl: "https://api.day.app", deviceKey: "********", enabled: false }] } }));
    c.put5Status = put5.status;
    const byId2 = Object.fromEntries(settings.getUser().channels.map((ch) => [ch.id, ch.deviceKey]));
    c.byId2Phone = byId2.phone;
    c.byId2Pad = byId2.pad;

    // 新实例带掩码 → 400（掩码只允许表达「未修改」）
    const put6 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "brand-new", type: "bark", baseUrl: "https://api.day.app", deviceKey: "********", enabled: false }] } }));
    c.put6Status = put6.status;
    c.put6HintHasMask = JSON.parse(put6.text).error.hint.includes("掩码");

    // 重复 id → 400（校验器查重）
    const put7 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "dup", type: "bark", baseUrl: "https://api.day.app", deviceKey: "k1", enabled: false }, { id: "dup", type: "bark", baseUrl: "https://api.day.app", deviceKey: "k2", enabled: false }] } }));
    c.put7Status = put7.status;
    c.put7Error = JSON.parse(put7.text).error.error;
  });

  it("合法 channels PUT 成功", () => {
    expect(c.put1Status).toBe(200);
  });

  it("PUT 响应不含 deviceKey 明文（评审 P0-1：PUT 成功响应也是出口）", () => {
    expect(c.put1HasPlaintext).toBe(false);
  });

  it("PUT 响应 user 已掩码", () => {
    expect(c.put1MaskedKey).toBe("********");
  });

  it("settings user 层持明文（服务端回填依据）", () => {
    expect(c.userPlainKey).toBe(c.secret);
  });

  it("GET 响应全文深度扫描不含 deviceKey 明文", () => {
    expect(c.get1HasPlaintext).toBe(false);
  });

  it("GET user 出口掩码", () => {
    expect(c.get1UserMasked).toBe("********");
  });

  it("GET effective 出口掩码", () => {
    expect(c.get1EffectiveMasked).toBe("********");
  });

  it("非凭据字段不受影响", () => {
    expect(c.get1BaseUrl).toBe("https://api.day.app");
  });

  it("掩码提交（未修改语义）成功", () => {
    expect(c.put2Status).toBe(200);
  });

  it("掩码按 id 回填 user 层原值（未覆盖为掩码字面量）", () => {
    expect(c.unmaskedKey).toBe(c.secret);
  });

  it("其余字段正常更新", () => {
    expect(c.unmaskedEnabled).toBe(false);
  });

  it("新增可选参数正常更新", () => {
    expect(c.unmaskedGroup).toBe("dsh");
  });

  it("乱序掩码前 PUT 成功", () => {
    expect(c.put3Status).toBe(200);
  });

  it("乱序掩码 PUT 成功", () => {
    expect(c.put4Status).toBe(200);
  });

  it("phone 的 key 未被串改", () => {
    expect(c.byIdPhone).toBe(c.secret);
  });

  it("pad 的 key 未被串改", () => {
    expect(c.byIdPad).toBe("padKey777");
  });

  it("混合提交（改 key + 掩码未改）成功", () => {
    expect(c.put5Status).toBe(200);
  });

  it("非掩码新 key 生效（key 轮换）", () => {
    expect(c.byId2Phone).toBe("rotatedKey9");
  });

  it("掩码实例保持原 key", () => {
    expect(c.byId2Pad).toBe("padKey777");
  });

  it("新实例带掩码 400 拒绝", () => {
    expect(c.put6Status).toBe(400);
  });

  it("400 hint 指引真实 key", () => {
    expect(c.put6HintHasMask).toBeTruthy();
  });

  it("重复 id 400", () => {
    expect(c.put7Status).toBe(400);
  });

  it("400 指明 channels 键", () => {
    expect(c.put7Error).toBe("配置校验失败: channels");
  });
});

// ===== webhook 频道写入/凭据掩码泛化（凭据只走请求头不落 URL）=====
describe("webhook 频道写入与凭据掩码泛化", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-wh.jsonl") });
    const configRoute = main.routes.find((r) => r.path === ROUTES.config);
    const settings = main.settings;
    const WH_SECRET = "whTokenValue99";
    c = { secret: WH_SECRET };

    const putW1 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "webhook-1", type: "webhook", url: "https://ntfy.sh/dsh-x", enabled: false, auth: "bearer", token: WH_SECRET, timeoutSec: 10, preset: "ntfy" }] } }));
    c.putW1Status = putW1.status;
    c.putW1HasPlaintext = JSON.stringify(putW1.text).includes(WH_SECRET);
    const getWBody = JSON.parse((await call(configRoute, fakeReq({}))).text);
    const whView = getWBody.user.channels.find((ch) => ch.id === "webhook-1");
    c.whToken = whView.token;
    c.getWHasPlaintext = JSON.stringify(getWBody).includes(WH_SECRET);
    c.whAuth = whView.auth;

    // 掩码回填：webhook token 掩码提交 → user 层原值保持（未修改语义）
    const putW2 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "webhook-1", type: "webhook", url: "https://ntfy.sh/dsh-x", enabled: true, auth: "bearer", token: "********", timeoutSec: 10 }] } }));
    c.putW2Status = putW2.status;
    const whAfter = settings.getUser().channels.find((ch) => ch.id === "webhook-1");
    c.whAfterToken = whAfter.token;
    c.whAfterEnabled = whAfter.enabled;

    // 新 webhook 实例带掩码 → 400（掩码只允许表达「未修改」，与 bark 同 hint 语义）
    const putW3 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "webhook-new", type: "webhook", url: "https://ntfy.sh/dsh-y", enabled: false, token: "********" }] } }));
    c.putW3Status = putW3.status;
    c.putW3HintHasMask = JSON.parse(putW3.text).error.hint.includes("掩码");

    // 客户端修复后「空白起步」形态回归——chAdd 不预置可选键，用户填 url/token
    // 后提交（无任何空串键）→ 200；此前该形态必 400（保存失败: channels）
    const putW4 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "webhook-2", type: "webhook", url: "https://ntfy.sh/dsh-z", enabled: false, auth: "bearer", token: WH_SECRET, preset: "ntfy", timeoutSec: 10 }] } }));
    c.putW4Status = putW4.status;

    // 存量「空串残留」payload 仍 400（写面契约锁定——空串 ≠ 未配置，
    // 语义由客户端 assignChannelFields/stripChannelEmpties 剥除承接，服务端不放宽）
    const putW5 = await call(configRoute, bodyReq({ patch: { channels: [{ id: "webhook-3", type: "webhook", url: "https://ntfy.sh/dsh-b", enabled: false, auth: "bearer", token: "tk614", username: "", password: "", headerName: "", headerValue: "" }] } }));
    c.putW5Status = putW5.status;
    c.putW5Error = JSON.parse(putW5.text).error.error;
  });

  it("合法 webhook 实例 PUT 成功", () => {
    expect(c.putW1Status).toBe(200);
  });

  it("PUT 响应不含 webhook token 明文", () => {
    expect(c.putW1HasPlaintext).toBe(false);
  });

  it("GET user 出口 webhook token 掩码", () => {
    expect(c.whToken).toBe("********");
  });

  it("GET 响应全文深度扫描不含 webhook token 明文", () => {
    expect(c.getWHasPlaintext).toBe(false);
  });

  it("非凭据字段不受影响（auth）", () => {
    expect(c.whAuth).toBe("bearer");
  });

  it("webhook 掩码提交（未修改语义）成功", () => {
    expect(c.putW2Status).toBe(200);
  });

  it("webhook token 掩码按 id 回填原值", () => {
    expect(c.whAfterToken).toBe(c.secret);
  });

  it("其余字段正常更新（enabled）", () => {
    expect(c.whAfterEnabled).toBe(true);
  });

  it("新 webhook 实例带掩码 400 拒绝", () => {
    expect(c.putW3Status).toBe(400);
  });

  it("400 hint 指引真实 token", () => {
    expect(c.putW3HintHasMask).toBeTruthy();
  });

  it("#614：无空串键形态（客户端 strip 产物）PUT 成功", () => {
    expect(c.putW4Status).toBe(200);
  });

  it("#614：空串认证字段仍整组 400（写面口径不变）", () => {
    expect(c.putW5Status).toBe(400);
  });

  it("#614：报错键仍为 channels", () => {
    expect(c.putW5Error).toBe("配置校验失败: channels");
  });
});

// config PUT 容错：非法 JSON → 400；超大 body → 不挂起、无未处理拒绝
describe("config PUT 容错：非法 JSON 与超大 body", () => {
  let c: { badJson: number; hugeBody: number };

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-tolerance.jsonl") });
    const configRoute = main.routes.find((r) => r.path === ROUTES.config);
    const rawBodyReq = (text) => ({
      method: "PUT",
      url: "/",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
      on(event, cb) {
        if (event === "data") setTimeout(() => cb(Buffer.from(text)), 0);
        else if (event === "end") setTimeout(cb, 1);
        return this;
      },
      destroy() {},
    });
    const rec = await call(configRoute, rawBodyReq("{ not json"));
    const rec2 = await call(configRoute, rawBodyReq('{"big":"' + "x".repeat(20 * 1024) + '"}'));
    c = { badJson: rec.status, hugeBody: rec2.status };
  });

  it("非法 JSON 返回 400 可读错误", () => {
    expect(c.badJson).toBe(400);
  });

  it("超大 body：连接被 destroy、handler 无响应但不挂起不抛错", () => {
    expect(c.hugeBody).toBe(0);
  });
});

// 首个非法键 hint → 400（quietHours.start=25:00）
describe("首个非法键 hint → 400", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-hint.jsonl") });
    const configRoute = main.routes.find((r) => r.path === ROUTES.config);
    const rec = await call(configRoute, bodyReq({ patch: { quietHours: { start: "25:00" } } }));
    const body = JSON.parse(rec.text);
    c = { status: rec.status, ok: body.ok, error: body.error.error, hint: body.error.hint };
  });

  it("非法键 400", () => {
    expect(c.status).toBe(400);
  });

  it("400 响应 ok=false", () => {
    expect(c.ok).toBe(false);
  });

  it("400 带「配置校验失败」", () => {
    expect(c.error).toMatch(/配置校验失败/);
  });

  it("400 带 hint（合法范围描述）", () => {
    expect(c.hint).toBeTruthy();
  });
});

// 新声音键写入校验——合法值 200、非法值 400 + 音色白名单 hint
describe("新声音键写入校验", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-sound.jsonl") });
    const configRoute = main.routes.find((r) => r.path === ROUTES.config);
    const settings = main.settings;
    const ok1 = await call(configRoute, bodyReq({ patch: { browserSound: "ding", systemSound: "pop" } }));
    const ok2 = await call(configRoute, bodyReq({ patch: { systemSound: false } }));
    const bad1 = await call(configRoute, bodyReq({ patch: { browserSound: "loud" } }));
    const badBody = JSON.parse(bad1.text);
    const bad2 = await call(configRoute, bodyReq({ patch: { systemSound: "<script>" } }));
    const eff = settings.getUser();
    c = {
      ok1: ok1.status,
      ok2: ok2.status,
      bad1: bad1.status,
      badError: badBody.error.error,
      badHint: String(badBody.error.hint),
      bad2: bad2.status,
      effBrowserSound: eff.browserSound,
      effSystemSound: eff.systemSound,
    };
  });

  it("合法音色 PUT 成功", () => {
    expect(c.ok1).toBe(200);
  });

  it("systemSound false PUT 成功", () => {
    expect(c.ok2).toBe(200);
  });

  it("browserSound 非法音色 400", () => {
    expect(c.bad1).toBe(400);
  });

  it("400 指明 browserSound 键", () => {
    expect(c.badError).toBe("配置校验失败: browserSound");
  });

  it("400 hint 含音色白名单", () => {
    expect(c.badHint.includes("ding/bell/chime/pop")).toBeTruthy();
  });

  it("systemSound 任意字符串 400", () => {
    expect(c.bad2).toBe(400);
  });

  it("合法 browserSound 写入 user 层", () => {
    expect(c.effBrowserSound).toBe("ding");
  });

  it("合法 systemSound 写入 user 层", () => {
    expect(c.effSystemSound).toBe(false);
  });
});

// SETTINGS_CONFLICT → 409 固定文案（expectedRevision 过期 → service.update 抛冲突）
describe("expectedRevision 过期 → 409 版本冲突", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    // 独立实例：先写入推进 revision，再用旧 revision PUT → 服务端冲突 409
    const { routes, settings: conflictSettings } = makeNotifier(work, { historyFile: join(work, "history-conflict.jsonl") });
    const cfgRoute = routes.find((r) => r.path === ROUTES.config);
    // 首次写入，revision 前进
    await cfgRoute.handler(bodyReq({ patch: { notifyAsk: true } }), makeRes().res);
    const staleRevision = conflictSettings.getRevision();
    // 直接推进 user 层 revision（模拟其他窗口修改）
    await conflictSettings.service.update("dsh-notifier", { notifyQuestion: true });
    const rec = await call(cfgRoute, bodyReq({ patch: { notifySound: false }, expectedRevision: staleRevision }));
    const body = JSON.parse(rec.text);
    c = { status: rec.status, ok: body.ok, code: body.error.code, error: body.error.error };
  });

  it("expectedRevision 过期 → 409", () => {
    expect(c.status).toBe(409);
  });

  it("409 响应 ok=false", () => {
    expect(c.ok).toBe(false);
  });

  it("409 带 code=SETTINGS_CONFLICT", () => {
    expect(c.code).toBe("SETTINGS_CONFLICT");
  });

  it("409 固定文案「版本冲突」", () => {
    expect(c.error).toMatch(/版本冲突/);
  });
});

// settings 服务缺失（未 attach）→ PUT 503 settings-unavailable
describe("settings 缺失 → PUT 503", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    // 不 provide settings 服务 → writable=false
    const { ctx, routes } = makeFakeCtx({});
    apply(ctx, { enabled: true, configFile: join(work, "no-settings-cfg.json"), historyFile: join(work, "no-settings-hist.jsonl") });
    const cfgRoute = routes.find((r) => r.path === ROUTES.config);
    const rec = await call(cfgRoute, bodyReq({ patch: { notifyAsk: false } }));
    const body = JSON.parse(rec.text);
    c = { status: rec.status, code: body.error.code, error: body.error.error };
  });

  it("settings 缺失 → 503", () => {
    expect(c.status).toBe(503);
  });

  it("503 带 code=settings-unavailable", () => {
    expect(c.code).toBe("settings-unavailable");
  });

  it("503 固定文案「设置服务不可用」", () => {
    expect(c.error).toMatch(/设置服务不可用/);
  });
});

// 写入异常原文只进服务端日志 → 500 收敛固定文案（不含底层异常原文）
describe("写入异常 → 500 固定文案且不泄露原文", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const warns: string[] = [];
    const failingSettings = {
      register(ns, schema, opts) {
        return { get: () => ({ notifyAsk: true }), watch: () => () => {}, update: async () => {} };
      },
      describe: () => [{ ns: "dsh-notifier", user: {}, revision: 0 }],
      async update(ns, patch) {
        throw new Error("secret-internal-path /home/user/.config/boom");
      },
    };
    const { ctx, routes } = makeFakeCtx({ logger: { warn: (m) => warns.push(m), info: () => {} } });
    ctx.provide("settings", failingSettings);
    apply(ctx, { enabled: true, configFile: join(work, "g3-cfg.json"), historyFile: join(work, "g3-hist.jsonl") });
    const cfgRoute = routes.find((r) => r.path === ROUTES.config);
    const rec = await call(cfgRoute, bodyReq({ patch: { notifyAsk: false } }));
    const body = JSON.parse(rec.text);
    c = {
      status: rec.status,
      hasSecret: rec.text.includes("secret-internal-path"),
      error: body.error.error,
      warnHasSecret: warns.some((w) => w.includes("secret-internal-path")),
    };
  });

  it("写入异常 → 500", () => {
    expect(c.status).toBe(500);
  });

  it("500 响应不含底层异常原文（P2-2）", () => {
    expect(c.hasSecret).toBe(false);
  });

  it("500 收敛固定文案", () => {
    expect(c.error).toMatch(/保存失败/);
  });

  it("异常原文进服务端日志", () => {
    expect(c.warnHasSecret).toBeTruthy();
  });
});
