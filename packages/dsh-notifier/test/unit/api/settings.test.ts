/**
 * dsh-notifier api 域 settings 块 —— GET /config 与 PUT /config。
 *
 * 判据面：写面把请求**形状**（`patch` 是不是非空对象、`expectedRevision` 是不是非负整数）与设置
 * **内容**分开把关，本块只管前者；后者由 config 域写面回答，本块只把它的四态结果映射成四个状态码。
 * 四态不能压扁——压扁之后用户看到的就只剩「保存失败」，而「字段非法」「版本过期」「服务不可用」
 * 要做的事完全不同。故这里逐态断言状态码与机器可判的 `code`，而不是只断言「不是 200」。
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import type { ConfigPort } from "../../../src/server/api/deps.ts";
import { SettingsEndpoints } from "../../../src/server/api/impl/settings/index.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import { jsonReq, makeRes } from "../../helpers.ts";

/** 视图与写面结果经能力面的签名可达，不请 config 域再多导出一个名字。 */
type SettingsView = ReturnType<ConfigPort["readSettingsView"]>;
type WriteResult = Awaited<ReturnType<ConfigPort["writeConfig"]>>;

const VIEW: SettingsView = {
  user: { notifyAsk: false },
  revision: 7,
  writable: true,
  effective: { notifyAsk: false, notifyTaskDone: true },
};

/** 假请求：body 由 async 迭代器吐出（`readJsonBody` 走的就是这条路）。 */
function makeReq(options: { body?: unknown; rawBody?: string } = {}): IncomingMessage {
  return jsonReq({ method: "PUT", url: "/api/dsh-notifier/config", ...options });
}

/** 假 config 端口：读面给固定视图，写面记账并按用例指定的结果作答。 */
function fakeConfig(result?: WriteResult) {
  const writes: Array<{ patch: unknown; revision?: number }> = [];
  const port: ConfigPort = {
    readConfig: () => ({ ...DEFAULT_CONFIG }),
    readSettingsView: () => VIEW,
    writeConfig: async (patch, revision) => {
      writes.push({ patch, revision });
      return result ?? { ok: true, view: VIEW };
    },
  };
  return { port, writes };
}

/** GET 一次设置视图。 */
function get(result?: WriteResult) {
  const config = fakeConfig(result);
  const { res, rec, json } = makeRes();
  new SettingsEndpoints(config.port).read(makeReq(), res);
  return { rec, json, config };
}

/** PUT 一次设置。 */
async function put(request: { body?: unknown; rawBody?: string }, result?: WriteResult) {
  const config = fakeConfig(result);
  const { res, rec, json } = makeRes();
  await new SettingsEndpoints(config.port).write(makeReq(request), res);
  return { rec, json, config };
}

describe("GET /config：视图的四个事实一次取齐", () => {
  it("回 user / revision / writable / effective 四件事实（分开取会让界面拿旧修订号提交，凭空造出冲突）", () => {
    const { rec, json } = get();
    expect(rec.status).toBe(200);
    const body = json();
    expect(body.ok).toBe(true);
    expect(body.user).toEqual(VIEW.user);
    expect(body.revision).toBe(7);
    expect(body.writable).toBe(true);
    expect(body.effective).toEqual(VIEW.effective);
  });
});

describe("PUT /config：形状把关", () => {
  it("省略 expectedRevision 时不做版本校验，写面只收到 patch", async () => {
    const { rec, json, config } = await put({ body: { patch: { notifyAsk: true } } });
    expect(rec.status).toBe(200);
    expect(config.writes).toHaveLength(1);
    expect(config.writes[0]!.patch).toEqual({ notifyAsk: true });
    expect(config.writes[0]!.revision).toBeUndefined();
    expect(json().ok).toBe(true);
  });

  it("带 expectedRevision 时把修订号原样交给写面（乐观并发是客户端唯一的防覆盖手段）", async () => {
    const { config } = await put({ body: { patch: { notifyAsk: true }, expectedRevision: 3 } });
    expect(config.writes[0]!.revision).toBe(3);
  });

  // 0 是合法的修订号（冷启动后的第一份设置就是 0）。把「显式传 0」当成「省略」，写面就不再比对
  // 版本——用户拿着旧界面提交会静默覆盖别人的改动，而这条路径上没有任何错误可看。
  it("expectedRevision 显式传 0 不等于省略：写面收到的 revision 必须是 0", async () => {
    const { rec, config } = await put({
      body: { patch: { notifyAsk: true }, expectedRevision: 0 },
    });
    expect(rec.status).toBe(200);
    expect(config.writes).toEqual([{ patch: { notifyAsk: true }, revision: 0 }]);
  });

  it("成功体只回 user 与 revision（多回一份 effective 就多一个可能与本地草稿不一致的服务端版本）", async () => {
    const { json } = await put({ body: { patch: { notifyAsk: true } } });
    const body = json();
    expect(body.user).toEqual(VIEW.user);
    expect(body.revision).toBe(7);
    expect("effective" in body).toBe(false);
    expect("writable" in body).toBe(false);
  });

  it.each<[string, unknown]>([
    ["patch 是字符串", { patch: "abc" }],
    ["patch 是空对象", { patch: {} }],
    ["patch 是数组", { patch: [] }],
    ["patch 是 null", { patch: null }],
    ["patch 缺席", {}],
  ])("patch 非法（%s）→ 400 且根本不进写面", async (_label, body) => {
    const { rec, json, config } = await put({ body });
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: { error: "配置校验失败: patch", hint: "需至少包含一个配置键（patch 不能为空）" },
    });
    expect(config.writes).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["负数", -1],
    ["小数", 1.5],
    ["字符串", "3"],
    ["null", null],
  ])("expectedRevision 非法（%s）→ 400 而不是当成「省略」", async (_label, revision) => {
    const { rec, json, config } = await put({
      body: { patch: { notifyAsk: true }, expectedRevision: revision },
    });
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: {
        error: "配置校验失败: expectedRevision",
        hint: "expectedRevision 必须为非负整数或省略",
      },
    });
    expect(config.writes).toEqual([]);
  });

  it("请求体不是合法 JSON 对象 → 400 invalid-json（否则会按「没有 patch」的理由误导排查）", async () => {
    const { rec, json, config } = await put({ rawBody: "{ 这不是 JSON" });
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: {
        code: "invalid-json",
        details: "请求体不是合法 JSON 对象（或超出大小上限）",
      },
    });
    expect(config.writes).toEqual([]);
  });
});

describe("PUT /config：写面四态 → 四个状态码", () => {
  // 第四态（写入异常 → 500 + 固定文案、底层原因只进日志）由**路由层**的异常收口承担
  // （`api/route.test.ts` 的两条 500 用例）。端点这一半的契约是「不吞异常」——吞成 503 会让用户
  // 看到「设置服务不可用」而真正的原因进不了日志（实测：给端点加 `.catch(() => ({ok:false,
  // reason:"unavailable"}))` 之后，原先没有任何用例会红）。
  it("写面抛错 → 端点不吞，异常交给路由层收口成 500", async () => {
    const port: ConfigPort = {
      readConfig: () => ({ ...DEFAULT_CONFIG }),
      readSettingsView: () => VIEW,
      writeConfig: async () => {
        throw new Error("写盘炸了");
      },
    };
    const { res } = makeRes();
    await expect(
      new SettingsEndpoints(port).write(makeReq({ body: { patch: { notifyAsk: true } } }), res),
    ).rejects.toThrow("写盘炸了");
  });

  it("invalid → 400，并把出错的键与提示带回界面（界面要能定位到那一行）", async () => {
    const { rec, json } = await put(
      { body: { patch: { quietHours: "x" } } },
      { ok: false, reason: "invalid", error: { key: "quietHours.start", hint: "格式为 HH:MM" } },
    );
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: { error: "配置校验失败: quietHours.start", hint: "格式为 HH:MM" },
    });
  });

  it("conflict → 409 且带 SETTINGS_CONFLICT（客户端按 code 分流，不按会翻译的中文文案）", async () => {
    const { rec, json } = await put(
      { body: { patch: { notifyAsk: true }, expectedRevision: 3 } },
      { ok: false, reason: "conflict" },
    );
    expect(rec.status).toBe(409);
    expect(json()).toEqual({
      ok: false,
      error: { error: "版本冲突", code: "SETTINGS_CONFLICT" },
    });
  });

  it("unavailable → 503（界面据此把表单整体置灰，而不是提示用户重试一次没用的保存）", async () => {
    const { rec, json } = await put(
      { body: { patch: { notifyAsk: true } } },
      { ok: false, reason: "unavailable" },
    );
    expect(rec.status).toBe(503);
    expect(json()).toEqual({
      ok: false,
      error: { error: "设置服务不可用", code: "settings-unavailable" },
    });
  });
});
