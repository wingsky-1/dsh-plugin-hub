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
import { ROUTES } from "../src/index.ts";

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
  assert.ok(configRoute && eventsRoute && healthRoute && testRoute && historyRoute, "五条路由已注册");

  // 403（J1）
  for (const route of [configRoute, eventsRoute, healthRoute, testRoute, historyRoute]) {
    const { rec, res } = makeRes();
    await route.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res);
    assert.equal(rec.status, 403);
  }

  // 405（J2）：test 路由仅 POST；history 路由仅 GET；health 仅 GET
  {
    const { rec, res } = makeRes();
    await testRoute.handler(fakeReq({}), res);
    assert.equal(rec.status, 405);
    const { rec: rec2, res: res2 } = makeRes();
    await historyRoute.handler(fakeReq({ method: "POST" }), res2);
    assert.equal(rec2.status, 405);
    const { rec: rec3, res: res3 } = makeRes();
    await healthRoute.handler(fakeReq({ method: "DELETE" }), res3);
    assert.equal(rec3.status, 405);
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
} finally {
  mainNotifier.dispose(); // 停心跳（P2-5：30s unref 定时器不在测试进程存活期残留）
  rmSync(work, { recursive: true, force: true });
}
