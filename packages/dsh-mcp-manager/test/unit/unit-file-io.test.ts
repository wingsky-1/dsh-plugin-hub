/**
 * dsh-mcp-manager — unit：落盘原语（mode 登记表 + 原子写 + 容错读）。
 *
 * 这里全部走真实文件系统；**同路径串行**的判据在 unit-file-io-queue.test.ts——它要控住
 * writeFile 的一拍才能稳定区分「有队列」与「没队列」。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_LAYOUT,
  PACKAGE_DIR_MODE,
  catalogDir,
  catalogFile,
  catalogSummaryFile,
  configFile,
  directoryMode,
  ensureDir,
  fileMode,
  legacyFile,
  legacyProjectConfigFile,
  mcpManagerHome,
  projectConfigFile,
  readJsonFile,
  readTextFile,
  statsFile,
  userStatePath,
  versionFile,
  writeFileAtomic,
} from "../../src/server/shared/interface.ts";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dsh-mcp-io-"));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

/** statSync 的 mode 含文件类型位，逐次取权限位。 */
function permissionBits(path: string): number {
  return statSync(path).mode & 0o777;
}

/** 目录里残留的临时名（写失败必须清干净）。 */
function temporaryNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".tmp"));
}

describe("布局登记（新路径 / 旧路径）", () => {
  it("新路径全部落在插件私有目录下", () => {
    expect(mcpManagerHome()).toBe(join(home, "@wingsky-1", "dsh-mcp-manager"));
    expect(configFile()).toBe(join(mcpManagerHome(), "mcp.json"));
    expect(userStatePath()).toBe(join(mcpManagerHome(), "user-state.json"));
    expect(catalogSummaryFile()).toBe(join(mcpManagerHome(), "catalog-summary.json"));
    expect(statsFile()).toBe(join(mcpManagerHome(), "stats.json"));
    expect(versionFile()).toBe(join(mcpManagerHome(), "version"));
    expect(catalogFile("h")).toBe(join(catalogDir(), "h.json"));
    expect(PACKAGE_DIR_MODE).toBe(0o700);
  });

  it("两条旧路径显式登记（可再生落点不进迁移面，故 LEGACY 只剩用户数据）", () => {
    expect(legacyFile(LEGACY_LAYOUT.config)).toBe(join(home, "dsh-mcp.json"));
    expect(legacyFile(LEGACY_LAYOUT.userState)).toBe(join(home, "dsh-mcp-user-state.json"));
    expect(Object.values(LEGACY_LAYOUT).sort()).toEqual(
      ["dsh-mcp-user-state.json", "dsh-mcp.json"].sort(),
    );
  });

  it("项目级新旧形态：新形态按包分区，旧扁平形态只做迁移读面", () => {
    const root = join(home, "proj");
    expect(projectConfigFile(root)).toBe(
      join(root, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json"),
    );
    expect(legacyProjectConfigFile(root)).toBe(join(root, ".dsh", "mcp.json"));
  });

  it("旧路径只读：写函数拒绝回写旧布局", async () => {
    await expect(writeFileAtomic(legacyFile(LEGACY_LAYOUT.config), "{}")).rejects.toThrow(/未登记/);
    // 项目级旧扁平形态同样只读：isProjectConfigFile 只认包分区新形态。
    await expect(
      writeFileAtomic(legacyProjectConfigFile(join(home, "proj")), "{}"),
    ).rejects.toThrow(/未登记/);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("mode 登记表经写函数生效", () => {
  it("mcp.json 是 0o600", async () => {
    await writeFileAtomic(configFile(), '{"version":1}\n');
    expect(permissionBits(configFile())).toBe(0o600);
  });

  it("其余登记文件都是 0o644（含 catalog/<hash>.json 多个落点）", async () => {
    const byName = new Map([
      ["user-state.json", userStatePath()],
      ["catalog-summary.json", catalogSummaryFile()],
      ["stats.json", statsFile()],
      ["version", versionFile()],
      ["catalog/<hash>.json (a)", catalogFile("a".repeat(16))],
      ["catalog/<hash>.json (b)", catalogFile("b".repeat(16))],
    ]);
    for (const target of byName.values()) await writeFileAtomic(target, "x");
    for (const [name, target] of byName) {
      expect([name, permissionBits(target)]).toEqual([name, 0o644]);
    }
  });

  it("写函数自建插件自有目录，目录 0o700", async () => {
    await writeFileAtomic(catalogFile("c".repeat(16)), "x");
    expect(permissionBits(mcpManagerHome())).toBe(0o700);
    expect(permissionBits(catalogDir())).toBe(0o700);
  });

  // 逐行确认：经 helper 取目标（自动跟随包分区新形态）；mode 口径 null 不变——
  // 叶子包分区目录走 directoryMode 新分支，中间级由 mkdir recursive 建。
  it("ensureDir 对项目 .dsh/ 与包分区叶子目录不套插件档位（随项目）", async () => {
    const projectRoot = join(home, "proj");
    mkdirSync(projectRoot, { recursive: true });
    await writeFileAtomic(projectConfigFile(projectRoot), "{}\n");
    expect(await readTextFile(projectConfigFile(projectRoot))).toBe("{}\n");
    expect(permissionBits(projectConfigFile(projectRoot))).toBe(0o666 & ~process.umask());
  });
});

describe("未登记路径不写（不静默降级）", () => {
  it("fileMode 对未登记文件抛错", () => {
    expect(() => fileMode(join(home, "rogue.json"))).toThrow(/未登记/);
  });

  it("directoryMode 对未登记目录抛错", () => {
    expect(() => directoryMode(join(home, "elsewhere"))).toThrow(/未登记/);
  });

  it("writeFileAtomic 在落盘前就抛错，磁盘上不留任何东西", async () => {
    await expect(writeFileAtomic(join(home, "rogue.json"), "x")).rejects.toThrow(/未登记/);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("写失败清理临时名并上抛原错误", () => {
  it("目标是目录（rename 必失败）时不残留 *.tmp", async () => {
    mkdirSync(configFile(), { recursive: true });
    await expect(writeFileAtomic(configFile(), "x")).rejects.toMatchObject({ code: "EISDIR" });
    expect(temporaryNames(mcpManagerHome())).toEqual([]);
    expect(statSync(configFile()).isDirectory()).toBe(true);
  });
});

describe("同路径写链", () => {
  it("前一次写失败不毒化链：恢复目标后同路径写仍成功", async () => {
    mkdirSync(configFile(), { recursive: true });
    await expect(writeFileAtomic(configFile(), "first")).rejects.toMatchObject({ code: "EISDIR" });
    rmSync(configFile(), { recursive: true, force: true });
    await writeFileAtomic(configFile(), "second");
    expect(await readTextFile(configFile())).toBe("second");
  });
});

describe("容错读", () => {
  it("文件不存在回落 null，不抛", async () => {
    expect(await readTextFile(configFile())).toBeNull();
    expect(await readJsonFile(configFile())).toBeNull();
  });

  it("目录（不是文件）同样回落 null", async () => {
    await ensureDir(catalogDir());
    expect(await readTextFile(catalogDir())).toBeNull();
    expect(await readJsonFile(catalogDir())).toBeNull();
  });

  it("坏 JSON 回落 null，原文仍可读回", async () => {
    await writeFileAtomic(configFile(), "{ 坏");
    expect(await readJsonFile(configFile())).toBeNull();
    expect(await readTextFile(configFile())).toBe("{ 坏");
  });

  it("合法 JSON 原样读回", async () => {
    await writeFileAtomic(statsFile(), JSON.stringify({ version: 1, calls: 3 }));
    expect(await readJsonFile(statsFile())).toEqual({ version: 1, calls: 3 });
  });
});
