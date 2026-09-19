/**
 * dsh-lan-proxy — 一键 CA 客户端提醒判定（issue #930 F8 展示层，客户端纯逻辑层）。
 *
 * 到期阈值 30 天与 IP 覆盖比对的边界：不可解析/缺键一律不提醒（展示层 fail-open，
 * 下发端照常 404 兜底）；判定只读快照，不读 DOM/网络。
 */
import { describe, expect, it } from "vitest";
import { LEAF_EXPIRY_WARN_MS, evaluateCaWarnings, sanIps } from "../../src/client/ca-status.ts";

const DAY_MS = 86400 * 1000;

describe("sanIps 解析", () => {
  it("只取 IP Address: 条目（DNS/垃圾忽略）", () => {
    expect(
      sanIps(["DNS:localhost", "IP Address:192.168.1.5", "IP Address:10.0.0.2", 42, null]),
    ).toEqual(["192.168.1.5", "10.0.0.2"]);
  });
  it("非数组一律空", () => {
    expect(sanIps(undefined)).toEqual([]);
    expect(sanIps("IP Address:1.2.3.4")).toEqual([]);
  });
});

describe("evaluateCaWarnings 到期", () => {
  it("阈值确为 30 天（与 certStillValid 口径风格同源的第二事实源）", () => {
    expect(LEAF_EXPIRY_WARN_MS).toBe(30 * DAY_MS);
  });
  it("剩余 29 天提醒，31 天不提醒", () => {
    const now = Date.parse("2026-09-19T00:00:00.000Z");
    expect(
      evaluateCaWarnings({ leafValidTo: new Date(now + 29 * DAY_MS).toISOString() }, now).expiring,
    ).toBe(true);
    expect(
      evaluateCaWarnings({ leafValidTo: new Date(now + 31 * DAY_MS).toISOString() }, now).expiring,
    ).toBe(false);
  });
  it("已过期同样提醒", () => {
    const now = Date.parse("2026-09-19T00:00:00.000Z");
    expect(
      evaluateCaWarnings({ leafValidTo: new Date(now - DAY_MS).toISOString() }, now).expiring,
    ).toBe(true);
  });
  it("不可解析/缺席不提醒", () => {
    expect(evaluateCaWarnings({ leafValidTo: "not-a-date" }, 0).expiring).toBe(false);
    expect(evaluateCaWarnings({}, 0).expiring).toBe(false);
  });
});

describe("evaluateCaWarnings IP 变化", () => {
  const sans = ["DNS:localhost", "IP Address:127.0.0.1", "IP Address:192.168.1.5"];
  it("当期全被覆盖不提醒", () => {
    expect(evaluateCaWarnings({ leafSans: sans, currentIps: ["192.168.1.5"] }, 0).ipChanged).toBe(
      false,
    );
  });
  it("当期存在未覆盖者提醒", () => {
    expect(
      evaluateCaWarnings({ leafSans: sans, currentIps: ["192.168.1.5", "192.168.2.9"] }, 0)
        .ipChanged,
    ).toBe(true);
  });
  it("当期为空无法判断不提醒", () => {
    expect(evaluateCaWarnings({ leafSans: sans, currentIps: [] }, 0).ipChanged).toBe(false);
    expect(evaluateCaWarnings({ leafSans: sans }, 0).ipChanged).toBe(false);
  });
});
