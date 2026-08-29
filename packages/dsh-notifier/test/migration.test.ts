// @ts-nocheck
/**
 * dsh-notifier — e2e：存量配置迁移（issue #76 E1-E7 / R1）。
 *
 * 覆盖：
 * - E1 旧 json 存在 → 一次性迁移至官方 settings user 层，原文改名 .migrated.bak；
 * - E2 迁移幂等：二次启动 .bak 存在且 json 不存在且 user 层有值 → 跳过（不重复写入）；
 * - E3 中断态重放：.migrated.bak 存在且 json 不存在且 user 层为空 → 重放写入；
 * - E4 损坏/非对象/无有效键 → 改名 .corrupted.bak，不写入；
 * - E5 Windows rename 目标已存在 → 先 unlink 旧 bak 再 rename；
 * - E6 迁移写入失败 → 回滚改名（json 还原）+ warn，不阻塞启动；
 * - E7 迁移前置于 enabled 判定（禁用态也迁移，路由/命名空间照常注册）。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { assert, makeNotifier, makeFakeSettings, makeFakeCtx } from "./helpers.ts";
import { ROUTES, apply } from "../lib/index.js";

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
} finally {
  rmSync(work, { recursive: true, force: true });
}
