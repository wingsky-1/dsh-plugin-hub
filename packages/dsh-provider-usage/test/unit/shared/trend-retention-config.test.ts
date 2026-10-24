/**
 * dsh-provider-usage - unit: trendRetentionDays normalization.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig } from "../../../src/shared/interface.ts";

describe("config：trendRetentionDays 归一化", () => {
  let defaultDays: number;
  let zeroDays: number;
  let negativeDays: number;
  let fractionalDays: number;
  let upperBoundDays: number;
  let passthroughDays: number;

  beforeAll(() => {
    defaultDays = normalizeConfig({}).trendRetentionDays;
    zeroDays = normalizeConfig({ trendRetentionDays: 0 }).trendRetentionDays;
    negativeDays = normalizeConfig({ trendRetentionDays: -3 }).trendRetentionDays;
    fractionalDays = normalizeConfig({ trendRetentionDays: 1.5 }).trendRetentionDays;
    upperBoundDays = normalizeConfig({ trendRetentionDays: 99999 }).trendRetentionDays;
    passthroughDays = normalizeConfig({ trendRetentionDays: 30 }).trendRetentionDays;
  });

  it("trendRetentionDays 默认 180", () => {
    expect(defaultDays).toBe(DEFAULT_CONFIG.trendRetentionDays);
  });

  it("非法（0）回落默认", () => {
    expect(zeroDays).toBe(180);
  });

  it("非法（负数）回落默认", () => {
    expect(negativeDays).toBe(180);
  });

  it("非法（非整数）回落默认", () => {
    expect(fractionalDays).toBe(180);
  });

  it("上界 3650", () => {
    expect(upperBoundDays).toBe(3650);
  });

  it("合法透传", () => {
    expect(passthroughDays).toBe(30);
  });
});
