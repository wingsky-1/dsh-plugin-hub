/**
 * dsh-mcp-manager upgrade 域 steps 块 —— 存储布局归位（本次迁移唯一的一步，也是唯一动用户数据的一步）。
 *
 * 判据面：搬错的表现是静默丢数据——配置读空、状态表回默认、旧文件留在 home 根目录，而用户只会看到
 * 「服务器列表没了」。故逐条锁四态（有旧无新 / 无旧有新 / 都有 / 都没有）与四个不可放宽的点：
 * **不覆盖目标**（用户可能已经在新位置改过东西）、**不解析内容**（坏文件交给各域容错读面）、
 * **目录型旧路径逐文件过写函数**（整目录 rename 会让目标权限绕过 mode 表）、**旧文件 IO 失败即抛**
 * （搬不动不能被当成「没有旧数据」）。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_LAYOUT,
  catalogDir,
  catalogFile,
  catalogSummaryFile,
  configFile,
  legacyCatalogFile,
  legacyFile,
  statsFile,
  userStatePath,
  writeFileAtomic,
} from "../../../src/server/shared/interface.ts";
import type { UpgradeDeps } from "../../../src/server/upgrade/deps.ts";
import { migrateStorageLayout } from "../../../src/server/upgrade/impl/steps/storage-layout.ts";
import { makeLogger, tempDshHome } from "../../helpers.ts";

/** 归档后缀：与实现同名的固定标记（判据要的是「重跑不累积」，故名字必须与实现一致地固定）。 */
const MIGRATED_SUFFIX = ".migrated.bak";

/** 单文件布局项：labels 数组的每一项都是「旧文件名 → 目标路径」的一行。 */
interface FileEntry {
  readonly label: string;
  readonly legacy: string;
  readonly target: string;
  readonly initial: Record<string, unknown>;
  /** 目标文件的登记 mode（§7.1 的 mode 表）。 */
  readonly mode: number;
}

let home: string;
let disposeHome: () => void;

beforeEach(() => {
  const isolated = tempDshHome();
  home = isolated.dir;
  disposeHome = isolated.dispose;
});

afterEach(() => {
  disposeHome();
});

/** 路径必须在 DSH_HOME 打桩**之后**取：`paths.ts` 的每个函数都在调用时解析根目录。 */
function fileEntries(): FileEntry[] {
  return [
    {
      label: "全局配置",
      legacy: legacyFile(LEGACY_LAYOUT.config),
      target: configFile(),
      initial: { version: 1, servers: [] },
      mode: 0o600,
    },
    {
      label: "用户状态",
      legacy: legacyFile(LEGACY_LAYOUT.userState),
      target: userStatePath(),
      initial: { version: 1, disabled: {} },
      mode: 0o644,
    },
    {
      label: "目录摘要",
      legacy: legacyFile(LEGACY_LAYOUT.catalogSummary),
      target: catalogSummaryFile(),
      initial: {},
      mode: 0o644,
    },
    {
      label: "调用统计",
      legacy: legacyFile(LEGACY_LAYOUT.stats),
      target: statsFile(),
      initial: {},
      mode: 0o644,
    },
  ];
}

/** 装配入参：默认未显式接管任何路径；需要断言诊断时把 logger 传进来自己持有。 */
function deps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return { logger: makeLogger(), storePath: "", statsFile: "", ...overrides };
}

/** statSync 的 mode 含文件类型位，逐次取权限位。 */
function permissionBits(path: string): number {
  return statSync(path).mode & 0o777;
}

/** 目录里已归档的名字（幂等判据：每个源文件只该有一个固定后缀的归档）。 */
function bakNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(MIGRATED_SUFFIX))
    .sort();
}

/** 一份有代表性的旧文件内容（逐字保留判据用它，不解析）。 */
function legacyText(label: string): string {
  return `{"from":"${label}"}\n`;
}

describe("单文件四态", () => {
  it("有旧无新：内容逐字搬到目标、旧文件改名留痕、mode 取自登记表", async () => {
    for (const entry of fileEntries()) writeFileSync(entry.legacy, legacyText(entry.label), "utf8");

    await migrateStorageLayout(deps());

    for (const entry of fileEntries()) {
      expect([entry.label, readFileSync(entry.target, "utf8")]).toEqual([
        entry.label,
        legacyText(entry.label),
      ]);
      expect([entry.label, permissionBits(entry.target)]).toEqual([entry.label, entry.mode]);
      expect([entry.label, existsSync(entry.legacy)]).toEqual([entry.label, false]);
      expect([entry.label, readFileSync(`${entry.legacy}${MIGRATED_SUFFIX}`, "utf8")]).toEqual([
        entry.label,
        legacyText(entry.label),
      ]);
    }
  });

  it("无旧有新：一个字节都不动（重跑常态，归档标记也不该凭空出现）", async () => {
    for (const entry of fileEntries()) await writeFileAtomic(entry.target, "already-migrated\n");

    await migrateStorageLayout(deps());

    for (const entry of fileEntries()) {
      expect([entry.label, readFileSync(entry.target, "utf8")]).toEqual([
        entry.label,
        "already-migrated\n",
      ]);
    }
    expect(bakNames(home)).toEqual([]);
  });

  it("都有：只归档旧文件，绝不覆盖目标（用历史盖回现在就是丢用户的新改动）", async () => {
    const logger = makeLogger();
    for (const entry of fileEntries()) {
      await writeFileAtomic(entry.target, "target-newer\n");
      writeFileSync(entry.legacy, legacyText(entry.label), "utf8");
      // 目标比旧文件新 = 正常次序：这一步不该出声。
      const newer = Date.now() / 1000;
      utimesSync(entry.target, newer, newer);
      utimesSync(entry.legacy, newer - 60, newer - 60);
    }

    await migrateStorageLayout(deps({ logger }));

    for (const entry of fileEntries()) {
      expect([entry.label, readFileSync(entry.target, "utf8")]).toEqual([
        entry.label,
        "target-newer\n",
      ]);
      expect([entry.label, readFileSync(`${entry.legacy}${MIGRATED_SUFFIX}`, "utf8")]).toEqual([
        entry.label,
        legacyText(entry.label),
      ]);
    }
    expect(logger.warns).toEqual([]);
  });

  it("都没有：写初始空形态——配置是版本化空形而不是裸空对象", async () => {
    await migrateStorageLayout(deps());

    for (const entry of fileEntries()) {
      expect([entry.label, JSON.parse(readFileSync(entry.target, "utf8"))]).toEqual([
        entry.label,
        entry.initial,
      ]);
      expect([entry.label, permissionBits(entry.target)]).toEqual([entry.label, entry.mode]);
    }
    // 插件自有目录与本包最敏感的一档权限：同机其它用户不得列举。
    expect(permissionBits(join(home, "@wingsky-1", "dsh-mcp-manager"))).toBe(0o700);
  });
});

describe("目录型旧路径（逐文件搬，不整目录 rename）", () => {
  it("每个 <hash>.json 落成 catalog/<hash>.json 并经写函数拿到登记 mode，源文件逐文件归档", async () => {
    const legacyDir = legacyFile(LEGACY_LAYOUT.catalogDir);
    // 旧目录权限刻意与目标登记值不同：整目录 rename 会把这份历史权限原样带到新落点。
    mkdirSync(legacyDir, { recursive: true, mode: 0o755 });
    const hashes = ["a".repeat(16), "b".repeat(16)];
    for (const hash of hashes)
      writeFileSync(legacyCatalogFile(hash), `{"hash":"${hash}"}\n`, "utf8");
    // 非 *.json 的文件不在迁移面内（归档产物也不以 .json 结尾，故重跑不会再搬一次）。
    writeFileSync(join(legacyDir, "notes.txt"), "keep\n", "utf8");

    await migrateStorageLayout(deps());

    for (const hash of hashes) {
      expect([hash, readFileSync(catalogFile(hash), "utf8")]).toEqual([
        hash,
        `{"hash":"${hash}"}\n`,
      ]);
      expect([hash, permissionBits(catalogFile(hash))]).toEqual([hash, 0o644]);
      expect([hash, existsSync(legacyCatalogFile(hash))]).toEqual([hash, false]);
      expect([hash, readFileSync(`${legacyCatalogFile(hash)}${MIGRATED_SUFFIX}`, "utf8")]).toEqual([
        hash,
        `{"hash":"${hash}"}\n`,
      ]);
    }
    // 目标目录的 mode 来自 §7.1 的登记表，不是旧目录的历史权限。
    expect(permissionBits(catalogDir())).toBe(0o700);
    // 源目录原地保留（逐文件归档），非 json 文件也没被顺手清掉。
    expect(readdirSync(legacyDir).sort()).toEqual(
      [...hashes.map((hash) => `${hash}.json${MIGRATED_SUFFIX}`), "notes.txt"].sort(),
    );
  });

  it("旧目录不在时也把目标目录落定（目录型落点的初始形态就是它自己）", async () => {
    await migrateStorageLayout(deps());

    expect(existsSync(catalogDir())).toBe(true);
    expect(permissionBits(catalogDir())).toBe(0o700);
    expect(readdirSync(catalogDir())).toEqual([]);
  });

  it("目录里一个 *.json 都没有时不动目标目录里的既有内容", async () => {
    const legacyDir = legacyFile(LEGACY_LAYOUT.catalogDir);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "notes.txt"), "keep\n", "utf8");
    await writeFileAtomic(catalogFile("c".repeat(16)), "existing\n");

    await migrateStorageLayout(deps());

    expect(readFileSync(catalogFile("c".repeat(16)), "utf8")).toBe("existing\n");
    expect(readdirSync(catalogDir())).toEqual([`${"c".repeat(16)}.json`]);
  });
});

describe("幂等：重跑不累积、内容不变", () => {
  it("连跑两次只有一个 .bak，目标内容逐字不变", async () => {
    for (const entry of fileEntries()) writeFileSync(entry.legacy, legacyText(entry.label), "utf8");
    const legacyDir = legacyFile(LEGACY_LAYOUT.catalogDir);
    mkdirSync(legacyDir, { recursive: true });
    const hashes = ["a".repeat(16), "b".repeat(16)];
    for (const hash of hashes)
      writeFileSync(legacyCatalogFile(hash), `{"hash":"${hash}"}\n`, "utf8");

    await migrateStorageLayout(deps());
    const first = fileEntries().map((entry) => readFileSync(entry.target, "utf8"));
    await migrateStorageLayout(deps());

    expect(fileEntries().map((entry) => readFileSync(entry.target, "utf8"))).toEqual(first);
    expect(bakNames(home)).toEqual(
      fileEntries()
        .map((entry) => `${basename(entry.legacy)}${MIGRATED_SUFFIX}`)
        .sort(),
    );
    expect(bakNames(legacyDir)).toEqual(
      hashes.map((hash) => `${hash}.json${MIGRATED_SUFFIX}`).sort(),
    );
    expect(readdirSync(catalogDir()).sort()).toEqual(hashes.map((hash) => `${hash}.json`).sort());
  });
});

describe("失败语义：IO 与权限问题一律抛出，不被当成「没有旧数据」", () => {
  it("旧文件读不出来即抛，且不留下半个目标文件", async () => {
    // 同名目录：路径存在但没有可读内容——「搬不动」不能被当成「没有旧数据」。
    mkdirSync(legacyFile(LEGACY_LAYOUT.config), { recursive: true });

    await expect(migrateStorageLayout(deps())).rejects.toThrow(/旧存储文件不可读/);
    expect(existsSync(configFile())).toBe(false);
  });

  it("旧文件改名失败即抛（归档没成功就不能算这一步做完了）", async () => {
    const legacy = legacyFile(LEGACY_LAYOUT.config);
    writeFileSync(legacy, "{}\n", "utf8");
    // 归档目标被非空目录占住：rename 覆盖不了它。
    mkdirSync(`${legacy}${MIGRATED_SUFFIX}`, { recursive: true });
    writeFileSync(join(`${legacy}${MIGRATED_SUFFIX}`, "占位"), "", "utf8");

    await expect(migrateStorageLayout(deps())).rejects.toThrow(/改名失败/);
  });

  it("目标写不进去即抛（包私有目录的位置被同名文件占住）", async () => {
    mkdirSync(join(home, "@wingsky-1"), { recursive: true });
    writeFileSync(join(home, "@wingsky-1", "dsh-mcp-manager"), "", "utf8");

    await expect(migrateStorageLayout(deps())).rejects.toThrow();
  });
});

describe("内容损坏：迁移不解析内容（纯字节搬移）", () => {
  it("坏 JSON 原样搬到新位置并照常归档，不抛", async () => {
    const broken = "{ 这不是 JSON\n";
    writeFileSync(legacyFile(LEGACY_LAYOUT.config), broken, "utf8");

    await migrateStorageLayout(deps());

    expect(readFileSync(configFile(), "utf8")).toBe(broken);
    expect(readFileSync(`${legacyFile(LEGACY_LAYOUT.config)}${MIGRATED_SUFFIX}`, "utf8")).toBe(
      broken,
    );
  });
});

describe("mtime 只影响文案，不改变动作", () => {
  it("旧文件比目标新时出声提示降级写入，但仍然归档、仍然不覆盖目标", async () => {
    const logger = makeLogger();
    await writeFileAtomic(configFile(), '{"target":1}\n');
    const legacy = legacyFile(LEGACY_LAYOUT.config);
    writeFileSync(legacy, '{"legacy":1}\n', "utf8");
    const now = Date.now() / 1000;
    utimesSync(legacy, now, now);
    utimesSync(configFile(), now - 3600, now - 3600);

    await migrateStorageLayout(deps({ logger }));

    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain("降级写入");
    expect(readFileSync(configFile(), "utf8")).toBe('{"target":1}\n');
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(`${legacy}${MIGRATED_SUFFIX}`, "utf8")).toBe('{"legacy":1}\n');
  });
});

describe("用户显式 storePath / statsFile：整项不动（用户可见契约）", () => {
  it("显式接管的两项不迁移、不归档、不建初始形态，用户那个文件继续读", async () => {
    const userStore = join(home, "custom", "mcp.json");
    const userStats = join(home, "custom", "stats.json");
    mkdirSync(dirname(userStore), { recursive: true });
    writeFileSync(userStore, '{"user":"store"}\n', "utf8");
    writeFileSync(userStats, '{"user":"stats"}\n', "utf8");
    writeFileSync(legacyFile(LEGACY_LAYOUT.config), '{"legacy":"store"}\n', "utf8");
    writeFileSync(legacyFile(LEGACY_LAYOUT.stats), '{"legacy":"stats"}\n', "utf8");

    await migrateStorageLayout(deps({ storePath: userStore, statsFile: userStats }));

    // 用户那个文件一个字节没动，也没有出现它的归档。
    expect(readFileSync(userStore, "utf8")).toBe('{"user":"store"}\n');
    expect(readFileSync(userStats, "utf8")).toBe('{"user":"stats"}\n');
    expect(existsSync(`${userStore}${MIGRATED_SUFFIX}`)).toBe(false);
    // 默认落点整项不动：不建目标、也不归档「不是用户那份数据」的旧文件。
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(statsFile())).toBe(false);
    expect(readFileSync(legacyFile(LEGACY_LAYOUT.config), "utf8")).toBe('{"legacy":"store"}\n');
    expect(readFileSync(legacyFile(LEGACY_LAYOUT.stats), "utf8")).toBe('{"legacy":"stats"}\n');
    // 未被接管的两项照常迁移。
    expect(existsSync(userStatePath())).toBe(true);
    expect(existsSync(catalogSummaryFile())).toBe(true);
  });

  it("显式接管时连初始形态都不建（默认落点保持不存在）", async () => {
    await migrateStorageLayout(
      deps({ storePath: join(home, "x.json"), statsFile: join(home, "s.json") }),
    );

    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(statsFile())).toBe(false);
    expect(existsSync(userStatePath())).toBe(true);
  });
});
