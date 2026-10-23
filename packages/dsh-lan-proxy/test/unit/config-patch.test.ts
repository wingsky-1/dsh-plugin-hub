// dsh-lan-proxy unit：applyConfigPatch（PUT /config 主体：校验 → 官方存储写入）
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出（该文件名为 e2e 却混装 unit 场景族）。
// 断言与 describe 名逐字保留。unit 层直连 src 源码，不 import 包根组合根与构建产物面
// （DEVELOPMENT §I8① 判据）。
// 被测面：src/server/config/impl/routes.ts 内的 patch 主体；deps 为手写 fake
// （只提供原始事实与调用记录，不替被测代码做决定）。

import { beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { applyConfigPatch } from "../../src/server/config/interface.ts";
import type {
  ConfigRouteDeps,
  PatchResult,
  ResolvedConfig,
} from "../../src/server/config/interface.ts";

/** applyConfigPatch 成功分支（ok:true 携带 value）。 */
type PatchSuccess = Extract<PatchResult, { ok: true }>;
/** applyConfigPatch 失败分支（ok:false 携带 status/code/details）。 */
type PatchFailure = Extract<PatchResult, { ok: false }>;

// 共享观测状态提到文件级：拆出的注册函数只负责登记用例，保持「同一 beforeAll 观测、
// 逐 it 断言快照」的原语义（#1174 A1）。钩子仍注册在本 describe 内（vitest 钩子作用域）。
const makeDeps = (
  initialUser: Record<string, unknown> = {},
  opts: { broken?: boolean; conflict?: boolean } = {},
) => {
  const state = {
    user: { ...initialUser },
    updates: [] as Array<{ patch: Record<string, unknown>; expectedRevision?: number }>,
    replaces: [] as Array<{ section: Record<string, unknown>; expectedRevision?: number }>,
  };
  return {
    state,
    deps: {
      resolve: () =>
        ({
          enabled: true,
          host: "0.0.0.0",
          port: 3081,
          httpsEnabled: true,
          httpsPort: 3443,
          targetHost: "127.0.0.1",
          printBanner: true,
        }) as unknown as ResolvedConfig,
      readUser: () => ({ user: { ...state.user }, revision: 7 }),
      writable: () => true,
      update: async (patch: Record<string, unknown>, expectedRevision?: number) => {
        if (opts.broken) throw new Error("disk full");
        if (opts.conflict) throw Object.assign(new Error("stale"), { code: "SETTINGS_CONFLICT" });
        state.updates.push({ patch, expectedRevision });
        Object.assign(state.user, patch);
      },
      replace: async (section: Record<string, unknown>, expectedRevision?: number) => {
        // 与 update 同口径注入写入失败/乐观并发冲突（清除路径走 replace）。
        if (opts.broken) throw new Error("disk full");
        if (opts.conflict) throw Object.assign(new Error("stale"), { code: "SETTINGS_CONFLICT" });
        state.replaces.push({ section, expectedRevision });
        state.user = { ...section };
      },
      compress: () => ({
        httpCompressEnabled: true,
        httpCompressLevel: 1,
        httpCompressMounted: true,
        httpCompressStats: { compressed: 7, passthrough: 2 },
      }),
    } as unknown as ConfigRouteDeps,
  };
};

let hOk!: DepsHandle;

let rOk!: PatchResult;

let hClear!: DepsHandle;

let rClear!: PatchResult;

let badPort!: PatchResult;

let lone!: PatchResult;

let mixedClear!: PatchResult;

let mixedSet!: PatchResult;

let na!: PatchResult;

let clearCertOnly!: PatchResult;

let clearKeyOnly!: PatchResult;

let clearBoth!: PatchResult;

let clearConflict!: PatchResult;

let brokenUser!: PatchResult;

let inPair!: PatchResult;

let orphanPair!: DepsHandle;

let orphanRes!: PatchResult;

let orphanLone!: PatchResult;

let broken!: PatchResult;

let brokenLogWarns: string[] = [];

let conflict!: PatchResult;

type DepsHandle = ReturnType<typeof makeDeps>;

// 场景族按语义分组注册（#1174 A1）：避免顶层 describe 回调超过 max-lines-per-function
// 阈值。分组依据是「族内用例共享同一被测语义」，不是行数硬切；describe 名与嵌套
// 顺序逐字保留，故拆分前后完整名称路径相同。
function registerHappyPathScenarios() {
  describe("patch 合法提交走 update 增量合并且透传 expectedRevision", () => {
    it("ok 为 true", () => {
      expect(rOk.ok).toBe(true);
    });

    it("update 收到 patch 与 expectedRevision", () => {
      expect(hOk.state.updates).toEqual([
        { patch: { port: 4099, printBanner: false }, expectedRevision: 7 },
      ]);
    });

    it("未提交键保持原值", () => {
      expect(hOk.state.user).toEqual({ tlsCertFile: "/x.pem", port: 4099, printBanner: false });
    });

    it("回执 revision 透传", () => {
      expect((rOk as PatchSuccess).value.revision).toEqual(7);
    });
  });

  describe("tls 双空串触发 replace 整节替换并从用户层剔除两个键", () => {
    it("ok 为 true", () => {
      expect(rClear.ok).toBe(true);
    });

    it("走了 replace 路径", () => {
      expect(hClear.state.replaces.length).toBe(1);
    });

    it("不走 update", () => {
      expect(hClear.state.updates.length).toBe(0);
    });

    it("tls 键已剔除、其余键保留", () => {
      expect(hClear.state.user).toEqual({ port: 4000, printBanner: false });
    });
  });

  describe("patch 非法端口 400 且 details 含键名与范围", () => {
    it("ok 为 false", () => {
      expect(badPort.ok).toBe(false);
    });

    it("status 400 且 code=invalid", () => {
      expect((badPort as PatchFailure).status === 400 && (badPort as PatchFailure).code).toBe(
        "invalid",
      );
    });

    it("details 含键名与范围", () => {
      expect(
        (badPort as PatchFailure).details.includes("port") &&
          (badPort as PatchFailure).details.includes("1-65535"),
      ).toBeTruthy();
    });
  });

  it("patch 单边证书被拒（tls-pair）", () => {
    expect(lone.ok === false && (lone as PatchFailure).code).toBe("tls-pair");
  });

  describe("patch 单边空串混非空值被拒（raw 层成对形态判定）", () => {
    it("空 cert + 非空 key → ok=false", () => {
      expect(mixedClear.ok).toBe(false);
    });

    it("空 cert + 非空 key → code=tls-pair", () => {
      expect((mixedClear as PatchFailure).code).toBe("tls-pair");
    });

    it("空 cert + 非空 key → status=400", () => {
      expect((mixedClear as PatchFailure).status).toBe(400);
    });

    it("非空 cert + 空 key → ok=false", () => {
      expect(mixedSet.ok).toBe(false);
    });

    it("非空 cert + 空 key → code=tls-pair", () => {
      expect((mixedSet as PatchFailure).code).toBe("tls-pair");
    });
  });

  it("settings 服务不可用时写入 503 拒绝", () => {
    expect(na.ok === false && (na as PatchFailure).status).toBe(503);
  });
}

function registerTlsPairScenarios() {
  describe("#467 只清 cert（另一侧未提交）400 tls-pair 拒绝，不落盘", () => {
    it("ok 为 false", () => {
      expect(clearCertOnly.ok).toBe(false);
    });

    it("status 400", () => {
      expect((clearCertOnly as PatchFailure).status).toBe(400);
    });

    it("code=tls-pair", () => {
      expect((clearCertOnly as PatchFailure).code).toBe("tls-pair");
    });
  });

  describe("#467 只清 key（另一侧未提交）400 tls-pair 拒绝，不落盘", () => {
    it("ok 为 false", () => {
      expect(clearKeyOnly.ok).toBe(false);
    });

    it("status 400", () => {
      expect((clearKeyOnly as PatchFailure).status).toBe(400);
    });

    it("code=tls-pair", () => {
      expect((clearKeyOnly as PatchFailure).code).toBe("tls-pair");
    });
  });

  describe("#467 双清（同空）整套成对剔除，user 层不留任何 tls 键", () => {
    it("ok 为 true", () => {
      expect(clearBoth.ok).toBe(true);
    });

    it("tlsCertFile 已剔除", () => {
      expect((clearBoth as PatchSuccess).value.user.tlsCertFile).toBe(undefined);
    });

    it("tlsKeyFile 已剔除", () => {
      expect((clearBoth as PatchSuccess).value.user.tlsKeyFile).toBe(undefined);
    });

    it("其余键保留（port）", () => {
      expect((clearBoth as PatchSuccess).value.user.port).toBe(4000);
    });

    it("其余键保留（printBanner）", () => {
      expect((clearBoth as PatchSuccess).value.user.printBanner).toBe(false);
    });
  });

  describe("#467 清除遇 SETTINGS_CONFLICT 映射 409/conflict 固定文案", () => {
    it("ok 为 false", () => {
      expect(clearConflict.ok).toBe(false);
    });

    it("status 409", () => {
      expect((clearConflict as PatchFailure).status).toBe(409);
    });

    it("code=conflict", () => {
      expect((clearConflict as PatchFailure).code).toBe("conflict");
    });

    it("固定文案", () => {
      expect((clearConflict as PatchFailure).details).toBe("设置已被其他窗口修改，请刷新后重试");
    });
  });

  it("#467 双清不会产生含 undefined 段的路径（user 层干净成对）", () => {
    const user = (brokenUser as PatchSuccess).value.user;
    const fsPath = join(String(user?.tlsCertFile ?? ""), String(user?.tlsKeyFile ?? ""));
    expect(!fsPath.includes("undefined")).toBeTruthy();
  });

  describe("#467 只设 key 亦被拒（任一单侧显式即 400，含未清除意图）", () => {
    it("ok 为 false", () => {
      expect(inPair.ok).toBe(false);
    });

    it("code=tls-pair", () => {
      expect((inPair as PatchFailure).code).toBe("tls-pair");
    });
  });

  describe("#467 user 层已不完整（孤儿单侧残留）双清 replace 自愈，无孤儿留存", () => {
    it("ok 为 true", () => {
      expect(orphanRes.ok).toBe(true);
    });

    it("tlsCertFile 已剔除", () => {
      expect((orphanRes as PatchSuccess).value.user.tlsCertFile).toBe(undefined);
    });

    it("tlsKeyFile 已剔除", () => {
      expect((orphanRes as PatchSuccess).value.user.tlsKeyFile).toBe(undefined);
    });

    it("走 replace 整节替换", () => {
      expect(orphanPair.state.replaces.length).toBe(1);
    });
  });

  describe("#467 user 层已不完整时单侧清除仍被拒（不落盘半套）", () => {
    it("ok 为 false", () => {
      expect(orphanLone.ok).toBe(false);
    });

    it("code=tls-pair", () => {
      expect((orphanLone as PatchFailure).code).toBe("tls-pair");
    });
  });
}

function registerFailureMappingScenarios() {
  describe("写入异常映射 500/error 且 details 不泄露底层错误原文", () => {
    it("status 500", () => {
      expect(broken.ok === false && (broken as PatchFailure).status).toBe(500);
    });

    it("code=error", () => {
      expect((broken as PatchFailure).code).toBe("error");
    });

    it("details 为固定文案", () => {
      expect((broken as PatchFailure).details).toBe("保存失败，请查看服务端日志");
    });

    it("details 不含 err.message 原文", () => {
      expect(!(broken as PatchFailure).details.includes("disk full")).toBeTruthy();
    });

    it("err.message 走服务端日志", () => {
      expect(brokenLogWarns.some((m) => m.includes("disk full"))).toBeTruthy();
    });
  });

  describe("SETTINGS_CONFLICT 映射 409/conflict", () => {
    it("status 409", () => {
      expect(conflict.ok === false && (conflict as PatchFailure).status).toBe(409);
    });

    it("code=conflict", () => {
      expect((conflict as PatchFailure).code).toBe("conflict");
    });
  });
}

describe("unit: applyConfigPatch（PUT /config 主体：校验 → 官方存储写入）", () => {
  beforeAll(async () => {
    // 合法 patch：validate/sanitize 后增量 update（expectedRevision 透传）。
    hOk = makeDeps({ tlsCertFile: "/x.pem" as unknown });
    rOk = await applyConfigPatch(hOk.deps, {
      patch: { port: 4099, printBanner: false },
      expectedRevision: 7,
    });

    // 清除证书路径：raw 空字符串 → replace 整节（unset 语义），其余键保留。
    hClear = makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 });
    rClear = await applyConfigPatch(hClear.deps, {
      patch: { tlsCertFile: "", tlsKeyFile: "", printBanner: false },
    });

    // 校验失败：首个非法键定位 + 范围提示。
    badPort = await applyConfigPatch(makeDeps().deps, { patch: { port: 70000 } });
    // tls 成对约束。
    lone = await applyConfigPatch(makeDeps().deps, { patch: { tlsCertFile: "/x.pem" } });
    // P2-1：单边空串 + 单侧非空字符串 → raw 层直接拒绝（不再被 sanitize 剔除绕过）。
    mixedClear = await applyConfigPatch(makeDeps({ port: 4000 }).deps, {
      patch: { tlsCertFile: "", tlsKeyFile: "/keep.pem" },
    });
    mixedSet = await applyConfigPatch(makeDeps().deps, {
      patch: { tlsCertFile: "/new.pem", tlsKeyFile: "" },
    });
    // settings 服务不可用。
    const unavail = makeDeps();
    unavail.deps.writable = () => false;
    na = await applyConfigPatch(unavail.deps, { patch: { port: 4000 } });
    // ── #467 验收：TLS 成对清除语义（只清 cert / 只清 key / 双清 / 清除遇 409 /
    //    user 层已不完整）。
    clearCertOnly = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsCertFile: "" } },
    );
    clearKeyOnly = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsKeyFile: "" } },
    );
    clearBoth = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsCertFile: "", tlsKeyFile: "", printBanner: false } },
    );
    clearConflict = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem" }, { conflict: true }).deps,
      { patch: { tlsCertFile: "", tlsKeyFile: "" } },
    );
    brokenUser = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsCertFile: "", tlsKeyFile: "" } },
    );
    inPair = await applyConfigPatch(
      makeDeps({ tlsCertFile: "/x.pem", tlsKeyFile: "/x-key.pem", port: 4000 }).deps,
      { patch: { tlsKeyFile: "/new-key.pem", printBanner: false } },
    );
    // 场景 5：user 层已不完整（历史孤儿 { tlsCertFile: "/x.pem" } 残留）时，
    // 双清仍整体剔除两键并走 replace 自愈；单侧清除请求仍被 raw 层拒绝（双清是唯一出口）。
    orphanPair = makeDeps({ tlsCertFile: "/x.pem", port: 4000 });
    orphanRes = await applyConfigPatch(orphanPair.deps, {
      patch: { tlsCertFile: "", tlsKeyFile: "" },
    });
    orphanLone = await applyConfigPatch(makeDeps({ tlsCertFile: "/x.pem", port: 4000 }).deps, {
      patch: { tlsCertFile: "" },
    });

    brokenLogWarns = [];
    const brokenDeps = makeDeps({}, { broken: true });
    brokenDeps.deps.logWarn = (m: string) => brokenLogWarns.push(m);
    broken = await applyConfigPatch(brokenDeps.deps, { patch: { port: 4000 } });
    conflict = await applyConfigPatch(makeDeps({}, { conflict: true }).deps, {
      patch: { port: 4000 },
    });
  }, 120_000);
  registerHappyPathScenarios();
  registerTlsPairScenarios();
  registerFailureMappingScenarios();
});
