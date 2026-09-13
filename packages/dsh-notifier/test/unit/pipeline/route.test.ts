/**
 * dsh-notifier pipeline 域 route 块 —— 这条通知该发给谁（纯函数，判据全来自设置）。
 *
 * 判据为什么是这些：
 *  - `kindRoutes` 命中与缺省广播是「用户改了路由却不生效」的唯一解释面；
 *  - `stale` 只对配置里**根本不存在**的 id 报，停用不算已删除——旧实现按「不在投递池里」判，
 *    用户一停用频道就收到一串「指向已删除频道」的误导告警；
 *  - 投递池对每个频道只有 `enabled` 一个判据：弹窗与声音都关的频道照样进池，由出口回答
 *    「这一次没有可发的内容」——在管线里按弹窗 / 声音剔目标，等于替出口决定它该发什么，
 *    而出口的回答还会被伪装成一次投递成功（全关即出池时，用户连 skipped 都看不到）；
 *  - 目标构造里的取舍（空串=没配置、badge 0 有语义、`levels[kind]` 优先于 `level`）决定出口
 *    实际收到什么，写错一处就是「设置页上明明填了，通知里却没有」。
 * 路由是纯函数，故这里只喂设置与假帧出口，不经装配面。
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type { NotifyConfig } from "../../../src/server/config/impl/model/type.ts";
import { channelIdOf, routeTargets } from "../../../src/server/pipeline/impl/route/index.ts";
import type {
  BarkConfig,
  BarkTarget,
  BrowserConfig,
  ChannelConfig,
  RouteOutcome,
  SystemConfig,
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

/**
 * 内置两频道：默认表就带它们且恒在最前，故这里取默认表的真实值再覆盖字段——用例写死的
 * 默认值一旦与默认表漂移，读面物化的形态就没人替它把关了。
 */
function builtins(
  over: { browser?: Partial<BrowserConfig>; system?: Partial<SystemConfig> } = {},
): ChannelConfig[] {
  const browser = DEFAULT_CONFIG.channels.find(
    (channel): channel is BrowserConfig => channel.type === "browser",
  );
  const system = DEFAULT_CONFIG.channels.find(
    (channel): channel is SystemConfig => channel.type === "system",
  );
  if (browser === undefined || system === undefined) throw new Error("默认表里缺内置频道");
  return [
    { ...browser, ...over.browser },
    { ...system, ...over.system },
  ];
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

/** 系统出口的投递参数：`popup` 的取值只有在这里看得见。 */
function systemTargetOf(
  outcome: RouteOutcome,
  channelId: string,
): Extract<DeliveryTarget, { type: "system" }> {
  const target = targetOf(outcome, channelId);
  if (target.type !== "system") throw new Error(`${channelId} 不是系统目标`);
  return target;
}

describe("kindRoutes：命中收窄，缺省广播", () => {
  // 路由命中不生效，用户看到的是「设置改了没用」。
  it("命中时只投命中的频道实例（改了路由就要生效）", () => {
    const outcome = routeTargets(
      { frames: framePort().port, logger: makeLogger() },
      configAt({
        channels: [...builtins(), barkChannel({ id: "a" }), barkChannel({ id: "b" })],
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
      ...builtins(),
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

  // 这条规则是跨端契约：客户端有一份同名实现（`channelIdOf`），两边算出来的 id 必须逐字一致，
  // 否则 chips 写进 kindRoutes 的 id 与池里的 id 对不上，用户勾了却收不到。
  it("频道对外 id：内置取 type（裸 id），实例取 type:id", () => {
    expect(channelIdOf(builtins()[0]!)).toBe("browser");
    expect(channelIdOf(builtins()[1]!)).toBe("system");
    expect(channelIdOf(barkChannel({ id: "phone" }))).toBe("bark:phone");
  });

  // 反过来锁 `knownChannelIds`：内置条目必须按裸 id 计入、不能再按 `type:id` 加一遍——多出来的
  // `browser:browser` 会把一条自造 id 认成「已知频道」，用户写成它时收不到「指向已删除频道」的提醒。
  it("kindRoutes：内置裸 id 命中且不报 stale，自造的 type:id 仍被认成不存在", () => {
    const deps = { frames: framePort().port, logger: makeLogger() };
    const staleOf = (ids: string[]) =>
      routeTargets(deps, configAt({ kindRoutes: { done: ids } }), requestOf()).stale;
    expect(staleOf(["browser", "system"])).toEqual([]);
    expect(staleOf(["browser:browser"])).toEqual(["browser:browser"]);
  });

  // onlyChannel 是单频道测试按钮的唯一入口，被 kindRoutes 拦下就等于测试按钮失灵。
  it("onlyChannel 直接收窄到一处并绕过 kindRoutes；查不到就是空结果，不报 stale", () => {
    const deps = { frames: framePort().port, logger: makeLogger() };
    const config = configAt({
      channels: [...builtins(), barkChannel({ id: "a" }), barkChannel({ id: "b" })],
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
        channels: [...builtins(), barkChannel({ id: "off", enabled: false })],
        kindRoutes: { done: ["bark:gone", "bark:off", "browser"] },
      }),
      requestOf(),
    );
    expect(outcome.stale).toEqual(["bark:gone"]);
    expect(outcome.targets.map((routed) => routed.channelId)).toEqual(["browser"]);
  });
});

describe("内置频道池：启用决定发不发，弹窗与声音决定怎么发", () => {
  // 弹窗关而声音开是合法组合（只响不弹），全关也是合法组合（这次什么都不发）：两者都只改变
  // 目标携带的配置，不改变「要不要投递」——判成出池会让出口连回答「没有可发的内容」的机会都没有。
  it("启用的内置频道恒进池：弹窗与声音只决定出口发什么，不决定发不发", () => {
    const deps = { frames: framePort().port, logger: makeLogger() };
    const soundOnly = routeTargets(
      deps,
      configAt({
        channels: builtins({
          browser: { popup: false, sound: "ding" },
          system: { popup: false, sound: false },
        }),
      }),
      requestOf(),
    );
    expect(soundOnly.targets.map((routed) => routed.channelId)).toEqual(["browser", "system"]);
    const browser = browserTargetOf(soundOnly, "browser");
    expect(browser.popup).toBe(false);
    expect(browser.sound).toBe("ding");

    // 全关（弹窗与声音都关）仍进池：出口据此回答 skipped，而不是被管线悄悄剔出去。
    const closed = routeTargets(
      deps,
      configAt({
        channels: builtins({
          browser: { popup: false, sound: false },
          system: { popup: false, sound: false },
        }),
      }),
      requestOf(),
    );
    expect(closed.targets.map((routed) => routed.channelId)).toEqual(["browser", "system"]);
    expect(browserTargetOf(closed, "browser").popup).toBe(false);
    expect(systemTargetOf(closed, "system").sound).toBe(false);
  });

  // 「发不发只看启用」：关掉启用之后，哪怕弹窗与声音都开着也不该有任何目标。这条与上一条一起
  // 把职责钉开——`enabled` 从池条件里删掉，这里的期望就会变成两个目标。
  it("渠道启用关掉即完全不投递：弹窗与声音开着也没有目标", () => {
    const deps = { frames: framePort().port, logger: makeLogger() };
    const browserOff = routeTargets(
      deps,
      configAt({
        channels: builtins({
          browser: { enabled: false, popup: true, sound: true },
          system: { enabled: true, popup: true, sound: true },
        }),
      }),
      requestOf(),
    );
    expect(browserOff.targets.map((routed) => routed.channelId)).toEqual(["system"]);

    const bothOff = routeTargets(
      deps,
      configAt({
        channels: builtins({
          browser: { enabled: false },
          system: { enabled: false },
        }),
      }),
      requestOf(),
    );
    expect(bothOff.targets).toEqual([]);
  });

  // popup 不是「有没有这个目标」，而是「弹不弹」：取反或写死一处，用户关掉弹窗后仍会被弹，
  // 而「只响不弹」这个组合也就退化成「什么都没配」。
  it("popup 跟随各自的弹窗开关：开关开才弹，只响不弹时两个内置出口都是 popup=false", () => {
    const deps = { frames: framePort().port, logger: makeLogger() };
    const bothOpen = routeTargets(
      deps,
      configAt({
        channels: builtins({
          browser: { popup: true, sound: false },
          system: { popup: true, sound: false },
        }),
      }),
      requestOf(),
    );
    expect(browserTargetOf(bothOpen, "browser").popup).toBe(true);
    expect(systemTargetOf(bothOpen, "system").popup).toBe(true);

    const soundOnly = routeTargets(
      deps,
      configAt({
        channels: builtins({
          browser: { popup: false, sound: "ding" },
          system: { popup: false, sound: "ding" },
        }),
      }),
      requestOf(),
    );
    expect(browserTargetOf(soundOnly, "browser").popup).toBe(false);
    expect(systemTargetOf(soundOnly, "system").popup).toBe(false);
  });

  // 帧里没有 kind，客户端只能给所有通知同一套图标与颜色；可见性漏带则「页面可见时也弹」失效。
  it("浏览器目标的帧出口带上本次 kind，可见性随目标进帧", () => {
    const { port, emitted } = framePort();
    const outcome = routeTargets(
      { frames: port, logger: makeLogger() },
      configAt({ channels: builtins({ browser: { whenVisible: true } }) }),
      requestOf({ kind: "error", title: "出错了", body: "细节" }),
    );
    const frame: NotifyFrame = {
      pop: true,
      sound: { mode: "silent" },
      whenVisible: true,
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
    const withChannel = (over: Partial<NotifyConfig> = {}) =>
      configAt({ channels: [...builtins(), channel], ...over });
    const done = barkTargetOf(routeTargets(deps, withChannel(), requestOf()), "bark:a");
    expect(done.level).toBe("critical");
    expect("group" in done).toBe(false);
    expect("icon" in done).toBe(false);
    expect("url" in done).toBe(false);
    expect(done.badge).toBe(0);
    expect("timeoutMs" in done).toBe(false);

    const other = barkTargetOf(
      routeTargets(deps, withChannel(), requestOf({ kind: "error" })),
      "bark:a",
    );
    expect(other.level).toBe("active");

    const timed = barkTargetOf(
      routeTargets(
        deps,
        configAt({ channels: [...builtins(), barkChannel({ id: "a", timeoutMs: 5000 })] }),
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
      routeTargets(deps, configAt({ channels: [...builtins(), webhookChannel()] }), requestOf()),
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
          channels: [
            ...builtins(),
            webhookChannel({ preset: "custom", template: '{"a":1}', timeoutSec: 0 }),
          ],
        }),
        requestOf(),
      ),
      "webhook:w",
    );
    expect(custom.preset).toBe("raw");
    expect(custom.template).toBe('{"a":1}');
    expect("timeoutSec" in custom).toBe(false);

    // 空模板是「用预设默认模板」的表达，带进去对端会收到一个空 body。
    const emptyTemplate = webhookTargetOf(
      routeTargets(
        deps,
        configAt({ channels: [...builtins(), webhookChannel({ template: "" })] }),
        requestOf(),
      ),
      "webhook:w",
    );
    expect("template" in emptyTemplate).toBe(false);

    // 正超时必须带过去：不带就等于用户在设置页设的超时永远不生效（出口一律回落 10s）。
    const timed = webhookTargetOf(
      routeTargets(
        deps,
        configAt({ channels: [...builtins(), webhookChannel({ timeoutSec: 30 })] }),
        requestOf(),
      ),
      "webhook:w",
    );
    expect(timed.timeoutSec).toBe(30);
  });

  // 凭据空着却带上 auth 会发出一个「Bearer undefined」，none 却带凭据则是把凭据发给了不该收的端点。
  it("webhook 凭据：bearer/basic 出凭据对象，header 并入自定义头，空凭据与 none 都不给 auth", () => {
    const deps = { frames: framePort().port, logger: makeLogger() };
    const outcomeOf = (over: Partial<WebhookConfig>) =>
      webhookTargetOf(
        routeTargets(
          deps,
          configAt({ channels: [...builtins(), webhookChannel(over)] }),
          requestOf(),
        ),
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
    // 字段整个缺席（不只是空串）也不能炸：脏配置不该把整条出站路由一起吃掉。
    expect("auth" in outcomeOf({ auth: "bearer" })).toBe(false);
    expect("auth" in outcomeOf({ auth: "basic" })).toBe(false);
    // header 认证两侧都非空才并入：空名会写出一个无名头，空值等于把对端原有的凭据清掉。
    expect("headers" in outcomeOf({ auth: "header", headerName: "X-Token", headerValue: "" })).toBe(
      false,
    );
    expect("headers" in outcomeOf({ auth: "header", headerName: "", headerValue: "v-1" })).toBe(
      false,
    );
    expect("headers" in outcomeOf({ auth: "header" })).toBe(false);
  });

  // 一个坏项吃掉整条通知，表现为「配置里加了个频道之后所有通知都没了」。
  it("频道读取 fail-soft：坏了一项只记 warn，已收进池的内置频道照常投", () => {
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
      configAt({ channels: [...builtins(), broken] }),
      requestOf(),
    );
    expect(outcome.targets.map((routed) => routed.channelId)).toEqual(["browser", "system"]);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain("频道读取失败");
  });
});
