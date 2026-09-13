/**
 * dsh-notifier — 对外服务面契约（`wingsky.notifier`）。
 *
 * 面口径：这是**兄弟插件看到的那一面**。经 `sdk/interface.ts` 装配（与组合根同一条路径），
 * 只伪 `sdk/deps.ts` 声明的那三个端口；域内管理面（清单 / 确认）也在这里测，因为它回答的是
 * 「用户答不答应」，只有设置页该问——挂在服务面上等于任何插件都能替用户点头。
 *
 * 装配纪律：`sdkService` 与 `kindRegistry` 都是模块级单例（源码注释明写「类不外放，外面 new 不出
 * 第二份」），故每个用例后必须 `releaseSdk()`，否则下一个 `installSdk` 当场抛「只能装配一次」；
 * 注册表没有重置口，故用例之间用互不相同的 id，断言一律用 `toContainEqual` 而不是整体相等。
 */
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/server/config/impl/model/index.ts";
import { isBuiltinKind } from "../../src/server/pipeline/interface.ts";
import type { ConfigPort, ExposePort, PipelinePort, SdkDeps } from "../../src/server/sdk/deps.ts";
import {
  NOTIFIER_SERVICE,
  confirmKind,
  installSdk,
  listKinds,
  releaseSdk,
} from "../../src/server/sdk/interface.ts";
import type { NotifierService } from "../../src/server/sdk/interface.ts";

/** 服务面入参：经签名可达，不必请 impl 再导出一个名字。 */
type SendInput = Parameters<NotifierService["send"]>[0];
type RegisterInput = Parameters<NotifierService["registerKind"]>[0];

/**
 * 绕过类型造一个「未走类型的调用方」（JS 插件）才会送出的形状。
 * 守卫用例只能这样写：这些形状在编译期本就被拦住，而守卫存在的理由正是编译期管不到的那一侧。
 */
function untyped<T>(value: Record<string, unknown>): T {
  return value as unknown as T;
}

/**
 * config 端口：读面给可变设置的快照，写面记账并让 `allowKinds` 生效（确认是读改写，撤销要靠它才成立）。
 * 配置对象取自 `config/impl/model` 的默认值表：它是值表而不是 config 域的服务，且经
 * `config/interface.ts` 取不到（那里只出类型）——手抄二十个字段等于把默认值抄成第二份事实源。
 */
function fakeConfig(allowKinds: readonly string[] = []) {
  const writes: Array<Parameters<ConfigPort["writeConfig"]>[0]> = [];
  const state = { allowKinds: [...allowKinds] };
  const port: ConfigPort = {
    readConfig: () => ({ ...DEFAULT_CONFIG, allowKinds: [...state.allowKinds] }),
    writeConfig: async (patch) => {
      writes.push(patch);
      const next = patch.allowKinds;
      if (Array.isArray(next)) state.allowKinds = next.map((value) => String(value));
      return { ok: true, view: { user: {}, revision: 1, writable: true, effective: {} } };
    },
  };
  return { port, writes };
}

/**
 * pipeline 端口：提交口记账，`isBuiltinKind` 用生产实现——它是纯函数而不是被测对象，且
 * 「内置名单只有一份」正是本域不抄它的理由（抄一份，新增内置种类时两边会给出不同答案）。
 */
function fakePipeline() {
  const submitted: Array<Parameters<PipelinePort["submit"]>[0]> = [];
  const port: PipelinePort = {
    isBuiltinKind,
    submit: (request) => {
      submitted.push(request);
    },
  };
  return { port, submitted };
}

/** 宿主出口：记下交出来的服务对象与摘除次数。 */
function fakeExpose() {
  const provided: NotifierService[] = [];
  let disposed = 0;
  const port: ExposePort = {
    provide: (service) => {
      provided.push(service);
      return () => {
        disposed += 1;
      };
    },
  };
  return { port, provided, disposedCount: () => disposed };
}

/** 装配一次，交出四件观测物。 */
function assemble(allowKinds: readonly string[] = []) {
  const config = fakeConfig(allowKinds);
  const pipeline = fakePipeline();
  const expose = fakeExpose();
  const deps: SdkDeps = { expose: expose.port, config: config.port, pipeline: pipeline.port };
  installSdk(deps);
  return { service: expose.provided[0], config, pipeline, expose };
}

afterEach(() => {
  releaseSdk();
});

describe("装配面", () => {
  it("装配后交出服务面：apiVersion 为 2，且不夹带确认与清单（授权边界靠运行时形状守）", () => {
    const { service, expose } = assemble();
    expect(NOTIFIER_SERVICE).toBe("wingsky.notifier");
    expect(service.apiVersion).toBe(2);
    expect(expose.provided).toHaveLength(1);
    // 两个口的存在性由 `implements NotifierService` 在编译期保证，这里只守「不多给」：
    // 多一个成员就是把本域的内部状态变成公共 API，而公共 API 从此不能再改。
    expect("confirmKind" in service).toBe(false);
    expect("listKinds" in service).toBe(false);
  });

  it("重复装配当场抛错（单例语义：装配守卫不留半装配状态）", () => {
    assemble();
    expect(() => assemble()).toThrow(/只能装配一次/u);
  });

  it("release 收回服务面：摘除器被调用，此后管理面报「未装配」而不是静默空值", async () => {
    const { service, expose } = assemble();
    service.registerKind({ id: "svc-release:a", label: "A" });
    releaseSdk();
    expect(expose.disposedCount()).toBe(1);
    expect(() => listKinds()).toThrow(/尚未装配/u);
    await expect(confirmKind("svc-release:a", true)).rejects.toThrow(/尚未装配/u);
  });
});

describe("send：本域只做形状收窄，不判该不该发", () => {
  it("内置种类直通管线；缺省标题补中性文案（空标题在系统通知里看起来像一条残缺记录）", async () => {
    const { service, pipeline } = assemble();
    await service.send({ kind: "done", body: "正文" });
    expect(pipeline.submitted).toEqual([{ kind: "done", title: "DSH 通知", body: "正文" }]);
    expect("severity" in pipeline.submitted[0]!).toBe(false);
  });

  it("自填标题与 severity 原样进管线", async () => {
    const { service, pipeline } = assemble();
    await service.send({ kind: "demo:report", title: "自定义", body: "正文", severity: "warning" });
    expect(pipeline.submitted).toEqual([
      { kind: "demo:report", title: "自定义", body: "正文", severity: "warning" },
    ]);
  });

  // 空串标题与「没给标题」对用户是同一件事：空标题在系统通知里看起来像一条残缺记录。
  // 只测缺席那一档的话，把判据退化成「有字符串就用」也全绿。
  it("标题是空串时同样补中性文案（判的是非空，不是「有没有给字符串」）", async () => {
    const { service, pipeline } = assemble();
    await service.send({ kind: "done", title: "", body: "正文" });
    expect(pipeline.submitted).toEqual([{ kind: "done", title: "DSH 通知", body: "正文" }]);
  });

  it("形状守卫：非法种类与非字符串正文一律 reject（调用方应在调用点 catch）", async () => {
    const { service, pipeline } = assemble();
    await expect(
      service.send(untyped<SendInput>({ kind: "no-colon", body: "正文" })),
    ).rejects.toThrow(/种类非法/u);
    // 命名空间撞内置名：`ask:foo` 查不到任何事件开关，放行它等于放行一条无归属的通知。
    await expect(
      service.send(untyped<SendInput>({ kind: "ask:foo", body: "正文" })),
    ).rejects.toThrow(/种类非法/u);
    await expect(service.send(untyped<SendInput>({ kind: "done", body: 42 }))).rejects.toThrow(
      /正文/u,
    );
    expect(pipeline.submitted).toEqual([]);
  });
});

describe("registerKind：登记不等于放行", () => {
  it("登记进清单且默认未确认；label 缺省回退 id（设置页上宁可显示一串 id 也不显示空白行）", () => {
    const { service } = assemble();
    service.registerKind({ id: "svc-face:a", label: "A 插件" });
    service.registerKind({ id: "svc-face:b", label: "" });
    expect(listKinds()).toContainEqual({ id: "svc-face:a", label: "A 插件", confirmed: false });
    expect(listKinds()).toContainEqual({ id: "svc-face:b", label: "svc-face:b", confirmed: false });
  });

  it("装配时已在 allowKinds 里的种类直接是已确认", () => {
    const { service } = assemble(["svc-face:pre"]);
    service.registerKind({ id: "svc-face:pre", label: "预确认" });
    expect(listKinds()).toContainEqual({ id: "svc-face:pre", label: "预确认", confirmed: true });
  });

  // 清单顺序就是设置页的展示顺序（注册表注释自称如此），而重复登记是插件重载/热更新下的常态：
  // 取先登记的 label 会让用户看到过期的名字，把新登记项插到前面会让列表每次重载都跳一下。
  it("同 id 重复登记取后者的 label 且保持首次登记的位置：清单顺序 = 登记顺序", () => {
    const { service } = assemble();
    // 注册表跨用例累积（没有重置口），故按本用例独有的命名空间过滤后判相对顺序。
    service.registerKind({ id: "svc-order:a", label: "先登记" });
    service.registerKind({ id: "svc-order:b", label: "后登记" });
    service.registerKind({ id: "svc-order:a", label: "后改的展示名" });

    expect(listKinds().filter((kind) => kind.id.startsWith("svc-order:"))).toEqual([
      { id: "svc-order:a", label: "后改的展示名", confirmed: false },
      { id: "svc-order:b", label: "后登记", confirmed: false },
    ]);
  });

  it("守卫：无冒号 / 命名空间撞内置 / id 非字符串 一律抛错而不是静默忽略", () => {
    const { service } = assemble();
    expect(() =>
      service.registerKind(untyped<RegisterInput>({ id: "no-colon", label: "x" })),
    ).toThrow(/id 非法/u);
    // `:x` 的冒号位置在头部：命名空间是空串，它在设置页上是一行没有归属人的种类。
    expect(() => service.registerKind(untyped<RegisterInput>({ id: ":x", label: "x" }))).toThrow(
      /id 非法/u,
    );
    expect(() =>
      service.registerKind(untyped<RegisterInput>({ id: "ask:foo", label: "x" })),
    ).toThrow(/命名空间/u);
    expect(() => service.registerKind(untyped<RegisterInput>({ id: 42, label: "x" }))).toThrow(
      /需要一个/u,
    );
  });
});

describe("清单与确认：确认态住在设置里，注册表随进程生灭", () => {
  it("确认写整份名单（去重），撤销从名单里移除", async () => {
    const { service, config } = assemble(["svc-face:c", "svc-keep:other"]);
    service.registerKind({ id: "svc-face:c", label: "C" });
    expect(listKinds()).toContainEqual({ id: "svc-face:c", label: "C", confirmed: true });

    // 撤销一个不能顺手清掉别人：名单是整份写回的，过滤条件写错就是「撤销 A 之后 B 也失效」。
    await confirmKind("svc-face:c", false);
    expect(config.writes).toEqual([{ allowKinds: ["svc-keep:other"] }]);
    expect(listKinds()).toContainEqual({ id: "svc-face:c", label: "C", confirmed: false });

    await confirmKind("svc-face:c", true);
    expect(config.writes[1]).toEqual({ allowKinds: ["svc-keep:other", "svc-face:c"] });
    expect(listKinds()).toContainEqual({ id: "svc-face:c", label: "C", confirmed: true });
  });

  it("重复确认不产生重复条目（写的是整份名单，不是增量）", async () => {
    const { service, config } = assemble(["svc-face:d", "svc-face:d"]);
    service.registerKind({ id: "svc-face:d", label: "D" });
    await confirmKind("svc-face:d", true);
    expect(config.writes).toEqual([{ allowKinds: ["svc-face:d"] }]);
  });

  it("确认未登记的种类抛错（设置端点先查清单给 404，走到这里说明有人绕过了它）", async () => {
    assemble();
    await expect(confirmKind("svc-face:never", true)).rejects.toThrow(/未登记/u);
  });
});
