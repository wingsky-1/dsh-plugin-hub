// @ts-nocheck
/**
 * dsh-notifier — e2e：存量配置迁移（issue #76 E1-E7 / R1；#468 逐字段补齐）。
 *
 * 覆盖：
 * - E1 旧 json 存在 → 一次性迁移至官方 settings user 层，原文改名 .migrated.bak；
 * - E2 迁移幂等：二次启动 .bak 存在且 json 不存在且 user 层有值 → 跳过（不重复写入）；
 * - E3 中断态重放：.migrated.bak 存在且 json 不存在且 user 层为空 → 重放写入；
 * - E4 损坏/非对象/无有效键 → 改名 .corrupted.bak，不写入；
 * - E5 Windows rename 目标已存在 → 先 unlink 旧 bak 再 rename；
 * - E6 迁移写入失败 → 回滚改名（json 还原）+ warn，不阻塞启动；
 * - E7 迁移前置于 enabled 判定（禁用态也迁移，路由/命名空间照常注册）；
 * - E8 migrateLegacyConfig outcome 精确断言（#468 起迁移完成判定 = 逐字段缺失
 *   补齐，不再是「user 层任意键存在」整体跳过）；
 * - E9 #468 回归：中断部分写入后重跑补齐剩余字段；用户改值不被迁移覆盖
 *   （冲突策略：只补写 user 层缺失的键，用户已改/已存在的键不被覆盖）。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { assert, makeNotifier, makeFakeSettings, makeFakeCtx } from "./helpers.ts";
import { ROUTES, apply, migrateLegacyConfig, MIGRATED_BAK_SUFFIX, CORRUPTED_BAK_SUFFIX } from "../lib/index.js";

const work = mkdtempSync(join(tmpdir(), "dnotify-migrate-"));
/** 轮询直到谓词成立（替代固定 sleep：迁移是 onScope 内异步 fire-and-forget）。 */
async function pollUntil(predicate, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
try {
  // E1：旧 json 存在 → 迁移 + 改名 .migrated.bak
  {
    const legacy = join(work, "e1-dsh-notifier.json");
    writeFileSync(legacy, JSON.stringify({ notifyAsk: false, quietHours: { enabled: true, start: "23:00", end: "07:00" } }));
    // makeNotifier 的 configFile 指向旧 json；settings user 层预置空
    const { settings } = makeNotifier(work, { configFile: legacy });
    // 迁移在 onScope 内异步执行，轮询直到 user 层写入
    await pollUntil(() => settings.getUser().notifyAsk === false);
    const user = settings.getUser();
    assert.equal(user.notifyAsk, false, "E1：notifyAsk 迁入 settings user 层");
    assert.equal(user.quietHours?.enabled, true, "E1：quietHours 迁入 settings user 层");
    assert.ok(existsSync(legacy + ".migrated.bak"), "E1：原文改名 .migrated.bak");
    assert.ok(!existsSync(legacy), "E1：原 json 已改名（不再作为自建配置读取）");
  }

  // E2：迁移幂等——同一 settings 文档再次 apply（.bak 存在且 json 不存在且
  // user 层有值）→ 不重复写入
  {
    const legacy = join(work, "e2-dsh-notifier.json");
    writeFileSync(legacy, JSON.stringify({ notifyAsk: false }));
    // 首次：共享 fake settings（user 层为空 → 触发迁移）
    const shared = makeFakeSettings({});
    const ctx1 = makeFakeCtx({});
    ctx1.ctx.provide("settings", shared.service);
    apply(ctx1.ctx, { enabled: true, configFile: legacy, historyFile: join(work, "e2-hist.jsonl") });
    await pollUntil(() => shared.getUser().notifyAsk === false);
    const callsAfterFirst = shared.getUpdateCalls().length;
    assert.ok(callsAfterFirst >= 1, "E2：首次迁移触发写入");
    // 二次：同一 settings 文档（user 层已有值）→ 幂等跳过（不触发 update）
    const ctx2 = makeFakeCtx({});
    ctx2.ctx.provide("settings", shared.service);
    apply(ctx2.ctx, { enabled: true, configFile: legacy, historyFile: join(work, "e2-hist.jsonl") });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const callsAfterSecond = shared.getUpdateCalls().length;
    assert.equal(callsAfterSecond, callsAfterFirst, "E2：二次启动幂等跳过（不重复写入 settings）");
    assert.equal(shared.getUser().notifyAsk, false, "E2：user 层保留首次迁移结果");
  }

  // E3：中断态重放——.migrated.bak 存在且 json 不存在且 user 层为空 → 重放写入
  {
    const legacy = join(work, "e3-dsh-notifier.json");
    const bak = legacy + ".migrated.bak";
    writeFileSync(bak, JSON.stringify({ notifyTaskDone: false })); // 模拟「改名成功但 update 前被杀」
    const { settings } = makeNotifier(work, { configFile: legacy });
    await pollUntil(() => settings.getUser().notifyTaskDone === false);
    assert.equal(settings.getUser().notifyTaskDone, false, "E3：中断态从 bak 重放写入 settings");
  }

  // E4：损坏 json → 改名 .corrupted.bak，不写入
  {
    const legacy = join(work, "e4-dsh-notifier.json");
    writeFileSync(legacy, "{ not json !!!");
    const { settings } = makeNotifier(work, { configFile: legacy });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(settings.getUser(), {}, "E4：损坏 json 不写入 settings user 层");
    assert.ok(existsSync(legacy + ".corrupted.bak"), "E4：损坏 json 改名 .corrupted.bak 标记");
    assert.ok(!existsSync(legacy), "E4：损坏原文件已改名");
  }

  // E4b：非对象/无有效键 json → 只标记不写入
  {
    const legacy = join(work, "e4b-dsh-notifier.json");
    writeFileSync(legacy, "123");
    const { settings } = makeNotifier(work, { configFile: legacy });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(settings.getUser(), {}, "E4b：非对象 json 不写入");
    assert.ok(existsSync(legacy + ".corrupted.bak"), "E4b：非对象 json 改名 .corrupted.bak");
  }

  // E5：Windows rename 目标已存在 → 先 unlink 旧 bak 再 rename（.migrated.bak 已存在）
  {
    const legacy = join(work, "e5-dsh-notifier.json");
    const bak = legacy + ".migrated.bak";
    writeFileSync(legacy, JSON.stringify({ notifyAsk: true }));
    writeFileSync(bak, "old backup"); // 预置旧 bak（Windows 上 rename 目标已存在会抛错）
    const { settings } = makeNotifier(work, { configFile: legacy });
    await pollUntil(() => settings.getUser().notifyAsk === true);
    assert.equal(settings.getUser().notifyAsk, true, "E5：rename 覆盖旧 bak 后迁移成功");
    const newBak = readFileSync(bak, "utf8");
    assert.ok(newBak.includes("notifyAsk"), "E5：新 bak 内容为本次迁移（旧 bak 已被 unlink 替换）");
  }

  // E6：迁移写入失败 → 回滚改名 + warn，不阻塞启动
  {
    const legacy = join(work, "e6-dsh-notifier.json");
    writeFileSync(legacy, JSON.stringify({ notifyAsk: true }));
    const warns = [];
    // 用一个 update 必失败的 settings 服务（模拟持久化失败）
    const { ctx, routes } = makeFakeCtx({
      logger: { warn: (m) => warns.push(m), info: () => {} },
    });
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
    ctx.provide("settings", failingSettings);
    apply(ctx, { enabled: true, configFile: legacy, historyFile: join(work, "e6-hist.jsonl") });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(existsSync(legacy), "E6：写入失败回滚，原 json 还原");
    assert.ok(warns.some((w) => w.includes("迁移")), "E6：迁移失败输出 warn 日志");
    assert.ok(routes.length >= 5, "E6：迁移失败不阻塞路由注册");
  }

  // E7：enabled=false 禁用态仍迁移（H2/H3 前置）——禁用态 apply 仍注册路由 + 迁移照常
  {
    const legacy = join(work, "e7-dsh-notifier.json");
    writeFileSync(legacy, JSON.stringify({ notifyTaskError: false }));
    const fakeSettings = makeFakeSettings({});
    const { ctx, routes } = makeFakeCtx({});
    ctx.provide("settings", fakeSettings.service);
    apply(ctx, { enabled: false, configFile: legacy, historyFile: join(work, "e7-hist.jsonl") });
    await pollUntil(() => fakeSettings.getUser().notifyTaskError === false);
    const paths = routes.map((r) => r.path);
    for (const route of Object.values(ROUTES)) assert.ok(paths.includes(route), `E7：禁用态仍注册路由 ${route}`);
    assert.equal(fakeSettings.getUser().notifyTaskError, false, "E7：禁用态仍迁移旧配置");
  }

  // E8：migrateLegacyConfig outcome 精确断言（直测，对照 stryker 幸存名单——
  // 布尔结果字段翻转/逻辑运算符/条件分支的存活变异体由 outcome 深比较杀灭）
  {
    const dir = mkdtempSync(join(tmpdir(), "dnotify-migrate-outcome-"));
    // 直测注入面（#468 起 readUser）：user 层当前值可预置（模拟部分写入/用户改值）
    const deps = (user = {}, failUpdate = false) => {
      const updates = [];
      return {
        updates,
        readUser: () => user,
        async update(patch) {
          if (failUpdate) throw new Error("io boom");
          // #468 P1-4：锁死「只补缺失键」语义——update 提交的每个键在写入前
          // 必须不存在于 user 层（防未来实现改成快照全量/覆盖写导致漏报）
          for (const key of Object.keys(patch)) {
            assert.equal(key in user, false, `E9：update 不得提交 user 层已存在的键 ${key}`);
          }
          updates.push(patch);
          Object.assign(user, patch);
        },
      };
    };
    const IDLE = { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, skippedIdempotent: true, resumed: false };
    const CORRUPT_ONLY = { performed: false, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: true, resumed: false };
    // idle：json 与 bak 都不存在
    {
      const d = deps();
      const legacy = join(dir, "idle.json");
      const out = await migrateLegacyConfig(legacy, d);
      assert.deepEqual(out, IDLE, "E8：双文件不存在 → idle outcome 全 false/skippedIdempotent");
      assert.equal(d.updates.length, 0, "E8：idle 不写入");
    }
    // 损坏标记态：只有 .corrupted.bak → 幂等跳过
    {
      const d = deps();
      const legacy = join(dir, "corrupt-only.json");
      writeFileSync(legacy + CORRUPTED_BAK_SUFFIX, "{oops");
      const out = await migrateLegacyConfig(legacy, d);
      assert.deepEqual(out, CORRUPT_ONLY, "E8：损坏标记态 → skippedCorrupt+skippedIdempotent");
      assert.equal(d.updates.length, 0, "E8：损坏标记态不写入");
    }
    // migrated.bak 存在 + user 层全量有值 → 幂等跳过（E2）
    {
      const d = deps({ notifyAsk: false, notifySound: true });
      const legacy = join(dir, "bak-user.json");
      writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifyAsk: false, notifySound: true }));
      const out = await migrateLegacyConfig(legacy, d);
      assert.deepEqual(out, IDLE, "E8：bak 存在 + user 已全量 → 幂等跳过");
      assert.equal(d.updates.length, 0, "E8：幂等跳过不写入");
    }
    // 中断态重放成功：bak 存在 + user 空 + bak 合法 → resumed+migrated
    {
      const d = deps();
      const legacy = join(dir, "resume-ok.json");
      writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifySound: false }));
      const out = await migrateLegacyConfig(legacy, d);
      assert.deepEqual(out, { performed: false, migrated: true, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: true }, "E8：中断态重放成功 outcome");
      assert.deepEqual(d.updates, [{ notifySound: false }], "E8：重放写入键集");
    }
    // 中断态重放失败：bak 非法 JSON → skippedCorrupt+resumed，不写入
    {
      const d = deps();
      const legacy = join(dir, "resume-bad.json");
      writeFileSync(legacy + MIGRATED_BAK_SUFFIX, "{bad json");
      const out = await migrateLegacyConfig(legacy, d);
      assert.deepEqual(out, { performed: false, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: false, resumed: true }, "E8：中断态 bak 损坏 → 标记跳过");
      assert.equal(d.updates.length, 0, "E8：损坏 bak 不写入");
    }
    // 中断态重放：bak 仅含未知键 → #470 P2-1 透传补写（不再是「无有效键」，
    // 升级不丢 legacy 未来键），skippedCorrupt=false
    {
      const d = deps();
      const legacy = join(dir, "resume-future.json");
      writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ futureKey: { a: 1 } }));
      const out = await migrateLegacyConfig(legacy, d);
      assert.equal(out.resumed, true, "E8：纯未知键重放标记 resumed");
      assert.equal(out.migrated, true, "E8：#470 纯未知键重放透传迁移（不再判无有效键）");
      assert.equal(out.skippedCorrupt, false, "E8：#470 纯未知键不标记 corrupted");
      assert.deepEqual(d.updates, [{ futureKey: { a: 1 } }], "E8：#470 纯未知键原样补写");
    }
    // 中断态重放失败：bak 无任何键 → skippedCorrupt+resumed
    {
      const d = deps();
      const legacy = join(dir, "resume-empty.json");
      writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({}));
      const out = await migrateLegacyConfig(legacy, d);
      assert.equal(out.resumed, true, "E8：无键重放标记 resumed");
      assert.equal(out.migrated, false, "E8：无键重放不迁移");
      assert.equal(out.skippedCorrupt, true, "E8：无键重放标记 corrupted");
      assert.equal(d.updates.length, 0, "E8：无键不写入");
    }
    // 损坏 json：只标记 .corrupted.bak，不写入（E4）
    {
      const d = deps();
      const legacy = join(dir, "broken.json");
      writeFileSync(legacy, "{ not json !!!");
      const out = await migrateLegacyConfig(legacy, d);
      assert.deepEqual(out, { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: false, resumed: false }, "E8：损坏 json outcome");
      assert.ok(existsSync(legacy + CORRUPTED_BAK_SUFFIX), "E8：损坏 json 改名 corrupted.bak");
      assert.equal(d.updates.length, 0, "E8：损坏 json 不写入");
    }
    // 非对象 json → 只标记（E4b）
    {
      const d = deps();
      const legacy = join(dir, "nonobj.json");
      writeFileSync(legacy, "123");
      const out = await migrateLegacyConfig(legacy, d);
      assert.equal(out.performed, true, "E8：非对象 json performed");
      assert.equal(out.skippedCorrupt, true, "E8：非对象 json 标记 corrupted");
      assert.equal(d.updates.length, 0, "E8：非对象 json 不写入");
    }
    // 合法 json → renamed-first 后写入，outcome migrated+performed（E1）
    {
      const d = deps();
      const legacy = join(dir, "valid.json");
      writeFileSync(legacy, JSON.stringify({ notifyAsk: false, quietHours: { enabled: true, start: "23:00", end: "07:00" } }));
      const out = await migrateLegacyConfig(legacy, d);
      assert.deepEqual(out, { performed: true, migrated: true, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: false }, "E8：合法 json outcome");
      assert.ok(existsSync(legacy + MIGRATED_BAK_SUFFIX), "E8：合法 json 改名 migrated.bak");
      assert.ok(!existsSync(legacy), "E8：原 json 已改名");
      assert.deepEqual(d.updates[0], { notifyAsk: false, quietHours: { enabled: true, start: "23:00", end: "07:00" } }, "E8：写入键集 = sanitize 白名单");
    }
    // 写入失败 → 回滚改名（E6）：json 还原 + rolledBack
    {
      const d = deps({}, true);
      const legacy = join(dir, "rollback.json");
      writeFileSync(legacy, JSON.stringify({ notifyAsk: true }));
      const out = await migrateLegacyConfig(legacy, d, { warn: () => {} });
      assert.deepEqual(out, { performed: true, migrated: false, rolledBack: true, skippedCorrupt: false, skippedIdempotent: false, resumed: false }, "E8：写入失败回滚 outcome");
      assert.ok(existsSync(legacy), "E8：回滚后原 json 还原");
      assert.ok(!existsSync(legacy + MIGRATED_BAK_SUFFIX), "E8：回滚后 migrated.bak 已还原为 json");
    }
    // #468 E9a：json 迁移部分写入中断（user 层只落了部分键）→ 重跑补齐剩余字段
    {
      const d = deps({ notifyAsk: false }); // 上次迁移只写进 notifyAsk 就被打断
      const legacy = join(dir, "partial.json");
      writeFileSync(legacy, JSON.stringify({ notifyAsk: false, notifySound: true, quietHours: { enabled: true, start: "23:00", end: "07:00" } }));
      const out = await migrateLegacyConfig(legacy, d);
      assert.deepEqual(out, { performed: true, migrated: true, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: false }, "E9a：部分写入中断后重跑 → 继续迁移");
      assert.deepEqual(d.updates, [{ notifySound: true, quietHours: { enabled: true, start: "23:00", end: "07:00" } }], "E9a：只补写 user 层缺失字段（已写 notifyAsk 不重写）");
    }
    // #468 E9b：中断态（bak-only）部分写入 → 重跑补齐，全部齐后再跑幂等跳过
    {
      const d = deps({ notifyAsk: false }); // 上次重放只写进 notifyAsk 就被打断
      const legacy = join(dir, "resume-partial.json");
      writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifyAsk: false, notifySound: true }));
      const out = await migrateLegacyConfig(legacy, d);
      assert.deepEqual(out, { performed: false, migrated: true, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: true }, "E9b：中断态部分写入后重跑 → 补齐 + resumed");
      assert.deepEqual(d.updates, [{ notifySound: true }], "E9b：只补缺失字段 notifySound");
      // 再跑一次（user 层已全量）→ 幂等跳过，不再写
      const out2 = await migrateLegacyConfig(legacy, d);
      assert.deepEqual(out2, { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, skippedIdempotent: true, resumed: false }, "E9b：补齐后再次运行 → 幂等跳过");
      assert.equal(d.updates.length, 1, "E9b：幂等运行不重复写入");
    }
    // #468 E9c：用户改值不被迁移覆盖（冲突策略：只补 user 层缺失键）
    // 中断态：bak 里 notifyAsk=false，用户已改为 true 且已保存 notifySound——
    // 两条都存在 → 幂等跳过；只缺 quietHours → 只补 quietHours，不动用户值
    {
      const d = deps({ notifyAsk: true, notifySound: false }); // 用户改值后的 user 层
      const legacy = join(dir, "user-conflict.json");
      writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifyAsk: false, notifySound: true, quietHours: { enabled: false, start: "22:00", end: "08:00" } }));
      const out = await migrateLegacyConfig(legacy, d);
      assert.equal(out.migrated, true, "E9c：缺 quietHours → 迁移补齐");
      assert.deepEqual(d.updates, [{ quietHours: { enabled: false, start: "22:00", end: "08:00" } }], "E9c：只补缺失键 quietHours");
      assert.equal(d.readUser().notifyAsk, true, "E9c：用户改过的 notifyAsk 不被迁移覆盖");
      assert.equal(d.readUser().notifySound, false, "E9c：用户已存在的 notifySound 不被迁移覆盖");
    }
    // #468 E9d：json 正常迁移 + user 键全量已存在（经 PUT /config 保存过）→
    // 改名后幂等跳过，不重复写入、不覆盖用户值
    {
      const d = deps({ notifyAsk: true }); // 用户已把该键改成 true
      const legacy = join(dir, "valid-user.json");
      writeFileSync(legacy, JSON.stringify({ notifyAsk: false })); // legacy 里是 false
      const out = await migrateLegacyConfig(legacy, d);
      assert.deepEqual(out, { performed: true, migrated: false, rolledBack: false, skippedCorrupt: false, skippedIdempotent: true, resumed: false }, "E9d：user 全量存在 → 改名后幂等跳过");
      assert.equal(d.updates.length, 0, "E9d：不重复写入");
      assert.equal(d.readUser().notifyAsk, true, "E9d：用户改值不被迁移覆盖");
    }
    // #468 E9e：冲突策略字段粒度 = 顶层配置键——user 层 quietHours 以部分子键
    // 形态存在（用户只 PUT 过子键 start）即视为用户已接管整组：不补写嵌套
    // 子键（bak 的 enabled/end 不覆盖不补），迁移只补顶层缺失键 notifySound
    {
      const d = deps({ notifyAsk: true, quietHours: { start: "07:00" } }); // 用户部分子键接管
      const legacy = join(dir, "subkey-owner.json");
      writeFileSync(legacy + MIGRATED_BAK_SUFFIX, JSON.stringify({ notifyAsk: false, notifySound: true, quietHours: { enabled: false, start: "22:00", end: "08:00" } }));
      const out = await migrateLegacyConfig(legacy, d);
      assert.equal(out.migrated, true, "E9e：缺顶层键 notifySound → 迁移补齐");
      assert.deepEqual(d.updates, [{ notifySound: true }], "E9e：不补写 quietHours 嵌套子键（仅顶层缺失键）");
      assert.deepEqual(d.readUser().quietHours, { start: "07:00" }, "E9e：用户部分子键保持原样（不被 bak 子键覆盖）");
    }
    // #470 E9f：json 正常迁移含未知键 → user 层缺失则补写透传保留；
    // 已存在（用户改过/已存在）→ 不覆盖（#468 不变）
    {
      const d = deps({ notifyAsk: true, futureKey: "user-value" }); // user 层已存在 futureKey
      const legacy = join(dir, "future-mix.json");
      writeFileSync(legacy, JSON.stringify({ notifyAsk: false, futureKey: "legacy-value", futureKey2: { a: 1 }, configFile: "/x" }));
      const out = await migrateLegacyConfig(legacy, d);
      assert.equal(out.migrated, true, "E9f：纯未知键 json 正常迁移透传补写");
      assert.deepEqual(d.updates, [{ futureKey2: { a: 1 } }], "E9f：缺失未知键补写、已存在未知键不覆盖、装配键 configFile 剔除");
      assert.equal(d.readUser().futureKey, "user-value", "E9f：用户已存在未知键不被 legacy 覆盖");
      assert.equal(d.readUser().notifyAsk, true, "E9f：用户已改 notifyAsk 不被覆盖（#468 不变）");
      assert.ok(!("configFile" in d.readUser()), "E9f：装配键 configFile 不入 user 层");
    }
    // #470 E9g：纯未知键 legacy json（user 层空）→ 透传补写迁移（不再判无有效键 corrupt）
    {
      const d = deps();
      const legacy = join(dir, "future-only.json");
      writeFileSync(legacy, JSON.stringify({ futureKey: 1, bogus: "x" }));
      const out = await migrateLegacyConfig(legacy, d);
      assert.equal(out.migrated, true, "E9g：纯未知键 legacy 不再判无有效键 → 透传迁移");
      assert.deepEqual(d.updates, [{ futureKey: 1, bogus: "x" }], "E9g：未知键原样补写");
    }
    // #470 E9h：legacy json 仅含装配键 → 净化后无任何可写键 → 只标记 corrupted 不写入
    {
      const d = deps();
      const legacy = join(dir, "assembly-only.json");
      writeFileSync(legacy, JSON.stringify({ configFile: "/x", enabled: true }));
      const out = await migrateLegacyConfig(legacy, d);
      assert.equal(out.migrated, false, "E9h：仅装配键 legacy 无键可迁移");
      assert.equal(out.skippedCorrupt, true, "E9h：仅装配键 legacy 标记 corrupted");
      assert.equal(d.updates.length, 0, "E9h：仅装配键不写入");
    }
    rmSync(dir, { recursive: true, force: true });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
