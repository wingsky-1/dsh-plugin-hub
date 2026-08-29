// @ts-nocheck
/**
 * dsh-notifier — e2e：HTTP 路由（config / events SSE / health / test / history）。
 *
 * 覆盖：路由注册面；403 loopback 围栏与 405 方法白名单；config GET/PUT
 * （落盘持久化 + 内存生效）；PUT 容错（非法 JSON 400、超大 body 不挂起）；
 * events SSE（头/connected/kind=test 广播/seq/?since 回放/非法 since）；
 * history（落盘轮询查询/并发写不丢/DELETE 清空/historyMaxAgeDays 按天清理）。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assert, makeNotifier, fakeReq, makeRes, waitForHistory } from "./helpers.ts";
import { ROUTES } from "../src/index.ts";

const work = mkdtempSync(join(tmpdir(), "dnotify-routes-"));
let mainNotifier;
try {
  const storeFile = join(work, "config.json");

  // 独立 history 文件：隔离其他测试块的 fire-and-forget 异步写盘，
  // 避免跨 apply 实例对同一 history.jsonl 的 read-modify-write 竞态把 test 挤出末尾（issue #17）。
  mainNotifier = await makeNotifier(work, { configFile: storeFile, historyFile: join(work, "history-route.jsonl") });
  const { routes } = mainNotifier;
  const configRoute = routes.find((r) => r.path === ROUTES.config);
  const eventsRoute = routes.find((r) => r.path === ROUTES.events);
  const healthRoute = routes.find((r) => r.path === ROUTES.health);
  const testRoute = routes.find((r) => r.path === ROUTES.test);
  const historyRoute = routes.find((r) => r.path === ROUTES.history);
  assert.ok(configRoute && eventsRoute && healthRoute && testRoute && historyRoute, "五条路由已注册");

  // 403
  for (const route of [configRoute, eventsRoute, healthRoute, testRoute, historyRoute]) {
    const { rec, res } = makeRes();
    await route.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res);
    assert.equal(rec.status, 403);
  }

  // 405：test 路由仅 POST；history 路由仅 GET；health 仅 GET
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

  // config GET：默认值
  {
    const { rec, res } = makeRes();
    await configRoute.handler(fakeReq({}), res);
    assert.equal(rec.status, 200);
    assert.equal(JSON.parse(rec.text).notifyAsk, true);
  }

  // config PUT：持久化 + 内存生效
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
    await configRoute.handler(bodyReq({ notifyAsk: false, quietHours: { enabled: true, start: "23:00", end: "07:00" } }), res);
    assert.equal(rec.status, 200);
    assert.equal(JSON.parse(rec.text).notifyAsk, false);
    const stored = JSON.parse(readFileSync(storeFile, "utf8"));
    assert.equal(stored.notifyAsk, false);
    assert.equal(stored.quietHours.start, "23:00");

    // GET 反映新值
    const { rec: rec2, res: res2 } = makeRes();
    await configRoute.handler(fakeReq({}), res2);
    assert.equal(JSON.parse(rec2.text).notifyAsk, false);
  }

  // config PUT 容错：非法 JSON → 400；超大 body → 不挂起、无未处理拒绝
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

  // events SSE
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

  // events ?since 回放（独立上下文，seq 从 1 起）：断线补拉不丢尾部事件
  {
    const notifier2 = await makeNotifier(work, { historyFile: join(work, "history-since.jsonl") });
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
      const cfg = join(work, `sse-${mark}-cfg.json`);
      writeFileSync(cfg, JSON.stringify({ maxConnections }));
      const out = await makeNotifier(work, { configFile: cfg, historyFile: join(work, `sse-${mark}.jsonl`) });
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
      // PUT maxConnections=2（内存生效 + 落盘，沿用现有 bodyReq 模式）
      const text = JSON.stringify({ maxConnections: 2 });
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
      assert.equal(JSON.parse(rec.text).maxConnections, 2, "PUT 后配置生效");
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

  // history：测试通知已落盘，GET 可查（独立 history 文件，无跨块串扰）
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

  // history：DELETE 清空 + historyMaxAgeDays 按天清理（独立上下文，隔离其他用例）
  {
    const hfile = join(work, "history-clean.jsonl");
    const hcfg = join(work, "history-clean-cfg.json");
    writeFileSync(hcfg, JSON.stringify({ historyMaxAgeDays: 7 }));
    // 预置一条 10 天前的旧记录
    writeFileSync(hfile, JSON.stringify({ ts: Date.now() - 10 * 86400000, kind: "done", title: "旧记录", message: "10 天前" }) + "\n");
    const { routes, dispose: disposeClean } = await makeNotifier(work, { historyFile: hfile, configFile: hcfg });
    const h = routes.find((r) => r.path === ROUTES.history);
    const t = routes.find((r) => r.path === ROUTES.test);
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
} finally {
  mainNotifier.dispose(); // 停心跳（P2-5：30s unref 定时器不在测试进程存活期残留）
  rmSync(work, { recursive: true, force: true });
}
