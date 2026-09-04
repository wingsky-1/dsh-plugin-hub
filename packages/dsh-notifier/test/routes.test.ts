// @ts-nocheck
/**
 * dsh-notifier — e2e：HTTP 路由（config / events SSE / health / test / history）。
 *
 * 覆盖（issue #76 新契约）：
 * - 五条路由注册面；403 loopback 围栏与 405 方法白名单（J1/J2）；
 * - config GET：包装体 {ok, user, revision, effective, writable}（F1/A3）
 *   与 user 层/revision 反映；
 * - config PUT：{patch, expectedRevision} → 增量写入 settings user 层（F2/A2）；
 *   A4 基线 diff（仅提交变更键 → service.update 只收到该 patch）；
 *   F4 expectedRevision 可选（缺省不校验）；G1 409 版本冲突 / G2 503
 *   settings-unavailable / G3 写入异常 500 不含原文 / G4 首个非法键 400 + hint；
 * - PUT 容错：非法 JSON 400、超大 body 不挂起（J3/J4）；
 * - events SSE：connected 首帧（C1）、kind=test 广播、seq、?since 回放（C7）；
 * - history：落盘轮询（D4）/DELETE 清空（D7）/historyMaxAgeDays 按天清理（D5）
 *   /200 滚动上限（D6）；免打扰拦截 suppressed:quiet（D3）。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assert, makeNotifier, fakeReq, makeRes, waitForHistory, turnPair, quietWindowNow } from "./helpers.ts";
import { ROUTES } from "../lib/index.js";

const work = mkdtempSync(join(tmpdir(), "dnotify-routes-"));
let mainNotifier;
try {
  // 独立 history 文件：隔离其他测试块的 fire-and-forget 异步写盘，
  // 避免跨 apply 实例对同一 history.jsonl 的 read-modify-write 竞态把 test 挤出末尾（issue #17）。
  mainNotifier = makeNotifier(work, { historyFile: join(work, "history-route.jsonl") });
  const { routes, settings } = mainNotifier;
  const configRoute = routes.find((r) => r.path === ROUTES.config);
  const eventsRoute = routes.find((r) => r.path === ROUTES.events);
  const healthRoute = routes.find((r) => r.path === ROUTES.health);
  const testRoute = routes.find((r) => r.path === ROUTES.test);
  const historyRoute = routes.find((r) => r.path === ROUTES.history);
  const statusRoute = routes.find((r) => r.path === ROUTES.status);
  const kindsRoute = routes.find((r) => r.path === ROUTES.kinds);
  assert.ok(configRoute && eventsRoute && healthRoute && testRoute && historyRoute && statusRoute && kindsRoute, "七条路由已注册（M2 增 status/kinds）");

  // #472 收敛锚定：sseData 收敛 shared/host-utils.js 后 notifier 导出面不变——
  // lib/index.js 不得新增 sseData 导出（现状从不导出，防未来误加导出面漂移）。
  {
    const lib = await import("../lib/index.js");
    assert.ok(!("sseData" in lib), "lib/index.js 不得可见 sseData（notifier 从不导出该符号）");
  }

  // 403（J1）——含 M2 新路由（围栏必项，评审缺口项）
  // #473 批 1（B1-4）：403 body 文案断言（守卫收敛后逐字节锁定）
  for (const route of [configRoute, eventsRoute, healthRoute, testRoute, historyRoute, statusRoute, kindsRoute]) {
    const { rec, res } = makeRes();
    await route.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res);
    assert.equal(rec.status, 403);
    assert.equal(JSON.parse(rec.text).error, "forbidden: loopback-only", "403 body 围栏文案");
  }

  // 405（J2）：test 路由仅 POST；history 路由 GET/DELETE；health 仅 GET；status 仅 GET；kinds 仅 GET/POST
  {
    const { rec, res } = makeRes();
    await testRoute.handler(fakeReq({}), res);
    assert.equal(rec.status, 405);
    const { rec: rec2, res: res2 } = makeRes();
    await historyRoute.handler(fakeReq({ method: "POST" }), res2);
    assert.equal(rec2.status, 405);
    // #473 批 1（B1-3）：history（GET/DELETE 白名单）POST → 405 + error 文案
    assert.equal(JSON.parse(rec2.text).error, "method not allowed: POST", "history POST 405 body 文案");
    const { rec: rec3, res: res3 } = makeRes();
    await healthRoute.handler(fakeReq({ method: "DELETE" }), res3);
    assert.equal(rec3.status, 405);
    // #473 批 1（B1-4）：单方法端点 405 body 文案断言
    assert.equal(JSON.parse(rec3.text).error, "method not allowed: DELETE", "health DELETE 405 body 文案");
    const { rec: rec4, res: res4 } = makeRes();
    await statusRoute.handler(fakeReq({ method: "POST" }), res4);
    assert.equal(rec4.status, 405);
    const { rec: rec5, res: res5 } = makeRes();
    await kindsRoute.handler(fakeReq({ method: "DELETE" }), res5);
    assert.equal(rec5.status, 405);
    // #473 批 1（B1-3）：kinds（GET/POST 白名单）DELETE → 405 + error 文案
    assert.equal(JSON.parse(rec5.text).error, "method not allowed: DELETE", "kinds DELETE 405 body 文案");
    // #473 批 1（B1-3）：config（GET/PUT 白名单）补非法方法锚 DELETE → 405 + error 文案
    const { rec: rec6, res: res6 } = makeRes();
    await configRoute.handler(fakeReq({ method: "DELETE" }), res6);
    assert.equal(rec6.status, 405);
    assert.equal(JSON.parse(rec6.text).error, "method not allowed: DELETE", "config DELETE 405 body 文案");
  }

  // health：配置摘要与 sseConnections
  {
    const { rec, res } = makeRes();
    await healthRoute.handler(fakeReq({}), res);
    assert.equal(rec.status, 200);
    const body = JSON.parse(rec.text);
    assert.equal(body.ok, true);
    assert.equal(body.plugin, "dsh-notifier");
    assert.equal(typeof body.config.notifyAsk, "boolean", "health 返回配置摘要");
    assert.equal(body.config.maxConnections, 16, "health 摘要含 maxConnections（与默认配置一致）");
    assert.equal(typeof body.sseConnections, "number");
  }

  // config GET：包装体 {ok, user, revision, effective, writable}（F1/A3）
  {
    const { rec, res } = makeRes();
    await configRoute.handler(fakeReq({}), res);
    assert.equal(rec.status, 200);
    const body = JSON.parse(rec.text);
    assert.equal(body.ok, true, "GET 带 ok 标记");
    assert.deepEqual(body.user, {}, "初始 user 层为空（未设过值）");
    assert.equal(typeof body.revision, "number");
    assert.equal(body.effective.notifyAsk, true, "effective 含默认值");
    assert.equal(body.writable, true, "settings 可用时 writable=true");
  }

  // config PUT：{patch, expectedRevision} → settings user 层增量写入（F2/A2）
  {
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
    const { rec, res } = makeRes();
    await configRoute.handler(bodyReq({ patch: { notifyAsk: false } }), res);
    assert.equal(rec.status, 200);
    const body = JSON.parse(rec.text);
    assert.equal(body.ok, true);
    assert.equal(body.user.notifyAsk, false, "user 层反映新值");
    assert.equal(typeof body.revision, "number");
    // settings 命名空间 user 层已写入（非自建 json 文件）
    assert.equal(settings.getUser().notifyAsk, false, "PUT 写官方 settings 命名空间 user 层（非 dsh-notifier.json）");

    // GET 反映新值（effective + user）
    const { rec: rec2, res: res2 } = makeRes();
    await configRoute.handler(fakeReq({}), res2);
    const getBody = JSON.parse(rec2.text);
    assert.equal(getBody.user.notifyAsk, false, "GET user 层反映新值");
    assert.equal(getBody.effective.notifyAsk, false, "GET effective 反映新值");
    assert.equal(getBody.effective.quietHours.start, "22:00", "未提交的键保留 schema 默认");
  }

  // A4 基线 diff：PUT 仅含变更键 → service.update 只收到该 patch（不整表覆盖）
  {
    const calls = settings.getUpdateCalls();
    const lastCall = calls[calls.length - 1];
    assert.ok(lastCall, "PUT 触发 service.update");
    assert.deepEqual(lastCall.patch, { notifyAsk: false }, "service.update 只收到变更键（增量 patch，非整表）");
  }

  // ===== #470：未知键透传保留（前向兼容）——PUT /config 行为 =====
  {
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
    // 独立实例：预置 user 层存量未知键（模拟旧版本/手改 yaml 的未来键）
    const { routes: nfRoutes, settings: nfSettings, dispose: nfDispose } = makeNotifier(
      work,
      { historyFile: join(work, "history-future.jsonl") },
      { settings: { user: { notifyAsk: true, futureKey: "keepme" } } },
    );
    const cfgR = nfRoutes.find((r) => r.path === ROUTES.config);

    // (1) #470 验收 2：存量 user 层未知键在保存已知键后不丢（读写闭合）
    {
      const put = makeRes();
      await cfgR.handler(bodyReq({ patch: { notifyAsk: false } }), put.res);
      assert.equal(put.rec.status, 200, "保存已知键成功");
      const after = nfSettings.getUser();
      assert.equal(after.notifyAsk, false, "已知键保存生效");
      assert.equal(after.futureKey, "keepme", "存量未知键不被已知键保存清除");
    }

    // (2) #470 验收 3：PUT 携带顶层未知键 → 200 透传写入（GET 往返深等）；
    //     纯未知键 patch 200（不再落入「至少一个有效键」400）
    {
      const put = makeRes();
      await cfgR.handler(bodyReq({ patch: { futureKey2: { a: 1 }, notifySound: false } }), put.res);
      assert.equal(put.rec.status, 200, "已知+未知混合 PUT 200");
      const putBody = JSON.parse(put.rec.text);
      assert.deepEqual(putBody.user.futureKey2, { a: 1 }, "PUT 响应 user 含透传未知键");
      assert.deepEqual(nfSettings.getUser().futureKey2, { a: 1 }, "settings user 层含透传未知键（原样并入）");
      // GET 往返：读到的键原样仍在（读写闭合）
      const get = makeRes();
      await cfgR.handler(fakeReq({}), get.res);
      const getBody = JSON.parse(get.rec.text);
      assert.deepEqual(getBody.user.futureKey2, { a: 1 }, "GET user 层保留透传未知键");
      assert.deepEqual(getBody.effective.futureKey2, { a: 1 }, "GET effective 透传未知键（读面归一化保留）");
      assert.equal(getBody.user.notifySound, false, "已知键同步生效");
      // 纯未知键 patch → 200
      const put2 = makeRes();
      await cfgR.handler(bodyReq({ patch: { pureFuture: 1 } }), put2.res);
      assert.equal(put2.rec.status, 200, "纯未知键 patch 200 透传（不再 400）");
      assert.equal(nfSettings.getUser().pureFuture, 1, "纯未知键写入 user 层");
      // #470 qa 复核：未知键 null 值透传（PUT {nullFuture:null} → 200，GET 可读回）
      const putNull = makeRes();
      await cfgR.handler(bodyReq({ patch: { nullFuture: null } }), putNull.res);
      assert.equal(putNull.rec.status, 200, "纯未知键 null patch 200 透传");
      assert.equal(Object.prototype.hasOwnProperty.call(nfSettings.getUser(), "nullFuture"), true, "settings user 层含 nullFuture 键");
      assert.equal(nfSettings.getUser().nullFuture, null, "nullFuture 值为 null 原样保留");
      const getNull = makeRes();
      await cfgR.handler(fakeReq({}), getNull.res);
      const getNullBody = JSON.parse(getNull.rec.text);
      assert.equal(Object.prototype.hasOwnProperty.call(getNullBody.user, "nullFuture"), true, "GET user 读回 nullFuture");
      assert.equal(getNullBody.user.nullFuture, null, "GET user nullFuture 值为 null");
      assert.equal(Object.prototype.hasOwnProperty.call(getNullBody.effective, "nullFuture"), true, "GET effective 读回 nullFuture");
    }

    // (3) #470 验收 3 边界：空 patch {} → 仍 400（无变更可写）
    {
      const put = makeRes();
      await cfgR.handler(bodyReq({ patch: {} }), put.res);
      assert.equal(put.rec.status, 400, "空 patch 仍 400");
      const body = JSON.parse(put.rec.text);
      assert.match(body.error.error, /配置校验失败/, "空 patch 400 带配置校验失败");
    }

    // (4) #470 验收 4：PUT 透传排除装配键名——configFile/toastScript/historyFile/
    //     statusFile/enabled 被剔除（不入 user 层）；组合层 entry 白名单语义不变
    {
      const put = makeRes();
      await cfgR.handler(bodyReq({ patch: { configFile: "/x", toastScript: "/y", historyFile: "/z", statusFile: "/s", enabled: false } }), put.res);
      assert.equal(put.rec.status, 400, "纯装配键 patch 净化后无任何可写键 → 400（同空 patch 语义）");
      const user = nfSettings.getUser();
      for (const key of ["configFile", "toastScript", "historyFile", "statusFile", "enabled"]) {
        assert.ok(!(key in user), `装配键 ${key} 不入 user 层`);
      }
      // 装配键 + 已知键混合 → 200，装配键剔除、已知键生效
      const put2 = makeRes();
      await cfgR.handler(bodyReq({ patch: { configFile: "/x", notifyQuestion: false } }), put2.res);
      assert.equal(put2.rec.status, 200, "装配键+已知键混合 200（装配键剔除）");
      assert.ok(!("configFile" in nfSettings.getUser()), "混合提交后 configFile 仍未入 user 层");
      assert.equal(nfSettings.getUser().notifyQuestion, false, "已知键生效");
    }

    // (5) #470 验收 5：已知键非法值仍 400 + hint；未知键存在不改变校验结果
    {
      const put = makeRes();
      await cfgR.handler(bodyReq({ patch: { notifyAsk: "yes", futureKey3: 1 } }), put.res);
      assert.equal(put.rec.status, 400, "非法已知键 400（未知键并存不改变结果）");
      const body = JSON.parse(put.rec.text);
      assert.match(body.error.error, /配置校验失败: notifyAsk/, "400 指明首个非法键 notifyAsk");
      assert.ok(body.error.hint, "400 带 hint");
      assert.ok(!("futureKey3" in nfSettings.getUser()), "被拒 patch 的未知键不写入");
    }

    // (6) #470 验收 6：user 层旧脏键不被自动清洗——透传键升为已知键后提交脏值
    //     400 + hint；保存其他键不触发 400（脏键留 user 层，读面归一化兜底）
    {
      // 模拟 vN 未知键 futureFlag 已透传进 user 层、vN+1 升级为已知键（脏值 true 是
      // 合法布尔，此处用类型非法值模拟旧脏键；直接 setUser 预置，模拟「升级前写入」）
      nfSettings.setUser({ notifyAsk: true, futureKey: "keepme", futureKey2: { a: 1 }, pureFuture: 1, dirtyKnown: "yes" });
      // 保存其他已知键（不提交 dirtyKnown）→ 200，脏键仍在
      const put = makeRes();
      await cfgR.handler(bodyReq({ patch: { notifySound: true } }), put.res);
      assert.equal(put.rec.status, 200, "保存其他键不触发脏键 400");
      assert.equal(nfSettings.getUser().dirtyKnown, "yes", "旧脏键不被自动清洗（留待用户主动改/手清）");
      // 主动提交脏已知键（dirtyKnown 若为已知键需合法——此处用真的已知键 notifyAsk 字符串形态）
      const put2 = makeRes();
      await cfgR.handler(bodyReq({ patch: { notifyAsk: "yes" } }), put2.res);
      assert.equal(put2.rec.status, 400, "主动提交脏已知键 400 + hint");
      const b2 = JSON.parse(put2.rec.text);
      assert.match(b2.error.error, /notifyAsk/, "400 指明脏已知键");
    }

    // (7) #470 验收 8（链路模拟）：GET effective（含未知键）→ 改已知键 →
    //     diffPayload 不含未知键 → PUT → GET 未知键保留（client 只提交变更键）
    {
      // 预置未知键 + 已知键，读 GET effective 作为 UI 基线（client loadCard 语义）
      const pre = makeRes();
      await cfgR.handler(bodyReq({ patch: { chainFuture: { k: 1 }, notifyTaskDone: true } }), pre.res);
      const get0 = makeRes();
      await cfgR.handler(fakeReq({}), get0.res);
      const effective0 = JSON.parse(get0.rec.text).effective;
      // UI 以 effective 深拷贝为 settings 与 baselineRef：只改一个已知键
      const baselineRef = JSON.parse(JSON.stringify(effective0));
      const settingsView = JSON.parse(JSON.stringify(effective0));
      settingsView.notifyTaskDone = false;
      // diffPayload 只提交与基线不同的键——逻辑与 src/client/index.ts
      // diffSettingsPayload 完全一致（无夹带守卫；真函数另有 client-contract
      // #470 P1-2 产物直测，此处模拟同语义 diff 走 HTTP 整链）
      const payload = {};
      for (const key in settingsView) {
        if (!Object.prototype.hasOwnProperty.call(settingsView, key)) continue;
        if (JSON.stringify(settingsView[key]) !== JSON.stringify(baselineRef[key])) {
          payload[key] = settingsView[key];
        }
      }
      assert.deepEqual(payload, { notifyTaskDone: false }, "diff 只含变更已知键，不含未知键");
      const put = makeRes();
      await cfgR.handler(bodyReq({ patch: payload }), put.res);
      assert.equal(put.rec.status, 200, "diff payload PUT 成功");
      const get1 = makeRes();
      await cfgR.handler(fakeReq({}), get1.res);
      const finalUser = JSON.parse(get1.rec.text).user;
      assert.deepEqual(finalUser.chainFuture, { k: 1 }, "GET→diff→PUT→GET 整链后未知键保留且值未变");
      assert.equal(JSON.parse(get1.rec.text).effective.chainFuture.k, 1, "effective 同保未知键");
      // 边界：diff 含未知键时 PUT 可透传（未知键作为 payload 一部分 → 200 写入）
      const put2 = makeRes();
      await cfgR.handler(bodyReq({ patch: { diffFuture: 2, notifyAsk: false } }), put2.res);
      assert.equal(put2.rec.status, 200, "diff 含未知键可透传写入");
      assert.equal(nfSettings.getUser().diffFuture, 2, "未知键经 PUT 透传并入 user 层");
    }

    nfDispose();
  }

  // (8) #470 验收 4（entry 白名单回归）：组合层装配键 configFile/enabled 不进
  //     settings user 层（makeNotifier 的 entry 经 sanitizeSettings 白名单过滤，
  //     base 层承载已知配置键、装配键被丢弃——不混入 user 层，也不进 GET user）
  {
    const { routes: enRoutes, settings: enSettings, dispose: enDispose } = makeNotifier(work, {
      historyFile: join(work, "history-entry.jsonl"),
      configFile: join(work, "entry-cfg.json"),
      enabled: true,
      notifyAsk: false,
    });
    const cfgR2 = enRoutes.find((r) => r.path === ROUTES.config);
    const user = enSettings.getUser();
    assert.deepEqual(user, {}, "组合层 entry 只进 base 层，user 层保持空（装配键与已知键都不入 user）");
    const get = makeRes();
    await cfgR2.handler(fakeReq({}), get.res);
    const getBody = JSON.parse(get.rec.text);
    for (const key of ["configFile", "toastScript", "historyFile", "statusFile", "enabled"]) {
      assert.ok(!(key in getBody.user), `GET user 不含装配键 ${key}`);
    }
    assert.equal(getBody.effective.notifyAsk, false, "entry 已知键经 base 层进 effective（装配键不干扰）");
    assert.equal(getBody.effective.quietHours.enabled, false, "effective 其余键默认值兜底");
    enDispose();
  }

  // (9) #470 复核 P0/P1 路由级回归：数组 patch 拒绝（不写脏数字键）；
  //     原型链成员键（constructor/hasOwnProperty/__proto__…）不触发 500、
  //     不脏写 user 层（既有 JSON.parse 注入形态）
  {
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
    const { routes: pfRoutes, settings: pfSettings, dispose: pfDispose } = makeNotifier(work, {
      historyFile: join(work, "history-proto.jsonl"),
    });
    const cfgR3 = pfRoutes.find((r) => r.path === ROUTES.config);

    // 数组 patch：[1,2] 不得被当对象透传 → 400，user 层无 "0"/"1" 脏键
    const putArr = makeRes();
    await cfgR3.handler(bodyReq({ patch: [1, 2] }), putArr.res);
    assert.equal(putArr.rec.status, 400, "数组 patch → 400（不当对象透传）");
    const arrUser = pfSettings.getUser();
    assert.ok(!("0" in arrUser) && !("1" in arrUser), "数组 patch 不写脏数字索引键");
    assert.deepEqual(arrUser, {}, "数组 patch 后 user 层保持空");
    // 空数组同样 400
    const putArr2 = makeRes();
    await cfgR3.handler(bodyReq({ patch: [] }), putArr2.res);
    assert.equal(putArr2.rec.status, 400, "空数组 patch → 400");

    // 原型链成员键：逐个 PUT 不得抛异常（handler 捕获 → 400）、不脏写 user 层
    for (const key of ["constructor", "hasOwnProperty", "prototype", "toString", "valueOf", "__proto__"]) {
      const evil = JSON.parse(`{"${key}": 1}`);
      const put = makeRes();
      let threw = false;
      try {
        await cfgR3.handler(bodyReq({ patch: evil }), put.res);
      } catch {
        threw = true;
      }
      assert.equal(threw, false, `${key} patch 不抛未捕获异常（无 500/悬挂）`);
      assert.equal(put.rec.status, 400, `${key} 纯原型键 patch → 400（净化后无键可写）`);
      const userAfter = pfSettings.getUser();
      assert.equal(Object.prototype.hasOwnProperty.call(userAfter, key), false, `${key} 不脏写 user 层`);
    }
    // 原型键 + 已知键混合：仅已知键生效、原型键剔除（200）
    const mixed = JSON.parse('{"notifyAsk":false,"__proto__":{"polluted":1},"constructor":1}');
    const putMix = makeRes();
    await cfgR3.handler(bodyReq({ patch: mixed }), putMix.res);
    assert.equal(putMix.rec.status, 200, "原型键+已知键混合 → 200（原型键剔除）");
    const mixUser = pfSettings.getUser();
    assert.equal(mixUser.notifyAsk, false, "混合提交已知键生效");
    assert.equal(Object.prototype.hasOwnProperty.call(mixUser, "constructor"), false, "混合提交 constructor 不写入");
    assert.equal({}.polluted, undefined, "无全局原型污染");

    pfDispose();
  }

  // (10) #470 复核 P2 采纳：GET user/effective 不含特殊键（constructor/prototype/
  //      __proto__/toString/hasOwnProperty/valueOf）契约扫描——即使存量 user 层
  //      被外部手改注入特殊键（模拟 setUser 预置），读出口也不泄露（normalize 剔除）
  {
    const { routes: gfRoutes, settings: gfSettings, dispose: gfDispose } = makeNotifier(
      work,
      { historyFile: join(work, "history-getproto.jsonl") },
      {
        settings: {
          user: JSON.parse('{"notifyAsk":true,"futureKey":1,"constructor":1,"prototype":2,"toString":3,"hasOwnProperty":4,"valueOf":5,"__proto__":{"polluted":1}}'),
        },
      },
    );
    const cfgR4 = gfRoutes.find((r) => r.path === ROUTES.config);
    const get = makeRes();
    await cfgR4.handler(fakeReq({}), get.res);
    assert.equal(get.rec.status, 200, "存量 user 含特殊键 GET 正常 200（不崩）");
    const body = JSON.parse(get.rec.text);
    for (const badKey of ["constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(body.user, badKey), false, `GET user 不含特殊键 ${badKey}`);
      assert.equal(Object.prototype.hasOwnProperty.call(body.effective, badKey), false, `GET effective 不含特殊键 ${badKey}`);
    }
    assert.equal(body.user.futureKey, 1, "GET user 普通未知键保留");
    assert.equal(body.effective.notifyAsk, true, "GET effective 已知键正常");
    assert.equal(Object.prototype.polluted, undefined, "GET 读出口无全局原型污染");
    gfDispose();
  }

  // F4 expectedRevision 缺省：无冲突检测（不带 revision 的 PUT 成功）
  {
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
    const { rec, res } = makeRes();
    await configRoute.handler(bodyReq({ patch: { notifyQuestion: false } }), res);
    assert.equal(rec.status, 200, "缺省 expectedRevision 的 PUT 成功");
  }

  // ===== M2：Bark channels 凭据脱敏与掩码回填（issue #366，评审 P0-1/P0-2）=====
  {
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
    const SECRET = "realSecretKey42";

    // PUT 写入含 deviceKey 的 channels：user 层持明文，响应已掩码（单一出口）
    const put1 = makeRes();
    await configRoute.handler(bodyReq({ patch: { channels: [{ id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: SECRET, enabled: false }] } }), put1.res);
    assert.equal(put1.rec.status, 200, "合法 channels PUT 成功");
    const put1Body = JSON.parse(put1.rec.text);
    assert.ok(!JSON.stringify(put1Body).includes(SECRET), "PUT 响应不含 deviceKey 明文（评审 P0-1：PUT 成功响应也是出口）");
    assert.equal(put1Body.user.channels[0].deviceKey, "********", "PUT 响应 user 已掩码");
    assert.equal(settings.getUser().channels[0].deviceKey, SECRET, "settings user 层持明文（服务端回填依据）");

    // GET：user + effective 双出口深度扫描无明文
    const get1 = makeRes();
    await configRoute.handler(fakeReq({}), get1.res);
    const get1Body = JSON.parse(get1.rec.text);
    assert.ok(!JSON.stringify(get1Body).includes(SECRET), "GET 响应全文深度扫描不含 deviceKey 明文");
    assert.equal(get1Body.user.channels[0].deviceKey, "********", "GET user 出口掩码");
    assert.equal(get1Body.effective.channels[0].deviceKey, "********", "GET effective 出口掩码");
    assert.equal(get1Body.effective.channels[0].baseUrl, "https://api.day.app", "非凭据字段不受影响");

    // 掩码回填：同 id 实例提交掩码 → user 层 key 保持原值（先回填再校验）
    const put2 = makeRes();
    await configRoute.handler(bodyReq({ patch: { channels: [{ id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: "********", enabled: false, group: "dsh" }] } }), put2.res);
    assert.equal(put2.rec.status, 200, "掩码提交（未修改语义）成功");
    const afterUnmask = settings.getUser().channels[0];
    assert.equal(afterUnmask.deviceKey, SECRET, "掩码按 id 回填 user 层原值（未覆盖为掩码字面量）");
    assert.equal(afterUnmask.enabled, false, "其余字段正常更新");
    assert.equal(afterUnmask.group, "dsh", "新增可选参数正常更新");

    // 乱序多实例：掩码仍按 id 对齐（防下标串凭据）
    const put3 = makeRes();
    await configRoute.handler(bodyReq({ patch: { channels: [{ id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: SECRET, enabled: false }, { id: "pad", type: "bark", baseUrl: "https://api.day.app", deviceKey: "padKey777", enabled: false }] } }), put3.res);
    assert.equal(put3.rec.status, 200);
    const put4 = makeRes();
    await configRoute.handler(bodyReq({ patch: { channels: [{ id: "pad", type: "bark", baseUrl: "https://api.day.app", deviceKey: "********", enabled: false }, { id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: "********", enabled: false }] } }), put4.res);
    assert.equal(put4.rec.status, 200, "乱序掩码 PUT 成功");
    const userChs = settings.getUser().channels;
    const byId = Object.fromEntries(userChs.map((c) => [c.id, c.deviceKey]));
    assert.equal(byId.phone, SECRET, "phone 的 key 未被串改");
    assert.equal(byId.pad, "padKey777", "pad 的 key 未被串改");

    // 改 key：非掩码新值直接生效
    const put5 = makeRes();
    await configRoute.handler(bodyReq({ patch: { channels: [{ id: "phone", type: "bark", baseUrl: "https://api.day.app", deviceKey: "rotatedKey9", enabled: false }, { id: "pad", type: "bark", baseUrl: "https://api.day.app", deviceKey: "********", enabled: false }] } }), put5.res);
    assert.equal(put5.rec.status, 200, "混合提交（改 key + 掩码未改）成功");
    const byId2 = Object.fromEntries(settings.getUser().channels.map((c) => [c.id, c.deviceKey]));
    assert.equal(byId2.phone, "rotatedKey9", "非掩码新 key 生效（key 轮换）");
    assert.equal(byId2.pad, "padKey777", "掩码实例保持原 key");

    // 新实例带掩码 → 400（掩码只允许表达「未修改」）
    const put6 = makeRes();
    await configRoute.handler(bodyReq({ patch: { channels: [{ id: "brand-new", type: "bark", baseUrl: "https://api.day.app", deviceKey: "********", enabled: false }] } }), put6.res);
    assert.equal(put6.rec.status, 400, "新实例带掩码 400 拒绝");
    assert.ok(JSON.parse(put6.rec.text).error.hint.includes("掩码"), "400 hint 指引真实 key");

    // 重复 id → 400（校验器查重）
    const put7 = makeRes();
    await configRoute.handler(bodyReq({ patch: { channels: [{ id: "dup", type: "bark", baseUrl: "https://api.day.app", deviceKey: "k1", enabled: false }, { id: "dup", type: "bark", baseUrl: "https://api.day.app", deviceKey: "k2", enabled: false }] } }), put7.res);
    assert.equal(put7.rec.status, 400, "重复 id 400");
    assert.equal(JSON.parse(put7.rec.text).error.error, "配置校验失败: channels", "400 指明 channels 键");
  }

  // ===== M2：/test 收敛 service 管线 + /status + /kinds（issue #366）=====
  {
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
    // GET /status 初始空表
    const st1 = makeRes();
    await statusRoute.handler(fakeReq({}), st1.res);
    assert.equal(st1.rec.status, 200);
    const st1Body = JSON.parse(st1.rec.text);
    assert.equal(st1Body.ok, true);
    assert.deepEqual(st1Body.channels, {}, "初始状态空表");

    // POST /test（无 body）：收敛后返回受理 results（内置频道按开关）
    const t1 = makeRes();
    await testRoute.handler(postReq({}), t1.res);
    assert.equal(t1.rec.status, 200, "测试通知成功");
    const t1Body = JSON.parse(t1.rec.text);
    assert.equal(t1Body.ok, true);
    assert.ok(Array.isArray(t1Body.results), "收敛后响应含受理 results");
    assert.ok(t1Body.results.some((x) => x.channelId === "browser" && x.status === "ok"), "test kind 走 service 管线投递");

    // 投递终态落盘：内置频道同步终态，内存镜像即时可见（落盘 debounce 合并）
    const st2 = makeRes();
    await statusRoute.handler(fakeReq({}), st2.res);
    const st2Body = JSON.parse(st2.rec.text);
    assert.equal(st2Body.channels.browser?.lastStatus, "ok", "/test 后 browser 频道状态 ok");
    assert.equal(st2Body.channels.system?.lastStatus, "ok", "/test 后 system 频道状态 ok");

    // GET /kinds 初始空 + POST 未注册 kind → 404
    const k1 = makeRes();
    await kindsRoute.handler(fakeReq({}), k1.res);
    assert.deepEqual(JSON.parse(k1.rec.text).kinds, [], "初始动态 kind 清单空");
    const k2 = makeRes();
    await kindsRoute.handler(postReq({ kind: "nope:x", confirmed: true }), k2.res);
    assert.equal(k2.rec.status, 404, "未注册 kind 确认 404");
    const k3 = makeRes();
    await kindsRoute.handler(postReq({ kind: "bad" }), k3.res);
    assert.equal(k3.rec.status, 400, "非法 body 400");

    // 全链路：插件注册 kind → 待确认 → POST 确认 → user 层 allowKinds 落盘
    const notifier = mainNotifier.ctx.get("wingsky.notifier", false);
    assert.ok(notifier, "fake ctx 可读取 wingsky.notifier 服务");
    notifier.registerKind({ id: "e2e:due", label: "E2E 到期" });
    const k4 = makeRes();
    await kindsRoute.handler(fakeReq({}), k4.res);
    const kinds1 = JSON.parse(k4.rec.text).kinds;
    assert.ok(kinds1.some((k) => k.id === "e2e:due" && k.confirmed === false), "注册后待确认");
    const k5 = makeRes();
    await kindsRoute.handler(postReq({ kind: "e2e:due", confirmed: true }), k5.res);
    assert.equal(k5.rec.status, 200, "确认成功");
    assert.equal(JSON.parse(k5.rec.text).kinds.find((k) => k.id === "e2e:due").confirmed, true, "响应内确认态即时可见");
    assert.deepEqual(settings.getUser().allowKinds, ["e2e:due"], "确认态持久化到配置 allowKinds（重启保持）");
    // 确认后 send 放行（M1 的 suppressed 解除）
    const send1 = await notifier.send({ source: "e2e", kind: "e2e:due", severity: "info", body: "到期提醒" });
    assert.ok(send1.some((x) => x.status === "ok"), "确认后动态 kind 正常投递");
  }

  // config PUT 容错：非法 JSON → 400；超大 body → 不挂起、无未处理拒绝（J3/J4）
  {
    function rawBodyReq(text) {
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
    const { rec, res } = makeRes();
    await configRoute.handler(rawBodyReq("{ not json"), res);
    assert.equal(rec.status, 400, "非法 JSON 返回 400 可读错误");
    const { rec: rec2, res: res2 } = makeRes();
    await configRoute.handler(rawBodyReq('{"big":"' + "x".repeat(20 * 1024) + '"}'), res2);
    assert.equal(rec2.status, 0, "超大 body：连接被 destroy、handler 无响应但不挂起不抛错");
  }

  // G4 首个非法键 hint → 400（quietHours.start=25:00）
  {
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
    const { rec, res } = makeRes();
    await configRoute.handler(bodyReq({ patch: { quietHours: { start: "25:00" } } }), res);
    assert.equal(rec.status, 400, "非法键 400");
    const body = JSON.parse(rec.text);
    assert.equal(body.ok, false);
    assert.match(body.error.error, /配置校验失败/, "400 带「配置校验失败」");
    assert.ok(body.error.hint, "400 带 hint（合法范围描述）");
  }

  // G1：SETTINGS_CONFLICT → 409 固定文案（expectedRevision 过期 → service.update 抛冲突）
  {
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
    // 独立实例：先写入推进 revision，再用旧 revision PUT → 服务端冲突 409
    const { routes: conflictRoutes, settings: conflictSettings } = makeNotifier(work, { historyFile: join(work, "history-conflict.jsonl") });
    const cfgRoute = conflictRoutes.find((r) => r.path === ROUTES.config);
    // 首次写入，revision 前进
    await cfgRoute.handler(bodyReq({ patch: { notifyAsk: true } }), makeRes().res);
    const staleRevision = conflictSettings.getRevision();
    // 直接推进 user 层 revision（模拟其他窗口修改）
    await conflictSettings.service.update("dsh-notifier", { notifyQuestion: true });
    const { rec, res } = makeRes();
    await cfgRoute.handler(bodyReq({ patch: { notifySound: false }, expectedRevision: staleRevision }), res);
    assert.equal(rec.status, 409, "expectedRevision 过期 → 409");
    const body = JSON.parse(rec.text);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "SETTINGS_CONFLICT", "409 带 code=SETTINGS_CONFLICT");
    assert.match(body.error.error, /版本冲突/, "409 固定文案「版本冲突」");
  }

  // G2：settings 服务缺失（未 attach）→ PUT 503 settings-unavailable
  {
    const { apply } = await import("../lib/index.js");
    const { makeFakeCtx } = await import("./helpers.ts");
    // 不 provide settings 服务 → writable=false
    const { ctx, routes } = makeFakeCtx({});
    apply(ctx, { enabled: true, configFile: join(work, "no-settings-cfg.json"), historyFile: join(work, "no-settings-hist.jsonl") });
    const cfgRoute = routes.find((r) => r.path === ROUTES.config);
    const text = JSON.stringify({ patch: { notifyAsk: false } });
    const { rec, res } = makeRes();
    await cfgRoute.handler({
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
    }, res);
    assert.equal(rec.status, 503, "settings 缺失 → 503");
    const body = JSON.parse(rec.text);
    assert.equal(body.error.code, "settings-unavailable", "503 带 code=settings-unavailable");
    assert.match(body.error.error, /设置服务不可用/, "503 固定文案「设置服务不可用」");
  }

  // G3：写入异常原文只进服务端日志 → 500 收敛固定文案（不含底层异常原文）
  {
    const { apply } = await import("../lib/index.js");
    const { makeFakeCtx } = await import("./helpers.ts");
    const warns = [];
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
    const text = JSON.stringify({ patch: { notifyAsk: false } });
    const { rec, res } = makeRes();
    await cfgRoute.handler({
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
    }, res);
    assert.equal(rec.status, 500, "写入异常 → 500");
    const body = JSON.parse(rec.text);
    assert.ok(!rec.text.includes("secret-internal-path"), "500 响应不含底层异常原文（P2-2）");
    assert.match(body.error.error, /保存失败/, "500 收敛固定文案");
    assert.ok(warns.some((w) => w.includes("secret-internal-path")), "异常原文进服务端日志");
  }

  // events SSE（C1）
  {
    const { rec, res } = makeRes();
    await eventsRoute.handler(fakeReq({}), res);
    assert.equal(rec.status, 200);
    assert.equal(rec.headers["content-type"], "text/event-stream");
    assert.match(rec.text, /connected/);
  }

  // test：POST 触发通知广播到已连接的 SSE 客户端
  {
    const { rec: rec1, res: res1 } = makeRes();
    await eventsRoute.handler(fakeReq({}), res1);
    const { rec: rec2, res: res2 } = makeRes();
    const testReq = fakeReq({ method: "POST" });
    await testRoute.handler(testReq, res2);
    assert.equal(rec2.status, 200);
    assert.equal(JSON.parse(rec2.text).ok, true);
    assert.match(rec1.text, /测试通知/, "SSE 客户端收到测试通知帧");
    assert.match(rec1.text, /"kind":"test"/, "测试帧带 kind=test 标记");
    assert.match(rec1.text, /"seq":\d+/, "通知帧带递增 seq");
  }

  // events ?since 回放（独立上下文，seq 从 1 起）：断线补拉不丢尾部事件（C7）
  {
    const notifier2 = makeNotifier(work, { historyFile: join(work, "history-since.jsonl") });
    const { routes: routes2 } = notifier2;
    const eventsRoute2 = routes2.find((r) => r.path === ROUTES.events);
    const testRoute2 = routes2.find((r) => r.path === ROUTES.test);
    await testRoute2.handler(fakeReq({ method: "POST" }), makeRes().res); // seq=1
    await testRoute2.handler(fakeReq({ method: "POST" }), makeRes().res); // seq=2
    // since=1 的连接：只回放 seq=2
    const { rec, res } = makeRes();
    await eventsRoute2.handler(fakeReq({ url: "/api/dsh-notifier/events?since=1" }), res);
    const notifyFrames = rec.text.split("data: ").filter((s) => s.includes('"type":"notify"'));
    assert.equal(notifyFrames.length, 1, "since=1 只回放 1 条");
    assert.match(notifyFrames[0], /"seq":2/, "回放帧带正确 seq");
    // since 超出缓冲 → 无回放，仅 connected 注释
    const { rec: rec3, res: res3 } = makeRes();
    await eventsRoute2.handler(fakeReq({ url: "/api/dsh-notifier/events?since=99" }), res3);
    assert.ok(!rec3.text.includes('"type":"notify"'), "since 超出无回放");
    // 非法 since 静默回退为 0
    const { rec: rec4, res: res4 } = makeRes();
    await eventsRoute2.handler(fakeReq({ url: "/api/dsh-notifier/events?since=abc" }), res4);
    assert.ok(!rec4.text.includes('"type":"notify"'), "非法 since 按 0 处理");
    notifier2.dispose();
  }

  // #330 SSE 连接生命周期：上限淘汰最老 / close+error 幂等清理 /
  // write-false 背压不误杀 / 写失败连续 3 次判死 / 配置改小实时生效（下次注册收缩）。
  // 每个场景独立 makeNotifier 实例（隔离连接表，防跨块串扰）。
  {
    /** 可触发 close/error、可配置 write 行为的 fake res（events 路由用）。 */
    function sseRes(opts = {}) {
      const listeners = {};
      const state = { destroyed: false, writes: 0, destroyCalls: 0 };
      // presetDestroyed：模拟「对端已断但 close 事件漏发」的残留连接（P2-6 兜底分支用）
      if (opts.presetDestroyed) state.destroyed = true;
      return {
        state,
        writeHead() {},
        write() {
          state.writes += 1;
          if (opts.throwAfter !== undefined && state.writes > opts.throwAfter) throw new Error("EPIPE");
          if (opts.falseAfter !== undefined && state.writes > opts.falseAfter) return false;
          return true;
        },
        on(evt, cb) {
          (listeners[evt] = listeners[evt] || []).push(cb);
          return this;
        },
        emit(evt) {
          for (const cb of listeners[evt] || []) cb();
        },
        destroy() {
          state.destroyed = true;
          state.destroyCalls += 1; // 调用计数：区分幂等 evict 与重复销毁（P2-4）
        },
        get destroyed() {
          return state.destroyed;
        },
        writableEnded: false,
        socket: { setKeepAlive() {} },
      };
    }
    /** 独立实例路由查找（每次全新连接表）。 */
    async function freshRoutes(mark, maxConnections) {
      // issue #76 后配置走 settings 命名空间（configFile 仅作迁移源）：maxConnections
      // 直接经组合层 entry 注入（sanitizeSettings 白名单 → 命名空间 base 层）。
      const out = await makeNotifier(work, { maxConnections, historyFile: join(work, `sse-${mark}.jsonl`) });
      const near = (p) => out.routes.find((r) => r.path === p);
      return { ev: near(ROUTES.events), he: near(ROUTES.health), te: near(ROUTES.test), cfgR: near(ROUTES.config), dispose: out.dispose };
    }
    async function connCount(he) {
      const { rec, res } = makeRes();
      await he.handler(fakeReq({}), res);
      return JSON.parse(rec.text).sseConnections;
    }

    // (a) 上限淘汰最老：上限 2，注册 3 条 → 连接数收敛 2、最老被 destroy
    {
      const { ev, he, dispose } = await freshRoutes("a", 2);
      const r1 = sseRes();
      const r2 = sseRes();
      const r3 = sseRes();
      await ev.handler(fakeReq({}), r1);
      await ev.handler(fakeReq({}), r2);
      await ev.handler(fakeReq({}), r3);
      assert.equal(await connCount(he), 2, "注册 3 条超上限，连接数收敛到 2");
      assert.equal(r1.state.destroyed, true, "最老连接被 destroy（淘汰）");
      assert.equal(r2.state.destroyed, false, "较新连接保留");
      assert.equal(r3.state.destroyed, false, "最新连接保留");
      assert.equal(r1.state.destroyCalls, 1, "淘汰只销毁一次（evict 幂等）");
      dispose(); // 停心跳，防 30s unref 定时器残留（P2-5）
    }

    // (b) close/error 幂等清理：多次触发只移除一次
    {
      const { ev, he, dispose } = await freshRoutes("b", 4);
      const r = sseRes();
      await ev.handler(fakeReq({}), r);
      assert.equal(await connCount(he), 1, "注册后连接数为 1");
      r.emit("close");
      r.emit("error");
      r.emit("close"); // 重复触发，幂等
      assert.equal(await connCount(he), 0, "close/error 多次触发只移除一次");
      assert.equal(r.state.destroyed, true, "close 后连接被销毁");
      assert.equal(r.state.destroyCalls, 1, "幂等：close/error/close 只触发一次 destroy");
      dispose();
    }

    // (c) write 返回 false（背压）不误杀：多次广播连接仍在
    {
      const { ev, he, te, dispose } = await freshRoutes("c", 4);
      const r = sseRes({ falseAfter: 1 }); // 初始 connected 写成功，之后均返回 false
      await ev.handler(fakeReq({}), r);
      for (let i = 0; i < 5; i += 1) await te.handler(fakeReq({ method: "POST" }), makeRes().res);
      assert.equal(await connCount(he), 1, "write 返回 false 视为背压，5 次广播不误杀");
      assert.equal(r.state.destroyed, false, "背压连接未被销毁");
      dispose();
    }

    // (d) 写失败连续 3 次判死：前 2 次保留，第 3 次销毁
    {
      const { ev, he, te, dispose } = await freshRoutes("d", 4);
      const r = sseRes({ throwAfter: 1 }); // 初始 connected 写成功，之后每次写抛错
      await ev.handler(fakeReq({}), r);
      await te.handler(fakeReq({ method: "POST" }), makeRes().res); // failStreak=1
      await te.handler(fakeReq({ method: "POST" }), makeRes().res); // failStreak=2
      assert.equal(await connCount(he), 1, "连续 2 次写失败未达阈值，连接保留");
      await te.handler(fakeReq({ method: "POST" }), makeRes().res); // failStreak=3 → 销毁
      assert.equal(await connCount(he), 0, "连续 3 次写失败判死销毁");
      assert.equal(r.state.destroyed, true, "判死连接被销毁");
      dispose();
    }

    // (e) maxConnections 配置改小实时生效：下次注册即收缩到新上限
    {
      const { ev, he, cfgR, dispose } = await freshRoutes("e", 16);
      const r1 = sseRes();
      const r2 = sseRes();
      const r3 = sseRes();
      await ev.handler(fakeReq({}), r1);
      await ev.handler(fakeReq({}), r2);
      await ev.handler(fakeReq({}), r3);
      assert.equal(await connCount(he), 3, "默认上限 16 下注册 3 条不淘汰");
      // PUT {patch:{maxConnections:2}} → settings user 层（#76 新契约 F2/A2）
      const text = JSON.stringify({ patch: { maxConnections: 2 } });
      const putReq = {
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
      const { rec, res } = makeRes();
      await cfgR.handler(putReq, res);
      assert.equal(JSON.parse(rec.text).ok, true, "PUT 后配置生效");
      assert.equal(JSON.parse(rec.text).user.maxConnections, 2, "PUT 写 settings user 层");
      // 新注册触发 enforceLimit → 收缩到 2（淘汰最老 r1、r2）
      const r4 = sseRes();
      await ev.handler(fakeReq({}), r4);
      assert.equal(await connCount(he), 2, "配置改小后下次注册即收缩到新上限 2");
      assert.equal(r1.state.destroyed, true, "最老连接被淘汰");
      assert.equal(r2.state.destroyed, true, "次老连接同样被淘汰（收缩到上限 2）");
      assert.equal(r4.state.destroyed, false, "新注册保留");
      dispose();
    }

    // (f) destroyed/writableEnded 兜底分支：preset destroyed=true 后广播 → 立即 evict
    {
      const { ev, he, te, dispose } = await freshRoutes("f", 4);
      const r = sseRes({ presetDestroyed: true }); // 对端已断但 close 事件漏发的残留
      await ev.handler(fakeReq({}), r);
      assert.equal(await connCount(he), 1, "preset destroyed 注册后仍在表（注册路径不做预判）");
      await te.handler(fakeReq({ method: "POST" }), makeRes().res); // 广播 → writeFrame 命中兜底分支
      assert.equal(await connCount(he), 0, "广播命中 destroyed 兜底分支，立即 evict");
      assert.equal(r.state.destroyed, true, "兜底分支销毁连接");
      assert.equal(r.state.destroyCalls, 1, "兜底 evict 只销毁一次");
      dispose();
    }
  }

  // history：测试通知已落盘，GET 可查（独立 history 文件，无跨块串扰）（D4）
  {
    // appendHistory 是 fire-and-forget；轮询直到落盘，不再依赖固定 sleep 的时序假设
    const records = await waitForHistory(historyRoute, (rs) => rs.length >= 1 && rs[rs.length - 1]?.kind === "test");
    assert.ok(Array.isArray(records) && records.length >= 1, "历史记录非空");
    assert.equal(records[records.length - 1].kind, "test", "最近一条为测试通知");
    assert.match(records[records.length - 1].message, /通知链路工作正常/, "记录含测试文案");
  }

  // 并发历史写入：写队列串行化，不丢记录（模拟真实多事件同时触发）
  {
    const concurrent = 20;
    await Promise.all(Array.from({ length: concurrent }, async () => {
      const { rec, res } = makeRes();
      await testRoute.handler(fakeReq({ method: "POST" }), res);
      assert.equal(rec.status, 200);
    }));
    // 轮询直到并发写入全部落盘（独立 history 文件，单写链串行，末尾恒为 test）
    const records = await waitForHistory(historyRoute, (rs) => rs.filter((r) => r.kind === "test").length >= concurrent);
    const testCount = records.filter((r) => r.kind === "test").length;
    assert.ok(testCount >= concurrent, `并发写不丢记录（test 记录 ${testCount} ≥ ${concurrent}）`);
  }

  // history：DELETE 清空（D7）+ historyMaxAgeDays 按天清理（D5）（独立上下文）
  {
    const hfile = join(work, "history-clean.jsonl");
    const { routes, dispose: disposeClean } = makeNotifier(work, { historyFile: hfile, historyMaxAgeDays: 7 });
    const h = routes.find((r) => r.path === ROUTES.history);
    const t = routes.find((r) => r.path === ROUTES.test);
    // 预置一条 10 天前的旧记录
    writeFileSync(hfile, JSON.stringify({ ts: Date.now() - 10 * 86400000, kind: "done", title: "旧记录", message: "10 天前" }) + "\n");
    // 触发一条新通知（test 路由 → 落盘；写时会按 7 天 cutoff 剔除旧行）
    await t.handler(fakeReq({ method: "POST" }), makeRes().res);
    await new Promise((resolve) => setTimeout(resolve, 80)); // 等写队列排空
    const { rec: recGet, res: resGet } = makeRes();
    await h.handler(fakeReq({}), resGet);
    const records = JSON.parse(recGet.text).records;
    assert.equal(records.length, 1, "historyMaxAgeDays=7：10 天前旧记录被清理，只留新记录");
    assert.equal(records[0].kind, "test", "保留的是新记录");
    // DELETE 清空
    const { rec: recDel, res: resDel } = makeRes();
    await h.handler(fakeReq({ method: "DELETE" }), resDel);
    const del = JSON.parse(recDel.text);
    assert.equal(del.ok, true);
    assert.ok(del.removed >= 1, "DELETE 返回被清空条数");
    const { rec: recEmpty, res: resEmpty } = makeRes();
    await h.handler(fakeReq({}), resEmpty);
    assert.equal(JSON.parse(recEmpty.text).records.length, 0, "清空后 GET 为空");
    disposeClean(); // 停心跳（P2-5）
  }

  // D3：被免打扰拦截（suppressed: "quiet"）的记录在历史中标记（独立上下文）
  {
    // #181 动态窗口：写死 "00:00"/"23:59" 在半开区间镜下 23:59 这一分钟不命中
    // （UTC 边缘必炸，run 33282203798 同源隐患）；围绕当前时间 ±2 分钟恒命中。
    const qhAll = quietWindowNow();
    const { routes, listeners } = makeNotifier(work, { quietHours: { ...qhAll, allowKinds: ["ask"] }, historyFile: join(work, "history-quiet.jsonl") });
    const h = routes.find((r) => r.path === ROUTES.history);
    const status = listeners.get("agent/status")[0];
    // #290 阶段二两态时序：running=上一轮（首轮无 closure），idle=本轮 turn 1 completed
    const pair = turnPair("q-1", "免打扰完成", {}, { turn: 1 });
    status({ agent: pair.running, status: "running" });
    status({ agent: pair.idle, status: "idle" });
    const records = await waitForHistory(h, (rs) => rs.some((e) => e.kind === "done" && e.suppressed === "quiet"));
    assert.ok(records.some((e) => e.kind === "done" && e.suppressed === "quiet"), "免打扰拦截记录带 suppressed:quiet 标记");
  }

  // D6：200 条滚动上限（独立上下文，预置 210 条 → 读取只保留最近 200）
  {
    const hfile = join(work, "history-limit.jsonl");
    const lines = Array.from({ length: 210 }, (_, i) => JSON.stringify({ ts: Date.now() + i, kind: "test", title: "t", message: `m${i}` })).join("\n") + "\n";
    writeFileSync(hfile, lines);
    const { routes } = makeNotifier(work, { historyFile: hfile });
    const h = routes.find((r) => r.path === ROUTES.history);
    const { rec, res } = makeRes();
    await h.handler(fakeReq({}), res);
    const records = JSON.parse(rec.text).records;
    assert.ok(records.length <= 200, "滚动上限 200：读取最多 200 条");
    assert.equal(records[records.length - 1].message, "m209", "保留的是最新记录");
  }
  // P2-4（#436 复核 P1-1 同根因）：settings 服务消失 → 回落 current 与初始形态
  // 一致（same-shape）。entry 只给 maxConnections（缺 notifySound/askRemindMin 等
  // 默认键）：回落若不经 normalizeConfig 会退回裸 entry（notifySound=true →
  // undefined、askRemindMin 缺失）——与初始 normalizeConfig(entry) 形态不对称。
  // 观测面 = GET /config 的 effective（redactConfigView(resolve()) = current 全量
  // 视图，含 askRemindMin）。捕获 shared 的回落 disposer 手动触发（模拟服务消失
  // 但插件存活，isUnloading=false 不短路）。
  {
    const { apply } = await import("../lib/index.js");
    const { makeFakeCtx, makeFakeSettings } = await import("./helpers.ts");
    const entry = { maxConnections: 64 };
    let fallbackDisposer = null;
    const fakeSettings = makeFakeSettings({ base: entry });
    const { ctx, routes } = makeFakeCtx({
      inject(serviceNames, fn) {
        if (Array.isArray(serviceNames) && serviceNames.includes("settings")) {
          fn({
            settings: fakeSettings.service,
            effect(f2) {
              const d = f2();
              const disp = typeof d === "function" ? d : () => {};
              fallbackDisposer = disp;
              return disp;
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
      const { rec, res } = makeRes();
      await cfgRoute.handler(fakeReq({}), res);
      return JSON.parse(rec.text).effective;
    };
    const before = await getEffective();
    assert.equal(before.maxConnections, 64, "attach 态 current 反映 entry 值");
    assert.equal(before.notifySound, true, "attach 态 notifySound 默认值兜底");
    assert.equal(before.askRemindMin, 5, "attach 态 askRemindMin 默认值兜底");
    assert.ok(fallbackDisposer, "shared 回落 disposer 已捕获（服务消失回落路径可达）");
    fallbackDisposer(); // 模拟 settings 服务消失（插件存活）→ 回落
    const after = await getEffective();
    assert.deepEqual(after, before, "回落 current 与初始形态 same-shape（同键同值、默认值兜底一致）");
  }
} finally {
  mainNotifier.dispose(); // 停心跳（P2-5：30s unref 定时器不在测试进程存活期残留）
  rmSync(work, { recursive: true, force: true });
}
