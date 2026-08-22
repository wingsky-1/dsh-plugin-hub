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
import { ROUTES } from "../lib/index.js";

const work = mkdtempSync(join(tmpdir(), "dnotify-routes-"));
try {
  const storeFile = join(work, "config.json");

  // 独立 history 文件：隔离其他测试块的 fire-and-forget 异步写盘，
  // 避免跨 apply 实例对同一 history.jsonl 的 read-modify-write 竞态把 test 挤出末尾（issue #17）。
  const { routes } = await makeNotifier(work, { configFile: storeFile, historyFile: join(work, "history-route.jsonl") });
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
    const { routes: routes2 } = await makeNotifier(work, { historyFile: join(work, "history-since.jsonl") });
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
    const { routes } = await makeNotifier(work, { historyFile: hfile, configFile: hcfg });
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
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
