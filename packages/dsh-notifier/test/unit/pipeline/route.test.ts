/**
 * dsh-notifier pipeline 域 route 块 —— 这条通知该发给谁（纯函数，判据全来自设置）。
 *
 * 判据为什么是这些：
 *  - `kindRoutes` 命中与缺省广播是「用户改了路由却不生效」的唯一解释面；
 *  - `stale` 只对配置里**根本不存在**的 id 报，停用不算已删除——旧实现按「不在投递池里」判，
 *    用户一停用频道就收到一串「指向已删除频道」的误导告警；
 *  - 目标构造里的取舍（空串=没配置、badge 0 有语义、`levels[kind]` 优先于 `level`）决定出口
 *    实际收到什么，写错一处就是「设置页上明明填了，通知里却没有」。
 * 路由是纯函数，故这里只喂设置与假帧出口，不经装配面。
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type { NotifyConfig } from "../../../src/server/config/impl/model/type.ts";
import { routeTargets } from "../../../src/server/pipeline/impl/route/index.ts";
import type {
  BarkConfig,
  BarkTarget,
  ChannelConfig,
  RouteOutcome,
  WebhookConfig,
  WebhookTarget,
} from "../../../src/server/pipeline/impl/route/type.ts";
import type {
  DeliveryTarget,
  FramePort,
  OutgoingFrame,
} from "../../../src/server/pipeline/deps.ts";
import type { NotifyFrame } from "../../../src/server/channels/interface.ts";
import type { NotifyRequest } from "../../../src/server/pipeline/interface.ts";
import { makeLogger } from "../../helpers.ts";

/** 浏览器官口的投递参数：经投递目标联合可达，不必请 channels 域再导出一个名字。 */
type BrowserTarget = Extract<DeliveryTarget, { type: "browser" }>;

function configAt(over: Partial<NotifyConfig> = {}): NotifyConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

function requestOf(over: Partial<NotifyRequest> = {}): NotifyRequest {
  return { kind: "done", title: "标题", body: "正文", ...over };
}

function barkChannel(over: Partial<BarkConfig> = {}): BarkConfig {
  return {
    type: "bark",
    id: "a",
    enabled: true,
    baseUrl: "http://127.0.0.1:40281/bark",
    deviceKey: "dk",
    ...over,
  };
}

function webhookChannel(over: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    type: "webhook",
    id: "w",
    enabled: true,
    url: "http://127.0.0.1:40281/hook",
    auth: "none",
    ...over,
  };
}

/** 帧出口的假实现：帧是浏览器目标的唯一产物，收帧即观测到路由接线。 */
function framePort(): { port: FramePort; emitted: OutgoingFrame[] } {
  const emitted: OutgoingFrame[] = [];
  return {
    port: {
      emit: (payload) => {
        emitted.push(payload);
      },
    },
    emitted,
  };
}

/** 取指定频道的投递参数；没有就判红——断言的前置条件不该在后面变成一串 undefined 比较。 */
function targetOf(outcome: RouteOutcome, channelId: string): DeliveryTarget {
  const found = outcome.targets.find((routed) => routed.channelId === channelId);
  if (found === undefined) throw new Error(`路由结果里没有 ${channelId}`);
  return found.target;
}

function barkTargetOf(outcome: RouteOutcome, channelId: string): BarkTarget {
  const target = targetOf(outcome, channelId);
  if (target.type !== "bark") throw new Error(`${channelId} 不是 bark 目标`);
  return target;
}

function webhookTargetOf(outcome: RouteOutcome, channelId: string): WebhookTarget {
  const target = targetOf(outcome, channelId);
  if (target.type !== "webhook") throw new Error(`${channelId} 不是 webhook 目标`);
  return target;
}

function browserTargetOf(outcome: RouteOutcome, channelId: string): BrowserTarget {
  const target = targetOf(outcome, channelId);
  if (target.type !== "browser") throw new Error(`${channelId} 不是浏览器目标`);
  return target;
}

describe("kindRoutes：命中收窄，缺省广播", () => {
  // 路由命中不生效，用户看到的是「设置改了没用」。
  it("命中时只投命中的频道实例（改了路由就要生效）", () => {
    const outcome = routeTargets(
      { frames: framePort().port, logger: makeLogger() },
      configAt({
        channels: [barkChannel({ id: "a" }), barkChannel({ id: "b" })],
        kindRoutes: { done: ["bark:b"] },
      }),
      requestOf(),
    );
    expect(outcome.targets.map((routed) => routed.channelId)).toEqual(["bark:b"]);
    expect(outcome.stale).toEqual([]);
  });

  // 缺省广播是绝大多数用户的形态，漏掉停用判断会把通知发到用户已经关掉的频道。
  it("缺省与空数组都是广播全部启用频道，停用的不进池；顺序为内置在前、出站随后", () => {
    const channels: ChannelConfig[] = [
      barkChannel({ id: "a" }),
      barkChannel({ id: "off", enabled: false }),
      webhookChannel({ id: "w" }),
    ];
    const broadcastCases: Array<Record<string, string[]>> = [{}, { done: [] }];
    for (const kindRoutes of broadcastCases) {
      const outcome = routeTargets(
        { frames: framePort().port, logger: makeLogger() },
        configAt({ channels, kindRoutes }),
        requestOf(),
      );
      expect(
        outcome.targets.map((routed) => routed.channelId),
        JSON.stringify(kindRoutes),
      ).toEqual(["browser", "system", "bark:a", "webhook:w"]);
    }
  });

  // onlyChannel 是单频道测试按钮的唯一入口，被 kindRoutes 拦下就等于测试按钮失灵。
  it("onlyChannel 直接收窄到一处并绕过 kindRoutes；查不到就是空结果，不报 stale", () => {
    const deps = { frames: framePort().port, logger: makeLogger() };
    const config = configAt({
      channels: [barkChannel({ id: "a" }), barkChannel({ id: "b" })],
      kindRoutes: { done: ["bark:a"] },
    });
    const only = routeTargets(deps, config, requestOf({ onlyChannel: "bark:b" }));
    expect(only.targets.map((routed) => routed.channelId)).toEqual(["bark:b"]);
    expect(only.stale).toEqual([]);

    const gone = routeTargets(deps, config, requestOf({ onlyChannel: "bark:gone" }));
    expect(gone.targets).toEqual([]);
    expect(gone.stale).toEqual([]);
  });

  // 停用被误报成「已删除」，用户一关频道就收到一串误导告警。
  it("stale 只报配置里根本不存在的频道；被停用的频道不误报", () => {
    const outcome = routeTargets(
      { frames: framePort().port, logger: makeLogger() },
      configAt({
        channels: [barkChannel({ id: "off", enabled: false })],
        kindRoutes: { done: ["bark:gone", "bark:off", "browser"] },
      }),
      requestOf(),
    );
    expect(outcome.stale).toEqual(["bark:gone"]);
    expect(outcome.targets.map((routed) => routed.channelId)).toEqual(["browser"]);
  });
});

describe("内置频道池：弹窗关而声音开 = 只响不弹", () => {
  // 弹窗关而声音开是合法组合（只响不弹），判成「没配置」会让用户彻底收不到。
  it("开关关但声音非静音时仍进池（pop=false），两者全关才出池", () => {
    const outcome = routeTargets(
      { frames: framePort().port, logger: makeLogger() },
      configAt({
        browserNotify: false,
        browserSound: "ding",
        systemNotify: false,
        systemSound: false,
      }),
      requestOf(),
    );
    expect(outcome.targets.map((routed) => routed.channelId)).toEqual(["browser"]);
    const browser = browserTargetOf(outcome, "browser");
    expect(browser.pop).toBe(false);
    expect(browser.sound).toBe("ding");

    const closed = routeTargets(
      { frames: framePort().port, logger: makeLogger() },
      configAt({
        browserNotify: false,
        browserSound: false,
        systemNotify: false,
        systemSound: false,
      }),
      requestOf(),
    );
    expect(closed.targets).toEqual([]);
  });

  // 帧里没有 kind，客户端只能给所有通知同一套图标与颜色。
  it("浏览器目标的帧出口带上本次 kind（客户端靠它选图标与颜色）", () => {
    const { port, emitted } = framePort();
    const outcome = routeTargets(
      { frames: port, logger: makeLogger() },
      configAt(),
      requestOf({ kind: "error", title: "出错了", body: "细节" }),
    );
    const frame: NotifyFrame = {
      pop: true,
      sound: { mode: "silent" },
      title: "出错了",
      body: "细节",
    };
    browserTargetOf(outcome, "browser").emitFrame(frame);
    expect(emitted).toEqual([{ kind: "error", frame }]);
  });
});

describe("出站目标构造", () => {
  // 空串当配置带走会覆盖 bark 端的默认值；levels[kind] 不优先，紧急度就永远按 level 走。
  it("bark：levels[kind] 命中优先于 level；空串是没配置，badge 0 与正超时有值就带", () => {
    const deps = { frames: framePort().port, logger: makeLogger() };
    const channel = barkChannel({
      id: "a",
      level: "active",
      levels: { done: "critical" },
      group: "",
      icon: "",
      url: "",
      badge: 0,
      timeoutMs: 0,
    });
    const done = barkTargetOf(
      routeTargets(deps, configAt({ channels: [channel] }), requestOf()),
      "bark:a",
    );
    expect(done.level).toBe("critical");
    expect("group" in done).toBe(false);
    expect("icon" in done).toBe(false);
    expect("url" in done).toBe(false);
    expect(done.badge).toBe(0);
    expect("timeoutMs" in done).toBe(false);

    const other = barkTargetOf(
      routeTargets(deps, configAt({ channels: [channel] }), requestOf({ kind: "error" })),
      "bark:a",
    );
    expect(other.level).toBe("active");

    const timed = barkTargetOf(
      routeTargets(
        deps,
        configAt({ channels: [barkChannel({ id: "a", timeoutMs: 5000 })] }),
        requestOf(),
      ),
      "bark:a",
    );
    expect(timed.timeoutMs).toBe(5000);
  });

  // preset 缺省或 custom 映射错了，对端收到的就是另一种模板。
  it("webhook：preset 缺省回落 ntfy、custom 映射成 raw、空模板与 0 超时不带", () => {
    const deps = { frames: framePort().port, logger: makeLogger() };
    const bare = webhookTargetOf(
      routeTargets(deps, configAt({ channels: [webhookChannel()] }), requestOf()),
      "webhook:w",
    );
    expect(bare.preset).toBe("ntfy");
    expect("template" in bare).toBe(false);
    expect("headers" in bare).toBe(false);
    expect("timeoutSec" in bare).toBe(false);

    const custom = webhookTargetOf(
      routeTargets(
        deps,
        configAt({
          channels: [webhookChannel({ preset: "custom", template: '{"a":1}', timeoutSec: 0 })],
        }),
        requestOf(),
      ),
      "webhook:w",
    );
    expect(custom.preset).toBe("raw");
    expect(custom.template).toBe('{"a":1}');
    expect("timeoutSec" in custom).toBe(false);
  });

  // 凭据空着却带上 auth 会发出一个「Bearer undefined」，none 却带凭据则是把凭据发给了不该收的端点。
  it("webhook 凭据：bearer/basic 出凭据对象，header 并入自定义头，空凭据与 none 都不给 auth", () => {
    const deps = { frames: framePort().port, logger: makeLogger() };
    const outcomeOf = (over: Partial<WebhookConfig>) =>
      webhookTargetOf(
        routeTargets(deps, configAt({ channels: [webhookChannel(over)] }), requestOf()),
        "webhook:w",
      );

    expect(outcomeOf({ auth: "bearer", token: "tk-1" }).auth).toEqual({
      kind: "bearer",
      token: "tk-1",
    });
    expect(outcomeOf({ auth: "basic", username: "user", password: "pass" }).auth).toEqual({
      kind: "basic",
      user: "user",
      password: "pass",
    });

    const header = outcomeOf({
      auth: "header",
      headerName: "X-Token",
      headerValue: "v-1",
      headers: { "x-extra": "1" },
    });
    expect(header.headers).toEqual({ "x-extra": "1", "X-Token": "v-1" });
    expect("auth" in header).toBe(false);

    expect("auth" in outcomeOf({ auth: "none" })).toBe(false);
    // 凭据字段空着时宁可没有 auth，也不发一个 "Bearer undefined" 出去。
    expect("auth" in outcomeOf({ auth: "bearer", token: "" })).toBe(false);
  });

  // 一个坏项吃掉整条通知，表现为「配置里加了个频道之后所有通知都没了」。
  it("出站频道读取 fail-soft：坏了一项只记 warn，内置频道照常投", () => {
    const logger = makeLogger();
    const broken = {
      type: "bark",
      id: "bad",
      get enabled(): boolean {
        throw new Error("配置项损坏");
      },
    } as unknown as ChannelConfig;
    const outcome = routeTargets(
      { frames: framePort().port, logger },
      configAt({ channels: [broken] }),
      requestOf(),
    );
    expect(outcome.targets.map((routed) => routed.channelId)).toEqual(["browser", "system"]);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain("出站频道读取失败");
  });
});
