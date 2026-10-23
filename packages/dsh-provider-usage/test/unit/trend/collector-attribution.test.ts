import { beforeAll, describe, expect, it } from "vitest";
import {
  TrendCollector,
  type TrendCallRecord,
  type TrendEmit,
} from "../../../src/server/collect/interface.ts";
import { TREND_UNIDENTIFIED } from "../../../src/server/shared/interface.ts";
import {
  HEADER,
  MESSAGE,
  T0,
  USAGE,
  callsOf,
  ev,
  makeCollector,
  snapshot,
} from "./collector-test-support.ts";

describe("collector：归属", () => {
  describe("归属缺失 → 未识别桶（不静默丢弃）", () => {
    let calls: TrendCallRecord[];

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      send({ id: "s1" }, ev("assistant/chunk", USAGE(10, 5), T0, 1));
      calls = snapshot(callsOf(emitted));
    });

    it("归属缺失入未识别桶", () => {
      expect(calls[0].provider).toBe(TREND_UNIDENTIFIED);
    });

    it("未识别桶 model=null", () => {
      expect(calls[0].model).toBe(null);
    });
  });

  describe('副源：message.source（kind:"model"）在归属缺失时补齐', () => {
    let calls: TrendCallRecord[];

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      const s = { id: "s1" };
      send(
        s,
        ev(
          "assistant/message",
          { ...MESSAGE({ inputTokens: 1, outputTokens: 1 }), turn: 1 },
          T0,
          1,
        ),
      );
      // 后续调用（新 turn）：副源归属已折叠进会话状态
      send(
        s,
        ev(
          "assistant/chunk",
          {
            turn: 2,
            step: 1,
            chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
          },
          T0 + 100,
          2,
        ),
      );
      calls = snapshot(callsOf(emitted));
    });

    it("message 补记 + 后续 usage 各计一次", () => {
      expect(calls.length).toBe(2);
    });

    it("首条经副源归属", () => {
      expect(calls[0].provider).toBe("deepseek");
    });

    it("副源归属折叠对后续调用生效", () => {
      expect(calls[1].provider).toBe("deepseek");
    });
  });

  describe("mid-session 切换：新 header 覆盖归属", () => {
    let providers: string[];

    beforeAll(() => {
      const { emitted, send } = makeCollector();
      const s = { id: "s1" };
      send(s, ev("request/header", HEADER("deepseek", "chat"), T0, 1));
      send(
        s,
        ev(
          "assistant/chunk",
          {
            turn: 1,
            step: 1,
            chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
          },
          T0,
          2,
        ),
      );
      send(s, ev("request/header", HEADER("opencode", "glm-4"), T0 + 10, 3));
      send(
        s,
        ev(
          "assistant/chunk",
          {
            turn: 2,
            step: 1,
            chunk: { type: "usage", usage: { inputTokens: 2, outputTokens: 2 } },
          },
          T0 + 20,
          4,
        ),
      );
      providers = callsOf(emitted).map((c) => c.provider);
    });

    it("切换后归属更新", () => {
      expect(providers).toEqual(["deepseek", "opencode"]);
    });
  });
});

describe("评审修复 P2-6：归属不一致告警（主源不被副源覆盖）", () => {
  let anomaliesLength: number;
  let anomalyHasSession: boolean;
  let callProvider: string;
  let callModel: string | null;
  let silentLength: number;
  let missingLength: number;

  beforeAll(() => {
    // P2-6：主源在场且 message.source 解析结果与之不一致 → onAnomaly 告警（带上下文）、
    // attribution 保持主源不被副源覆盖。
    const anomalies: string[] = [];
    const emitted: TrendEmit[] = [];
    const collector = new TrendCollector({
      now: () => T0,
      emit: (e) => emitted.push(e),
      onAnomaly: (m) => anomalies.push(m),
    });
    collector.handleEvent("s1", ev("request/header", HEADER("deepseek", "deepseek-chat"), T0, 1));
    collector.handleEvent(
      "s1",
      ev(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            role: "assistant",
            source: { kind: "model", provider: "opencode", model: "glm-4" },
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        T0 + 100,
        2,
      ),
    );
    anomaliesLength = anomalies.length;
    anomalyHasSession = anomalies[0].includes("s1");
    callProvider = callsOf(emitted)[0].provider;
    callModel = callsOf(emitted)[0].model;
    // 回归：主副源一致不告警；归属缺失走副源补齐不告警（既有语义不回退）
    const silent: string[] = [];
    const c2 = new TrendCollector({
      now: () => T0,
      emit: () => {},
      onAnomaly: (m) => silent.push(m),
    });
    c2.handleEvent("s1", ev("request/header", HEADER(), T0, 1));
    c2.handleEvent(
      "s1",
      ev("assistant/message", MESSAGE({ inputTokens: 1, outputTokens: 1 }), T0, 2),
    );
    silentLength = silent.length;
    const missing: string[] = [];
    const c3 = new TrendCollector({
      now: () => T0,
      emit: () => {},
      onAnomaly: (m) => missing.push(m),
    });
    c3.handleEvent(
      "s1",
      ev("assistant/message", MESSAGE({ inputTokens: 1, outputTokens: 1 }), T0, 1),
    );
    missingLength = missing.length;
  });

  it("归属不一致触发 onAnomaly（provider 不同）", () => {
    expect(anomaliesLength).toBe(1);
  });

  it("告警带上下文", () => {
    expect(anomalyHasSession).toBeTruthy();
  });

  it("attribution 保持主源 provider", () => {
    expect(callProvider).toBe("deepseek");
  });

  it("attribution 保持主源 model", () => {
    expect(callModel).toBe("deepseek-chat");
  });

  it("主副源一致不告警", () => {
    expect(silentLength).toBe(0);
  });

  it("归属缺失走副源补齐不告警", () => {
    expect(missingLength).toBe(0);
  });
});
