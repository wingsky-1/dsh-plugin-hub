/**
 * dsh-notifier channels 域 dry-run 块 —— 单目标出站（提案 B6）。
 *
 * 判据面：单跳超时复用出口 clamp 再压 15s（表驱动）；browser 返回 ok 但零 emit；
 * 双关即 skipped；bark / webhook 经注入的传输桩（全程离线，真凭据只进 body 不进 URL）；
 * 失败理由按三上限收口（响应体 200 → detail，超长 detail → 300）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  DRY_RUN_FETCH_CAP_MS,
  dryRunFetchTimeoutMs,
  dryRunTarget,
} from "../../../src/server/channels/impl/dry-run/index.ts";
import type { BarkTarget } from "../../../src/server/channels/impl/bark/type.ts";
import type { BrowserTarget } from "../../../src/server/channels/impl/browser/type.ts";
import type { SystemTarget } from "../../../src/server/channels/impl/system/type.ts";
import type { WebhookTarget } from "../../../src/server/channels/impl/webhook/type.ts";
import type {
  DeliverResult,
  NotifyMessage,
} from "../../../src/server/channels/impl/deliver/type.ts";
import type { PinnedOutcome } from "../../../src/server/channels/impl/dry-run/secure-fetch.ts";
import { reasonOf } from "../../helpers.ts";

function messageOf(): NotifyMessage {
  return { title: "标题", body: "正文", kind: "test", ts: 1_700_000_000_000 };
}

function barkOf(over: Partial<BarkTarget> = {}): BarkTarget {
  return { type: "bark", baseUrl: "https://api.day.app", deviceKey: "real-key", ...over };
}

function webhookOf(over: Partial<WebhookTarget> = {}): WebhookTarget {
  return { type: "webhook", url: "https://example.test/hook", preset: "raw", ...over };
}

/**
 * 传输桩：按剧本回包，记下命中的 URL（钉没钉死看这里）。DNS 同桩：夹具主机名（api.day.app /
 * example.test）一律解到公开测试地址——真实 getaddrinfo 不进单测（离线硬约束）。
 */
function transportOf(script: PinnedOutcome[]): {
  ports: {
    dns: { resolveAll: (host: string) => Promise<Array<{ address: string; family: number }>> };
    transport: (url: URL) => Promise<PinnedOutcome>;
  };
  calls: string[];
} {
  const calls: string[] = [];
  let step = 0;
  return {
    calls,
    ports: {
      dns: {
        resolveAll: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      },
      transport: (url: URL) => {
        calls.push(url.toString());
        const outcome = script[Math.min(step, script.length - 1)];
        step += 1;
        if (outcome === undefined) throw new Error("剧本耗尽");
        return Promise.resolve(outcome);
      },
    },
  };
}

describe("dryRunFetchTimeoutMs：复用 clamp 再压 15s（B4）", () => {
  it("bark 缺省 10s 原样通过", () => {
    expect(dryRunFetchTimeoutMs(barkOf())).toBe(10_000);
  });
  it("bark 60s 配置压到 15s 上限", () => {
    expect(dryRunFetchTimeoutMs(barkOf({ timeoutMs: 60_000 }))).toBe(15_000);
    expect(DRY_RUN_FETCH_CAP_MS).toBe(15_000);
  });
  it("bark 5s 配置原样通过", () => {
    expect(dryRunFetchTimeoutMs(barkOf({ timeoutMs: 5_000 }))).toBe(5_000);
  });
  it("webhook 缺省 10s、60s 压到 15s、5s 通过", () => {
    expect(dryRunFetchTimeoutMs(webhookOf())).toBe(10_000);
    expect(dryRunFetchTimeoutMs(webhookOf({ timeoutSec: 60 }))).toBe(15_000);
    expect(dryRunFetchTimeoutMs(webhookOf({ timeoutSec: 5 }))).toBe(5_000);
  });
});

describe("dryRunTarget：browser（零 emit）", () => {
  it("正常配置返回 ok 且 emitFrame 零调用（不 emit 真通知）", async () => {
    const emitFrame = vi.fn();
    const target: BrowserTarget = {
      type: "browser",
      popup: true,
      sound: false,
      whenVisible: false,
      emitFrame,
    };
    const result = await dryRunTarget(target, messageOf());
    expect(result).toEqual({ status: "ok", stage: "accepted" });
    expect(emitFrame).not.toHaveBeenCalled();
  });

  it("双关即 skipped（与出口同语义）", async () => {
    const target: BrowserTarget = {
      type: "browser",
      popup: false,
      sound: false,
      whenVisible: false,
      emitFrame: () => {},
    };
    const result = await dryRunTarget(target, messageOf());
    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") throw new Error("期望 skipped");
    expect(result.reason.code).toBe("reasonSkipConfig");
  });
});

describe("dryRunTarget：bark（经注入传输，全程离线）", () => {
  it("200 + code 200 即 ok：真凭据进 body，不进 URL", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const ports = {
      dns: {
        resolveAll: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      },
      transport: (url: URL, _ip: string, _family: 4 | 6, init: { body: string }) => {
        seen.push({ url: url.toString(), body: init.body });
        return Promise.resolve({
          kind: "response",
          status: 200,
          body: JSON.stringify({ code: 200 }),
        } as PinnedOutcome);
      },
    };
    const result = await dryRunTarget(barkOf(), messageOf(), ports);
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.day.app/push");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({ device_key: "real-key" });
  });

  it("500 即 failed：响应体按 200 字符截进 detail", async () => {
    const stub = transportOf([{ kind: "response", status: 500, body: "e".repeat(1000) }]);
    const result = await dryRunTarget(barkOf(), messageOf(), stub.ports);
    expect(result.status).toBe("failed");
    const reason = reasonOf(result as DeliverResult);
    expect(reason.code).toBe("reasonBarkHttp");
    expect(reason.params).toMatchObject({ status: 500 });
    expect(reason.detail).toBe("e".repeat(200));
  });

  it("传输层拒绝（SSRF 闸）即 request-failed：超长原因按 300 截", async () => {
    const blocked = {
      dns: {
        resolveAll: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      },
      transport: () => Promise.reject(new Error("x".repeat(1000))),
    };
    const result = await dryRunTarget(barkOf(), messageOf(), blocked);
    expect(result.status).toBe("failed");
    const reason = reasonOf(result as DeliverResult);
    expect(reason.code).toBe("reasonBarkRequestFailed");
    expect(reason.detail).toBe("x".repeat(300));
  });
});

describe("dryRunTarget：webhook（经注入传输）", () => {
  it("200 即 ok", async () => {
    const stub = transportOf([{ kind: "response", status: 200, body: "{}" }]);
    const result = await dryRunTarget(webhookOf(), messageOf(), stub.ports);
    expect(result).toEqual({ status: "ok", stage: "delivered" });
    expect(stub.calls).toEqual(["https://example.test/hook"]);
  });

  it("模板非法即 failed（建连零调用）", async () => {
    const stub = transportOf([{ kind: "response", status: 200, body: "{}" }]);
    const result = await dryRunTarget(
      webhookOf({ template: "{不是json" }),
      messageOf(),
      stub.ports,
    );
    expect(result.status).toBe("failed");
    expect(reasonOf(result as DeliverResult).code).toBe("reasonWebhookTemplateInvalid");
    expect(stub.calls).toEqual([]);
  });
});

describe("dryRunTarget：system（双关早退，无子进程）", () => {
  it("不弹不响即 skipped 且不碰平台探测", async () => {
    const target: SystemTarget = {
      type: "system",
      popup: false,
      sound: false,
      toastScript: "/nonexistent/toast.ps1",
      logger: {
        warn: () => {
          throw new Error("禁写面：logger 不许被调用");
        },
      },
    };
    const result = await dryRunTarget(target, messageOf());
    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") throw new Error("期望 skipped");
    expect(result.reason.code).toBe("reasonSkipConfig");
  });
});
