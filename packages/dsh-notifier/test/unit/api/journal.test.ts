/**
 * dsh-notifier api 域 journal 块 —— GET /history、DELETE /history、GET /status。
 *
 * 判据面：三个响应体的键名（`records` / `removed` / `channels`）是**客户端锁定**的契约，改一个名字
 * 页面就整块空白，而服务端不会有任何报错。另外这三个端点都必须**等**存储域的结果——store 的读是
 * 异步的，漏掉 await 会把一个 Promise 序列化成 `{}`，接口看上去「正常返回空历史」。
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import type { StorePort } from "../../../src/server/api/deps.ts";
import { JournalEndpoints } from "../../../src/server/api/impl/journal/index.ts";
import { jsonReq, makeRes } from "../../helpers.ts";

const HISTORY = [
  { ts: 1, kind: "done", title: "第一条", message: "正文", channels: [] },
  { ts: 2, kind: "error", title: "第二条", message: "出错了" },
];

const STATUS = {
  "bark:main": {
    lastTs: 2,
    lastStatus: "failed" as const,
    // 0.2.4 起失败理由是结构化对象（#782 批 1）：`lastStatus` 与信封键名不变，只有这一项换了形态。
    lastError: { code: "reasonBarkHttp", params: { status: 500 } },
    failStreak: 3,
  },
};

/** 假请求：三个端点都不读 body，只有方法不同。 */
function makeReq(method: string): IncomingMessage {
  return jsonReq({ method, url: "/api/dsh-notifier/history" });
}

/** 假 stores 端口：三个读面各自回带标记的值。`clear` 覆盖清空结果，用来演失败态。 */
function fakeStores(
  clear: Awaited<ReturnType<StorePort["clearHistory"]>> = { ok: true, removed: 2 },
) {
  const calls: string[] = [];
  const port: StorePort = {
    readHistory: async () => {
      calls.push("readHistory");
      return [...HISTORY];
    },
    clearHistory: async () => {
      calls.push("clearHistory");
      return clear;
    },
    readStatus: async () => {
      calls.push("readStatus");
      return { ...STATUS };
    },
  };
  return { port, calls };
}

describe("历史端点", () => {
  it("GET /history 回 `records`（键名是客户端锁定的契约，改名页面就整块空白）", async () => {
    const stores = fakeStores();
    const { res, rec, json } = makeRes();
    await new JournalEndpoints(stores.port).read(makeReq("GET"), res);
    expect(rec.status).toBe(200);
    expect(json()).toEqual({ ok: true, records: HISTORY });
  });

  it("DELETE /history 回 `removed` 条数（页面据此提示清掉了几条）", async () => {
    const stores = fakeStores();
    const { res, rec, json } = makeRes();
    await new JournalEndpoints(stores.port).clear(makeReq("DELETE"), res);
    expect(rec.status).toBe(200);
    expect(json()).toEqual({ ok: true, removed: 2 });
    expect(stores.calls).toEqual(["clearHistory"]);
  });

  // 落盘失败必须走 503 而不是被压成 200（#1016 残留 1）：答 200 时界面提示「已清空 N 条」，
  // 而文件纹丝未动，刷新后旧记录全在。
  it("DELETE /history 清空落盘失败：503 + `history-unavailable`（不是 200 的假成功）", async () => {
    const stores = fakeStores({ ok: false, reason: "unavailable" });
    const { res, rec, json } = makeRes();
    await new JournalEndpoints(stores.port).clear(makeReq("DELETE"), res);
    expect(rec.status).toBe(503);
    expect(json()).toEqual({
      ok: false,
      error: { error: "历史记录服务不可用", code: "history-unavailable" },
    });
    expect(stores.calls).toEqual(["clearHistory"]);
  });
});

describe("频道状态端点", () => {
  it("GET /status 回 `channels`（含结构化失败理由与连续失败计数，设置页据此标记异常出口）", async () => {
    const stores = fakeStores();
    const { res, rec, json } = makeRes();
    await new JournalEndpoints(stores.port).readStatus(makeReq("GET"), res);
    expect(rec.status).toBe(200);
    // 信封与条目键集逐个钉死：`lastStatus` 仍是 `ok|failed` 二值，本版只把理由换成了结构化的
    expect(json()).toEqual({ ok: true, channels: STATUS });
    expect(stores.calls).toEqual(["readStatus"]);
  });
});
