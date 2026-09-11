// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e：审批请求通知（approval/request waterfall）。
 *
 * 覆盖：五个事件监听器注册面；审批通知（工具中文名/任务标题/申请理由/
 * 行动建议，不短路、不暴露会话 id）；无标题降级；next 抛错原样传播；
 * notifyAsk=false 不通知；免打扰紧急例外 allowKinds。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, agentWithTitle } from "../helpers.ts";

/** 带 info 收集的 logger 覆盖。 */
function loggingOverride(infos) {
  return { logger: { warn: () => {}, info: (t) => infos.push(t) } };
}

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-e2e-approval-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** 审批夹具：独立 history 文件 + info 收集 + approval/request 监听器。 */
async function approvalNotifier(tag, config = {}) {
  const infos = [];
  const { listeners } = await makeNotifier(work, { historyFile: join(work, `history-ap-${tag}.jsonl`), ...config }, loggingOverride(infos));
  return { infos, listeners, approval: listeners.get("approval/request")[0] };
}

/** 主流程审批请求（带标题/工具/理由）。 */
const req = () => ({ toolName: "pwsh", agent: agentWithTitle("session-1", "优化 notifier 插件"), reason: "escalate sandbox to workspace-write: 需要写文件", signal: { aborted: false } });
/** 无会话标题的审批请求（降级为仅工具名）。 */
const reqNoTitle = () => ({ toolName: "bash", agent: agentWithTitle("session-9", null) });

describe("监听器注册面", () => {
  it("五个事件监听器已注册", async () => {
    const { listeners } = await approvalNotifier("reg");
    const approval = listeners.get("approval/request")[0];
    const status = listeners.get("agent/status")[0];
    const error = listeners.get("agent/error")[0];
    const turnStop = listeners.get("agent/turn-stopping")[0];
    const disposed = listeners.get("agent/disposed")[0];
    expect(approval && status && error && turnStop && disposed).toBeTruthy();
  });

  it("不再挂 pre-execute（真实审批走 approval/request）", async () => {
    const { listeners } = await approvalNotifier("reg");
    expect(listeners.has("tools/pre-execute")).toBe(false);
  });
});

describe("批准通知主流程（工具中文名 / 任务标题 / 申请理由 / 行动建议）", () => {
  // approval/request：通知后不短路返回 next 结果
  async function firstApproval() {
    const f = await approvalNotifier("main");
    const outcome = await f.approval(req(), async () => "allowed-once");
    return { ...f, outcome };
  }

  it("不短路，返回 next 结果", async () => {
    expect((await firstApproval()).outcome).toBe("allowed-once");
  });

  it("通知只发一条", async () => {
    expect((await firstApproval()).infos.length).toBe(1);
  });

  it("通知含 ask kind", async () => {
    expect((await firstApproval()).infos[0]).toMatch(/ask/);
  });

  it("审批通知带任务标题与工具中文名", async () => {
    expect((await firstApproval()).infos[0]).toMatch(/任务「优化 notifier 插件」等待审批（工具「PowerShell 命令」）/);
  });

  it("审批通知带申请理由", async () => {
    expect((await firstApproval()).infos[0]).toMatch(/理由：escalate sandbox to workspace-write: 需要写文件/);
  });

  it("审批通知带行动建议", async () => {
    expect((await firstApproval()).infos[0]).toMatch(/确认或拒绝/);
  });

  it("审批通知不暴露内部会话 id", async () => {
    expect((await firstApproval()).infos[0].includes("session-")).toBe(false);
  });
});

describe("无会话标题：降级为仅工具名", () => {
  async function secondApproval() {
    const f = await approvalNotifier("notitle");
    await f.approval(req(), async () => "allowed-once");
    const outcome2 = await f.approval(reqNoTitle(), async () => "allowed-once");
    return { ...f, outcome2 };
  }

  it("不短路，返回 next 结果（无标题路径）", async () => {
    expect((await secondApproval()).outcome2).toBe("allowed-once");
  });

  it("无标题时仅显示工具中文名", async () => {
    expect((await secondApproval()).infos[1]).toMatch(/工具「终端命令」等待审批/);
  });

  it("无标题时不显示任务行", async () => {
    expect((await secondApproval()).infos[1].includes("任务「")).toBe(false);
  });

  it("无标题路径也不暴露会话 id", async () => {
    expect((await secondApproval()).infos[1].includes("session-9")).toBe(false);
  });
});

describe("next 抛错 → 原样传播（waterfall 兜底由上层负责）", () => {
  async function throwingApproval() {
    const f = await approvalNotifier("throw");
    await f.approval(req(), async () => "allowed-once");
    await f.approval(reqNoTitle(), async () => "allowed-once");
    const failing = () => f.approval(req(), async () => {
      throw new Error("boom");
    });
    return { ...f, failing };
  }

  it("next 抛错原样传播", async () => {
    const f = await throwingApproval();
    await expect(f.failing()).rejects.toThrow(/boom/);
  });

  it("next 抛错前通知已发出", async () => {
    const f = await throwingApproval();
    await f.failing().catch(() => { /* 断言已发布的通知条数 */ });
    expect(f.infos.length).toBe(3);
  });
});

describe("notifyAsk=false（组合层 entry）时不通知、不短路", () => {
  it("不短路", async () => {
    const { approval } = await approvalNotifier("off", { notifyAsk: false });
    expect(await approval({ toolName: "bash", agent: { id: "session-1" } }, async () => "allowed-once")).toBe("allowed-once");
  });

  it("notifyAsk=false 不通知", async () => {
    const { approval, infos } = await approvalNotifier("off", { notifyAsk: false });
    await approval({ toolName: "bash", agent: { id: "session-1" } }, async () => "allowed-once");
    expect(infos.length).toBe(0);
  });
});

// 免打扰紧急例外：allowKinds 中的 kind 在免打扰时段仍通知
/** 免打扰窗口动态构造（±2 分钟，绕当前时间）。 */
function quietWindowNow() {
  // 写死 "00:00"/"23:59" 假设全天覆盖，但实现是半开区间 [start, end)，
  // 23:59 这一分钟不命中，UTC 边缘必炸；now 邻近 00:00 时 start > end，
  // 天然走实现的跨午夜分支（quiet-hours.ts）。
  const hhmm = (offsetMinutes) => {
    const t = new Date(Date.now() + offsetMinutes * 60_000);
    return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  };
  return { enabled: true, start: hhmm(-2), end: hhmm(2) };
}

describe("免打扰紧急例外：allowKinds 含 ask 仍通知", () => {
  async function quietAllowAsk() {
    const f = await approvalNotifier("qh1", { quietHours: { ...quietWindowNow(), allowKinds: ["ask"] } });
    await f.approval({ toolName: "pwsh", agent: agentWithTitle("qh-1", "免打扰审批", { turnEnd: 1 }) }, async () => "ok");
    return f;
  }

  it("免打扰期间 ask 仍通知（紧急例外 allowKinds）", async () => {
    expect((await quietAllowAsk()).infos.length).toBe(1);
  });

  it("免打扰期间 ask 通知含 ask kind", async () => {
    expect((await quietAllowAsk()).infos[0]).toMatch(/ask/);
  });
});

describe("免打扰无 allowKinds：静默但留拦截日志", () => {
  async function quietNoAllow() {
    const f = await approvalNotifier("qh2", { quietHours: { ...quietWindowNow(), allowKinds: [] } });
    await f.approval({ toolName: "pwsh", agent: { id: "qh-2" } }, async () => "ok");
    return f;
  }

  it("无 allowKinds 时免打扰不产生实际通知", async () => {
    expect((await quietNoAllow()).infos.filter((t) => !t.includes("被免打扰拦截")).length).toBe(0);
  });

  it("被拦截仍记录日志（可核对发没发）", async () => {
    expect((await quietNoAllow()).infos.some((t) => t.includes("被免打扰拦截"))).toBeTruthy();
  });
});
