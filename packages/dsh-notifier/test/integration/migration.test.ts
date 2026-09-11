// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e：存量配置迁移（逐字段补齐）。
 *
 * 覆盖：
 * - 旧 json 存在 → 一次性迁移至官方 settings user 层，原文改名 .migrated.bak；
 * - 迁移幂等：二次启动 .bak 存在且 json 不存在且 user 层有值 → 跳过（不重复写入）；
 * - 中断态重放：.migrated.bak 存在且 json 不存在且 user 层为空 → 重放写入；
 * - 损坏/非对象/无有效键 → 改名 .corrupted.bak，不写入；
 * - Windows rename 目标已存在 → 先 unlink 旧 bak 再 rename；
 * - 迁移写入失败 → 回滚改名（json 还原）+ warn，不阻塞启动；
 * - 迁移前置于 enabled 判定（禁用态也迁移，路由/命名空间照常注册）；
 * - migrateLegacyConfig outcome 精确断言（迁移完成判定 = 逐字段缺失
 *   补齐，不再是「user 层任意键存在」整体跳过）；
 * - 回归用例：中断部分写入后重跑补齐剩余字段；用户改值不被迁移覆盖
 *   （冲突策略：只补写 user 层缺失的键，用户已改/已存在的键不被覆盖）。
 *
 * 迁移说明：deps.update 内「只补 user 层缺失键」不变式是注入面护栏（每个 patch
 * 键执行一次），保留在 helper 内 fail-loud，不另立用例。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, makeFakeSettings, makeFakeCtx } from "../helpers.ts";
import { ROUTES, apply, migrateLegacyConfig, MIGRATED_BAK_SUFFIX, CORRUPTED_BAK_SUFFIX } from "../../src/index.ts";

let work: string;
let dir: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-migrate-"));
  dir = mkdtempSync(join(tmpdir(), "dnotify-migrate-outcome-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

/** 轮询直到谓词成立（替代固定 sleep：迁移是 onScope 内异步 fire-and-forget）。 */
async function pollUntil(predicate, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 轮询「安静期」：谓词持续成立达 quietMs 视为确认——负向观察窗（验证「某事
 *  不发生」）替代固定 sleep：谓词一旦被破坏立即失败（比等满固定毫秒更早暴露
 *  回归），无破坏则确认安静期后通过（比固定 wait 更稳：不依赖单次时机命中）。 */
async function pollUntilQuiet(predicate, quietMs = 80, timeoutMs = 1000) {
  const start = Date.now();
  let quiet = 0;
  for (;;) {
    if (!predicate()) return false;
    quiet += 10;
    if (quiet >= quietMs) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── E1：旧 json 存在 → 迁移 + 改名 .migrated.bak ──
describe("E1：旧 json 存在 → 迁移 + 改名 .migrated.bak", () => {
  let legacy: string;
  let settings: any;

  beforeAll(async () => {
    legacy = join(work, "e1-dsh-notifier.json");
    writeFileSync(legacy, JSON.stringify({ notifyAsk: false, quietHours: { enabled: true, start: "23:00", end: "07:00" } }));
    // makeNotifier 的 configFile 指向旧 json；settings user 层预置空
    ({ settings } = makeNotifier(work, { configFile: legacy }));
    // 迁移在 onScope 内异步执行，轮询直到 user 层写入
    await pollUntil(() => settings.getUser().notifyAsk === false);
  });

  it("E1：notifyAsk 迁入 settings user 层", () => {
    expect(settings.getUser().notifyAsk).toBe(false);
  });

  it("E1：quietHours 迁入 settings user 层", () => {
    expect(settings.getUser().quietHours?.enabled).toBe(true);
  });

  it("E1：原文改名 .migrated.bak", () => {
    expect(existsSync(legacy + ".migrated.bak")).toBeTruthy();
  });

  it("E1：原 json 已改名（不再作为自建配置读取）", () => {
    expect(!existsSync(legacy)).toBeTruthy();
  });
});

// ── E2：迁移幂等——同一 settings 文档再次 apply 不重复写入 ──
describe("E2：迁移幂等（二次启动不重复写入 settings）", () => {
  let shared: any;
  let callsAfterFirst: number;
  let quietOk: boolean;

  beforeAll(async () => {
    const legacy = join(work, "e2-dsh-notifier.json");
    writeFileSync(legacy, JSON.stringify({ notifyAsk: false }));
    // 首次：共享 fake settings（user 层为空 → 触发迁移）
    shared = makeFakeSettings({});
    const ctx1 = makeFakeCtx({});
    ctx1.ctx.provide("settings", shared.service);
    apply(ctx1.ctx, { enabled: true, configFile: legacy, historyFile: join(work, "e2-hist.jsonl") });
    await pollUntil(() => shared.getUser().notifyAsk === false);
    callsAfterFirst = shared.getUpdateCalls().length;
    // 二次：同一 settings 文档（user 层已有值）→ 幂等跳过（不触发 update）
    const ctx2 = makeFakeCtx({});
    ctx2.ctx.provide("settings", shared.service);
    apply(ctx2.ctx, { enabled: true, configFile: legacy, historyFile: join(work, "e2-hist.jsonl") });
    // 负向观察窗：安静期内不得新增 update 调用（幂等跳过）；一旦误写立即失败
    quietOk = await pollUntilQuiet(() => shared.getUpdateCalls().length === callsAfterFirst, 80);
  });

  it("E2：首次迁移触发写入", () => {
    expect(callsAfterFirst >= 1).toBeTruthy();
  });

  it("E2：二次启动幂等跳过（不重复写入 settings）", () => {
    expect(quietOk).toBeTruthy();
  });

  it("E2：二次启动不重复写入（调用数不变）", () => {
    expect(shared.getUpdateCalls().length).toBe(callsAfterFirst);
  });

  it("E2：user 层保留首次迁移结果", () => {
    expect(shared.getUser().notifyAsk).toBe(false);
  });
});

// ── E3：中断态重放（.migrated.bak 存在 + json 不存在 + user 层为空）──
describe("E3：中断态重放", () => {
  let settings: any;

  beforeAll(async () => {
    const legacy = join(work, "e3-dsh-notifier.json");
    const bak = legacy + ".migrated.bak";
    writeFileSync(bak, JSON.stringify({ notifyTaskDone: false })); // 模拟「改名成功但 update 前被杀」
    ({ settings } = makeNotifier(work, { configFile: legacy }));
    await pollUntil(() => settings.getUser().notifyTaskDone === false);
  });

  it("E3：中断态从 bak 重放写入 settings", () => {
    expect(settings.getUser().notifyTaskDone).toBe(false);
  });
});

// ── E4：损坏 json → 改名 .corrupted.bak，不写入 ──
describe("E4：损坏 json → 改名 .corrupted.bak 不写入", () => {
  let legacy: string;
  let settings: any;
  let quietOk: boolean;

  beforeAll(async () => {
    legacy = join(work, "e4-dsh-notifier.json");
    writeFileSync(legacy, "{ not json !!!");
    ({ settings } = makeNotifier(work, { configFile: legacy }));
    // 负向观察窗：user 层必须保持空（损坏不写入）；一旦误写立即失败
    quietOk = await pollUntilQuiet(() => Object.keys(settings.getUser()).length === 0, 80);
  });

  it("E4：损坏 json 不写入 settings user 层（安静期确认）", () => {
    expect(quietOk).toBeTruthy();
  });

  it("E4：损坏 json 不写入 settings user 层", () => {
    expect(settings.getUser()).toEqual({});
  });

  it("E4：损坏 json 改名 .corrupted.bak 标记", () => {
    expect(existsSync(legacy + ".corrupted.bak")).toBeTruthy();
  });

  it("E4：损坏原文件已改名", () => {
    expect(!existsSync(legacy)).toBeTruthy();
  });
});

// ── E4b：非对象/无有效键 json → 只标记不写入 ──
describe("E4b：非对象 json → 只标记不写入", () => {
  let legacy: string;
  let settings: any;
  let quietOk: boolean;

  beforeAll(async () => {
    legacy = join(work, "e4b-dsh-notifier.json");
    writeFileSync(legacy, "123");
    ({ settings } = makeNotifier(work, { configFile: legacy }));
    quietOk = await pollUntilQuiet(() => Object.keys(settings.getUser()).length === 0, 80);
  });

  it("E4b：非对象 json 不写入（安静期确认）", () => {
    expect(quietOk).toBeTruthy();
  });

  it("E4b：非对象 json 不写入", () => {
    expect(settings.getUser()).toEqual({});
  });

  it("E4b：非对象 json 改名 .corrupted.bak", () => {
    expect(existsSync(legacy + ".corrupted.bak")).toBeTruthy();
  });
});

// ── E5：Windows rename 目标已存在 → 先 unlink 旧 bak 再 rename ──
describe("E5：rename 覆盖旧 bak", () => {
  let bak: string;
  let settings: any;

  beforeAll(async () => {
    const legacy = join(work, "e5-dsh-notifier.json");
    bak = legacy + ".migrated.bak";
    writeFileSync(legacy, JSON.stringify({ notifyAsk: true }));
    writeFileSync(bak, "old backup"); // 预置旧 bak（Windows 上 rename 目标已存在会抛错）
    ({ settings } = makeNotifier(work, { configFile: legacy }));
    await pollUntil(() => settings.getUser().notifyAsk === true);
  });

  it("E5：rename 覆盖旧 bak 后迁移成功", () => {
    expect(settings.getUser().notifyAsk).toBe(true);
  });

  it("E5：新 bak 内容为本次迁移（旧 bak 已被 unlink 替换）", () => {
    expect(readFileSync(bak, "utf8").includes("notifyAsk")).toBeTruthy();
  });
});

// ── E6：迁移写入失败 → 回滚改名 + warn，不阻塞启动 ──
describe("E6：迁移写入失败 → 回滚改名 + warn", () => {
  let legacy: string;
  let warns: string[];
  let routes: any[];

  beforeAll(async () => {
    legacy = join(work, "e6-dsh-notifier.json");
    writeFileSync(legacy, JSON.stringify({ notifyAsk: true }));
    warns = [];
    // 用一个 update 必失败的 settings 服务（模拟持久化失败）
    const made = makeFakeCtx({
      logger: { warn: (m) => warns.push(m), info: () => {} },
    });
    routes = made.routes;
    const failingSettings = {
      register(ns, schema, opts) {
        return {
          get: () => ({ notifyAsk: true }),
          watch: () => () => {},
          update: async () => {},
        };
      },
      describe: () => [{ ns: "dsh-notifier", user: {}, revision: 0 }],
      async update(ns, patch) {
        throw new Error("persist boom");
      },
    };
    made.ctx.provide("settings", failingSettings);
    apply(made.ctx, { enabled: true, configFile: legacy, historyFile: join(work, "e6-hist.jsonl") });
    // 迁移失败 warn 出现 = 异步迁移链走完（warn 在回滚改名之后输出）→ 事件驱动替代固定 sleep
    await pollUntil(() => warns.length > 0);
  });

  it("E6：写入失败回滚，原 json 还原", () => {
    expect(existsSync(legacy)).toBeTruthy();
  });

  it("E6：迁移失败输出 warn 日志", () => {
    expect(warns.some((w) => w.includes("迁移"))).toBeTruthy();
  });

  it("E6：迁移失败不阻塞路由注册", () => {
    expect(routes.length >= 5).toBeTruthy();
  });
});

// ── E7：enabled=false 禁用态仍迁移——禁用态 apply 仍注册路由 + 迁移照常 ──
describe("E7：禁用态仍注册路由 + 仍迁移旧配置", () => {
  let fakeSettings: any;
  let paths: string[] = [];

  beforeAll(async () => {
    const legacy = join(work, "e7-dsh-notifier.json");
    writeFileSync(legacy, JSON.stringify({ notifyTaskError: false }));
    fakeSettings = makeFakeSettings({});
    const { ctx, routes } = makeFakeCtx({});
    ctx.provide("settings", fakeSettings.service);
    apply(ctx, { enabled: false, configFile: legacy, historyFile: join(work, "e7-hist.jsonl") });
    await pollUntil(() => fakeSettings.getUser().notifyTaskError === false);
    paths = routes.map((r) => r.path);
  });

  for (const route of Object.values(ROUTES)) {
    it(`E7：禁用态仍注册路由 ${route}`, () => {
      expect(paths.includes(route)).toBeTruthy();
    });
  }

  it("E7：禁用态仍迁移旧配置", () => {
    expect(fakeSettings.getUser().notifyTaskError).toBe(false);
  });
});

// ── E8/E9：migrateLegacyConfig outcome 精确断言（直测）──
// 对照 stryker 幸存名单——布尔结果字段翻转/逻辑运算符/条件分支的存活变异体由
// outcome 深比较杀灭。
/** 直测注入面（readUser）：user 层当前值可预置（模拟部分写入/用户改值）。 */
function deps(user = {}, failUpdate = false) {
  const updates = [];
  return {
    updates,
    readUser: () => user,
    async update(patch) {
      if (failUpdate) throw new Error("io boom");
      // 锁死「只补缺失键」语义——update 提交的每个键在写入前
      // 必须不存在于 user 层（防未来实现改成快照全量/覆盖写导致漏报）
      for (const key of Object.keys(patch)) {
        expect(key in user).toBe(false);
      }
      updates.push(patch);
      Object.assign(user, patch);
    },
  };
}

const IDLE = { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, skippedIdempotent: true, resumed: false };
const CORRUPT_ONLY = { performed: false, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: true, resumed: false };

describe("E8：idle（json 与 bak 都不存在）", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps();
    out = await migrateLegacyConfig(join(dir, "idle.json"), d);
  });

  it("E8：双文件不存在 → idle outcome 全 false/skippedIdempotent", () => {
    expect(out).toEqual(IDLE);
  });

  it("E8：idle 不写入", () => {
    expect(d.updates.length).toBe(0);
  });
});

describe("E8：损坏标记态（只有 .corrupted.bak）", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps();
    const legacy = join(dir, "corrupt-only.json");
    writeFileSync(legacy + CORRUPTED_BAK_SUFFIX, "{oops");
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E8：损坏标记态 → skippedCorrupt+skippedIdempotent", () => {
    expect(out).toEqual(CORRUPT_ONLY);
  });

  it("E8：损坏标记态不写入", () => {
    expect(d.updates.length).toBe(0);
  });
});

describe("E8：migrated.bak 存在 + user 层全量有值（含声音新键）→ 幂等跳过", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps({ notifyAsk: false, notifySound: true, browserSound: true, systemSound: true });
    const legacy = join(dir, "bak-user.json");
    writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifyAsk: false, notifySound: true, browserSound: true, systemSound: true }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E8：bak 存在 + user 已全量（含声音新键）→ 幂等跳过", () => {
    expect(out).toEqual(IDLE);
  });

  it("E8：幂等跳过不写入", () => {
    expect(d.updates.length).toBe(0);
  });
});

describe("D2：bak 仅旧键 notifySound → 补写 browserSound/systemSound 同值", () => {
  // legacy 源路径专属——user 层已有新键不覆盖由 diffMissingKeys 兜底
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps({ notifyAsk: false, notifySound: true });
    const legacy = join(dir, "bak-legacy-sound.json");
    writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifyAsk: false, notifySound: true }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("D2：bak 仅旧键 → 补写两新键 = notifySound 同值", () => {
    expect(d.updates).toEqual([{ browserSound: true, systemSound: true }]);
  });

  it("D2：legacy 声音键补齐算迁移写入", () => {
    expect(out.migrated).toBe(true);
  });
});

describe("E8：中断态重放成功（bak 存在 + user 空 + bak 合法）", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps();
    const legacy = join(dir, "resume-ok.json");
    writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifySound: false }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E8：中断态重放成功 outcome", () => {
    expect(out).toEqual({ performed: false, migrated: true, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: true });
  });

  it("D2：重放写入键集（旧键 notifySound + 两新键同值）", () => {
    expect(d.updates).toEqual([{ notifySound: false, browserSound: false, systemSound: false }]);
  });
});

describe("E8：中断态重放失败（bak 非法 JSON）", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps();
    const legacy = join(dir, "resume-bad.json");
    writeFileSync(legacy + MIGRATED_BAK_SUFFIX, "{bad json");
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E8：中断态 bak 损坏 → 标记跳过", () => {
    expect(out).toEqual({ performed: false, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: false, resumed: true });
  });

  it("E8：损坏 bak 不写入", () => {
    expect(d.updates.length).toBe(0);
  });
});

describe("E8/#470：中断态重放 bak 仅含未知键 → 透传补写", () => {
  // 不再是「无有效键」，升级不丢 legacy 未来键，skippedCorrupt=false
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps();
    const legacy = join(dir, "resume-future.json");
    writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ futureKey: { a: 1 } }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E8：纯未知键重放标记 resumed", () => {
    expect(out.resumed).toBe(true);
  });

  it("E8：#470 纯未知键重放透传迁移（不再判无有效键）", () => {
    expect(out.migrated).toBe(true);
  });

  it("E8：#470 纯未知键不标记 corrupted", () => {
    expect(out.skippedCorrupt).toBe(false);
  });

  it("E8：#470 纯未知键原样补写", () => {
    expect(d.updates).toEqual([{ futureKey: { a: 1 } }]);
  });
});

describe("E8：中断态重放失败（bak 无任何键）", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps();
    const legacy = join(dir, "resume-empty.json");
    writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({}));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E8：无键重放标记 resumed", () => {
    expect(out.resumed).toBe(true);
  });

  it("E8：无键重放不迁移", () => {
    expect(out.migrated).toBe(false);
  });

  it("E8：无键重放标记 corrupted", () => {
    expect(out.skippedCorrupt).toBe(true);
  });

  it("E8：无键不写入", () => {
    expect(d.updates.length).toBe(0);
  });
});

describe("E8：损坏 json → 只标记 .corrupted.bak 不写入", () => {
  let d: any;
  let out: any;
  let legacy: string;

  beforeAll(async () => {
    d = deps();
    legacy = join(dir, "broken.json");
    writeFileSync(legacy, "{ not json !!!");
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E8：损坏 json outcome", () => {
    expect(out).toEqual({ performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: false, resumed: false });
  });

  it("E8：损坏 json 改名 corrupted.bak", () => {
    expect(existsSync(legacy + CORRUPTED_BAK_SUFFIX)).toBeTruthy();
  });

  it("E8：损坏 json 不写入", () => {
    expect(d.updates.length).toBe(0);
  });
});

describe("E8：非对象 json → 只标记（E4b）", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps();
    const legacy = join(dir, "nonobj.json");
    writeFileSync(legacy, "123");
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E8：非对象 json performed", () => {
    expect(out.performed).toBe(true);
  });

  it("E8：非对象 json 标记 corrupted", () => {
    expect(out.skippedCorrupt).toBe(true);
  });

  it("E8：非对象 json 不写入", () => {
    expect(d.updates.length).toBe(0);
  });
});

describe("E8：合法 json → renamed-first 后写入", () => {
  let d: any;
  let out: any;
  let legacy: string;

  beforeAll(async () => {
    d = deps();
    legacy = join(dir, "valid.json");
    writeFileSync(legacy, JSON.stringify({ notifyAsk: false, quietHours: { enabled: true, start: "23:00", end: "07:00" } }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E8：合法 json outcome", () => {
    expect(out).toEqual({ performed: true, migrated: true, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: false });
  });

  it("E8：合法 json 改名 migrated.bak", () => {
    expect(existsSync(legacy + MIGRATED_BAK_SUFFIX)).toBeTruthy();
  });

  it("E8：原 json 已改名", () => {
    expect(!existsSync(legacy)).toBeTruthy();
  });

  it("E8：写入键集 = sanitize 白名单", () => {
    expect(d.updates[0]).toEqual({ notifyAsk: false, quietHours: { enabled: true, start: "23:00", end: "07:00" } });
  });
});

describe("E8：写入失败 → 回滚改名（json 还原 + rolledBack）", () => {
  let out: any;
  let legacy: string;

  beforeAll(async () => {
    const d = deps({}, true);
    legacy = join(dir, "rollback.json");
    writeFileSync(legacy, JSON.stringify({ notifyAsk: true }));
    out = await migrateLegacyConfig(legacy, d, { warn: () => {} });
  });

  it("E8：写入失败回滚 outcome", () => {
    expect(out).toEqual({ performed: true, migrated: false, rolledBack: true, skippedCorrupt: false, skippedIdempotent: false, resumed: false });
  });

  it("E8：回滚后原 json 还原", () => {
    expect(existsSync(legacy)).toBeTruthy();
  });

  it("E8：回滚后 migrated.bak 已还原为 json", () => {
    expect(!existsSync(legacy + MIGRATED_BAK_SUFFIX)).toBeTruthy();
  });
});

describe("E9a：json 迁移部分写入中断 → 重跑补齐剩余字段", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps({ notifyAsk: false }); // 上次迁移只写进 notifyAsk 就被打断
    const legacy = join(dir, "partial.json");
    writeFileSync(legacy, JSON.stringify({ notifyAsk: false, notifySound: true, quietHours: { enabled: true, start: "23:00", end: "07:00" } }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E9a：部分写入中断后重跑 → 继续迁移", () => {
    expect(out).toEqual({ performed: true, migrated: true, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: false });
  });

  it("E9a：只补写 user 层缺失字段（已写 notifyAsk 不重写；D2 补声音新键）", () => {
    expect(d.updates).toEqual([{ notifySound: true, browserSound: true, systemSound: true, quietHours: { enabled: true, start: "23:00", end: "07:00" } }]);
  });
});

describe("E9b：中断态（bak-only）部分写入 → 重跑补齐", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps({ notifyAsk: false }); // 上次重放只写进 notifyAsk 就被打断
    const legacy = join(dir, "resume-partial.json");
    writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifyAsk: false, notifySound: true }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E9b：中断态部分写入后重跑 → 补齐 + resumed", () => {
    expect(out).toEqual({ performed: false, migrated: true, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: true });
  });

  it("E9b：只补缺失字段 notifySound + D2 声音新键", () => {
    expect(d.updates).toEqual([{ notifySound: true, browserSound: true, systemSound: true }]);
  });
});

describe("E9b：补齐后再次运行 → 幂等跳过，不再写", () => {
  let d: any;
  let out2: any;

  beforeAll(async () => {
    d = deps({ notifyAsk: false });
    const legacy = join(dir, "resume-partial-2.json");
    writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifyAsk: false, notifySound: true }));
    await migrateLegacyConfig(legacy, d);
    // 再跑一次（user 层已全量）→ 幂等跳过，不再写
    out2 = await migrateLegacyConfig(legacy, d);
  });

  it("E9b：补齐后再次运行 → 幂等跳过", () => {
    expect(out2).toEqual({ performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, skippedIdempotent: true, resumed: false });
  });

  it("E9b：幂等运行不重复写入", () => {
    expect(d.updates.length).toBe(1);
  });
});

describe("E9c：用户改值不被迁移覆盖（中断态，只补缺失键）", () => {
  // bak 里 notifyAsk=false，用户已改为 true 且已保存 notifySound——
  // 两条都存在 → 幂等跳过；只缺 quietHours → 只补 quietHours，不动用户值
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps({ notifyAsk: true, notifySound: false }); // 用户改值后的 user 层
    const legacy = join(dir, "user-conflict.json");
    writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifyAsk: false, notifySound: true, quietHours: { enabled: false, start: "22:00", end: "08:00" } }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E9c：缺 quietHours/新声音键 → 迁移补齐", () => {
    expect(out.migrated).toBe(true);
  });

  it("E9c：补缺失键（D2 新键 = 用户 notifySound 值 false）", () => {
    // 用户层 notifySound=false 已表态（用户曾关声音）→ 补写新键取**用户值**
    // false（不因 legacy 的 true 复活成突然有声）
    expect(d.updates).toEqual([{ browserSound: false, systemSound: false, quietHours: { enabled: false, start: "22:00", end: "08:00" } }]);
  });

  it("E9c：用户改过的 notifyAsk 不被迁移覆盖", () => {
    expect(d.readUser().notifyAsk).toBe(true);
  });

  it("E9c：用户已存在的 notifySound 不被迁移覆盖", () => {
    expect(d.readUser().notifySound).toBe(false);
  });
});

describe("E9d：json 正常迁移 + user 键全量已存在 → 改名后幂等跳过", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps({ notifyAsk: true }); // 用户已把该键改成 true
    const legacy = join(dir, "valid-user.json");
    writeFileSync(legacy, JSON.stringify({ notifyAsk: false })); // legacy 里是 false
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E9d：user 全量存在 → 改名后幂等跳过", () => {
    expect(out).toEqual({ performed: true, migrated: false, rolledBack: false, skippedCorrupt: false, skippedIdempotent: true, resumed: false });
  });

  it("E9d：不重复写入", () => {
    expect(d.updates.length).toBe(0);
  });

  it("E9d：用户改值不被迁移覆盖", () => {
    expect(d.readUser().notifyAsk).toBe(true);
  });
});

describe("E9e：冲突策略字段粒度 = 顶层配置键", () => {
  // user 层 quietHours 以部分子键形态存在（用户只 PUT 过子键 start）即视为用户
  // 已接管整组：不补写嵌套子键（bak 的 enabled/end 不覆盖不补），迁移只补顶层
  // 缺失键 notifySound
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps({ notifyAsk: true, quietHours: { start: "07:00" } }); // 用户部分子键接管
    const legacy = join(dir, "subkey-owner.json");
    writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifyAsk: false, notifySound: true, quietHours: { enabled: false, start: "22:00", end: "08:00" } }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E9e：缺顶层键 → 迁移补齐（notifySound + D2 新键）", () => {
    expect(out.migrated).toBe(true);
  });

  it("E9e：不补写 quietHours 嵌套子键（仅顶层缺失键，含 D2 声音新键）", () => {
    expect(d.updates).toEqual([{ notifySound: true, browserSound: true, systemSound: true }]);
  });

  it("E9e：用户部分子键保持原样（不被 bak 子键覆盖）", () => {
    expect(d.readUser().quietHours).toEqual({ start: "07:00" });
  });
});

describe("E9f：json 正常迁移含未知键 → 缺失补写、已存在不覆盖", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps({ notifyAsk: true, futureKey: "user-value" }); // user 层已存在 futureKey
    const legacy = join(dir, "future-mix.json");
    writeFileSync(legacy, JSON.stringify({ notifyAsk: false, futureKey: "legacy-value", futureKey2: { a: 1 }, configFile: "/x" }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E9f：纯未知键 json 正常迁移透传补写", () => {
    expect(out.migrated).toBe(true);
  });

  it("E9f：缺失未知键补写、已存在未知键不覆盖、装配键 configFile 剔除", () => {
    expect(d.updates).toEqual([{ futureKey2: { a: 1 } }]);
  });

  it("E9f：用户已存在未知键不被 legacy 覆盖", () => {
    expect(d.readUser().futureKey).toBe("user-value");
  });

  it("E9f：用户已改 notifyAsk 不被覆盖（#468 不变）", () => {
    expect(d.readUser().notifyAsk).toBe(true);
  });

  it("E9f：装配键 configFile 不入 user 层", () => {
    expect(!("configFile" in d.readUser())).toBeTruthy();
  });
});

describe("E9g：纯未知键 legacy json（user 层空）→ 透传补写迁移", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps();
    const legacy = join(dir, "future-only.json");
    writeFileSync(legacy, JSON.stringify({ futureKey: 1, bogus: "x" }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E9g：纯未知键 legacy 不再判无有效键 → 透传迁移", () => {
    expect(out.migrated).toBe(true);
  });

  it("E9g：未知键原样补写", () => {
    expect(d.updates).toEqual([{ futureKey: 1, bogus: "x" }]);
  });
});

describe("E9h：legacy json 仅含装配键 → 净化后无键可写", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps();
    const legacy = join(dir, "assembly-only.json");
    writeFileSync(legacy, JSON.stringify({ configFile: "/x", enabled: true }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E9h：仅装配键 legacy 无键可迁移", () => {
    expect(out.migrated).toBe(false);
  });

  it("E9h：仅装配键 legacy 标记 corrupted", () => {
    expect(out.skippedCorrupt).toBe(true);
  });

  it("E9h：仅装配键不写入", () => {
    expect(d.updates.length).toBe(0);
  });
});

describe("E9i：legacy 含原型链成员键 → 不崩、正常键照常补写", () => {
  let d: any;
  let out: any;
  let legacy: string;
  let threw = false;

  beforeAll(async () => {
    d = deps();
    legacy = join(dir, "proto-mix.json");
    // 手动 JSON 文本：JSON.parse 后 __proto__/constructor 等均为**自有键**
    // （对象字面量 __proto__ 是原型语法，测不到真实威胁形态）
    writeFileSync(legacy, '{"notifyAsk":false,"futureKey":1,"constructor":2,"toString":3,"__proto__":{"polluted":1}}');
    try {
      out = await migrateLegacyConfig(legacy, d);
    } catch {
      threw = true;
    }
  });

  it("E9i：原型键 legacy 不抛异常（迁移不崩）", () => {
    expect(threw).toBe(false);
  });

  it("E9i：原型键 legacy 正常迁移（正常键补写）", () => {
    expect(out.migrated).toBe(true);
  });

  it("E9i：原型键剔除、只写正常键", () => {
    expect(d.updates).toEqual([{ notifyAsk: false, futureKey: 1 }]);
  });

  it("E9i：原型键不写 user 层", () => {
    expect(Object.prototype.hasOwnProperty.call(d.readUser(), "constructor") === false && Object.prototype.hasOwnProperty.call(d.readUser(), "toString") === false).toBeTruthy();
  });

  it("E9i：无全局原型污染", () => {
    expect(Object.prototype.polluted).toBe(undefined);
  });

  it("E9i：正常迁移改名 migrated.bak（未因原型键中断）", () => {
    expect(existsSync(legacy + MIGRATED_BAK_SUFFIX)).toBeTruthy();
  });
});

describe("E9j：legacy 为数组 → 视为非对象标记 corrupted 不写入", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps();
    const legacy = join(dir, "array-legacy.json");
    writeFileSync(legacy, JSON.stringify([1, 2]));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E9j：数组 legacy 不迁移（非对象语义）", () => {
    expect(out.migrated).toBe(false);
  });

  it("E9j：数组 legacy 标记 corrupted", () => {
    expect(out.skippedCorrupt).toBe(true);
  });

  it("E9j：数组 legacy 不写入", () => {
    expect(d.updates.length).toBe(0);
  });
});

describe("E9k：legacy 未知键 null 值透传补写（与 PUT 同净化通道一致）", () => {
  let d: any;
  let out: any;

  beforeAll(async () => {
    d = deps();
    const legacy = join(dir, "null-future.json");
    writeFileSync(legacy, JSON.stringify({ notifySound: true, nullFuture: null }));
    out = await migrateLegacyConfig(legacy, d);
  });

  it("E9k：含 null 未知键 legacy 正常迁移", () => {
    expect(out.migrated).toBe(true);
  });

  it("E9k：已知键+null 未知键一并补写（D2 声音新键随 notifySound 补齐）", () => {
    expect(d.updates).toEqual([{ notifySound: true, nullFuture: null, browserSound: true, systemSound: true }]);
  });

  it("E9k：nullFuture 键入 user 层", () => {
    expect(Object.prototype.hasOwnProperty.call(d.readUser(), "nullFuture")).toBe(true);
  });

  it("E9k：nullFuture 值为 null", () => {
    expect(d.readUser().nullFuture).toBe(null);
  });
});
