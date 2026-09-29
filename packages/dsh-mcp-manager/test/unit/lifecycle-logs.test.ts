/**
 * dsh-mcp-manager servers/lifecycle 域（装载生命周期）官方日志归属与诊断文案单测。
 *
 * 判据面（每条都锚一个可改坏的点）：
 * - officialLogText：只认官方客户端这个记录名、只拼字符串参数、纯空白等于没说话；
 * - attributeOfficialLog：按 `mcp-client(<serverName>)` **全等前缀**归属——名字互为前缀的两个实例
 *   不能被包含匹配记到对方头上；前缀之后没有正文不算命中；
 * - diagnosticText：单行字段的形态收敛（折行折叠 + 按字符上限截断）与条数上限（取末 3 条并报出总数）；
 * - collectOfficialLogs：收集器只收归属本实例的、按到达顺序、stop 之后不再收、重复 stop 无害、
 *   摘除器抛错被吞（诊断面不得把一次已结算的装载改写成失败）。
 *
 * 夹具是 `test/helpers.ts` 的 `fakeLogsPort`（宿主日志面的结构形状）。本文件刻意不带 @ts-nocheck：
 * test/tsconfig.json 真实编译整个 test 树，隐式 any 会被 service-contract-wiring 判红。
 */
import { describe, expect, it } from "vitest";
import type { LogRecord, LogsPort } from "../../src/server/shared/interface.ts";
import {
  attributeOfficialLog,
  collectOfficialLogs,
  diagnosticText,
  officialLogText,
} from "../../src/server/servers/lifecycle/interface.ts";
import { fakeLogsPort } from "../helpers.ts";

/** 造一条宿主日志记录：判据只看 name 与 args，type / level 取最小形状。 */
function record(name: string, ...args: unknown[]): LogRecord {
  return { name, type: "warn", level: 2, args };
}

describe("officialLogText：官方记录名与可读文案", () => {
  it("不是 mcp-client 的记录名一律不取：域内导出器收的是全宿主日志", () => {
    expect(officialLogText(record("dsh-mcp-manager", "mcp-client(srv): 疑似"))).toBeUndefined();
  });

  it("没有字符串参数时返回 undefined：官方把可读文案放在字符串参数里", () => {
    expect(officialLogText(record("mcp-client", { code: 1 }, 42))).toBeUndefined();
    expect(officialLogText(record("mcp-client"))).toBeUndefined();
  });

  it("多段字符串参数按到达顺序拼接，非字符串参数不入文案", () => {
    expect(officialLogText(record("mcp-client", "connection", "refused", { port: 1 }))).toBe(
      "connection refused",
    );
  });

  it("纯空白等于没说话：返回 undefined 而不是空串", () => {
    expect(officialLogText(record("mcp-client", "   ", "\n\t"))).toBeUndefined();
  });
});

describe("attributeOfficialLog：按全等前缀归属", () => {
  it("命中：去掉 mcp-client(<id>) 前缀与紧随的冒号（半角 / 全角 / 空白）", () => {
    expect(attributeOfficialLog("mcp-client(id1): 连接被拒", "id1")).toBe("连接被拒");
    expect(attributeOfficialLog("mcp-client(id1)：连接被拒", "id1")).toBe("连接被拒");
    expect(attributeOfficialLog("mcp-client(id1) 连接被拒", "id1")).toBe("连接被拒");
  });

  it("id 互为前缀时不误归属：包含匹配会把 A 的错因记到 B 头上", () => {
    // 另一个实例的 id 是本 id 的前缀。
    expect(attributeOfficialLog("mcp-client(idsee): 别人的失败", "idseed")).toBeUndefined();
    // 本 id 是另一个实例 id 的前缀。
    expect(attributeOfficialLog("mcp-client(idseed): 别人的失败", "idsee")).toBeUndefined();
  });

  it("前缀出现在文案中段不算命中：归属认的是整条记录的开头", () => {
    // 官方可能转述别人的原话，包含匹配会把中段那个前缀后面的碎片当成自己的错因。
    expect(attributeOfficialLog("转述：mcp-client(id1): 连接被拒", "id1")).toBeUndefined();
  });

  it("前缀之后没有正文不算命中：只有前缀（或补冒号 / 空白）返回 undefined", () => {
    expect(attributeOfficialLog("mcp-client(id1)", "id1")).toBeUndefined();
    expect(attributeOfficialLog("mcp-client(id1):", "id1")).toBeUndefined();
    expect(attributeOfficialLog("mcp-client(id1)：   ", "id1")).toBeUndefined();
  });
});

describe("diagnosticText：状态面字段的形态收敛", () => {
  it("空数组或全空白返回 undefined：不占状态面字段", () => {
    expect(diagnosticText([])).toBeUndefined();
    expect(diagnosticText(["  ", "\n"])).toBeUndefined();
  });

  it("不超过上限时原样给出，不报条数", () => {
    expect(diagnosticText(["连接被拒", "已放弃重连"])).toBe("官方日志：连接被拒 | 已放弃重连");
  });

  it("超过 3 条取末 3 条并报出总条数：不说省略了多少，读的人会以为官方只说了这些", () => {
    expect(diagnosticText(["a", "b", "c", "d", "e"])).toBe(
      "官方日志（共 5 条，取末 3 条）：c | d | e",
    );
  });

  it("单条超上限按字符截断并带省略号，折行折叠成空格", () => {
    expect(diagnosticText(["x".repeat(300)])).toBe("官方日志：" + "x".repeat(240) + "…");
    expect(diagnosticText(["第一行\n第二行"])).toBe("官方日志：第一行 第二行");
  });
});

describe("collectOfficialLogs：一个装载窗口的收集面", () => {
  it("只收归属本实例的官方日志，按到达顺序：别的记录名 / 别的 id 一律不收", () => {
    const logs = fakeLogsPort();
    const collected = collectOfficialLogs(logs as unknown as LogsPort, "id1");

    logs.emit(record("mcp-client", "mcp-client(id1): 第一条"));
    logs.emit(record("mcp-client", "mcp-client(id2): 别人的失败"));
    logs.emit(record("dsh-mcp-manager", "mcp-client(id1): 别的插件"));
    logs.emit(record("mcp-client", "mcp-client(id1): 第二条"));

    expect(collected.lines()).toEqual(["第一条", "第二条"]);
  });

  it("stop() 摘掉导出器：之后到的官方日志不再收，重复 stop 无害", () => {
    const logs = fakeLogsPort();
    const collected = collectOfficialLogs(logs as unknown as LogsPort, "id1");
    logs.emit(record("mcp-client", "mcp-client(id1): 第一条"));

    collected.stop();
    expect(logs.captured).toBe(0);
    logs.emit(record("mcp-client", "mcp-client(id1): 第二条"));

    expect(collected.lines()).toEqual(["第一条"]);
    expect(() => collected.stop()).not.toThrow();
  });

  it("摘除器抛错被吞：诊断面不得把一次已结算的装载改写成失败", () => {
    let disposeCalls = 0;
    const logs: LogsPort = {
      capture: () => () => {
        disposeCalls += 1;
        throw new Error("宿主摘除失败");
      },
    };
    const collected = collectOfficialLogs(logs as unknown as LogsPort, "id1");

    expect(() => collected.stop()).not.toThrow();
    expect(() => collected.stop()).not.toThrow();
    expect(disposeCalls).toBe(1);
  });
});
