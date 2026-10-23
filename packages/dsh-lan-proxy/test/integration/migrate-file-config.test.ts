// dsh-lan-proxy integration：存量 config.json 一次性迁移（rename-first marker）。
//
// #1174 A1 自 test/e2e/smoke.test.ts 的「e2e: 真实转发」外壳内迁出为独立文件。
// 层归属：DEVELOPMENT 测试分层表 integration 行明列「真实配置迁移」——本块对真实
// 文件系统做 rename / 还原 / 重放，不是纯逻辑 mock，故不落 unit。
// 独立成文件的理由：并入既有 test/unit/apply.test.ts（2567 行）会把该文件推成新的
// 长文件/长函数债，与本批消债目标相反。
// 断言与 describe 名逐字保留（仅去 e2e 外壳前缀，见对账登记）。
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATED_BAK_NAME, migrateFileConfig } from "../../src/server/migrate/impl/file/index.ts";
import type { OwnerScopeLike } from "../../src/server/config/impl/namespace.ts";

// 共享观测状态与辅助函数提到文件级（#1174 A1）：提取出的注册函数是独立作用域，
// 状态必须在其外层可见。钩子仍注册在本 describe 内（vitest 钩子作用域语义）。
/** fake owner scope：update 增量 merge 进内存 user 层（官方存储文档的 fake 形态）。 */
const makeScope = () => {
  const state = {
    user: {} as Record<string, unknown>,
    updates: [] as Record<string, unknown>[],
  };
  return {
    state,
    async update(patch: Record<string, unknown>) {
      state.updates.push(patch);
      Object.assign(state.user, patch);
    },
  };
};

// 场景族提取为注册函数（#1174 A1）：避免顶层 describe 回调超过 max-lines-per-function。
// 提取的是完整的一级子 describe（场景族），其内容与名字逐字保留，嵌套顺序不变。
function register1Case1() {
  describe("迁移主链：有效配置 + 幂等跳过", () => {
    let cfgDir = "";
    let firstOutcome!: Awaited<ReturnType<typeof migrateFileConfig>>;
    let configExistsAfterFirst = false;
    let bakExistsAfterFirst = false;
    let bakRaw: { port: number } = { port: 0 };
    let userAfterFirst: Record<string, unknown> = {};
    let secondOutcome!: Awaited<ReturnType<typeof migrateFileConfig>>;
    let secondUpdatesLength = 0;

    beforeAll(async () => {
      cfgDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-"));
      // 有效配置：改名 + 过滤未知键 + 增量写入官方存储。
      writeFileSync(
        join(cfgDir, "config.json"),
        JSON.stringify({
          port: 4081,
          printBanner: false,
          unknownKey: "dropped",
          httpCompressLevel: 6,
        }),
      );
      const scope1 = makeScope();
      firstOutcome = await migrateFileConfig(cfgDir, scope1);
      configExistsAfterFirst = existsSync(join(cfgDir, "config.json"));
      bakExistsAfterFirst = existsSync(join(cfgDir, MIGRATED_BAK_NAME));
      bakRaw = JSON.parse(readFileSync(join(cfgDir, MIGRATED_BAK_NAME), "utf8"));
      userAfterFirst = { ...scope1.state.user };

      // 幂等：config.json 与 .bak 都不存在（用户已清理备份的稳态）→ 跳过，不写。
      // 注：正常迁移成功后 .bak 保留，二次启动会命中中断态重放（同值 merge 无害，
      // 见下方用例）；真正「跳过」的稳态是备份被清理之后。
      rmSync(join(cfgDir, MIGRATED_BAK_NAME));
      const scope2 = makeScope();
      secondOutcome = await migrateFileConfig(cfgDir, scope2);
      secondUpdatesLength = scope2.state.updates.length;
      rmSync(cfgDir, { recursive: true, force: true });
    });

    describe("迁移：原子改名为 .bak 且增量写入有效键（旧档位 6→3、未知键丢弃）", () => {
      it("performed 且 migrated 为 true", () => {
        expect(firstOutcome.performed && firstOutcome.migrated).toBe(true);
      });

      it("config.json 已改名消失", () => {
        expect(configExistsAfterFirst).toBe(false);
      });

      it(".bak 备份存在", () => {
        expect(bakExistsAfterFirst).toBe(true);
      });

      it("bak 保留原始内容供用户回滚", () => {
        expect(bakRaw.port).toBe(4081);
      });

      it("写入官方存储的用户层（旧档位 6→3、未知键丢弃）", () => {
        expect(userAfterFirst).toEqual({ port: 4081, printBanner: false, httpCompressLevel: 3 });
      });
    });

    describe("迁移幂等：config.json 与备份都不存在 → 跳过且不写", () => {
      it("outcome 全 false", () => {
        expect(secondOutcome).toEqual({
          performed: false,
          migrated: false,
          rolledBack: false,
          skippedCorrupt: false,
          resumed: false,
        });
      });

      it("未产生第二次写入", () => {
        expect(secondUpdatesLength).toBe(0);
      });
    });
  });
}

function register2Case2() {
  describe("中断重放（bak 重放 / 二次重放 / 坏 bak）", () => {
    let resumeDir = "";
    let resumeScope!: ReturnType<typeof makeScope>;
    let resumeOutcome!: Awaited<ReturnType<typeof migrateFileConfig>>;
    let resumeWarns: string[] = [];
    let resumeBakExists = false;
    let againOutcome!: Awaited<ReturnType<typeof migrateFileConfig>>;
    let againUpdates: unknown[] = [];
    let badResume!: Awaited<ReturnType<typeof migrateFileConfig>>;
    let badResumeWarns: string[] = [];

    beforeAll(async () => {
      // 中断态重放：.bak 存在且 config.json 不存在（改名成功后写入完成前进程被杀）
      // → 视为未完成迁移，从 bak 重放「解析→sanitize→update」，配置不再永滞 bak。
      // （正常迁移成功后 bak 保留，因此二次启动也会命中重放——同值 merge 无害。）
      resumeDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-resume-"));
      writeFileSync(
        join(resumeDir, MIGRATED_BAK_NAME),
        JSON.stringify({ port: 4077, printBanner: false }),
      );
      resumeWarns = [];
      resumeScope = makeScope();
      resumeOutcome = await migrateFileConfig(resumeDir, resumeScope, {
        warn: (m: unknown) => resumeWarns.push(String(m)),
      });
      resumeBakExists = existsSync(join(resumeDir, MIGRATED_BAK_NAME));

      // 二次启动（bak 未清理）→ 再次重放同值，无副作用、不抛错。
      againOutcome = await migrateFileConfig(resumeDir, resumeScope);
      againUpdates = [...resumeScope.state.updates];

      // 重放遇损坏 bak：warn 手动恢复路径，不抛错。
      const badBak = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-resume-bad-"));
      writeFileSync(join(badBak, MIGRATED_BAK_NAME), "{not json");
      badResumeWarns = [];
      badResume = await migrateFileConfig(badBak, makeScope(), {
        warn: (m: unknown) => badResumeWarns.push(String(m)),
      });
      rmSync(resumeDir, { recursive: true, force: true });
      rmSync(badBak, { recursive: true, force: true });
    });

    describe("中断重放：.bak 存在且 config.json 不存在 → 从 bak 重写官方存储且保留备份", () => {
      it("resumed 且 migrated 为 true", () => {
        expect(resumeOutcome.resumed && resumeOutcome.migrated).toBe(true);
      });

      it("滞留 .bak 的配置已重放进官方存储", () => {
        expect(resumeScope.state.user.port).toBe(4077);
      });

      it("重放成功后保留 bak", () => {
        expect(resumeBakExists).toBe(true);
      });

      it("warn 明示恢复路径", () => {
        expect(resumeWarns.some((m) => m.includes("重放写入设置"))).toBeTruthy();
      });
    });

    describe("中断重放幂等：二次启动重放同值无害", () => {
      it("resumed 且 migrated 为 true（第二次）", () => {
        expect(againOutcome.resumed && againOutcome.migrated).toBe(true);
      });

      it("user 层端口仍为 4077", () => {
        expect(resumeScope.state.user.port).toBe(4077);
      });

      it("两次重放内容一致", () => {
        expect(againUpdates[0]).toEqual(againUpdates[1]);
      });
    });

    describe("中断重放：bak 损坏时 warn 手动恢复路径且不写入", () => {
      it("resumed 为 true", () => {
        expect(badResume.resumed).toBe(true);
      });

      it("migrated 为 false", () => {
        expect(badResume.migrated).toBe(false);
      });

      it("warn 含手动恢复指引", () => {
        expect(badResumeWarns.some((m) => m.includes("无法自动恢复"))).toBeTruthy();
      });
    });
  });
}

function register3Case3() {
  describe("迁移：损坏 / 非 object / 全非法值 JSON 只标记不写（3 种载荷）", () => {
    const badPayloads = [
      { label: "损坏 json 只标记不写", raw: "{broken json" },
      { label: "数组 json 只标记不写", raw: JSON.stringify(["array"]) },
      { label: "含类型非法值只标记不写", raw: JSON.stringify({ port: "not-a-number" }) },
    ];
    let records: Array<{
      bad: Awaited<ReturnType<typeof migrateFileConfig>>;
      bakExists: boolean;
      updatesLength: number;
    }> = [];

    beforeAll(async () => {
      records = [];
      for (const { raw } of badPayloads) {
        const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-bad-"));
        writeFileSync(join(dir, "config.json"), raw);
        const scope = makeScope();
        const bad = await migrateFileConfig(dir, scope);
        // bak 标记必须在 rmSync 之前观测（目录随即被回收）
        records.push({
          bad,
          bakExists: existsSync(join(dir, MIGRATED_BAK_NAME)),
          updatesLength: scope.state.updates.length,
        });
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // 原脚本把 check 写在标签循环内，故按标签展开为逐条可见用例。
    const titled = (suffix: string) =>
      badPayloads.map((c, i) => ({
        title: `${c.label}（.bak 存在、scope 未被调用）：${suffix}`,
        i,
      }));

    it.each(titled("skippedCorrupt"))("$title", ({ i }) => {
      expect(records[i].bad.skippedCorrupt).toBe(true);
    });

    it.each(titled("migrated=false"))("$title", ({ i }) => {
      expect(records[i].bad.migrated).toBe(false);
    });

    it.each(titled("仅改名标记"))("$title", ({ i }) => {
      expect(records[i].bakExists).toBe(true);
    });

    it.each(titled("不写入 scope"))("$title", ({ i }) => {
      expect(records[i].updatesLength).toBe(0);
    });
  });
}

function register4Case4() {
  describe("迁移：写入失败回滚 rename（config.json 还原、下次启动重试）", () => {
    let rollbackOutcome!: Awaited<ReturnType<typeof migrateFileConfig>>;
    let configRestored = false;
    let failingUpdatesLength = 0;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-rollback-"));
      writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 4099 }));
      const failing: Pick<OwnerScopeLike, "update"> & { updates: unknown[] } = {
        updates: [] as unknown[],
        async update() {
          throw new Error("disk full");
        },
      };
      rollbackOutcome = await migrateFileConfig(dir, failing);
      configRestored = existsSync(join(dir, "config.json"));
      failingUpdatesLength = failing.updates.length;
      rmSync(dir, { recursive: true, force: true });
    });

    it("rolledBack 为 true", () => {
      expect(rollbackOutcome.rolledBack).toBe(true);
    });

    it("config.json 已还原", () => {
      expect(configRestored).toBe(true);
    });

    it("失败时未写入 scope", () => {
      expect(failingUpdatesLength).toBe(0);
    });
  });
}

function register5Case5() {
  describe("迁移：ws 压缩白名单归一化（#395 M2）", () => {
    let m2!: Awaited<ReturnType<typeof migrateFileConfig>>;
    let m2User: Record<string, unknown> = {};
    let m2Custom!: Awaited<ReturnType<typeof migrateFileConfig>>;
    let m2CustomUser: Record<string, unknown> = {};

    beforeAll(async () => {
      // M2（#395）：迁移含旧默认白名单的 config.json → 写入归一化后的新值；
      // 自定义白名单（含废弃端点的组合）迁移后原样保留。
      const m2Dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-m2-"));
      writeFileSync(
        join(m2Dir, "config.json"),
        JSON.stringify({ wsCompressPaths: ["/api/events.host", "/api/events.mux"] }),
      );
      const m2Scope = makeScope();
      m2 = await migrateFileConfig(m2Dir, m2Scope);
      m2User = { ...m2Scope.state.user };
      rmSync(m2Dir, { recursive: true, force: true });

      const m2CustomDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-migrate-m2c-"));
      writeFileSync(
        join(m2CustomDir, "config.json"),
        JSON.stringify({ wsCompressPaths: ["/api/events.mux", "/api/custom/ws"] }),
      );
      const m2CustomScope = makeScope();
      m2Custom = await migrateFileConfig(m2CustomDir, m2CustomScope);
      m2CustomUser = { ...m2CustomScope.state.user };
      rmSync(m2CustomDir, { recursive: true, force: true });
    });

    describe("迁移：含旧默认白名单的 config.json 写入归一化后的 remote.mux", () => {
      it("migrated 为 true", () => {
        expect(m2.migrated).toBe(true);
      });

      it("写入官方存储的用户层为 remote.mux", () => {
        expect(m2User).toEqual({ wsCompressPaths: ["/api/remote.mux"] });
      });
    });

    describe("迁移：自定义白名单（含废弃端点组合）原样保留不改写", () => {
      it("migrated 为 true", () => {
        expect(m2Custom.migrated).toBe(true);
      });

      it("写入官方存储的用户层原样保留", () => {
        expect(m2CustomUser).toEqual({ wsCompressPaths: ["/api/events.mux", "/api/custom/ws"] });
      });
    });
  });
}

describe("unit: migrateFileConfig（存量 config.json 一次性迁移，rename-first marker）", () => {
  register1Case1();
  register2Case2();
  register3Case3();
  register4Case4();
  register5Case5();
});
