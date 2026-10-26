import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SCRIPTS_DIR } from "./smoke-support";

const SYMLINK_TYPE = process.platform === "win32" ? "junction" : "dir";

const writeFixture = (state, path, content) => {
  mkdirSync(join(state.tmp, dirname(path)), { recursive: true });
  writeFileSync(join(state.tmp, path), content);
};

const runAdded = (state) => {
  const t0 = state.audit.scanSnapshot(state.tmp);
  writeFixture(state, "mystery.bin", "x");
  const t1 = state.audit.scanSnapshot(state.tmp);
  const r = state.audit.runAudit({ t0, t1, isolatedRoot: state.tmp });
  state.p1 = {
    count: r.count,
    path: r.suspicious[0].path,
    type: r.suspicious[0].type,
    conclusion: r.conclusion,
  };
};

const runEscapes = (state) => {
  const t0 = state.audit.scanSnapshot(state.tmp);
  symlinkSync(join(state.outside, "evil"), join(state.tmp, "evil-link"), SYMLINK_TYPE);
  mkdirSync(join(state.tmp, "profiles", "verify_x"), { recursive: true });
  symlinkSync(
    join(state.outside, "evil2"),
    join(state.tmp, "profiles", "verify_x", "evil2"),
    SYMLINK_TYPE,
  );
  const t1 = state.audit.scanSnapshot(state.tmp);
  const r = state.audit.runAudit({ t0, t1, isolatedRoot: state.tmp });
  state.p2 = {
    count: r.count,
    evilLink: r.suspicious.some((s) => s.path === "evil-link" && s.type === "越界 symlink"),
    nested: r.suspicious.some(
      (s) => s.path === "profiles/verify_x/evil2" && s.type === "越界 symlink",
    ),
    dupNew: r.suspicious.some((s) => s.path === "evil-link" && s.type === "新增"),
  };
};

const runDeleted = (state) => {
  writeFixture(state, "doomed.bin", "x");
  const t0 = state.audit.scanSnapshot(state.tmp);
  rmSync(join(state.tmp, "doomed.bin"));
  const t1 = state.audit.scanSnapshot(state.tmp);
  const r = state.audit.runAudit({ t0, t1, isolatedRoot: state.tmp });
  state.p3 = {
    count: r.count,
    deleted: r.suspicious.some((s) => s.path === "doomed.bin" && s.type === "删除"),
  };
};

const runModified = (state) => {
  writeFixture(state, "mut.bin", "aa");
  const t0 = state.audit.scanSnapshot(state.tmp);
  writeFixture(state, "mut.bin", "bbbb");
  const t1 = state.audit.scanSnapshot(state.tmp);
  const r = state.audit.runAudit({ t0, t1, isolatedRoot: state.tmp });
  state.p4 = {
    count: r.count,
    modified: r.suspicious.some((s) => s.path === "mut.bin" && s.type === "修改"),
  };
};

const runCtime = (state) => {
  const mk = (ctimeMs) => ({
    root: state.tmp,
    entries: new Map([["rewrite.bin", { type: "file", size: 4, mtimeMs: 1000, ctimeMs }]]),
  });
  const r = state.audit.runAudit({ t0: mk(1000), t1: mk(1001), isolatedRoot: state.tmp });
  state.ctime = { count: r.count, type: r.suspicious[0].type };
};

const runWhitelisted = (state) => {
  const t0 = state.audit.scanSnapshot(state.tmp);
  writeFixture(state, "settings.json", "{}");
  writeFixture(state, "browser.state", "{}");
  writeFixture(state, "dsh.log", "hello");
  writeFixture(state, ".credentials.yaml", "token: x\n");
  writeFixture(state, "profiles/verify_x/p.json", "{}");
  writeFixture(state, "evidence/shot.png", "x");
  writeFixture(state, "audit/audit.json", "{}");
  writeFixture(state, "storages/workspace.json", "{}");
  const t1 = state.audit.scanSnapshot(state.tmp);
  const r = state.audit.runAudit({
    t0,
    t1,
    isolatedRoot: state.tmp,
    whitelist: state.audit.WHITELIST,
  });
  state.n1 = { count: r.count, conclusion: r.conclusion };
};

const runWhitelistedDeleteAndModify = (state) => {
  writeFixture(state, "wl-del.json", "{}");
  writeFixture(state, "wl-mod.log", "old");
  const t0 = state.audit.scanSnapshot(state.tmp);
  rmSync(join(state.tmp, "wl-del.json"));
  writeFixture(state, "wl-mod.log", "new content");
  const t1 = state.audit.scanSnapshot(state.tmp);
  const r = state.audit.runAudit({ t0, t1, isolatedRoot: state.tmp });
  state.n1b = { count: r.count, conclusion: r.conclusion };
};

const runLinkedMount = (state) => {
  mkdirSync(join(state.tmp, "profiles", "verify_x", "node_modules"), { recursive: true });
  symlinkSync(
    join(state.outside, "pkg"),
    join(state.tmp, "profiles", "verify_x", "node_modules", "pkg"),
    SYMLINK_TYPE,
  );
  const t0 = state.audit.scanSnapshot(state.tmp);
  const t1 = state.audit.scanSnapshot(state.tmp);
  const r = state.audit.runAudit({ t0, t1, isolatedRoot: state.tmp });
  state.n2 = {
    reportsNodeModules: r.suspicious.some((s) => s.path.includes("node_modules")),
  };
};

const runUnchanged = (state) => {
  const s0 = state.audit.scanSnapshot(state.tmp);
  const s1 = state.audit.scanSnapshot(state.tmp);
  const r = state.audit.runAudit({ t0: s0, t1: s1, isolatedRoot: state.tmp });
  state.n3 = { count: r.count, conclusion: r.conclusion };
};

const runBrowserProfileSkipped = (state) => {
  writeFixture(state, "browser-profile/deep/file", "y");
  const s = state.audit.scanSnapshot(state.tmp, { skipDeep: state.audit.SKIP_DEEP });
  state.e9 = {
    hasDir: s.entries.has("browser-profile"),
    hasDeepFile: s.entries.has("browser-profile/deep/file"),
  };
};

const runStartedWrites = (state) => {
  mkdirSync(join(state.tmp, "profiles", "verify_x", "node_modules", "@deepseek-ai"), {
    recursive: true,
  });
  symlinkSync(
    join(state.outside, "dsh-install-lib"),
    join(state.tmp, "profiles", "verify_x", "node_modules", "@deepseek-ai", "dsh-base"),
    SYMLINK_TYPE,
  );
  writeFixture(state, ".credentials.yaml", "token: x\n");
  writeFixture(state, "storages/workspace.json", "{}");
  const t0 = state.audit.scanSnapshot(state.tmp, { skipDeep: state.audit.SKIP_DEEP });
  const r1 = state.audit.runAudit({
    t0,
    t1: state.audit.scanSnapshot(state.tmp, { skipDeep: state.audit.SKIP_DEEP }),
    isolatedRoot: state.tmp,
  });
  state.f1 = { count: r1.count, conclusion: r1.conclusion };
  writeFixture(state, "runtime-mystery.bin", "x");
  const r2 = state.audit.runAudit({
    t0,
    t1: state.audit.scanSnapshot(state.tmp, { skipDeep: state.audit.SKIP_DEEP }),
    isolatedRoot: state.tmp,
  });
  state.f2 = {
    count: r2.count,
    path: r2.suspicious[0].path,
    type: r2.suspicious[0].type,
  };
};

const registerAddedFixtures = (state) => {
  describe("正例1：白名单外新增 → 可疑（新增）", () => {
    it("白名单外新增报 1 项", () => {
      expect(state.p1.count).toBe(1);
    });

    it("可疑路径正确", () => {
      expect(state.p1.path).toBe("mystery.bin");
    });

    it("可疑类型为新增", () => {
      expect(state.p1.type).toBe("新增");
    });

    it("结论 suspicious", () => {
      expect(state.p1.conclusion).toBe("suspicious");
    });
  });

  describe("正例2：越界 symlink（顶层 + 白名单内）", () => {
    it("新增 2 条越界 symlink", () => {
      expect(state.p2.count).toBe(2);
    });

    it("新增越界 symlink 报可疑", () => {
      expect(state.p2.evilLink).toBeTruthy();
    });

    it("白名单内新增越界 symlink 仍报（防逃逸优先）", () => {
      expect(state.p2.nested).toBeTruthy();
    });

    it("越界 symlink 不重复报新增", () => {
      expect(!state.p2.dupNew).toBeTruthy();
    });
  });

  describe("正例3：白名单外删除 → 可疑（删除）", () => {
    it("白名单外删除报 1 项", () => {
      expect(state.p3.count).toBe(1);
    });

    it("白名单外删除报可疑", () => {
      expect(state.p3.deleted).toBeTruthy();
    });
  });

  describe("正例4：白名单外修改（size 变化）→ 可疑（修改）", () => {
    it("白名单外修改报 1 项", () => {
      expect(state.p4.count).toBe(1);
    });

    it("白名单外修改报可疑", () => {
      expect(state.p4.modified).toBeTruthy();
    });
  });

  describe("ctimeMs 参与修改判定", () => {
    it("同 size 同 mtimeMs、ctimeMs 不同 → 报 1 项修改", () => {
      expect(state.ctime.count).toBe(1);
    });

    it("ctimeMs 变化报「修改」", () => {
      expect(state.ctime.type).toBe("修改");
    });
  });
};

const registerWhitelistedFixtures = (state) => {
  describe("反例1：白名单内变化忽略", () => {
    it("白名单内变化忽略", () => {
      expect(state.n1.count).toBe(0);
    });

    it("结论 pass", () => {
      expect(state.n1.conclusion).toBe("pass");
    });
  });

  describe("反例1b（m4 补强）：白名单内删除/修改忽略", () => {
    it("白名单内删除/修改忽略", () => {
      expect(state.n1b.count).toBe(0);
    });

    it("白名单内删除/修改结论 pass", () => {
      expect(state.n1b.conclusion).toBe("pass");
    });
  });

  describe("反例2：link: 挂载点合法", () => {
    it("t0 已存在且目标未变的外部 symlink（link: 挂载点）不报", () => {
      expect(!state.n2.reportsNodeModules).toBeTruthy();
    });
  });

  describe("反例3：t1 无变化 → 通过", () => {
    it("t1 无变化 0 可疑", () => {
      expect(state.n3.count).toBe(0);
    });

    it("t1 无变化结论 pass", () => {
      expect(state.n3.conclusion).toBe("pass");
    });
  });
};

const registerSkippedFixtures = (state) => {
  describe("9e. browser-profile 跳过深扫", () => {
    it("browser-profile 目录条目在位", () => {
      expect(state.e9.hasDir).toBeTruthy();
    });

    it("browser-profile/** 跳过深扫", () => {
      expect(!state.e9.hasDeepFile).toBeTruthy();
    });
  });
};

const registerStartedWriteFixtures = (state) => {
  describe("9f. dsh 启动写面回归（纯函数层）", () => {
    it("启动写面进 t0 基线，干净运行 pass", () => {
      expect(state.f1.count).toBe(0);
    });

    it("干净运行结论 pass", () => {
      expect(state.f1.conclusion).toBe("pass");
    });

    it("运行期新增仍报 1 项", () => {
      expect(state.f2.count).toBe(1);
    });

    it("运行期新增路径正确", () => {
      expect(state.f2.path).toBe("runtime-mystery.bin");
    });

    it("运行期新增类型为新增", () => {
      expect(state.f2.type).toBe("新增");
    });
  });
};

export function auditFixtureContract() {
  describe("9d. mkdtemp fixture 正反例", () => {
    const state = {};

    beforeAll(async () => {
      state.audit = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "audit.mjs")).href);
      state.tmp = mkdtempSync(join(tmpdir(), "dsh-verify-audit-"));
      state.outside = mkdtempSync(join(tmpdir(), "dsh-verify-audit-out-"));
      runAdded(state);
      runEscapes(state);
      runDeleted(state);
      runModified(state);
      runCtime(state);
      runWhitelisted(state);
      runWhitelistedDeleteAndModify(state);
      runLinkedMount(state);
      runUnchanged(state);
      runBrowserProfileSkipped(state);
      runStartedWrites(state);
    });

    afterAll(() => {
      rmSync(state.tmp, { recursive: true, force: true });
      rmSync(state.outside, { recursive: true, force: true });
    });

    registerAddedFixtures(state);
    registerWhitelistedFixtures(state);
    registerSkippedFixtures(state);
    registerStartedWriteFixtures(state);
  });
}
