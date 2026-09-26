/**
 * dsh-provider-usage — integration：S3 upgrade 三步（#768 计划表 rev2 S3 行）。
 *
 * 白盒直连 src（不经包入口），落盘一律进 mkdtemp 隔离目录（产物零污染），
 * 不碰真实 DSH_HOME（本域路径全经 resolveRoot 注入的 historyRoot，不直连 dshHome）。
 * 每条附判据句（把 X 改坏必须红）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdtempSync,
  readdirSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UpgradeDeps } from "../../../src/server/upgrade/deps.ts";
import {
  MIGRATED_SUFFIX,
  legacyConfigFile,
  targetConfigFile,
  targetLastRunFile,
} from "../../../src/server/upgrade/storage-layout.ts";
import { migrateReportConfig } from "../../../src/server/upgrade/config-morph.ts";
import { migrateLastRun } from "../../../src/server/upgrade/last-run-morph.ts";
import { newestTargetVersion } from "../../../../../shared/upgrade-chain.js";
import { runUpgradeChain } from "../../../src/server/upgrade/chain/index.ts";
import { installUpgrade, releaseUpgrade } from "../../../src/server/upgrade/interface.ts";
import { STEPS } from "../../../src/server/upgrade/steps.ts";
import { readStoredVersion, upgradeVersionFile } from "../../../src/server/upgrade/version.ts";
import { LAST_RUN_SCHEMA } from "../../../src/server/shared/interface.ts";
import {
  DEFAULT_PROMPTS,
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V1,
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_WEEKLY_PROMPT_V1,
} from "../../../src/server/config/interface.ts";

let root = "";
let dispose: () => void = () => {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dou-upgrade-"));
  dispose = () => rmSync(root, { recursive: true, force: true });
  releaseUpgrade();
});

afterEach(() => {
  releaseUpgrade();
  dispose();
});

function deps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  const logger = overrides.logger ?? makeLogger();
  return {
    logger,
    resolveRoot: () => root,
    readOldFile: async (file: string) => {
      try {
        return { ok: true as const, text: await readFile(file, "utf8") };
      } catch {
        return { ok: false as const };
      }
    },
    ...overrides,
  };
}

function makeLogger(): { warns: string[]; warn: (message: string) => void } {
  const warns: string[] = [];
  return { warns, warn: (message: string) => void warns.push(message) };
}

/**
 * 步骤表里最高的目标版本：链跑完的刻度应当正好落在它上面。
 * 写死版本号等于把「链跑到了表末」这条判据绑死在某一版上，每次发版都要来改一次。
 */
function newestTarget(): string {
  return newestTargetVersion(STEPS);
}

function permissionBits(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("存储归位：纯字节搬移四态", () => {
  it("有旧无新：内容逐字搬到目标、旧文件改名留痕、0600（判据：逐字搬移，不解析）", async () => {
    const legacy = legacyConfigFile(root);
    writeFileSync(legacy, '{"from":"legacy"}\n', "utf8");

    await runUpgradeChain(deps());

    expect(readFileSync(targetConfigFile(root), "utf8")).toBe('{"from":"legacy"}\n');
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(legacy + MIGRATED_SUFFIX, "utf8")).toBe('{"from":"legacy"}\n');
    expect(permissionBits(targetConfigFile(root))).toBe(0o600);
  });

  it("无旧有新：一个字节都不动（判据：重跑常态，归档标记也不凭空出现）", async () => {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(targetConfigFile(root), "already-migrated\n", "utf8");

    await runUpgradeChain(deps());

    expect(readFileSync(targetConfigFile(root), "utf8")).toBe("already-migrated\n");
    expect(readdirSync(root).filter((n) => n.endsWith(MIGRATED_SUFFIX))).toEqual([]);
  });

  it("都有：只归档旧文件，绝不覆盖目标（判据：用历史盖回现在就是丢用户新改动，改坏必须红）", async () => {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(targetConfigFile(root), "target-newer\n", "utf8");
    writeFileSync(legacyConfigFile(root), '{"legacy":true}\n', "utf8");

    await runUpgradeChain(deps());

    expect(readFileSync(targetConfigFile(root), "utf8")).toBe("target-newer\n");
    expect(readFileSync(legacyConfigFile(root) + MIGRATED_SUFFIX, "utf8")).toBe(
      '{"legacy":true}\n',
    );
  });

  it("都没有：写版本化空形（判据：裸{}会被读面当缺版本历史文件，改坏必须红）", async () => {
    await runUpgradeChain(deps());

    const config = JSON.parse(readFileSync(targetConfigFile(root), "utf8")) as Record<
      string,
      unknown
    >;
    expect(config.version).toBe(1);
    const lastRun = JSON.parse(readFileSync(targetLastRunFile(root), "utf8")) as Record<
      string,
      unknown
    >;
    expect(lastRun.schema).toBe(LAST_RUN_SCHEMA);
  });

  it("坏内容不解析：旧文件逐字搬运（判据：JSON.parse 一次即红，坏文件交给各域容错读面）", async () => {
    const legacy = legacyConfigFile(root);
    writeFileSync(legacy, "not-json{{{\n", "utf8");

    await runUpgradeChain(deps());

    expect(readFileSync(targetConfigFile(root), "utf8")).toBe("not-json{{{\n");
  });
});

describe("幂等三条（S3 验收，各有集成用例）", () => {
  it("1/3 失败不回写刻度：存储搬不动即抛，刻度停在原点，清障后从同一步重跑（判据：先写刻度即下次跳过，改坏必须红）", async () => {
    const legacy = legacyConfigFile(root);
    mkdirSync(legacy, { recursive: true });

    await expect(runUpgradeChain(deps())).rejects.toThrow("存储升级到 0.2.3 失败");
    expect(existsSync(upgradeVersionFile(root))).toBe(false);
    expect(existsSync(targetConfigFile(root))).toBe(false);

    rmSync(legacy, { recursive: true, force: true });
    writeFileSync(legacy, '{"legacy":true}\n', "utf8");
    await runUpgradeChain(deps());
    expect(await readStoredVersion(root)).toBe(newestTarget());
  });

  it("2/3 已存在不覆盖：刻度已到目标的存储不再重跑（判据：恒跑也绿，旧文件仍在原地才是未跑证据，改坏必须红）", async () => {
    const { writeStoredVersion } = await import("../../../src/server/upgrade/version.ts");
    await writeStoredVersion(root, "0.2.5");
    const legacy = legacyConfigFile(root);
    writeFileSync(legacy, '{"legacy":true}\n', "utf8");

    await runUpgradeChain(deps());

    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(legacy + MIGRATED_SUFFIX)).toBe(false);
  });

  it("3/3 坏文件容错读：配置 JSON 损坏保持原状 + 诊断，不抛（判据：抛即崩，改坏必须红）", async () => {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(targetConfigFile(root), "bad-json{{{\n", "utf8");
    const logger = makeLogger();

    await migrateReportConfig(deps({ logger }));

    expect(readFileSync(targetConfigFile(root), "utf8")).toBe("bad-json{{{\n");
    expect(logger.warns.join("\n")).toContain("损坏");
  });

  it("3/3 坏文件容错读：last-run JSON 损坏保持原状 + 诊断（判据同上）", async () => {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(targetLastRunFile(root), "bad{{{\n", "utf8");
    const logger = makeLogger();

    await migrateLastRun(deps({ logger }));

    expect(readFileSync(targetLastRunFile(root), "utf8")).toBe("bad{{{\n");
    expect(logger.warns.join("\n")).toContain("损坏");
  });
});

describe("配置形态割接：LEGACY 映射表复用", () => {
  it("旧单一默认模板统一升级为三份新默认（判据：单答案，改坏必须红）", async () => {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(
      targetConfigFile(root),
      JSON.stringify({ promptTemplate: LEGACY_PROMPT_TEMPLATE }),
      "utf8",
    );

    await migrateReportConfig(deps());

    const next = JSON.parse(readFileSync(targetConfigFile(root), "utf8")) as {
      prompts: unknown;
      promptTemplate: unknown;
    };
    expect(next.prompts).toEqual(DEFAULT_PROMPTS);
    expect(next.promptTemplate).toBe(DEFAULT_PROMPTS.monthly);
  });

  it("自定义旧单模板三周期均以该文本起始（判据：用户文本不丢，改坏必须红）", async () => {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(
      targetConfigFile(root),
      JSON.stringify({ promptTemplate: "我的自定义模板 {stats}" }),
      "utf8",
    );

    await migrateReportConfig(deps());

    const next = JSON.parse(readFileSync(targetConfigFile(root), "utf8")) as {
      prompts: Record<string, string>;
    };
    expect(next.prompts).toEqual({
      daily: "我的自定义模板 {stats}",
      weekly: "我的自定义模板 {stats}",
      monthly: "我的自定义模板 {stats}",
    });
  });

  it("旧三周期模板命中即回退当期默认（判据：平滑升级不丢形态，改坏必须红）", async () => {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(
      targetConfigFile(root),
      JSON.stringify({
        prompts: {
          daily: LEGACY_DAILY_PROMPT_V1,
          weekly: LEGACY_WEEKLY_PROMPT_V1,
          monthly: LEGACY_MONTHLY_PROMPT_V1,
        },
      }),
      "utf8",
    );

    await migrateReportConfig(deps());

    const next = JSON.parse(readFileSync(targetConfigFile(root), "utf8")) as { prompts: unknown };
    expect(next.prompts).toEqual(DEFAULT_PROMPTS);
  });

  it("已是新形态即无改写（判据：幂等，重跑不碰 mtime 内容，改坏必须红）", async () => {
    mkdirSync(join(root, "reports"), { recursive: true });
    const body =
      JSON.stringify(
        { prompts: DEFAULT_PROMPTS, promptTemplate: DEFAULT_PROMPTS.monthly },
        null,
        2,
      ) + "\n";
    writeFileSync(targetConfigFile(root), body, "utf8");
    const before = readFileSync(targetConfigFile(root), "utf8");

    await migrateReportConfig(deps());

    expect(readFileSync(targetConfigFile(root), "utf8")).toBe(before);
  });
});

describe("last-run 迁移：derive/align 纯函数复用", () => {
  function indexLine(period: string, key: string, endDay: string, daysAfter: number): string {
    const generatedAt = new Date(endDay + "T12:00:00").getTime() + daysAfter * 86400000;
    return JSON.stringify({
      period,
      key,
      startDay: endDay,
      endDay,
      provider: "p",
      model: "m",
      generatedAt,
      durationMs: 1,
      ok: true,
    });
  }

  it("schema 旧 → 全量重算（判据：旧语义污染键被修复，改坏必须红）", async () => {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(
      targetLastRunFile(root),
      JSON.stringify({ daily: "2026-01-01", schema: 1 }),
      "utf8",
    );
    writeFileSync(
      join(root, "reports", "index.jsonl"),
      indexLine("daily", "2026-01-13", "2026-01-13", 1) + "\n",
      "utf8",
    );

    await migrateLastRun(deps());

    const after = JSON.parse(readFileSync(targetLastRunFile(root), "utf8")) as Record<
      string,
      unknown
    >;
    expect(after.daily).toBe("2026-01-13");
    expect(after.schema).toBe(LAST_RUN_SCHEMA);
  });

  it("无 index 视作无事实不动（判据：不动 lastRun，改坏必须红）", async () => {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(
      targetLastRunFile(root),
      JSON.stringify({ daily: "2026-01-13", schema: 2 }),
      "utf8",
    );

    await migrateLastRun(deps());

    const after = JSON.parse(readFileSync(targetLastRunFile(root), "utf8")) as Record<
      string,
      unknown
    >;
    expect(after.daily).toBe("2026-01-13");
  });

  it("首次启用预置键在无闭环记录时保留（判据：全量重算会删预置键导致立即补跑，改坏必须红）", async () => {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(
      targetLastRunFile(root),
      JSON.stringify({ daily: "2026-01-13", schema: 2 }),
      "utf8",
    );
    writeFileSync(join(root, "reports", "index.jsonl"), "", "utf8");

    await migrateLastRun(deps());

    const after = JSON.parse(readFileSync(targetLastRunFile(root), "utf8")) as Record<
      string,
      unknown
    >;
    expect(after.daily).toBe("2026-01-13");
  });
});

describe("刻度读侧：空白刻度按起点起算", () => {
  it("刻度文件只有空白 → 读回 0.0.0（空串不是合法刻度），改坏必须红", async () => {
    writeFileSync(upgradeVersionFile(root), " \n\t\n", "utf8");

    expect(await readStoredVersion(root)).toBe("0.0.0");
  });
});

describe("装配顺序：迁移在读存储的域之前跑完", () => {
  it("await 门面返回后刻度落到本包最后一步且初始形态已落定（判据：不等待即各域读旧形态，改序必须红）", async () => {
    await installUpgrade(deps());
    expect(await readStoredVersion(root)).toBe(newestTarget());
    expect(existsSync(targetConfigFile(root))).toBe(true);
    expect(basename(root).length).toBeGreaterThan(0);
  });
});
