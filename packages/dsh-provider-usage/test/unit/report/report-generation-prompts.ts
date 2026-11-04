/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_PROMPT,
  DEFAULT_WEEKLY_PROMPT,
  DEFAULT_MONTHLY_PROMPT,
  DEFAULT_PROMPTS,
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_WEEKLY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V1,
  LEGACY_DAILY_PROMPT_V2,
  LEGACY_WEEKLY_PROMPT_V2,
  LEGACY_MONTHLY_PROMPT_V2,
  LEGACY_DAILY_PROMPT_V3,
  LEGACY_WEEKLY_PROMPT_V3,
  LEGACY_MONTHLY_PROMPT_V3,
  LEGACY_DAILY_PROMPT_V4,
  LEGACY_WEEKLY_PROMPT_V4,
  LEGACY_MONTHLY_PROMPT_V4,
  join,
  mkdirSync,
  mkdtempSync,
  normalizeReportConfig,
  promptFor,
  readReportConfig,
  rmSync,
  tmpdir,
  writeFileSync,
  type ReportConfig,
} from "./report-generation-support.ts";

const NEW_PROMPTS = { daily: "日模板{stats}", weekly: "周模板{stats}", monthly: "月模板{stats}" };

describe("#532 per-period 提示词：prompts 新格式直读", () => {
  let n: ReportConfig;
  beforeAll(() => {
    n = normalizeReportConfig({ prompts: NEW_PROMPTS });
  });

  it("prompts 新格式直读", () => {
    expect(n.prompts).toEqual(NEW_PROMPTS);
  });

  it("promptTemplate=月报镜像", () => {
    expect(n.promptTemplate).toBe("月模板{stats}");
  });
});

describe("#532 per-period 提示词：旧默认模板 → 升级三份新默认", () => {
  let legacyDefault: ReportConfig;
  beforeAll(() => {
    legacyDefault = normalizeReportConfig({ promptTemplate: LEGACY_PROMPT_TEMPLATE });
  });

  it("旧默认 → 升级日报新默认", () => {
    expect(legacyDefault.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("旧默认 → 升级周报新默认", () => {
    expect(legacyDefault.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("旧默认 → 升级月报新默认", () => {
    expect(legacyDefault.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：自定义旧模板三周期继承", () => {
  let custom: ReportConfig;
  beforeAll(() => {
    custom = normalizeReportConfig({ promptTemplate: "我的自定义模板 {stats}" });
  });

  it("自定义旧模板三周期继承", () => {
    expect(custom.prompts).toEqual({
      daily: "我的自定义模板 {stats}",
      weekly: "我的自定义模板 {stats}",
      monthly: "我的自定义模板 {stats}",
    });
  });
});

describe("#532 per-period 提示词：V1 旧默认（今天/本周/本月）自动升级", () => {
  let legacyV1: ReportConfig;
  beforeAll(() => {
    legacyV1 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V1,
        weekly: LEGACY_WEEKLY_PROMPT_V1,
        monthly: LEGACY_MONTHLY_PROMPT_V1,
      },
    });
  });

  it("未自定义的旧版日报模板自动升级", () => {
    expect(legacyV1.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("未自定义的旧版周报模板自动升级", () => {
    expect(legacyV1.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("未自定义的旧版月报模板自动升级", () => {
    expect(legacyV1.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：V2 单段模板自动升级为语义块", () => {
  let legacyV2: ReportConfig;
  beforeAll(() => {
    legacyV2 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V2,
        weekly: LEGACY_WEEKLY_PROMPT_V2,
        monthly: LEGACY_MONTHLY_PROMPT_V2,
      },
    });
  });

  it("V2 单段日报模板自动升级为语义块", () => {
    expect(legacyV2.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V2 单段周报模板自动升级为语义块", () => {
    expect(legacyV2.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("V2 单段月报模板自动升级为语义块", () => {
    expect(legacyV2.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：V3 无目录观察模板自动升级（复核 P1-4 盲区补齐）", () => {
  let legacyV3: ReportConfig;
  let mixedV3: ReportConfig;
  beforeAll(() => {
    legacyV3 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V3,
        weekly: LEGACY_WEEKLY_PROMPT_V3,
        monthly: LEGACY_MONTHLY_PROMPT_V3,
      },
    });
    // V3 混合形态：单周期自定义保留、其余周期平滑升级（防整表覆盖回退）
    mixedV3 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V3,
        weekly: "我的周报模板 {stats}",
        monthly: LEGACY_MONTHLY_PROMPT_V3,
      },
    });
  });

  it("V3 无目录观察日报模板自动升级", () => {
    expect(legacyV3.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V3 无目录观察周报模板自动升级", () => {
    expect(legacyV3.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("V3 无目录观察月报模板自动升级", () => {
    expect(legacyV3.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });

  it("V3 混合：未自定义日报仍升级", () => {
    expect(mixedV3.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V3 混合：自定义周报保留原样", () => {
    expect(mixedV3.prompts.weekly).toBe("我的周报模板 {stats}");
  });

  it("V3 混合：未自定义月报仍升级", () => {
    expect(mixedV3.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：V3 落盘 round-trip（绕过写侧归一化直读磁盘形态）", () => {
  let loaded: ReportConfig;
  beforeAll(async () => {
    const v3Root = mkdtempSync(join(tmpdir(), "dou-report-v3-migrate-"));
    const reportsDir = join(v3Root, "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(
      join(reportsDir, "config.json"),
      JSON.stringify({
        daily: { enabled: true, time: "09:30" },
        prompts: {
          daily: LEGACY_DAILY_PROMPT_V3,
          weekly: LEGACY_WEEKLY_PROMPT_V3,
          monthly: LEGACY_MONTHLY_PROMPT_V3,
        },
        push: { enabled: false },
      }),
    );
    loaded = await readReportConfig(v3Root);
    rmSync(v3Root, { recursive: true, force: true });
  });

  it("V3 落盘读回：日报自动升级新默认", () => {
    expect(loaded.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V3 落盘读回：周报自动升级新默认", () => {
    expect(loaded.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("V3 落盘读回：月报自动升级新默认", () => {
    expect(loaded.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });

  it("V3 落盘读回：其余字段不受迁移影响", () => {
    expect(loaded.daily.time).toBe("09:30");
  });
});

describe("#662 per-period 提示词：V4 无时段观察模板自动升级", () => {
  let legacyV4: ReportConfig;
  let mixedV4: ReportConfig;
  beforeAll(() => {
    legacyV4 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V4,
        weekly: LEGACY_WEEKLY_PROMPT_V4,
        monthly: LEGACY_MONTHLY_PROMPT_V4,
      },
    });
    // V4 混合形态：单周期自定义保留、其余周期平滑升级（防整表覆盖回退）
    mixedV4 = normalizeReportConfig({
      prompts: {
        daily: LEGACY_DAILY_PROMPT_V4,
        weekly: "我的周报模板 {stats}",
        monthly: LEGACY_MONTHLY_PROMPT_V4,
      },
    });
  });

  it("V4 无时段观察日报模板自动升级", () => {
    expect(legacyV4.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V4 无时段观察周报模板自动升级", () => {
    expect(legacyV4.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("V4 无时段观察月报模板自动升级", () => {
    expect(legacyV4.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });

  it("V4 混合：未自定义日报仍升级", () => {
    expect(mixedV4.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("V4 混合：自定义周报保留原样", () => {
    expect(mixedV4.prompts.weekly).toBe("我的周报模板 {stats}");
  });

  it("V4 混合：未自定义月报仍升级", () => {
    expect(mixedV4.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：用户自定义保留 + 非法值回退", () => {
  let userCustomPrompts: ReportConfig;
  let bad: ReportConfig;
  beforeAll(() => {
    // 若老用户对日报有自定义修改，则保留自定义内容，不被覆写
    userCustomPrompts = normalizeReportConfig({
      prompts: {
        daily: "用户自定义日报：{stats}",
        weekly: LEGACY_WEEKLY_PROMPT_V1,
        monthly: LEGACY_MONTHLY_PROMPT_V1,
      },
    });
    // 非法 prompts 值回退各周期自身默认模板
    bad = normalizeReportConfig({ prompts: { daily: "", weekly: 42, monthly: "x".repeat(20001) } });
  });

  it("自定义修改过的模板保留原样", () => {
    expect(userCustomPrompts.prompts.daily).toBe("用户自定义日报：{stats}");
  });

  it("同时存在的未自定义周报仍平滑升级", () => {
    expect(userCustomPrompts.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("空串回退该周期默认", () => {
    expect(bad.prompts.daily).toBe(DEFAULT_DAILY_PROMPT);
  });

  it("非字符串回退该周期默认", () => {
    expect(bad.prompts.weekly).toBe(DEFAULT_WEEKLY_PROMPT);
  });

  it("超长回退该周期默认", () => {
    expect(bad.prompts.monthly).toBe(DEFAULT_MONTHLY_PROMPT);
  });
});

describe("#532 per-period 提示词：promptFor 按周期取模板", () => {
  it("promptFor daily", () => {
    expect(promptFor(normalizeReportConfig({ prompts: NEW_PROMPTS }), "daily")).toBe(
      "日模板{stats}",
    );
  });

  it("promptFor weekly", () => {
    expect(promptFor(normalizeReportConfig({ prompts: NEW_PROMPTS }), "weekly")).toBe(
      "周模板{stats}",
    );
  });

  it("promptFor monthly", () => {
    expect(promptFor(normalizeReportConfig({ prompts: NEW_PROMPTS }), "monthly")).toBe(
      "月模板{stats}",
    );
  });
});

describe("#532 per-period 提示词：三份默认模板形态", () => {
  it("三默认模板含 {stats}", () => {
    expect(
      DEFAULT_DAILY_PROMPT.includes("{stats}") &&
        DEFAULT_WEEKLY_PROMPT.includes("{stats}") &&
        DEFAULT_MONTHLY_PROMPT.includes("{stats}"),
    ).toBeTruthy();
  });

  it("三默认模板互不相同", () => {
    expect(
      DEFAULT_DAILY_PROMPT !== DEFAULT_WEEKLY_PROMPT &&
        DEFAULT_WEEKLY_PROMPT !== DEFAULT_MONTHLY_PROMPT,
    ).toBeTruthy();
  });

  it("DEFAULT_PROMPTS 表与单常量一致", () => {
    expect(DEFAULT_PROMPTS.daily).toEqual(DEFAULT_DAILY_PROMPT);
  });
});

describe("#544 年报化定稿：模板禁项与全局纪律", () => {
  it("日报模板禁小标题（白名单无 ##）", () => {
    expect(DEFAULT_DAILY_PROMPT.includes("##")).toBeFalsy();
  });

  const templates = [
    ["日报", DEFAULT_DAILY_PROMPT],
    ["周报", DEFAULT_WEEKLY_PROMPT],
    ["月报", DEFAULT_MONTHLY_PROMPT],
  ];

  for (const [name, tpl] of templates) {
    it(`${name}模板含全局 null 降级纪律`, () => {
      expect(tpl.includes("null/0/NaN")).toBeTruthy();
    });

    it(`${name}模板含推算边界（占比与倍数豁免）`, () => {
      expect(tpl.includes("除占比与倍数外不得推算")).toBeTruthy();
    });

    it(`${name}模板含日期以 JSON 为准`, () => {
      expect(tpl.includes("以 JSON 为准")).toBeTruthy();
    });

    it(`${name}模板无代码围栏示例`, () => {
      expect(tpl.includes("```")).toBeFalsy();
    });
  }

  it("周报含占比分母除零护栏", () => {
    expect(DEFAULT_WEEKLY_PROMPT.includes("分母大于 0")).toBeTruthy();
  });

  it("月报含 byProvider 单条降级", () => {
    expect(DEFAULT_MONTHLY_PROMPT.includes("仅一个模型时")).toBeTruthy();
  });
});
