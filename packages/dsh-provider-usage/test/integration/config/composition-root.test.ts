/**
 * dsh-provider-usage — integration：组合根三纪律（#768 计划表 rev2 D1 验收）。
 *
 * 白盒直连 src（读装配源码文本 + 经 server/config 门面活装配），落盘一律进
 * mkdtemp 隔离目录（产物零污染）。三纪律：
 * - D1① 经域门面装配：ReportConfigService 与读面只经 server/config/interface.ts，
 *   不直连域实现文件（shape/prompts/normalize/store/service），不走旧 schedule 入口；
 * - D1② 根内无业务判断：apply/ 装配逻辑内不得出现归一化调用、默认值、旧词、
 *   周期字段判断（initial 经 readReportConfig 解析是装配，不算判断——见 D1③）；
 * - D1③ 构造只递 root+initial+onUpdate：三参可完成装配
 *   （内存权威 + 串行写链 + 落盘 roundtrip；实参键集文本形态锁已迁
 *   gate/verify-provider-usage-shape.mjs，本文件仅保留行为锁+探针）。
 *
 * 扫描面 = src/apply/apply.ts（装配逻辑；#768 D13 删空锚点 src/apply/interface.ts：
 * 原唯一源码消费 D11 起改走 server/report-routes/deps.ts 窄口，模块归属随锚点消除）；
 * src/apply/index.ts 是 lib 导出面（符号转发），不是判断——它的符号集由
 * export-surface-snapshot 门禁锁定，不在本用例扫描面内（误扫即把转发当判断）。
 *
 * 每条附判据句（把 X 改坏必须红）；红证明见同文件「探针：脏输入必被 flag」——
 * 同一 detector 在脏夹具上必须报出违规（detector 失明则探针先红）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ReportConfigService,
  normalizeReportConfig,
} from "../../../src/server/config/interface.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const applySrc = readFileSync(join(srcDir, "apply", "apply.ts"), "utf8");
// #768 D13：空锚点 src/apply/interface.ts 已删，扫描面只剩 apply.ts（本文件不再读该路径）。

/** 抽取组合根 new ReportConfigService({ ... }) 的实参键集（非对象字面量返回 null）。 */
function serviceCtorKeys(src: string): string[] | null {
  const m = /new ReportConfigService\(\{([^}]*)\}\)/.exec(src);
  if (m === null) return null;
  return m[1]
    .split(",")
    .map((p) => p.split(":")[0].trim())
    .filter((k) => k.length > 0)
    .sort();
}

/** 根内禁入业务判断标记：判据 = 任一标记进入 apply.ts 即红（#768 D13 起 interface.ts 锚点已删）。 */
const BUSINESS_MARKERS: Array<{ marker: string; why: string }> = [
  { marker: "normalizeReportConfig(", why: "归一化调用归 config 域，组合根只传 initial" },
  { marker: "normalizeReportDirectories(", why: "目录范围归一化同上" },
  { marker: "normalizePrompt", why: "单模板归一化同上" },
  { marker: "normalizePeriod", why: "周期归一化同上" },
  { marker: "migrateLegacyPrompt", why: "旧模板迁移同上" },
  { marker: "legacyPromptOf", why: "旧模板提取同上" },
  { marker: "isLegacySingleDefault", why: "旧默认判定归迁移域" },
  { marker: "LEGACY_", why: "旧词锁表只活在 config 域 prompts.ts 与迁移域比较式内" },
  { marker: "DEFAULT_PROMPT", why: "默认模板归 config 域" },
  { marker: "DEFAULT_REPORT_CONFIG", why: "缺省配置归 config 域" },
  { marker: "weekStartsOn", why: "周期字段判断归归一化" },
  { marker: "dayOfMonth", why: "周期字段判断归归一化" },
  {
    marker: "promptTemplate",
    why: "模板字段判断归归一化（initial 整体透传除外——本标记扫到即说明动了字段）",
  },
  { marker: "parseHHMM(", why: "时刻解析归归一化" },
  { marker: "sanitizePaths", why: "脱敏开关已移除，根内不得复活" },
  { marker: "promptsSrc", why: "三周期表拆解归归一化" },
];

/** 装配面禁直连：判据 = 任一实现路径进入组合根 import 即红。 */
const FORBIDDEN_FACES = [
  "server/config/shape",
  "server/config/prompts",
  "server/config/normalize",
  "server/config/store",
  "server/config/service",
  "schedule/config",
  "report-config-service",
];

describe("D1③ 构造只递 root+initial+onUpdate", () => {
  it("三参可装配：内存权威 + 串行写链 + 落盘 roundtrip（mkdtemp 隔离）", async () => {
    const root = mkdtempSync(join(tmpdir(), "d1-comproot-"));
    try {
      const seen: string[] = [];
      const svc = new ReportConfigService({
        root,
        initial: normalizeReportConfig({}),
        onUpdate: (c) => seen.push(c.daily.time),
      });
      expect(svc.get().daily.time).toBe("08:00");
      await Promise.all([
        svc.update(normalizeReportConfig({ daily: { enabled: true, time: "09:00" } })),
        svc.update(normalizeReportConfig({ daily: { enabled: true, time: "18:00" } })),
      ]);
      expect(svc.get().daily.time).toBe("18:00");
      expect(seen).toEqual(["09:00", "18:00"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("D1② 根内无业务判断（必须红）", () => {
  for (const { marker, why } of BUSINESS_MARKERS) {
    it("apply.ts 无 " + marker + "（" + why + "）", () => {
      expect(applySrc.includes(marker)).toBe(false);
    });
  }
});

describe("D1① 经 server/config 域门面装配", () => {
  it("服务与读面经同一门面进入（分头 import 即红）", () => {
    expect(
      /import \{[^}]*ReportConfigService[^}]*readReportConfig[^}]*\} from "\.\.\/server\/config\/interface\.ts"/.test(
        applySrc,
      ),
    ).toBe(true);
  });

  for (const face of FORBIDDEN_FACES) {
    it("组合根不直连 " + face, () => {
      expect(applySrc.includes(face)).toBe(false);
    });
  }
});

describe("探针：脏输入必被 flag（detector 失明则本段先红）", () => {
  it("多递一参即被 flag", () => {
    const dirty = "const s = new ReportConfigService({ root, initial, onUpdate, scheduler });";
    expect(serviceCtorKeys(dirty)).not.toEqual(["initial", "onUpdate", "root"]);
  });

  it("根内归一化调用即被 flag", () => {
    const dirty = "const cfg = normalizeReportConfig(raw);";
    expect(BUSINESS_MARKERS.some((b) => dirty.includes(b.marker))).toBe(true);
  });

  it("根内旧词即被 flag", () => {
    const dirty = "if (t === LEGACY_DAILY_PROMPT_V1) return d;";
    expect(BUSINESS_MARKERS.some((b) => dirty.includes(b.marker))).toBe(true);
  });

  it("直连实现文件即被 flag", () => {
    const dirty = 'import { ReportConfigService } from "./report-config-service.ts";';
    expect(FORBIDDEN_FACES.some((f) => dirty.includes(f))).toBe(true);
  });

  it("真实装配文本注入一行业务判断即被 flag（免洗 repo）", () => {
    const injected = applySrc + "\nconst cfg = normalizeReportConfig(raw);\n";
    expect(BUSINESS_MARKERS.filter((b) => injected.includes(b.marker))).toEqual([
      BUSINESS_MARKERS[0],
    ]);
  });
});
