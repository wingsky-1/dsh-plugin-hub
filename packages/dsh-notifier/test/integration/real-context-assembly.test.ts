/** 真实 Context 装配、locale 接线与宿主路由；隔离和成对清理由专属 support 保持原时序。 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import {
  assertEventReachability,
  assertRealCordisContextSemantics,
} from "../../../../test/smoke-lib.ts";
import { pollUntil, settleMicrotasks } from "../helpers.ts";
import {
  ROUTE_PATHS,
  countKind,
  fakeAgent,
  fakeSettings,
  fakeWebServer,
  kindLine,
  kindLines,
  mount,
  mounted,
  notifier,
  postTestNotification,
  sdkApi,
  seqAnchor,
  seqValue,
  settleHistory,
  titleEvent,
} from "./real-context-support.ts";

function registerServiceExposure(): void {
  it("装配即暴露：服务面挂在宿主上下文上（声明合并的读法可用），登记与发送当场可用", async () => {
    const { root, fiber, unmount } = await mount({});
    // 声明合并的读法可用，而且读到的是**同一个**对象：服务面经 `ctx.provide` 挂在宿主上下文上，
    // 不是又造了一份（再造一份就会有两个 apiVersion、两套登记表）。
    const service = root.get("wingsky.notifier", false);
    expect(fiber.ctx["wingsky.notifier"]).toBe(service);
    expect(service?.apiVersion).toBe(2);
    // 管理面（清单 / 确认）不进服务面：多给一样，兄弟插件就能替用户放行自己的通知种类。
    expect("confirmKind" in (service ?? {})).toBe(false);

    service?.registerKind({ id: "itest:face", label: "集成测试" });
    expect(sdkApi.listKinds()).toContainEqual({
      id: "itest:face",
      label: "集成测试",
      confirmed: false,
    });
    // 未确认的外部种类：送进的是真管线，出去的是一条「unlisted」归档（不是静默丢弃）。
    await service?.send({ kind: "itest:face", body: "正文" });
    await pollUntil(() => countKind("itest:face") === 1, "登记后的发送落史");
    expect(kindLine("itest:face")?.suppressed).toBe("unlisted");

    await unmount();
    // 卸载后消费方按「通知中心不在」降级：`get` 拿空而不是拿到半死对象。
    expect(root.get("wingsky.notifier", false)).toBeUndefined();
  });

  it("宿主 locale 实时接线：显式 en 覆盖 user 层、同次装配切回 zh、生成后历史不重写", async () => {
    let preference: unknown = "en";
    const { root, host, unmount } = await mount({
      locale: () => ({ value: { preference } }),
    });

    root.emit("agent/error", {
      agent: fakeAgent("itest-locale-en"),
      turn: 1,
      step: 1,
      error: new Error("failed"),
    });
    await pollUntil(() => countKind("error") === 1, "英文错误通知落史");
    const englishError = kindLines("error")[0];
    expect(englishError).toMatchObject({
      title: "DSH: Task failed",
      message: "Task failed\nTurn 1, step 1: failed",
    });

    await postTestNotification(host.routes);
    await pollUntil(() => countKind("test") === 1, "英文测试通知落史");
    expect(kindLines("test")[0]).toMatchObject({ title: "DSH: Test notification" });

    const service = root.get("wingsky.notifier", false);
    if (service === undefined) throw new Error("通知服务未装配");
    service.registerKind({ id: "itest:locale", label: "locale" });
    await service.send({ kind: "itest:locale", body: "body" });
    await pollUntil(() => countKind("itest:locale") === 1, "英文 SDK 缺省标题落史");
    expect(kindLines("itest:locale")[0]).toMatchObject({ title: "DSH notification" });

    preference = "zh";
    root.emit("agent/error", {
      agent: fakeAgent("itest-locale-en"),
      turn: 1,
      step: 1,
      error: new Error("failed"),
    });
    await pollUntil(() => countKind("error") === 2, "切换中文后的错误通知落史");
    expect(kindLines("error")[1]).toMatchObject({
      title: "DSH：任务出错",
      message: "任务执行出错\n第 1 轮第 1 步：failed",
    });

    await postTestNotification(host.routes);
    await pollUntil(() => countKind("test") === 2, "切换中文后的测试通知落史");
    expect(kindLines("test")[1]).toMatchObject({ title: "DSH：测试通知" });

    await service.send({ kind: "itest:locale", body: "正文" });
    await pollUntil(() => countKind("itest:locale") === 2, "中文 SDK 缺省标题落史");
    expect(kindLines("itest:locale")[1]).toMatchObject({ title: "DSH 通知" });

    await settleHistory();
    expect(kindLines("error")[0]).toMatchObject({
      title: "DSH: Task failed",
      message: "Task failed\nTurn 1, step 1: failed",
    });
    await unmount();
  });
}

function registerLocaleFallbacks(): void {
  it.each(["unset", "ru", "malformed", "null", "non-string"] as const)(
    "locale value=%s 回退中文，普通工具 ID 原样进入正文",
    async (variant) => {
      const values: Record<typeof variant, unknown> = {
        unset: undefined,
        ru: { preference: "ru" },
        malformed: "broken",
        null: null,
        "non-string": { preference: 42 },
      };
      await assertLocaleFallback(values[variant], "read");
    },
  );

  it.each(["unset", "ru", "malformed", "null", "non-string"] as const)(
    "locale value=%s 回退中文，MCP 工具 ID 原样进入正文",
    async (variant) => {
      const values: Record<typeof variant, unknown> = {
        unset: undefined,
        ru: { preference: "ru" },
        malformed: "broken",
        null: null,
        "non-string": { preference: 42 },
      };
      await assertLocaleFallback(values[variant], "mcp__filesystem__read_file");
    },
  );

  async function assertLocaleFallback(value: unknown, toolName: string): Promise<void> {
    const { root, unmount } = await mount({ locale: () => ({ value }) });
    const approval = {
      toolName,
      reason: "Проверить",
      agent: fakeAgent("itest-locale-fallback", [titleEvent("Разделение движка")]),
    } as unknown as ApprovalRequest;

    root.emit("approval/request", approval, async () => "unavailable");
    await pollUntil(() => countKind("ask") === 1, "回退中文的审批通知落史");
    const line = kindLine("ask");
    expect(line?.title).toBe("DSH：等待审批");
    expect(line?.message).toBe(
      `任务「Разделение движка」等待审批（工具「${toolName}」）\n理由：Проверить\n请到 DSH 界面确认或拒绝`,
    );
    await unmount();
  }
}

function registerAssemblyGuards(): void {
  it("inject 门：两条宿主服务（webServer / settings）都就绪才装配，缺一条都不跑", async () => {
    const root = new Context();
    const host = fakeWebServer(() => ({ configDays: 0, serviceAlive: false }));
    const fiber = await root.plugin(notifier);
    mounted.live = fiber;

    // 缺依赖时的现场：插件没跑（路由为空、服务面没上），也没有装配失败的声音。
    expect(host.routes).toHaveLength(0);
    expect(root.get("wingsky.notifier", false)).toBeUndefined();

    // 只补一条还不够：settings 是显式依赖（存量配置的读取面），缺它时装配体一步都不该走。
    root.provide("webServer", host.service);
    await settleMicrotasks();
    expect(host.routes).toHaveLength(0);
    expect(root.get("wingsky.notifier", false)).toBeUndefined();

    root.provide("settings", fakeSettings({}));
    await fiber.await();
    expect(host.routes.map((route) => route.path)).toHaveLength(8);
    expect(root.get("wingsky.notifier", false)?.apiVersion).toBe(2);
  });

  /**
   * 宿主契约 canary——**不是本插件的判据**：两个共用 helper 都只在自己临时挂的监听器上断言 cordis
   * 的语义（未注入访问抛错 / 缺位 get 安全 / effect 真实清理 / 作用域过滤只放行 global），
   * 它们不触本插件的任何代码。放在一个用例里是因为两者共用同一次装配，判据互不相干。
   */
  it("宿主契约 canary：真实 Context 语义 + `{global:true}` 的作用域过滤语义（非本插件行为判据）", async () => {
    const { fiber, unmount } = await mount({});
    // 插件 fiber 的运行时上下文才是「真实」的那一份：root 语义下未注入访问会静默给 undefined，
    // 断言①在那里恒真——历史教训（根因 A：fake-ctx 把服务当普通属性注入）正是靠这条堵住的。
    // 断恒等而非断存在：`root.fiber` 也存在，只有插件 fiber 才带 `runtime`（根为 null）。
    expect(fiber.ctx.fiber).toBe(fiber);
    assertRealCordisContextSemantics(fiber.ctx);
    assertEventReachability(fiber.ctx, Context, "agent/status", {
      agent: fakeAgent("itest-reach"),
      status: "running",
    });
    await unmount();
  });

  it("挂载点总开关 enabled:false 抵达裁决层：请求照进管线，但记的是 disabled 而不是照常投递", async () => {
    const { root, unmount } = await mount({ config: { enabled: false } });
    root.emit("agent/error", {
      agent: fakeAgent("itest-disabled"),
      turn: 1,
      step: 1,
      error: new Error("炸了"),
    });
    await pollUntil(() => countKind("error") === 1, "总开关关闭时的归档");
    expect(kindLine("error")?.suppressed).toBe("disabled");
    // 关掉的是「投递」，不是「记录」：帧的写排在归档之前，归档已在磁盘上时序号若前进过就已可见
    // ——所以这里断「没走到下一格」而不是「等于锚点」，免得受上一个用例迟到的那一笔影响。
    expect(seqValue()).not.toBe(seqAnchor + 1);
    await unmount();
  });
}

describe("装配与暴露", () => {
  registerServiceExposure();
  registerLocaleFallbacks();
  registerAssemblyGuards();
});

/**
 * 装配顺序（源码序锁定）：升级链必须 await 跑完，才轮到任何读文件的域。
 *
 * 为什么只能钉源码顺序：运行期能观测到的只有「apply 返回时链已跑完」，而各域的**装配先后**在运行期
 * 没有观测量——把它挪到 config/stores 之后，变坏的只是「各域读着被搬走一半的磁盘跑起来」这件事，
 * 假 ctx 装配照样成功。组合根里唯一可判的形态就是源码文本的先后（同先例：
 * dsh-provider-usage test/integration/report-routes/composition-root.test.ts 的装配序锁定）。
 */
describe("装配顺序：升级链 await 跑完才装其它域", () => {
  const applySrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "index.ts"),
    "utf8",
  );

  it("升级域是 await 装配方（漏掉 await 即红）", () => {
    expect(applySrc.indexOf("await installUpgrade({")).toBeGreaterThan(-1);
  });

  it("先复位 upgrade 装配标记再装配（release 晚于 install 即红）", () => {
    const release = applySrc.indexOf("releaseUpgrade();");
    const install = applySrc.indexOf("await installUpgrade({");
    expect(release).toBeGreaterThan(-1);
    expect(release).toBeLessThan(install);
  });

  it("升级链早于 config 域（迁移必须早于任何读文件的域）", () => {
    const install = applySrc.indexOf("await installUpgrade({");
    const config = applySrc.indexOf("configApi.installConfig(");
    expect(install).toBeGreaterThan(-1);
    expect(config).toBeGreaterThan(-1);
    expect(install).toBeLessThan(config);
  });
});

describe("宿主路由注册与摘除", () => {
  it("apply 期间宿主收到恰好 8 条 exact 路由，路径集合就是客户端锁定的那一份", async () => {
    const { host, unmount } = await mount({});
    expect(host.routes.map((route) => route.path).sort()).toEqual([...ROUTE_PATHS].sort());
    expect(host.routes.every((route) => route.kind === "exact")).toBe(true);
    expect(host.removals).toHaveLength(0);
    await unmount();
  });

  it("卸载摘除全部 8 条路由，重复卸载不再摘第二次（卸载链可能走到不止一次）", async () => {
    const { host, fiber, unmount } = await mount({});
    await unmount();
    expect(host.removals.map((removal) => removal.path).sort()).toEqual([...ROUTE_PATHS].sort());

    await fiber.dispose();
    expect(host.removals).toHaveLength(ROUTE_PATHS.length);
  });
});
