/**
 * dsh-provider-usage — unit：路由层纯函数（E5/C6 变异段前置，评审 P1-5）
 *
 * 抽离可测面：clampTrendN（trend 窗口封顶，#768 D12 起改址 server/ui-routes/trend.ts）、
 * isReportPeriodValid/isReportKeyValid/isTaskIdValid（报告路由双白名单校验，
 * #768 D11 起改址 server/report-routes）。SSE 薄 handler 断言（handleEvents，
 * #768 D12 起改址 server/ui-routes/events.ts，装配形状经 server/ui-routes/context.ts）。
 * 薄 handler 的其余行为经 unit-report/unit-apply/smoke 端到端覆盖。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { clampTrendN } from "../../../src/server/ui-routes/trend.ts";
import { handleEvents } from "../../../src/server/ui-routes/events.ts";
import type { UiRoutesContext } from "../../../src/server/ui-routes/context.ts";
import {
  isReportPeriodValid,
  isReportKeyValid,
  isTaskIdValid,
} from "../../../src/server/report-routes/reports.ts";

describe("clampTrendN", () => {
  it("null → 默认 day=30", () => {
    expect(clampTrendN(null, "day", 30)).toBe(30);
  });

  it("合法 5 → 5", () => {
    expect(clampTrendN("5", "day", 30)).toBe(5);
  });

  it("超留存 50 → 封顶 30", () => {
    expect(clampTrendN("50", "day", 30)).toBe(30);
  });

  it("非数字 → 默认", () => {
    expect(clampTrendN("abc", "day", 30)).toBe(30);
  });

  it("0 → 默认（>0 才接受）", () => {
    expect(clampTrendN("0", "day", 30)).toBe(30);
  });

  it("负数 → 默认 week=12", () => {
    expect(clampTrendN("-3", "week", 90)).toBe(12);
  });

  it("week 上限 ceil(90/7)=13，10 未超限原样返回", () => {
    expect(clampTrendN("10", "week", 90)).toBe(10);
  });

  it("week 封顶 ceil(90/7)=13", () => {
    expect(clampTrendN("50", "week", 90)).toBe(13);
  });

  it("month 封顶 ceil(90/30)=3", () => {
    expect(clampTrendN("100", "month", 90)).toBe(3);
  });
});

describe("isReportPeriodValid", () => {
  it("daily 合法", () => {
    expect(isReportPeriodValid("daily")).toBe(true);
  });

  it("weekly 合法", () => {
    expect(isReportPeriodValid("weekly")).toBe(true);
  });

  it("monthly 合法", () => {
    expect(isReportPeriodValid("monthly")).toBe(true);
  });

  it("yearly 非法", () => {
    expect(isReportPeriodValid("yearly")).toBe(false);
  });

  it("空串非法", () => {
    expect(isReportPeriodValid("")).toBe(false);
  });
});

describe("isReportKeyValid", () => {
  it("daily 合法键 YYYY-MM-DD", () => {
    expect(isReportKeyValid("daily", "2026-09-09")).toBe(true);
  });

  it("daily 缺零填充非法", () => {
    expect(isReportKeyValid("daily", "2026-9-9")).toBe(false);
  });

  it("daily 键只验形状不验日历（RegExp 白名单语义）", () => {
    expect(isReportKeyValid("daily", "2026-09-32")).toBe(true);
  });

  it("weekly 合法键", () => {
    expect(isReportKeyValid("weekly", "2026-09-09")).toBe(true);
  });

  it("monthly 合法键 YYYY-MM", () => {
    expect(isReportKeyValid("monthly", "2026-09")).toBe(true);
  });

  it("monthly 不接受日粒度键", () => {
    expect(isReportKeyValid("monthly", "2026-09-09")).toBe(false);
  });

  it("非法 period → 恒 false", () => {
    expect(isReportKeyValid("yearly", "2026")).toBe(false);
  });

  it("分隔符非法", () => {
    expect(isReportKeyValid("daily", "2026/09/09")).toBe(false);
  });
});

describe("isTaskIdValid", () => {
  it("合法 uuid v4", () => {
    expect(isTaskIdValid("3f8b9c2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f")).toBe(true);
  });

  it("版本位非 4 非法", () => {
    expect(isTaskIdValid("3f8b9c2e-1a2b-3c3d-8e4f-5a6b7c8d9e0f")).toBe(false);
  });

  it("变体位非 8/9/a/b 非法", () => {
    expect(isTaskIdValid("3f8b9c2e-1a2b-4c3d-7e4f-5a6b7c8d9e0f")).toBe(false);
  });

  it("空串非法", () => {
    expect(isTaskIdValid("")).toBe(false);
  });

  it("非 uuid 非法", () => {
    expect(isTaskIdValid("not-a-uuid")).toBe(false);
  });
});

// ---------------------------------------------------------------- D3 SSE 断连否定（#768 计划表 rev2 D3 验收）
//
// handleEvents 薄 handler：连通帧 + 注册 + close 移除。假件只提供 Behavioral 面
// （writeHead/write/on/end 记录调用），不断言之外的行为（healthContext 先例风格；
// ServerResponse 无测试接缝，结构假件经单点 unknown 中转——禁 as any/as never）。

function fakeEventsReq(remoteAddress: string): IncomingMessage {
  return {
    method: "GET",
    url: "/api/dsh-provider-usage/events",
    socket: { remoteAddress },
    headers: { host: "127.0.0.1:3080" },
  } as unknown as IncomingMessage;
}

function fakeEventsRes(): {
  res: ServerResponse;
  chunks: string[];
  ended: string[];
  status: () => number;
  emitClose: () => void;
} {
  const chunks: string[] = [];
  const ended: string[] = [];
  const handlers = new Map<string, Array<() => void>>();
  let status = 0;
  const res = {
    writeHead: (s: number) => {
      status = s;
    },
    write: (c: string) => {
      chunks.push(String(c));
    },
    end: (c: string) => {
      ended.push(String(c));
    },
    on: (evt: string, fn: () => void) => {
      const list = handlers.get(evt) ?? [];
      list.push(fn);
      handlers.set(evt, list);
    },
  } as unknown as ServerResponse;
  return {
    res,
    chunks,
    ended,
    status: () => status,
    emitClose: () => {
      for (const fn of handlers.get("close") ?? []) fn();
    },
  };
}

describe("handleEvents SSE 断连否定", () => {
  it("连通帧 + 注册（首帧文案改坏必须红）", () => {
    const clients = new Set<ServerResponse>();
    const fake = fakeEventsRes();
    const ctx = { sseClients: clients } as unknown as UiRoutesContext;
    handleEvents(fakeEventsReq("127.0.0.1"), fake.res, ctx);
    expect(fake.status()).toBe(200);
    expect(fake.chunks).toEqual([": connected\n\n"]);
    expect(clients.has(fake.res)).toBe(true);
  });

  it("断连移除客户端（close 处理删除即残留必须红）", () => {
    const clients = new Set<ServerResponse>();
    const fake = fakeEventsRes();
    const ctx = { sseClients: clients } as unknown as UiRoutesContext;
    handleEvents(fakeEventsReq("127.0.0.1"), fake.res, ctx);
    expect(clients.size).toBe(1);
    fake.emitClose();
    expect(clients.size).toBe(0);
  });

  it("重复断连安全（二次 close 抛错必须红）", () => {
    const clients = new Set<ServerResponse>();
    const fake = fakeEventsRes();
    const ctx = { sseClients: clients } as unknown as UiRoutesContext;
    handleEvents(fakeEventsReq("127.0.0.1"), fake.res, ctx);
    fake.emitClose();
    fake.emitClose();
    expect(clients.size).toBe(0);
  });

  it("非回环 403 不注册（越围栏放行必须红）", () => {
    const clients = new Set<ServerResponse>();
    const fake = fakeEventsRes();
    const ctx = { sseClients: clients } as unknown as UiRoutesContext;
    handleEvents(fakeEventsReq("8.8.8.8"), fake.res, ctx);
    expect(fake.status()).toBe(403);
    expect(clients.size).toBe(0);
  });
});
