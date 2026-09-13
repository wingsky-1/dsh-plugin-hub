/**
 * dsh-notifier api 域 kinds 块 —— GET /kinds 与 POST /kinds（动态种类清单与用户确认）。
 *
 * 判据面：本块自己只判两件事——**存在性**（未登记 → 404，且不去动设置）与**结果码映射**
 * （与设置端点同款：invalid 400 / conflict 409 / unavailable 503）。确认的写入语义归 sdk 域，
 * 不在这里重测；这里守的是「端点如何把 sdk 的答复翻译成 HTTP」——两个端点上对同一件事给出
 * 不同答复，会让客户端被迫按路径分叉处理同一件事。
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import type { KindPort } from "../../../src/server/api/deps.ts";
import { KindsEndpoints } from "../../../src/server/api/impl/kinds/index.ts";
import { jsonReq, makeRes } from "../../helpers.ts";

/** 写面结果经能力面的签名可达，不请 sdk 域再多导出一个名字。 */
type ConfirmResult = Awaited<ReturnType<KindPort["confirmKind"]>>;
type RegisteredKind = ReturnType<KindPort["listKinds"]>[number];

const REGISTERED: RegisteredKind[] = [
  { id: "demo:x", label: "X 插件", confirmed: false },
  { id: "demo:y", label: "Y 插件", confirmed: true },
];

/** 假请求：body 由 async 迭代器吐出（`readJsonBody` 走的就是这条路）。 */
function makeReq(options: { body?: unknown; rawBody?: string } = {}): IncomingMessage {
  return jsonReq({ method: "POST", url: "/api/dsh-notifier/kinds", ...options });
}

/** 假 sdk 管理面：清单给固定两条，确认记账并按用例指定的结果作答。 */
function fakeKinds(result?: ConfirmResult, listed: RegisteredKind[] = REGISTERED) {
  const confirmed: Array<{ id: string; confirmed: boolean }> = [];
  const port: KindPort = {
    listKinds: () => [...listed],
    confirmKind: async (id, value) => {
      confirmed.push({ id, confirmed: value });
      return (
        result ?? {
          ok: true,
          view: { user: {}, revision: 12, writable: true, effective: {} },
        }
      );
    },
  };
  return { port, confirmed };
}

/** GET 一次清单。 */
function get(listed: RegisteredKind[] = REGISTERED) {
  const kinds = fakeKinds(undefined, listed);
  const { res, rec, json } = makeRes();
  new KindsEndpoints(kinds.port).read(makeReq(), res);
  return { rec, json, kinds };
}

/** POST 一次确认。 */
async function post(request: { body?: unknown; rawBody?: string }, result?: ConfirmResult) {
  const kinds = fakeKinds(result);
  const { res, rec, json } = makeRes();
  await new KindsEndpoints(kinds.port).confirm(makeReq(request), res);
  return { rec, json, kinds };
}

describe("GET /kinds：清单是登记项 × 确认态", () => {
  it("回 `kinds` 清单（设置页据此渲染「允许 / 拒绝」，缺了确认态按钮就无从着色）", () => {
    const { rec, json } = get();
    expect(rec.status).toBe(200);
    expect(json()).toEqual({ ok: true, kinds: REGISTERED });
  });
});

describe("POST /kinds：存在性在本块判", () => {
  it("已登记 + 确认成功 → 200，成功体带回新修订号与更新后的清单", async () => {
    const { rec, json, kinds } = await post({ body: { kind: "demo:x", confirmed: true } });
    expect(rec.status).toBe(200);
    expect(kinds.confirmed).toEqual([{ id: "demo:x", confirmed: true }]);
    expect(json()).toEqual({ ok: true, kinds: REGISTERED, revision: 12 });
  });

  it("未登记的种类 → 404 且不写设置（存在性判在写面之前，否则设置里会多出一个查不到归属的键）", async () => {
    const { rec, json, kinds } = await post({ body: { kind: "demo:never", confirmed: true } });
    expect(rec.status).toBe(404);
    expect(json()).toEqual({
      ok: false,
      error: { code: "not-found", details: "未注册的动态种类: demo:never" },
    });
    expect(kinds.confirmed).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["kind 缺席", { confirmed: true }],
    ["kind 是空串", { kind: "", confirmed: true }],
    ["kind 不是字符串", { kind: 42, confirmed: true }],
    ["confirmed 缺席", { kind: "demo:x" }],
    ["confirmed 不是布尔", { kind: "demo:x", confirmed: "yes" }],
  ])("参数非法（%s）→ 400 且不写设置", async (_label, body) => {
    const { rec, json, kinds } = await post({ body });
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: { code: "invalid", details: "需为 { kind: string, confirmed: boolean }" },
    });
    expect(kinds.confirmed).toEqual([]);
  });

  it("请求体不是合法 JSON 对象 → 400 invalid-json", async () => {
    const { rec, json, kinds } = await post({ rawBody: "不是 JSON" });
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: {
        code: "invalid-json",
        details: "请求体不是合法 JSON 对象（或超出大小上限）",
      },
    });
    expect(kinds.confirmed).toEqual([]);
  });
});

describe("POST /kinds：写面四态 → 四个状态码（与设置端点同款映射）", () => {
  // 第四态（写入异常 → 500）由路由层的异常收口承担（`api/route.test.ts` 的两条 500 用例）；
  // 端点这一半的契约是「不吞异常」，吞掉会让原因进不了日志、用户只看到 503。
  it("写面抛错 → 端点不吞，异常交给路由层收口成 500", async () => {
    const port: KindPort = {
      listKinds: () => [...REGISTERED],
      confirmKind: async () => {
        throw new Error("写盘炸了");
      },
    };
    const { res } = makeRes();
    await expect(
      new KindsEndpoints(port).confirm(makeReq({ body: { kind: "demo:x", confirmed: true } }), res),
    ).rejects.toThrow("写盘炸了");
  });

  it("invalid → 400，带出错的键与提示", async () => {
    const { rec, json } = await post(
      { body: { kind: "demo:x", confirmed: true } },
      { ok: false, reason: "invalid", error: { key: "allowKinds", hint: "需要种类 id 数组" } },
    );
    expect(rec.status).toBe(400);
    expect(json()).toEqual({
      ok: false,
      error: { error: "配置校验失败: allowKinds", hint: "需要种类 id 数组" },
    });
  });

  it("conflict → 409 且带 SETTINGS_CONFLICT", async () => {
    const { rec, json } = await post(
      { body: { kind: "demo:x", confirmed: true } },
      { ok: false, reason: "conflict" },
    );
    expect(rec.status).toBe(409);
    expect(json()).toEqual({
      ok: false,
      error: { error: "版本冲突", code: "SETTINGS_CONFLICT" },
    });
  });

  it("unavailable → 503", async () => {
    const { rec, json } = await post(
      { body: { kind: "demo:x", confirmed: true } },
      { ok: false, reason: "unavailable" },
    );
    expect(rec.status).toBe(503);
    expect(json()).toEqual({
      ok: false,
      error: { error: "设置服务不可用", code: "settings-unavailable" },
    });
  });
});
