/**
 * dsh-provider-usage — integration：历史域组合根三维度（#768 计划表 rev2 D5 验收）。
 *
 * 白盒直连 src（读装配源码文本 + 经 server/history 门面活装配）；落盘一律进
 * mkdtempSync 隔离目录（afterAll 还原 DSH_HOME 并删目录，产物零污染）。三维度：
 * - D5一 经 server/history 域门面装配：HistoryStore 一族只经
 *   server/history/interface.ts，不走旧 domain1/history 入口；apply/apply.ts、
 *   apply/index.ts、server/pipeline/* 的历史消费收口新门面；门面禁整文件
 *   re-export；包导出面（apply/index.ts 转发名）收窄后集合（B波+A2波）。
 * - D5二 落盘时序 + 0600 + basename + 超龄清理：DSH_HOME 先于被测门面求值
 *   （动态 import 前指到隔离目录）；落盘文件 0600；恶意 provider/name
 *   段（../、分隔符）经 safeSegment 收敛不出隔离根；pruneAll 删过期留当期。
 * - D5三 门面最小面 + 原子写：门面值出口恰为 6 项（多一项即公共面膨胀）；
 *   同日并发 writeDirect 经门面实例串行、后写完整胜出且无 .tmp 残留。
 *
 * 落盘时序验收（判据原文）：先设 DSH_HOME 后 import，时序反了必须红。
 * 本文件把时序钉死在两处：① probeBeforeImport 在 import 语句正上方取值并断言
 * 等于隔离目录——把设 env 行挪到 import 之后，哨兵单跑即红（scratch 反转版
 * 已实证 1 failed）；② history.ts 文本禁 dshHome/process.env 已迁
 * gate/verify-provider-usage-shape.mjs（落盘根只经构造注入，模块求值期不读环境）。
 * 每条附判据句（把 X 改坏必须红）；文本哨兵仅锚真实 ABI 与装配关系，不做风格断言。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { containsAny, hasExportStar } from "../../helpers.ts";
import { dshHome } from "../../../../../shared/dsh-home.js";

// 落盘时序：先设 DSH_HOME，后 import 被测门面。dsh-home.js 本体是纯函数面
// （调用期读 env），静态导入它早晚无差；被测门面的求值必须发生在 env 就绪之后。
const homeDir = mkdtempSync(join(tmpdir(), "dou-histD5-"));
const savedDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = homeDir;
// 时序哨兵：紧贴 import 取值——挪序（设 env 落到 import 之后）即红，单跑连跑皆红。
const probeBeforeImport = process.env.DSH_HOME;
const historyApi = await import("../../../src/server/history/interface.ts");
const historyImpl = await import("../../../src/server/history/history.ts");

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const pkgDir = join(here, "..", "..", "..");
const repoRoot = join(here, "..", "..", "..", "..", "..");
const applySrc = readFileSync(join(srcDir, "apply", "apply.ts"), "utf8");
const applyFaceSrc = readFileSync(join(srcDir, "apply", "index.ts"), "utf8");
const statsServiceSrc = readFileSync(
  join(srcDir, "server", "pipeline", "stats-service.ts"),
  "utf8",
);
const pipelineV2Src = readFileSync(join(srcDir, "server", "pipeline", "v2.ts"), "utf8");
const historyFaceSrc = readFileSync(join(srcDir, "server", "history", "interface.ts"), "utf8");
const statsServiceTestSrc = readFileSync(
  join(pkgDir, "test", "unit", "pipeline", "unit-stats-service.test.ts"),
  "utf8",
);
const topologySrc = readFileSync(
  join(repoRoot, "scripts", "data", "mutation-topology.json"),
  "utf8",
);

afterAll(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  rmSync(homeDir, { recursive: true, force: true });
});

/** 旧门面判据：任一旧 domain1/history 引用残留即红（针脚为域事实，命中循环见 helpers）。 */
function usesOldFace(src: string): boolean {
  return containsAny(src, ["domain1/history"]);
}

describe("探针：脏输入必被 flag（detector 失明则本段先红）", () => {
  it("旧门面 detector 对脏输入有效", () => {
    expect(usesOldFace('import { x } from "../domain1/history/interface.ts"')).toBe(true);
    expect(usesOldFace('import { x } from "../server/history/interface.ts"')).toBe(false);
  });

  it("export * detector 对脏输入有效", () => {
    expect(hasExportStar(['export * from "./history.ts"'])).toBe(true);
    expect(hasExportStar(['// export * from "./history.ts"'])).toBe(false);
  });
});

describe("D5一 经 server/history 域门面装配", () => {
  it("组合根只经新门面取引史（旧入口残留必须红）", () => {
    expect(usesOldFace(applySrc)).toBe(false);
    expect(usesOldFace(applyFaceSrc)).toBe(false);
    expect(usesOldFace(statsServiceSrc)).toBe(false);
    expect(usesOldFace(pipelineV2Src)).toBe(false);
    expect(usesOldFace(statsServiceTestSrc)).toBe(false);
    expect(applySrc.includes("server/history/interface")).toBe(true);
    expect(applyFaceSrc.includes("server/history/interface")).toBe(true);
  });

  it("门面收口：interface 与实现同一引用（包装即红）", () => {
    expect(historyApi.HistoryStore).toBe(historyImpl.HistoryStore);
    expect(historyApi.parseJsonl).toBe(historyImpl.parseJsonl);
    expect(historyApi.startOfDay).toBe(historyImpl.startOfDay);
    expect(historyApi.migrateLegacyV3).toBe(historyImpl.migrateLegacyV3);
    expect(historyApi.legacySampleToData).toBe(historyImpl.legacySampleToData);
    expect(historyApi.listAdapters).toBe(historyImpl.listAdapters);
  });

  it("门面禁整文件 re-export（加星导出即红）", () => {
    const codeLines = historyFaceSrc
      .split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith("*"));
    expect(hasExportStar(codeLines)).toBe(false);
  });

  it("变异面登记随域改址（旧路径残留即红）", () => {
    expect(topologySrc.includes("src/domain1/history/history.ts")).toBe(false);
    expect(topologySrc.includes("src/server/history/history.ts")).toBe(true);
  });
});

describe("D5二 落盘时序 + 0600 + basename + 超龄清理", () => {
  it("时序哨兵：import 前 DSH_HOME 已指隔离目录（挪序即红）", () => {
    expect(probeBeforeImport).toBe(homeDir);
    expect(dshHome()).toBe(homeDir);
  });

  it("落盘进隔离目录且文件 0600（权限放宽即红）", async () => {
    const root = join(dshHome(), "dsh-provider-usage");
    const store = new historyApi.HistoryStore({ root });
    const ts = new Date().setHours(12, 0, 0, 0);
    await store.append("p", "n", { time: ts, data: { v: 1 } });
    const dayFile = readdirSync(join(root, "p", "n")).filter((f) => f.endsWith(".jsonl"))[0];
    expect(dayFile !== undefined).toBe(true);
    expect(statSync(join(root, "p", "n", dayFile)).mode & 0o777).toBe(0o600);
    const back = await store.query("p", "n", { start: ts - 1000, end: ts + 1000 });
    expect(back.entries.length).toBe(1);
  });

  it("恶意段不出隔离根（basename 收敛，穿透即红）", async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-histD5-evil-"));
    try {
      const store = new historyApi.HistoryStore({ root });
      const ts = new Date().setHours(12, 0, 0, 0);
      await store.append("..", "..", { time: ts, data: { v: 1 } });
      await store.append("a/b", "c\\d", { time: ts, data: { v: 2 } });
      await store.append("..\\..", "x", { time: ts, data: { v: 3 } });
      // `..` 收敛 unknown；`..\..` 的分隔符转下划线后为 `.._..`（非 `.`/`..`，保留）
      expect(readdirSync(root).sort()).toEqual([".._..", "a_b", "unknown"]);
      // 收敛位置经原键可回读（数据进了隔离根内的净化位，而非根外）
      const back = await store.query("..", "..", { start: ts - 1000, end: ts + 1000 });
      expect(back.entries.map((e) => e.data.v)).toEqual([1]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("超龄清理：pruneAll 删过期留当期（误删/漏删即红）", async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-histD5-prune-"));
    try {
      const store = new historyApi.HistoryStore({ root, maxAgeMs: 86400000 });
      const now = Date.now();
      await store.append("p", "n", { time: now, data: { fresh: true } });
      const oldDay = new Date(now - 3 * 86400000);
      const oldName = `${oldDay.getFullYear()}-${String(oldDay.getMonth() + 1).padStart(2, "0")}-${String(oldDay.getDate()).padStart(2, "0")}.jsonl`;
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(join(root, "p", "n"), { recursive: true });
      await writeFile(join(root, "p", "n", oldName), '{"time":1,"data":{}}\n', "utf8");
      await store.pruneAll();
      const files = readdirSync(join(root, "p", "n"));
      expect(files.includes(oldName)).toBe(false);
      expect(files.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("D5三 门面最小面 + 原子写", () => {
  it("门面值出口恰为 6 项（多一项即公共面膨胀）", () => {
    const keys = Object.keys(historyApi).sort();
    expect(keys).toEqual(
      [
        "HistoryStore",
        "legacySampleToData",
        "listAdapters",
        "migrateLegacyV3",
        "parseJsonl",
        "startOfDay",
      ].sort(),
    );
  });

  it("同日并发 writeDirect 经门面串行：后写完整胜出且无 .tmp 残留", async () => {
    const root = mkdtempSync(join(tmpdir(), "dou-histD5-atomic-"));
    try {
      const store = new historyApi.HistoryStore({ root });
      const day = new Date().setHours(12, 0, 0, 0);
      await Promise.all([
        store.writeDirect("p", "n", day, [{ time: day, data: { w: 1 } }]),
        store.writeDirect("p", "n", day, [{ time: day, data: { w: 2 } }]),
      ]);
      const dir = join(root, "p", "n");
      const files = readdirSync(dir);
      expect(files.filter((f) => f.endsWith(".tmp")).length).toBe(0);
      const jsonl = files.filter((f) => f.endsWith(".jsonl"));
      expect(jsonl.length).toBe(1);
      const back = await store.readDay("p", "n", day);
      expect(back).toEqual([{ time: day, data: { w: 2 } }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
