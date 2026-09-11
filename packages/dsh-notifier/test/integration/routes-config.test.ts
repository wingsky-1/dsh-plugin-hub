// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e（配置读面与写面净化域）：config GET 包装体、PUT 增量写入与
 * 基线 diff、未知键透传（含 null）与装配键剔除、空/非法/数组/原型键净化、
 * entry 白名单、GET 读出口特殊键剔除、expectedRevision 校验。
 *
 * 拆法：原 routes.test.ts 按功能域拆分，本文件承载「配置读写与净化」域。
 * 边界依据：这些块共享「settings user 层 + PUT/GET 往返」观测面，与凭据脱敏、
 * history、events 域无共享状态；每块以独立实例重放其所需前缀。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, fakeReq, makeRes } from "../helpers.ts";
import { ROUTES } from "../../src/index.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-routes-config-"));
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

// config GET：包装体 {ok, user, revision, effective, writable}
describe("config GET 包装体", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-get.jsonl") });
    const configRoute = main.routes.find((r) => r.path === ROUTES.config);
    const rec = await call(configRoute, fakeReq({}));
    const body = JSON.parse(rec.text);
    c = {
      status: rec.status,
      ok: body.ok,
      user: body.user,
      revisionType: typeof body.revision,
      notifyAsk: body.effective.notifyAsk,
      writable: body.writable,
    };
  });

  it("GET 返回 200", () => {
    expect(c.status).toBe(200);
  });

  it("GET 带 ok 标记", () => {
    expect(c.ok).toBe(true);
  });

  it("初始 user 层为空（未设过值）", () => {
    expect(c.user).toEqual({});
  });

  it("revision 为数字", () => {
    expect(c.revisionType).toBe("number");
  });

  it("effective 含默认值", () => {
    expect(c.notifyAsk).toBe(true);
  });

  it("settings 可用时 writable=true", () => {
    expect(c.writable).toBe(true);
  });
});

// config PUT：{patch, expectedRevision} → settings user 层增量写入
describe("config PUT 增量写入与 GET 反映", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-put.jsonl") });
    const configRoute = main.routes.find((r) => r.path === ROUTES.config);
    const settings = main.settings;
    const rec = await call(configRoute, bodyReq({ patch: { notifyAsk: false } }));
    const body = JSON.parse(rec.text);
    c = {
      status: rec.status,
      ok: body.ok,
      userNotifyAsk: body.user.notifyAsk,
      revisionType: typeof body.revision,
      // settings 命名空间 user 层已写入（非自建 json 文件）
      settingsNotifyAsk: settings.getUser().notifyAsk,
    };
    // GET 反映新值（effective + user）
    const getBody = JSON.parse((await call(configRoute, fakeReq({}))).text);
    c.getUserNotifyAsk = getBody.user.notifyAsk;
    c.getEffectiveNotifyAsk = getBody.effective.notifyAsk;
    c.getQuietStart = getBody.effective.quietHours.start;
  });

  it("PUT 返回 200", () => {
    expect(c.status).toBe(200);
  });

  it("PUT 响应 ok=true", () => {
    expect(c.ok).toBe(true);
  });

  it("user 层反映新值", () => {
    expect(c.userNotifyAsk).toBe(false);
  });

  it("PUT 响应 revision 为数字", () => {
    expect(c.revisionType).toBe("number");
  });

  it("PUT 写官方 settings 命名空间 user 层（非 dsh-notifier.json）", () => {
    expect(c.settingsNotifyAsk).toBe(false);
  });

  it("GET user 层反映新值", () => {
    expect(c.getUserNotifyAsk).toBe(false);
  });

  it("GET effective 反映新值", () => {
    expect(c.getEffectiveNotifyAsk).toBe(false);
  });

  it("未提交的键保留 schema 默认", () => {
    expect(c.getQuietStart).toBe("22:00");
  });
});

// 基线 diff：PUT 仅含变更键 → service.update 只收到该 patch（不整表覆盖）
describe("基线 diff：service.update 只收到变更键", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-diff.jsonl") });
    const configRoute = main.routes.find((r) => r.path === ROUTES.config);
    await call(configRoute, bodyReq({ patch: { notifyAsk: false } }));
    const calls = main.settings.getUpdateCalls();
    const lastCall = calls[calls.length - 1];
    c = { hasCall: !!lastCall, patch: lastCall?.patch };
  });

  it("PUT 触发 service.update", () => {
    expect(c.hasCall).toBeTruthy();
  });

  it("service.update 只收到变更键（增量 patch，非整表）", () => {
    expect(c.patch).toEqual({ notifyAsk: false });
  });
});

// ===== 未知键透传保留（前向兼容）——PUT /config 行为 =====
describe("未知键透传保留与写面净化", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    // 独立实例：预置 user 层存量未知键（模拟旧版本/手改 yaml 的未来键）
    const { routes: nfRoutes, settings: nfSettings, dispose: nfDispose } = makeNotifier(
      work,
      { historyFile: join(work, "history-future.jsonl") },
      { settings: { user: { notifyAsk: true, futureKey: "keepme" } } },
    );
    const cfgR = nfRoutes.find((r) => r.path === ROUTES.config);
    c = {};

    // (1) 存量 user 层未知键在保存已知键后不丢（读写闭合）
    {
      const put = await call(cfgR, bodyReq({ patch: { notifyAsk: false } }));
      const after = nfSettings.getUser();
      c.c1Status = put.status;
      c.c1NotifyAsk = after.notifyAsk;
      c.c1FutureKey = after.futureKey;
    }

    // (2) PUT 携带顶层未知键 → 200 透传写入（GET 往返深等）；
    //     纯未知键 patch 200（不再落入「至少一个有效键」400）
    {
      const put = await call(cfgR, bodyReq({ patch: { futureKey2: { a: 1 }, notifySound: false } }));
      const putBody = JSON.parse(put.text);
      c.c2Status = put.status;
      c.c2BodyFuture = putBody.user.futureKey2;
      c.c2SettingsFuture = nfSettings.getUser().futureKey2;
      // GET 往返：读到的键原样仍在（读写闭合）
      const getBody = JSON.parse((await call(cfgR, fakeReq({}))).text);
      c.c2GetUserFuture = getBody.user.futureKey2;
      c.c2GetEffectiveFuture = getBody.effective.futureKey2;
      c.c2GetNotifySound = getBody.user.notifySound;
      // 纯未知键 patch → 200
      const put2 = await call(cfgR, bodyReq({ patch: { pureFuture: 1 } }));
      c.c2PureStatus = put2.status;
      c.c2PureValue = nfSettings.getUser().pureFuture;
      // 未知键 null 值透传（PUT {nullFuture:null} → 200，GET 可读回）
      const putNull = await call(cfgR, bodyReq({ patch: { nullFuture: null } }));
      c.c2NullStatus = putNull.status;
      c.c2HasNullFuture = Object.prototype.hasOwnProperty.call(nfSettings.getUser(), "nullFuture");
      c.c2NullValue = nfSettings.getUser().nullFuture;
      const getNullBody = JSON.parse((await call(cfgR, fakeReq({}))).text);
      c.c2GetHasNullFuture = Object.prototype.hasOwnProperty.call(getNullBody.user, "nullFuture");
      c.c2GetNullValue = getNullBody.user.nullFuture;
      c.c2GetEffectiveHasNullFuture = Object.prototype.hasOwnProperty.call(getNullBody.effective, "nullFuture");
    }

    // (3) 边界：空 patch {} → 仍 400（无变更可写）
    {
      const put = await call(cfgR, bodyReq({ patch: {} }));
      c.c3Status = put.status;
      c.c3Error = JSON.parse(put.text).error.error;
    }

    // (4) PUT 透传排除装配键名——configFile/toastScript/historyFile/
    //     statusFile/enabled 被剔除（不入 user 层）；组合层 entry 白名单语义不变
    {
      const put = await call(cfgR, bodyReq({ patch: { configFile: "/x", toastScript: "/y", historyFile: "/z", statusFile: "/s", enabled: false } }));
      c.c4Status = put.status;
      const user = nfSettings.getUser();
      c.c4NoAssemblyKeys = ["configFile", "toastScript", "historyFile", "statusFile", "enabled"].filter((key) => key in user);
      // 装配键 + 已知键混合 → 200，装配键剔除、已知键生效
      const put2 = await call(cfgR, bodyReq({ patch: { configFile: "/x", notifyQuestion: false } }));
      c.c4MixStatus = put2.status;
      c.c4MixHasConfigFile = "configFile" in nfSettings.getUser();
      c.c4MixNotifyQuestion = nfSettings.getUser().notifyQuestion;
    }

    // (5) 已知键非法值仍 400 + hint；未知键存在不改变校验结果
    {
      const put = await call(cfgR, bodyReq({ patch: { notifyAsk: "yes", futureKey3: 1 } }));
      const body = JSON.parse(put.text);
      c.c5Status = put.status;
      c.c5Error = body.error.error;
      c.c5Hint = body.error.hint;
      c.c5HasFutureKey3 = "futureKey3" in nfSettings.getUser();
    }

    // (6) user 层旧脏键不被自动清洗——透传键升为已知键后提交脏值
    //     400 + hint；保存其他键不触发 400（脏键留 user 层，读面归一化兜底）
    {
      // 模拟 vN 未知键 futureFlag 已透传进 user 层、vN+1 升级为已知键（脏值 true 是
      // 合法布尔，此处用类型非法值模拟旧脏键；直接 setUser 预置，模拟「升级前写入」）
      nfSettings.setUser({ notifyAsk: true, futureKey: "keepme", futureKey2: { a: 1 }, pureFuture: 1, dirtyKnown: "yes" });
      // 保存其他已知键（不提交 dirtyKnown）→ 200，脏键仍在
      const put = await call(cfgR, bodyReq({ patch: { notifySound: true } }));
      c.c6Status = put.status;
      c.c6DirtyKnown = nfSettings.getUser().dirtyKnown;
      // 主动提交脏已知键（dirtyKnown 若为已知键需合法——此处用真的已知键 notifyAsk 字符串形态）
      const put2 = await call(cfgR, bodyReq({ patch: { notifyAsk: "yes" } }));
      c.c6DirtyStatus = put2.status;
      c.c6DirtyError = JSON.parse(put2.text).error.error;
    }

    // (7) 链路模拟：GET effective（含未知键）→ 改已知键 →
    //     diffPayload 不含未知键 → PUT → GET 未知键保留（client 只提交变更键）
    {
      // 预置未知键 + 已知键，读 GET effective 作为 UI 基线（client loadCard 语义）
      await call(cfgR, bodyReq({ patch: { chainFuture: { k: 1 }, notifyTaskDone: true } }));
      const effective0 = JSON.parse((await call(cfgR, fakeReq({}))).text).effective;
      // UI 以 effective 深拷贝为 settings 与 baselineRef：只改一个已知键
      const baselineRef = JSON.parse(JSON.stringify(effective0));
      const settingsView = JSON.parse(JSON.stringify(effective0));
      settingsView.notifyTaskDone = false;
      // diffPayload 只提交与基线不同的键——逻辑与 src/client/index.ts
      // diffSettingsPayload 完全一致（无夹带守卫；真函数另有 client-contract
      // 产物直测，此处模拟同语义 diff 走 HTTP 整链）
      const payload: Record<string, unknown> = {};
      for (const key in settingsView) {
        if (!Object.prototype.hasOwnProperty.call(settingsView, key)) continue;
        if (JSON.stringify(settingsView[key]) !== JSON.stringify(baselineRef[key])) {
          payload[key] = settingsView[key];
        }
      }
      c.c7Payload = payload;
      const put = await call(cfgR, bodyReq({ patch: payload }));
      c.c7Status = put.status;
      const get1 = JSON.parse((await call(cfgR, fakeReq({}))).text);
      c.c7FinalFuture = get1.user.chainFuture;
      c.c7EffectiveFutureK = get1.effective.chainFuture.k;
      // 边界：diff 含未知键时 PUT 可透传（未知键作为 payload 一部分 → 200 写入）
      const put2 = await call(cfgR, bodyReq({ patch: { diffFuture: 2, notifyAsk: false } }));
      c.c7DiffStatus = put2.status;
      c.c7DiffFuture = nfSettings.getUser().diffFuture;
    }

    nfDispose();
  });

  it("保存已知键成功", () => {
    expect(c.c1Status).toBe(200);
  });

  it("已知键保存生效", () => {
    expect(c.c1NotifyAsk).toBe(false);
  });

  it("存量未知键不被已知键保存清除", () => {
    expect(c.c1FutureKey).toBe("keepme");
  });

  it("已知+未知混合 PUT 200", () => {
    expect(c.c2Status).toBe(200);
  });

  it("PUT 响应 user 含透传未知键", () => {
    expect(c.c2BodyFuture).toEqual({ a: 1 });
  });

  it("settings user 层含透传未知键（原样并入）", () => {
    expect(c.c2SettingsFuture).toEqual({ a: 1 });
  });

  it("GET user 层保留透传未知键", () => {
    expect(c.c2GetUserFuture).toEqual({ a: 1 });
  });

  it("GET effective 透传未知键（读面归一化保留）", () => {
    expect(c.c2GetEffectiveFuture).toEqual({ a: 1 });
  });

  it("已知键同步生效", () => {
    expect(c.c2GetNotifySound).toBe(false);
  });

  it("纯未知键 patch 200 透传（不再 400）", () => {
    expect(c.c2PureStatus).toBe(200);
  });

  it("纯未知键写入 user 层", () => {
    expect(c.c2PureValue).toBe(1);
  });

  it("纯未知键 null patch 200 透传", () => {
    expect(c.c2NullStatus).toBe(200);
  });

  it("settings user 层含 nullFuture 键", () => {
    expect(c.c2HasNullFuture).toBe(true);
  });

  it("nullFuture 值为 null 原样保留", () => {
    expect(c.c2NullValue).toBe(null);
  });

  it("GET user 读回 nullFuture", () => {
    expect(c.c2GetHasNullFuture).toBe(true);
  });

  it("GET user nullFuture 值为 null", () => {
    expect(c.c2GetNullValue).toBe(null);
  });

  it("GET effective 读回 nullFuture", () => {
    expect(c.c2GetEffectiveHasNullFuture).toBe(true);
  });

  it("空 patch 仍 400", () => {
    expect(c.c3Status).toBe(400);
  });

  it("空 patch 400 带配置校验失败", () => {
    expect(c.c3Error).toMatch(/配置校验失败/);
  });

  it("纯装配键 patch 净化后无任何可写键 → 400（同空 patch 语义）", () => {
    expect(c.c4Status).toBe(400);
  });

  for (const key of ["configFile", "toastScript", "historyFile", "statusFile", "enabled"]) {
    it(`装配键 ${key} 不入 user 层`, () => {
      expect(c.c4NoAssemblyKeys).not.toContain(key);
    });
  }

  it("装配键+已知键混合 200（装配键剔除）", () => {
    expect(c.c4MixStatus).toBe(200);
  });

  it("混合提交后 configFile 仍未入 user 层", () => {
    expect(c.c4MixHasConfigFile).toBe(false);
  });

  it("已知键生效（notifyQuestion）", () => {
    expect(c.c4MixNotifyQuestion).toBe(false);
  });

  it("非法已知键 400（未知键并存不改变结果）", () => {
    expect(c.c5Status).toBe(400);
  });

  it("400 指明首个非法键 notifyAsk", () => {
    expect(c.c5Error).toMatch(/配置校验失败: notifyAsk/);
  });

  it("400 带 hint", () => {
    expect(c.c5Hint).toBeTruthy();
  });

  it("被拒 patch 的未知键不写入", () => {
    expect(c.c5HasFutureKey3).toBe(false);
  });

  it("保存其他键不触发脏键 400", () => {
    expect(c.c6Status).toBe(200);
  });

  it("旧脏键不被自动清洗（留待用户主动改/手清）", () => {
    expect(c.c6DirtyKnown).toBe("yes");
  });

  it("主动提交脏已知键 400 + hint", () => {
    expect(c.c6DirtyStatus).toBe(400);
  });

  it("400 指明脏已知键", () => {
    expect(c.c6DirtyError).toMatch(/notifyAsk/);
  });

  it("diff 只含变更已知键，不含未知键", () => {
    expect(c.c7Payload).toEqual({ notifyTaskDone: false });
  });

  it("diff payload PUT 成功", () => {
    expect(c.c7Status).toBe(200);
  });

  it("GET→diff→PUT→GET 整链后未知键保留且值未变", () => {
    expect(c.c7FinalFuture).toEqual({ k: 1 });
  });

  it("effective 同保未知键", () => {
    expect(c.c7EffectiveFutureK).toBe(1);
  });

  it("diff 含未知键可透传写入", () => {
    expect(c.c7DiffStatus).toBe(200);
  });

  it("未知键经 PUT 透传并入 user 层", () => {
    expect(c.c7DiffFuture).toBe(2);
  });
});

// (8) entry 白名单回归：组合层装配键 configFile/enabled 不进
//     settings user 层（makeNotifier 的 entry 经 sanitizeSettings 白名单过滤，
//     base 层承载已知配置键、装配键被丢弃——不混入 user 层，也不进 GET user）
describe("entry 白名单回归：装配键不入 user 层", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const { routes: enRoutes, settings: enSettings, dispose: enDispose } = makeNotifier(work, {
      historyFile: join(work, "history-entry.jsonl"),
      configFile: join(work, "entry-cfg.json"),
      enabled: true,
      notifyAsk: false,
    });
    const cfgR2 = enRoutes.find((r) => r.path === ROUTES.config);
    const user = enSettings.getUser();
    const getBody = JSON.parse((await call(cfgR2, fakeReq({}))).text);
    c = {
      user,
      getBody,
      assemblyInUser: ["configFile", "toastScript", "historyFile", "statusFile", "enabled"].filter((key) => key in getBody.user),
    };
    enDispose();
  });

  it("组合层 entry 只进 base 层，user 层保持空（装配键与已知键都不入 user）", () => {
    expect(c.user).toEqual({});
  });

  for (const key of ["configFile", "toastScript", "historyFile", "statusFile", "enabled"]) {
    it(`GET user 不含装配键 ${key}`, () => {
      expect(c.assemblyInUser).not.toContain(key);
    });
  }

  it("entry 已知键经 base 层进 effective（装配键不干扰）", () => {
    expect(c.getBody.effective.notifyAsk).toBe(false);
  });

  it("effective 其余键默认值兜底", () => {
    expect(c.getBody.effective.quietHours.enabled).toBe(false);
  });
});

// (9) 路由级回归：数组 patch 拒绝（不写脏数字键）；
//     原型链成员键（constructor/hasOwnProperty/__proto__…）不触发 500、
//     不脏写 user 层（既有 JSON.parse 注入形态）
describe("数组 patch 与原型链成员键净化", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const { routes: pfRoutes, settings: pfSettings, dispose: pfDispose } = makeNotifier(work, {
      historyFile: join(work, "history-proto.jsonl"),
    });
    const cfgR3 = pfRoutes.find((r) => r.path === ROUTES.config);
    c = {};

    // 数组 patch：[1,2] 不得被当对象透传 → 400，user 层无 "0"/"1" 脏键
    const putArr = await call(cfgR3, bodyReq({ patch: [1, 2] }));
    c.arrStatus = putArr.status;
    const arrUser = pfSettings.getUser();
    c.arrNoIndexKeys = !("0" in arrUser) && !("1" in arrUser);
    c.arrUser = { ...arrUser };
    // 空数组同样 400
    const putArr2 = await call(cfgR3, bodyReq({ patch: [] }));
    c.emptyArrStatus = putArr2.status;

    // 原型链成员键：逐个 PUT 不得抛异常（handler 捕获 → 400）、不脏写 user 层
    c.protoResults = [];
    for (const key of ["constructor", "hasOwnProperty", "prototype", "toString", "valueOf", "__proto__"]) {
      const evil = JSON.parse(`{"${key}": 1}`);
      let threw = false;
      let put: any;
      try {
        put = await call(cfgR3, bodyReq({ patch: evil }));
      } catch {
        threw = true;
      }
      c.protoResults.push({
        key,
        threw,
        status: put?.status,
        notWritten: !Object.prototype.hasOwnProperty.call(pfSettings.getUser(), key),
      });
    }
    // 原型键 + 已知键混合：仅已知键生效、原型键剔除（200）
    const mixed = JSON.parse('{"notifyAsk":false,"__proto__":{"polluted":1},"constructor":1}');
    const putMix = await call(cfgR3, bodyReq({ patch: mixed }));
    c.mixStatus = putMix.status;
    const mixUser = pfSettings.getUser();
    c.mixNotifyAsk = mixUser.notifyAsk;
    c.mixHasConstructor = Object.prototype.hasOwnProperty.call(mixUser, "constructor");
    c.mixPolluted = {}.polluted;
    pfDispose();
  });

  it("数组 patch → 400（不当对象透传）", () => {
    expect(c.arrStatus).toBe(400);
  });

  it("数组 patch 不写脏数字索引键", () => {
    expect(c.arrNoIndexKeys).toBeTruthy();
  });

  it("数组 patch 后 user 层保持空", () => {
    expect(c.arrUser).toEqual({});
  });

  it("空数组 patch → 400", () => {
    expect(c.emptyArrStatus).toBe(400);
  });

  for (const key of ["constructor", "hasOwnProperty", "prototype", "toString", "valueOf", "__proto__"]) {
    it(`${key} patch 不抛未捕获异常（无 500/悬挂）`, () => {
      expect(c.protoResults.find((r) => r.key === key).threw).toBe(false);
    });

    it(`${key} 纯原型键 patch → 400（净化后无键可写）`, () => {
      expect(c.protoResults.find((r) => r.key === key).status).toBe(400);
    });

    it(`${key} 不脏写 user 层`, () => {
      expect(c.protoResults.find((r) => r.key === key).notWritten).toBe(true);
    });
  }

  it("原型键+已知键混合 → 200（原型键剔除）", () => {
    expect(c.mixStatus).toBe(200);
  });

  it("混合提交已知键生效", () => {
    expect(c.mixNotifyAsk).toBe(false);
  });

  it("混合提交 constructor 不写入", () => {
    expect(c.mixHasConstructor).toBe(false);
  });

  it("无全局原型污染", () => {
    expect(c.mixPolluted).toBe(undefined);
  });
});

// (10) GET user/effective 不含特殊键（constructor/prototype/
//      __proto__/toString/hasOwnProperty/valueOf）契约扫描——即使存量 user 层
//      被外部手改注入特殊键（模拟 setUser 预置），读出口也不泄露（normalize 剔除）
describe("GET 读出口特殊键剔除", () => {
  let c: Record<string, any>;

  beforeAll(async () => {
    const { routes: gfRoutes, dispose: gfDispose } = makeNotifier(
      work,
      { historyFile: join(work, "history-getproto.jsonl") },
      {
        settings: {
          user: JSON.parse('{"notifyAsk":true,"futureKey":1,"constructor":1,"prototype":2,"toString":3,"hasOwnProperty":4,"valueOf":5,"__proto__":{"polluted":1}}'),
        },
      },
    );
    const cfgR4 = gfRoutes.find((r) => r.path === ROUTES.config);
    const rec = await call(cfgR4, fakeReq({}));
    const body = JSON.parse(rec.text);
    c = {
      status: rec.status,
      body,
      badKeys: ["constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "__proto__"],
      futureKey: body.user.futureKey,
      effectiveNotifyAsk: body.effective.notifyAsk,
      polluted: Object.prototype.polluted,
    };
    gfDispose();
  });

  it("存量 user 含特殊键 GET 正常 200（不崩）", () => {
    expect(c.status).toBe(200);
  });

  for (const badKey of ["constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
    it(`GET user 不含特殊键 ${badKey}`, () => {
      expect(Object.prototype.hasOwnProperty.call(c.body.user, badKey)).toBe(false);
    });

    it(`GET effective 不含特殊键 ${badKey}`, () => {
      expect(Object.prototype.hasOwnProperty.call(c.body.effective, badKey)).toBe(false);
    });
  }

  it("GET user 普通未知键保留", () => {
    expect(c.futureKey).toBe(1);
  });

  it("GET effective 已知键正常", () => {
    expect(c.effectiveNotifyAsk).toBe(true);
  });

  it("GET 读出口无全局原型污染", () => {
    expect(c.polluted).toBe(undefined);
  });
});

// expectedRevision 缺省：无冲突检测（不带 revision 的 PUT 成功）
describe("expectedRevision 缺省 PUT 成功", () => {
  it("缺省 expectedRevision 的 PUT 成功", async () => {
    const main = makeNotifier(work, { historyFile: join(work, "history-d18.jsonl") });
    const configRoute = main.routes.find((r) => r.path === ROUTES.config);
    const rec = await call(configRoute, bodyReq({ patch: { notifyQuestion: false } }));
    expect(rec.status).toBe(200);
  });
});

// expectedRevision 非非负整数 → 400 显式拒（不再静默忽略）；
// null 同省略 → 200（独立实例，避免污染主实例 revision 链）
describe("expectedRevision 非法值 400 与 null 同省略", () => {
  let f: { cfgD19: any; d19Dispose: () => void };

  beforeAll(() => {
    const { routes: d19Routes, dispose: d19Dispose } = makeNotifier(work, { historyFile: join(work, "history-d19.jsonl") });
    f = { cfgD19: d19Routes.find((r) => r.path === ROUTES.config), d19Dispose };
  });
  afterAll(() => f.d19Dispose());

  for (const bad of ["abc", 1.5, -1]) {
    it(`expectedRevision=${JSON.stringify(bad)} → 400`, async () => {
      const put = await call(f.cfgD19, bodyReq({ patch: { notifyAsk: false }, expectedRevision: bad }));
      expect(put.status).toBe(400);
    });

    it(`expectedRevision=${JSON.stringify(bad)}：400 指明 expectedRevision 键`, async () => {
      const put = await call(f.cfgD19, bodyReq({ patch: { notifyAsk: false }, expectedRevision: bad }));
      expect(JSON.parse(put.text).error.error).toMatch(/expectedRevision/);
    });

    it(`expectedRevision=${JSON.stringify(bad)}：400 hint 说明必须为非负整数或省略`, async () => {
      const put = await call(f.cfgD19, bodyReq({ patch: { notifyAsk: false }, expectedRevision: bad }));
      expect(JSON.parse(put.text).error.hint).toMatch(/非负整数/);
    });
  }

  it("null expectedRevision 同省略 → 200", async () => {
    const put = await call(f.cfgD19, bodyReq({ patch: { notifyAsk: false }, expectedRevision: null }));
    expect(put.status).toBe(200);
  });
});
