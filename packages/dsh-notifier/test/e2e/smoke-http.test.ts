import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pollUntil } from "../helpers.ts";
import {
  ROUTE_PATHS,
  VERDICTS,
  configFile,
  historyLines,
  mount,
  openSse,
  parseBody,
  send,
  seqAnchor,
  serviceOf,
} from "./smoke-support.ts";
import type { DiagnosticsBody, HealthBody, HistoryLine } from "./smoke-support.ts";

function registerRouteAndCapabilities(): void {
  it("7 条端点全部挂在真实宿主上：兄弟路径 404、方法不在表里 405 并带 allow", async () => {
    const { port } = await mount();

    // 每条端点都发一次真实请求，并断言**成功**：只断「不是 404」分不出「路由挂了且能用」与
    // 「路由挂了但恒错」（实测：把 GET /status 改成恒 500，旧的 not.toBe(404) 照样绿）。
    // `/events` 常驻连接（SSE），它的「已认领」由下面 SSE 组的真实连接证明，这里不盲等它结束。
    for (const path of ROUTE_PATHS.filter((path) => path !== "/api/dsh-notifier/events")) {
      const res = await send(
        port,
        path,
        path.endsWith("/test") ? { method: "POST", body: "{}" } : {},
      );
      expect(res.status, `${path} 已被本插件认领且能正常回答`).toBe(200);
    }

    // 测试按钮的投递是 fire-and-forget 的：不等它落定，那笔迟到的归档会落进下一个用例的现场
    // （下一个用例清过历史后断言「空」，看到的就是别人的记录）。
    await pollUntil(
      () => historyLines().some((line) => line.kind === "test"),
      "测试按钮投递收尾",
      10_000,
    );

    const unknown = await send(port, "/api/dsh-notifier/nope");
    expect(unknown.status, "未注册的兄弟路径由宿主 fallback 兜成 404").toBe(404);

    const wrongMethod = await send(port, "/api/dsh-notifier/health", { method: "DELETE" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow, "405 必须带 allow：调用方不必回翻文档").toBe("GET");
    expect(parseBody<{ error: string }>(wrongMethod.body).error).toBe("method not allowed: DELETE");
  });

  it("GET /health：真实 socket 上给出插件名、宿主平台、回收计数与能力面摘要（键集不与实现分叉）", async () => {
    const { port } = await mount();
    const res = await send(port, "/api/dsh-notifier/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = parseBody<HealthBody>(res.body);
    // 键集精确：多一个少一个都说明客户端与实现分叉了。
    expect(Object.keys(body).sort()).toEqual(
      ["capabilities", "ok", "platform", "plugin", "sseEvicts"].sort(),
    );
    expect(body.ok).toBe(true);
    expect(body.plugin).toBe("dsh-notifier");
    expect(body.platform).toBe(process.platform);
    expect(body.sseEvicts).toEqual({
      close: 0,
      error: 0,
      stalled: 0,
      maxage: 0,
      destroyed: 0,
      dispose: 0,
    });
    // 能力面结论取决于跑测机器有没有桌面会话，钉死具体值只会得到一条跟环境跑的假判据；
    // 这里判值域与形状，明细面（checked/players/remediation）由 /diagnostics 的用例判。
    expect(VERDICTS).toContain(body.capabilities.host.verdict);
    expect(Array.isArray(body.capabilities.host.unknownDimensions)).toBe(true);
    expect(Object.keys(body.capabilities.host).sort()).toEqual(
      ["popup", "sound", "unknownDimensions", "verdict"].sort(),
    );
    expect(Object.keys(body.capabilities.host.popup)).toEqual(["state"]);
    expect(Object.keys(body.capabilities.host.sound)).toEqual(["state"]);
  });

  it("GET /diagnostics：完整面给的是同一份缓存结果，且一条明细都不缺", async () => {
    const { port } = await mount();
    const health = await send(port, "/api/dsh-notifier/health");
    const diagnostics = await send(port, "/api/dsh-notifier/diagnostics");
    expect(diagnostics.status).toBe(200);

    const summary = parseBody<HealthBody>(health.body).capabilities.host;
    const full = parseBody<DiagnosticsBody>(diagnostics.body).capabilities.host;
    // 两条路由共用同一次探测：结论必须一致，摘要必须是完整面的投影。
    expect(full.verdict).toBe(summary.verdict);
    expect(full.unknownDimensions).toEqual(summary.unknownDimensions);
    expect(full.popup.state).toBe(summary.popup.state);
    expect(full.sound.state).toBe(summary.sound.state);
    // 明细只在完整面上：探测了哪些维度、缺哪个包。
    expect(Array.isArray(full.popup.checked)).toBe(true);
    expect(Array.isArray(full.sound.checked)).toBe(true);
    expect(Array.isArray(full.sound.players)).toBe(true);
    expect(Array.isArray(full.remediation)).toBe(true);
    // 播放器只报可执行文件名、音色只报布尔：绝对路径正是 lan-proxy 已披露的那类泄露。
    expect(JSON.stringify(full)).not.toContain("/usr/share/sounds");
    expect(JSON.stringify(full)).not.toContain("/System/Library");
  });

  it("GET /health 的 sseEvicts 是真实计数：断开一条 SSE 后 close ≥ 1（写死的零会被这条判红）", async () => {
    const { port } = await mount();
    const connection = await openSse(port, "/api/dsh-notifier/events");
    connection.close();
    // 服务端在 socket 的 close 回调里记这一笔，是异步的；用带截止时间的轮询等它上涨。
    // 不能复用 pollUntil：它收同步谓词，传 async 函数会被当成「永远成立」而立刻返回（判据变假绿）。
    const deadline = Date.now() + 10_000;
    for (;;) {
      const res = await send(port, "/api/dsh-notifier/health");
      const body = parseBody<{ sseEvicts: { close: number } }>(res.body);
      if (body.sseEvicts.close >= 1) return;
      if (Date.now() > deadline) throw new Error("客户端断开后 close 计数在 10s 内未上涨");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
}

function registerConfigAndHistory(): void {
  it("GET /config 与 PUT /config：视图四件套经真实 socket 往返，写入真实落盘并推进 revision", async () => {
    const { port } = await mount();

    const first = await send(port, "/api/dsh-notifier/config");
    expect(first.status).toBe(200);
    const view = parseBody<{
      ok: boolean;
      revision: number;
      writable: boolean;
      user: Record<string, unknown>;
      effective: Record<string, unknown>;
    }>(first.body);
    expect(view.ok).toBe(true);
    expect(view.writable).toBe(true);
    // 渠道形态只有 `channels` 一处表达（0.2.3 的顶层渠道键已被升级割接搬走并删除）。
    const effectiveChannels = view.effective.channels as ReadonlyArray<Record<string, unknown>>;
    const builtin = (type: string) => effectiveChannels.find((channel) => channel.type === type);
    expect(builtin("browser")?.popup, "种下的设置读得回来").toBe(true);
    expect(builtin("system")?.popup).toBe(false);

    const saved = await send(port, "/api/dsh-notifier/config", {
      method: "PUT",
      body: JSON.stringify({ patch: { historyMaxAgeDays: 5 }, expectedRevision: view.revision }),
    });
    expect(saved.status).toBe(200);
    const written = parseBody<{ ok: boolean; revision: number; user: Record<string, unknown> }>(
      saved.body,
    );
    expect(written.ok).toBe(true);
    expect(written.revision, "写入推进修订号").not.toBe(view.revision);
    expect(written.user.historyMaxAgeDays).toBe(5);
    await pollUntil(
      () => readFileSync(configFile, "utf8").includes('"historyMaxAgeDays": 5'),
      "配置写入真实落盘",
      10_000,
    );

    const conflict = await send(port, "/api/dsh-notifier/config", {
      method: "PUT",
      body: JSON.stringify({ patch: { historyMaxAgeDays: 6 }, expectedRevision: view.revision }),
    });
    expect(conflict.status).toBe(409);
    expect(parseBody<{ error: { code: string } }>(conflict.body).error.code).toBe(
      "SETTINGS_CONFLICT",
    );

    const badJson = await send(port, "/api/dsh-notifier/config", { method: "PUT", body: "{" });
    expect(badJson.status).toBe(400);
    expect(parseBody<{ error: { code: string } }>(badJson.body).error.code).toBe("invalid-json");

    const emptyPatch = await send(port, "/api/dsh-notifier/config", {
      method: "PUT",
      body: JSON.stringify({ patch: {} }),
    });
    expect(emptyPatch.status, "空 patch 是界面上的一次点击，不是一次无变化的写").toBe(400);
  });

  it("历史与状态端点读写真实落盘：POST /test 的投递归档经 GET /history 读回", async () => {
    const { port } = await mount();

    // 先经真实 DELETE 划一次界：它把此前排队的写入清干净，于是「接下来读到空」不是抢跑得来的。
    const reset = await send(port, "/api/dsh-notifier/history", { method: "DELETE" });
    expect(reset.status).toBe(200);

    const before = await send(port, "/api/dsh-notifier/history");
    expect(before.status).toBe(200);
    expect(parseBody<{ records: HistoryLine[] }>(before.body).records).toEqual([]);

    const accepted = await send(port, "/api/dsh-notifier/test", { method: "POST", body: "{}" });
    expect(accepted.status).toBe(200);
    const receipt = parseBody<{ ok: boolean; sseConnections: number }>(accepted.body);
    expect(receipt.ok).toBe(true);
    expect(receipt.sseConnections, "无连接时的句柄数").toBe(0);

    // 投递是 fire-and-forget 的，等它在磁盘上可见而不是等一个固定时长。
    await pollUntil(
      () => historyLines().some((line) => line.kind === "test"),
      "测试通知落史",
      10_000,
    );
    const listed = await send(port, "/api/dsh-notifier/history");
    const records = parseBody<{ records: HistoryLine[] }>(listed.body).records;
    expect(records).toHaveLength(1);
    expect(records[0]?.channels).toEqual([{ channelId: "browser", status: "ok" }]);

    const status = await send(port, "/api/dsh-notifier/status");
    expect(status.status).toBe(200);
    // 状态在内存镜像里随投递终态落定，而历史可见已经证明那次 dispatch 走完了（归档排在投递之后）。
    expect(
      parseBody<{ channels: Record<string, { lastStatus: string }> }>(status.body).channels.browser
        ?.lastStatus,
    ).toBe("ok");

    const cleared = await send(port, "/api/dsh-notifier/history", { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(parseBody<{ ok: boolean; removed: number }>(cleared.body)).toEqual({
      ok: true,
      removed: 1,
    });
    const after = await send(port, "/api/dsh-notifier/history");
    expect(parseBody<{ records: HistoryLine[] }>(after.body).records).toEqual([]);
  });
}

function registerTestButton(): void {
  it("POST /test 的畸形 body 在真实 socket 上 fail-closed：400 且一条投递都不发生", async () => {
    const { port } = await mount();

    // 先经真实 DELETE 划线：畸形请求之后历史必须仍是空的，「零副作用」才有可观察的判据。
    expect((await send(port, "/api/dsh-notifier/history", { method: "DELETE" })).status).toBe(200);

    // 真 Readable 的 async 迭代（单测那条走的是假迭代器），两种成因各走一遍。
    const malformed = await send(port, "/api/dsh-notifier/test", { method: "POST", body: "{" });
    expect(malformed.status).toBe(400);
    expect(
      parseBody<{ ok: boolean; error: { code: string; details: string } }>(malformed.body),
    ).toEqual({ ok: false, error: { code: "invalid-json", details: "请求体不是合法 JSON" } });

    const notObject = await send(port, "/api/dsh-notifier/test", { method: "POST", body: "42" });
    expect(notObject.status).toBe(400);
    expect(
      parseBody<{ error: { details: string } }>(notObject.body).error.details,
      "合法 JSON 但不是对象是另一种成因",
    ).toBe("请求体必须是 JSON 对象");

    // 「畸形」与「缺席」是两件事：没有 body 仍然按全频道测试受理。
    expect((await send(port, "/api/dsh-notifier/test", { method: "POST" })).status).toBe(200);

    await pollUntil(
      () => historyLines().some((line) => line.kind === "test"),
      "缺席 body 的那次测试通知落史",
      10_000,
    );
    const records = parseBody<{ records: HistoryLine[] }>(
      (await send(port, "/api/dsh-notifier/history")).body,
    ).records;
    expect(records, "两条畸形请求一条都不许投递").toHaveLength(1);
  });

  it("dry-run 零落盘：POST /test 带 draft 同步返回且不写 history/status/config", async () => {
    const { port } = await mount();

    // 先经真实 DELETE 划一次界：它把此前排队的写入清干净，于是「接下来读到空」不是抢跑得来的。
    expect((await send(port, "/api/dsh-notifier/history", { method: "DELETE" })).status).toBe(200);
    const configBefore = readFileSync(configFile, "utf8");

    const res = await send(port, "/api/dsh-notifier/test", {
      method: "POST",
      body: JSON.stringify({
        channelId: "browser",
        draft: {
          channels: [
            {
              type: "browser",
              id: "browser",
              enabled: true,
              popup: true,
              sound: false,
              whenVisible: false,
            },
          ],
          revision: 12345,
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(parseBody<unknown>(res.body)).toEqual({ ok: true, channelId: "browser", status: "ok" });

    // 否定断言必须覆盖 status 落盘 debounce 窗口（500ms）：单次 sleep 只看终态，
    // 在途写入后又被清掉的瞬态会漏网。这里在整个 800ms 窗口内连续断言为空
    // （轮询间隔 20ms，与 pollUntil 同族的确定性轮询，非单次固定 sleep 等待）。
    const deadline = Date.now() + 800;
    for (;;) {
      expect(historyLines(), "dry-run 不落历史").toEqual([]);
      const probe = await send(port, "/api/dsh-notifier/status");
      expect(probe.status).toBe(200);
      expect(parseBody<{ channels: unknown }>(probe.body).channels, "dry-run 不写频道状态").toEqual(
        {},
      );
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readFileSync(configFile, "utf8"), "dry-run 不碰配置文件（revision 不动）").toBe(
      configBefore,
    );
  });

  it("dry-run 同样过围栏：非回环 403、方法错 405", async () => {
    const { port } = await mount();
    const draftBody = JSON.stringify({ channelId: "browser", draft: { channels: [] } });

    const rebound = await send(port, "/api/dsh-notifier/test", {
      method: "POST",
      headers: { host: "attacker.example" },
      body: draftBody,
    });
    expect(rebound.status, "带 draft 也一样先过回环围栏").toBe(403);

    const wrongMethod = await send(port, "/api/dsh-notifier/test", { method: "GET" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow, "405 带 allow 头").toContain("POST");
  });
}

function registerKindsAndFences(): void {
  it("种类端点：未登记 404、参数非法 400，登记后确认并真实落进配置", async () => {
    const { root, port } = await mount();

    const listed = await send(port, "/api/dsh-notifier/kinds");
    expect(listed.status).toBe(200);
    expect(Array.isArray(parseBody<{ kinds: unknown[] }>(listed.body).kinds)).toBe(true);

    const ghost = await send(port, "/api/dsh-notifier/kinds", {
      method: "POST",
      body: JSON.stringify({ kind: "e2e:ghost", confirmed: true }),
    });
    expect(ghost.status, "未登记的 kind 一律 404（管理面不替用户放行陌生种类）").toBe(404);

    const malformed = await send(port, "/api/dsh-notifier/kinds", {
      method: "POST",
      body: JSON.stringify({ kind: "", confirmed: true }),
    });
    expect(malformed.status).toBe(400);

    serviceOf(root).registerKind({ id: "e2e:face", label: "E2E 面" });
    const afterRegister = await send(port, "/api/dsh-notifier/kinds");
    expect(
      parseBody<{ kinds: Array<{ id: string; confirmed: boolean }> }>(afterRegister.body).kinds,
    ).toContainEqual({ id: "e2e:face", label: "E2E 面", confirmed: false });

    const confirmed = await send(port, "/api/dsh-notifier/kinds", {
      method: "POST",
      body: JSON.stringify({ kind: "e2e:face", confirmed: true }),
    });
    expect(confirmed.status).toBe(200);
    expect(
      parseBody<{ kinds: Array<{ id: string; confirmed: boolean }> }>(confirmed.body).kinds,
    ).toContainEqual({ id: "e2e:face", label: "E2E 面", confirmed: true });
    await pollUntil(
      () => readFileSync(configFile, "utf8").includes("e2e:face"),
      "确认态真实落盘",
      10_000,
    );
  });

  it("回环围栏：Host 头不是回环（DNS 重绑定诱饵）与 cross-site 请求一律 403", async () => {
    const { port } = await mount();

    const rebound = await send(port, "/api/dsh-notifier/health", {
      headers: { host: "attacker.example" },
    });
    expect(rebound.status, "来源是回环但 Host 不是：D-Bus 式的诱饵必须被拒").toBe(403);
    expect(parseBody<{ error: string; code: string; status: number }>(rebound.body)).toEqual({
      error: "forbidden: loopback-only",
      code: "FORBIDDEN_LOOPBACK",
      status: 403,
    });

    const crossSite = await send(port, "/api/dsh-notifier/health", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status, "跨站默认拒绝，不猜测放行").toBe(403);

    // 对照组：同一次装配里回环 Host 放行——否则上面的 403 可能只是路由没挂。
    const ok = await send(port, "/api/dsh-notifier/health");
    expect(ok.status).toBe(200);
  });

  it("围栏拒答体的机读字段：403 与 405 各自带稳定的 code/status，error 仍是裸字符串", async () => {
    const { port } = await mount();

    const forbidden = await send(port, "/api/dsh-notifier/health", {
      headers: { host: "attacker.example" },
    });
    expect(forbidden.status).toBe(403);
    const forbiddenBody = parseBody<{ error: unknown; code: string; status: number }>(
      forbidden.body,
    );
    expect(forbiddenBody.code).toBe("FORBIDDEN_LOOPBACK");
    expect(forbiddenBody.status).toBe(403);
    // 向后兼容的关键：error 不能被升级成对象——旧客户端读失败提示的顺序是
    // 「details → error → HTTP <status>」，它识别局域网直连只认最后那条兜底里的状态码。
    expect(typeof forbiddenBody.error).toBe("string");

    const notAllowed = await send(port, "/api/dsh-notifier/health", { method: "DELETE" });
    expect(notAllowed.status).toBe(405);
    const notAllowedBody = parseBody<{ error: unknown; code: string; status: number }>(
      notAllowed.body,
    );
    expect(notAllowedBody.code).toBe("METHOD_NOT_ALLOWED");
    expect(notAllowedBody.status).toBe(405);
    expect(typeof notAllowedBody.error).toBe("string");
  });
}

describe("真实 HTTP 面（真实宿主 + 真实 loopback socket）", () => {
  registerRouteAndCapabilities();
  registerConfigAndHistory();
  registerTestButton();
  registerKindsAndFences();
});

describe("真实 SSE 面", () => {
  it("真实连接先收到开流锚点，投递后在真实连接上收到 notify 帧", async () => {
    const { root, port } = await mount();
    const connection = await openSse(port, "/api/dsh-notifier/events");
    try {
      // 心跳是 30 秒级，不真等：开流锚点（注释帧）就是「响应头已被立刻 flush」的可见证据
      // ——少了它客户端要等到第一个心跳才从 CONNECTING 进入 OPEN。
      await pollUntil(() => connection.raw().includes(": connected"), "开流锚点到场", 10_000);

      await serviceOf(root).send({ kind: "done", title: "端到端标题", body: "端到端正文" });
      await pollUntil(() => connection.frames().length >= 1, "帧到达真实连接", 10_000);

      expect(connection.frames()[0]).toEqual({
        type: "notify",
        seq: seqAnchor + 1,
        kind: "done",
        title: "端到端标题",
        message: "端到端正文",
        ts: expect.any(Number) as unknown as number,
        sound: { mode: "silent" },
        // 种下的浏览器条目 `whenVisible:false`：展示条件随帧下发，值就是条目里那一个。
        whenVisible: false,
      });
    } finally {
      connection.close();
    }
  });

  it("断线重连 ?since=N：只补拉序号大于 N 的帧，已确认的那条不重放", async () => {
    const { root, port } = await mount();
    const service = serviceOf(root);

    const first = await openSse(port, "/api/dsh-notifier/events");
    await service.send({ kind: "done", title: "第一帧", body: "A" });
    await pollUntil(() => first.frames().length >= 1, "第一帧到达", 10_000);
    const frameA = first.frames()[0];
    expect(frameA?.title).toBe("第一帧");
    first.close();

    // 重连带 `?since=<A 的序号>`：实现按 `seq > since` 过滤补拉缓冲。
    const second = await openSse(port, `/api/dsh-notifier/events?since=${frameA?.seq ?? 0}`);
    try {
      await pollUntil(() => second.raw().includes(": connected"), "重连锚点到场", 10_000);
      await service.send({ kind: "done", title: "第二帧", body: "B" });
      await pollUntil(
        () => second.frames().some((frame) => frame.title === "第二帧"),
        "补拉窗口之后的新帧到达",
        10_000,
      );
      // 帧在一条流上是顺序的：若 since 被忽略，A 一定排在 B 之前到达，这条判据会红。
      expect(second.frames().map((frame) => frame.title)).toEqual(["第二帧"]);
    } finally {
      second.close();
    }
  });
});
