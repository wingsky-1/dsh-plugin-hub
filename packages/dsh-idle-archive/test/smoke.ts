// @ts-nocheck
/**
 * dsh-idle-archive — 冒烟测试（fake ctx，无网络）。
 *
 * 覆盖：
 * - sanitizeSettings：默认值 / 合法修改 / 越界钳制 / 未知键忽略
 * - readState / writeState：缺文件回落默认、坏 JSON 回落、原子写、过期 snooze 清理
 * - handler：health / state / config / snooze / snoozeMany / clearSnooze / 非法参数 / 未知端点
 * - apply：RPC 通道注册（authority loopback）、health 路由注册、effect disposer 清理
 * - health 路由围栏：非回环 403、非 GET 405、GET 200
 * - 客户端契约：id / use strict / IIFE / apply / inject / SymbolTag / factory / load 在末尾
 * - 客户端与宿主 CHANNEL 一致性
 */
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
import {
  apply,
  CHANNEL,
  ROUTES,
  stateFile,
  defaultSettings,
  sanitizeSettings,
  readState,
  writeState,
  handler,
  titleOfAgent,
  isLoopbackRequest,
} from "../lib/index.js";

// 结构化单元测试（#82 批次 6：settings 命名空间路径 / isUnloading / warn /
// persistSettingsFromStore / sanitizeSettings 边界），对齐 notifier/provider-usage
// 样板：smoke.ts 作为入口同步加载（package.json test 命令只跑 smoke.ts）。
// #83 剩余缺口：三纯函数（settings/state/title）结构化单测同批挂载，
// unit 断言只写在 unit-*.test.ts 内，本文件不混入。
import "./unit-apply.test.ts";
import "./unit-settings.test.ts";
import "./unit-state.test.ts";
import "./unit-title.test.ts";

// 隔离 DSH_HOME：全部落盘到临时目录，不碰真实 ~/.dsh。
const HOME = mkdtempSync(join(tmpdir(), "dia-"));
process.env.DSH_HOME = HOME;

function cleanup() {
  rmSync(HOME, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 纯函数

const def = defaultSettings();
assert.equal(def.idleHours, 72);
assert.equal(def.snoozeHours, 24);
assert.equal(def.scanMinutes, 60);
assert.equal(def.enabled, true);

// 合法修改
let s = sanitizeSettings({ idleHours: 12, snoozeHours: 6, scanMinutes: 30, enabled: false });
assert.equal(s.idleHours, 12);
assert.equal(s.snoozeHours, 6);
assert.equal(s.scanMinutes, 30);
assert.equal(s.enabled, false);
assert.equal(s.maxRows, def.maxRows); // 未知/缺省键保持默认

// 越界钳制
s = sanitizeSettings({ idleHours: 0, snoozeHours: 99999, scanMinutes: 1, maxRows: 0 });
assert.equal(s.idleHours, 1);
assert.equal(s.snoozeHours, 24 * 30);
assert.equal(s.scanMinutes, 5);
assert.equal(s.maxRows, 1);

// 非法输入回落默认
assert.deepEqual(sanitizeSettings(null), def);
assert.deepEqual(sanitizeSettings("x"), def);
assert.deepEqual(sanitizeSettings({ idleHours: "abc", enabled: "yes" }), def);

// 持久化：写后读一致；坏 JSON 回落默认
await writeState({ settings: sanitizeSettings({ idleHours: 8 }), snoozed: {} });
let st = await readState();
assert.equal(st.settings.idleHours, 8);
const path = stateFile();
assert.ok(existsSync(path));
const raw = JSON.parse(readFileSync(path, "utf8"));
assert.equal(raw.settings.idleHours, 8);
await writeState({ settings: def, snoozed: {} });
await import("node:fs/promises").then((fsp) => fsp.writeFile(path, "{broken", "utf8"));
st = await readState();
assert.equal(st.settings.idleHours, def.idleHours); // 坏文件不炸，回落默认

// 过期 snooze 清理
await writeState({ settings: def, snoozed: { old: 1, fresh: Date.now() + 3600_000 } });
st = await readState();
assert.ok(!("old" in st.snoozed));
assert.ok("fresh" in st.snoozed);

// ---------------------------------------------------------------- handler

const rHealth = await handler("health", {});
assert.equal(rHealth.ok, true);
assert.equal(rHealth.value.ok, true);

const rState = await handler("state", {});
assert.equal(rState.ok, true);
assert.equal(rState.value.settings.idleHours, def.idleHours);

const rCfg = await handler("config", { settings: { idleHours: 20, snoozeHours: 5 } });
assert.equal(rCfg.ok, true);
assert.equal(rCfg.value.settings.idleHours, 20);
assert.equal(rCfg.value.settings.snoozeHours, 5);

// snooze 单会话：until = now + hours
const before = Date.now();
const rSn = await handler("snooze", { sessionId: "s1", hours: 2 });
assert.equal(rSn.ok, true);
assert.ok(rSn.value.snoozed.s1 > before + 2 * 3600_000 - 2000);
assert.ok(rSn.value.snoozed.s1 <= before + 2 * 3600_000 + 2000);

// snoozeMany 批量
const rSnM = await handler("snoozeMany", { sessionIds: ["s2", "s3"], hours: 1 });
assert.equal(rSnM.ok, true);
assert.ok(rSnM.value.snoozed.s2 > 0 && rSnM.value.snoozed.s3 > 0);

// clearSnooze
const rCl = await handler("clearSnooze", { sessionId: "s2" });
assert.equal(rCl.ok, true);
assert.ok(!("s2" in rCl.value.snoozed));

// 非法参数
assert.equal((await handler("snooze", {})).ok, false);
assert.equal((await handler("snooze", { sessionId: "" })).ok, false);
assert.equal((await handler("snoozeMany", { sessionIds: [] })).ok, false);
assert.equal((await handler("clearSnooze", {})).ok, false);

// 未知端点
const rUnknown = await handler("nope", {});
assert.equal(rUnknown.ok, false);
assert.equal(rUnknown.error.code, "unknown");

// ---------------------------------------------------------------- loopback 围栏

function fakeReq(overrides = {}) {
  return {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    method: "GET",
    ...overrides,
  };
}

assert.equal(isLoopbackRequest(fakeReq()), true);
assert.equal(isLoopbackRequest(fakeReq({ socket: { remoteAddress: "10.0.0.2" } })), false);
assert.equal(isLoopbackRequest(fakeReq({ headers: { host: "evil.example.com" } })), false);

function makeRes() {
  const rec = { status: 0, text: "" };
  return {
    rec,
    res: {
      writeHead(status, headers) { rec.status = status; rec.headers = headers; },
      write(text) { rec.text += text; },
      end(text) { if (text !== undefined) rec.text += text; },
      on() {},
    },
  };
}

// ---------------------------------------------------------------- fake ctx + apply

function makeFakeCtx(overrides = {}) {
  const routes = [];
  const rpcHandles = [];
  const effects = [];
  let routeDisposed = 0;
  const ctx = {
    logger: { warn: () => {} },
    webServer: {
      register(route) {
        routes.push(route);
        return () => { routeDisposed += 1; };
      },
    },
    inject(services, fn) {
      if (services.includes("connection")) {
        const connectionCtx = {
          connection: {
            rpc: {
              handle(channel, h, opts) {
                rpcHandles.push({ channel, h, opts });
                return () => {};
              },
            },
          },
          effect(fn, label) {
            // 真实 cordis 语义：fn 立即执行，返回 disposer（rpc.handle 的返回值）。
            effects.push({ fn, label });
            return fn();
          },
        };
        if (services.includes("agents")) {
          connectionCtx.agents = overrides.agents;
        }
        fn(connectionCtx);
      }
    },
    effect(fn, label) {
      effects.push({ fn, label });
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
  };
  return { ctx, routes, rpcHandles, effects, getRouteDisposed: () => routeDisposed };
}

const { ctx, routes, rpcHandles, effects, getRouteDisposed } = makeFakeCtx();
apply(ctx);

// titles：标题提取（session/title 事件）与缺省容错
{
  const titleAgent = { session: { id: "s-title", events: [{ type: "chat/complete", data: {} }, { type: "session/title", data: { title: " 修复 gzip 压缩  " } }] } };
  const noTitleAgent = { session: { id: "s-none", events: [{ type: "chat/complete", data: {} }] } };
  const { ctx: ctxT, rpcHandles: rpcT } = makeFakeCtx({ agents: { list: () => [titleAgent, noTitleAgent] } });
  apply(ctxT);
  const h = rpcT[0].h;
  const r = await h("titles", { sessionIds: ["s-title", "s-none", "s-missing"] });
  assert.equal(r.ok, true);
  assert.equal(r.value.titles["s-title"], "修复 gzip 压缩", "从 session/title 事件提取并 trim");
  assert.equal(r.value.titles["s-none"], undefined, "无标题会话不返回");
  assert.equal(r.value.titles["s-missing"], undefined, "非 live agent 不返回");
  const rEmpty = await h("titles", {});
  assert.equal(rEmpty.ok, true);
  assert.deepEqual(rEmpty.value.titles, {}, "空请求返回空映射");
}
// titleOfAgent 直接单测
assert.equal(titleOfAgent({ session: { events: [{ type: "session/title", data: { title: "标题" } }] } }), "标题");
assert.equal(titleOfAgent({ session: { events: [] } }), undefined);
assert.equal(titleOfAgent(undefined), undefined);
assert.equal(titleOfAgent({ session: { events: [{ type: "session/title", data: { title: "  " } }] } }), undefined, "空白标题视为无");

// RPC 通道已注册（authority loopback）
assert.equal(rpcHandles.length, 1);
assert.equal(rpcHandles[0].channel, CHANNEL);
assert.equal(rpcHandles[0].opts.authority, "loopback");
assert.equal(rpcHandles[0].h, handler);

// health 路由已注册
assert.equal(routes.length, 1);
assert.equal(routes[0].path, ROUTES.health);
assert.equal(routes[0].kind, "exact");

// effect disposer：卸载时清理路由（effects[0] 是 connectionCtx 的 RPC 注册，
// effects[1] 是 apply 级 ctx.effect，其返回的 disposer 负责清理路由）。
assert.equal(effects.length, 2);
const disposer = effects[1].fn();
assert.equal(getRouteDisposed(), 0);
disposer();
assert.equal(getRouteDisposed(), 1);

// health 路由围栏：403 / 405 / 200
const { res: res403, rec: rec403 } = makeRes();
routes[0].handler(fakeReq({ socket: { remoteAddress: "192.168.1.9" } }), res403);
assert.equal(rec403.status, 403);
const { res: res405, rec: rec405 } = makeRes();
routes[0].handler(fakeReq({ method: "POST" }), res405);
assert.equal(rec405.status, 405);
const { res: res200, rec: rec200 } = makeRes();
routes[0].handler(fakeReq(), res200);
assert.equal(rec200.status, 200);
assert.ok(rec200.text.includes('"plugin":"dsh-idle-archive"'));

// ---------------------------------------------------------------- 客户端契约

const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
// 客户端契约断言（共享 smoke-lib：源形态 + 执行契约，与 contract-check 同源）
assertClientSourceContract(pkgDir);
assertClientProductContract(pkgDir);

// CHANNEL 一致性（宿主与客户端单一来源）
assert.ok(client.includes('"/dsh-idle-archive"'), "客户端 CHANNEL 与宿主一致");

// i18n 接入哨兵（issue #348）：双语字典 + 官方 locale 双通道接线进产物
assert.ok(client.includes('"settings.idleArchive"'), "i18n 命名空间 NS 进产物");
assert.ok(client.includes("locale.register"), "locale.register（字典注册）进产物");
assert.ok(client.includes("locale.bind"), "locale.bind（原生 DOM 通道 t 绑定）进产物");
assert.ok(client.includes("just now") && client.includes("justNow"), "en/zh 双语字典进产物");
assert.ok(client.includes("locale: NS"), "slots.register locale 参数（React 通道）进产物");

console.log("PASS: dsh-idle-archive smoke（handler / apply / 围栏 / 契约）");
cleanup();
