/**
 * dsh-notifier pipeline 域 service 块 —— 种类词汇表、装配面与归档。
 *
 * 判据为什么是这些：
 *  - 词汇表（`kinds.ts`）是裁决的坐标系：事件开关、`kindRoutes`、`allowKinds`、bark 紧急度全按它
 *    查，所以「内置 / 外部」的分界与强度的运行时白名单必须各自只有一份答案；
 *  - 装配面是单例：重复装配、卸载后仍收请求、卸载不清节奏状态，都是「上一个用例的状态漏进下一个」
 *    这类最难查的现场；
 *  - 归档是「为什么我没收到」的唯一答案来源，压制分支与发出分支都得留下记录。
 *
 * 装配纪律：`installPipeline` 是模块级单例，故每个用例后必须 `releasePipeline()`——否则下一个
 * `installPipeline` 当场抛「只能装配一次」，且逐频道节奏状态会跨用例延续。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type { NotifyConfig } from "../../../src/server/config/impl/model/type.ts";
import type {
  ChannelsPort,
  HistoryEntry,
  NotifyMessage,
  OutgoingFrame,
  PipelineDeps,
} from "../../../src/server/pipeline/deps.ts";
import {
  BUILTIN_KINDS,
  KIND_SEVERITY,
  NOTIFY_SEVERITIES,
  isBuiltinKind,
  isNotifySeverity,
} from "../../../src/server/pipeline/impl/service/kinds.ts";
import {
  installPipeline,
  releasePipeline,
  submit,
} from "../../../src/server/pipeline/interface.ts";
import type { NotifyRequest } from "../../../src/server/pipeline/interface.ts";
import { makeLogger, pollUntil, settleMicrotasks } from "../../helpers.ts";

/** 出站频道配置与帧载荷：经设置模型 / 域依赖声明可达，不必请别的块再导出一个名字。 */
type ChannelConfig = NotifyConfig["channels"][number];
type BarkConfig = Extract<ChannelConfig, { type: "bark" }>;

/** 装配面夹具：只伪 `pipeline/deps.ts` 声明的那几个端口，顺手记下四件观测物。 */
interface Harness {
  readonly deps: PipelineDeps;
  readonly history: HistoryEntry[];
  readonly statuses: Array<{
    channelId: string;
    status: "ok" | "failed";
    error: string | undefined;
  }>;
  readonly delivered: Array<{ message: NotifyMessage; targets: readonly DeliveryTarget[] }>;
  readonly frames: OutgoingFrame[];
  readonly logger: ReturnType<typeof makeLogger>;
  /** 换掉这一刻生效的设置（设置是活的：装配期算出的快照会变成静态数据）。 */
  readonly useConfig: (patch?: Partial<NotifyConfig>) => void;
  /** 换掉投递出口的行为（缺省：全部送到）。 */
  readonly onDeliver: (deliver: ChannelsPort["deliver"]) => void;
}

type DeliveryTarget = Parameters<ChannelsPort["deliver"]>[1][number];

function configAt(patch: Partial<NotifyConfig> = {}): NotifyConfig {
  return { ...DEFAULT_CONFIG, ...patch };
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

/** 默认表里的内置频道：泛型只为把「按 type 找到的那条」收窄成对应型号——查找条件就是 type 相等。 */
function builtinOf<T extends "browser" | "system">(type: T): Extract<ChannelConfig, { type: T }> {
  const found = DEFAULT_CONFIG.channels.find((channel) => channel.type === type);
  if (found === undefined) throw new Error(`默认表里缺内置频道 ${type}`);
  return found as Extract<ChannelConfig, { type: T }>;
}

/**
 * 两条内置出口都停用：`channels` 是唯一关得掉它们的地方——顶层 `browserNotify` / `systemSound`
 * 一类键现在只是读面派生出来的只读投影，改它们不会让内置出口少投一次。
 */
function builtinsOff(): ChannelConfig[] {
  return [
    { ...builtinOf("browser"), enabled: false },
    { ...builtinOf("system"), enabled: false },
  ];
}

/** 只留 system 出口的设置：节流用例要「唯一目标」才数得清投递次数。 */
function systemOnly(patch: Partial<NotifyConfig> = {}): Partial<NotifyConfig> {
  return {
    // 内置两频道恒在 `channels` 里：停用 browser，只留 system（弹窗开、声音关，这一次有实际动作）。
    channels: [
      { ...builtinOf("browser"), enabled: false },
      { ...builtinOf("system"), enabled: true, popup: true, sound: false },
    ],
    ...patch,
  };
}

function assemble(over: Partial<PipelineDeps> = {}): Harness {
  const history: HistoryEntry[] = [];
  const statuses: Harness["statuses"][number][] = [];
  const delivered: Harness["delivered"][number][] = [];
  const frames: OutgoingFrame[] = [];
  const logger = makeLogger();
  const state: { config: NotifyConfig; deliver: ChannelsPort["deliver"] } = {
    config: DEFAULT_CONFIG,
    deliver: async (message, targets) => {
      delivered.push({ message, targets });
      return targets.map(() => ({ status: "ok", stage: "delivered" }));
    },
  };
  const deps: PipelineDeps = {
    enabled: true,
    frames: {
      emit: (payload) => {
        frames.push(payload);
      },
    },
    logger,
    config: { readConfig: () => state.config },
    stores: {
      appendHistory: (entry) => {
        history.push(entry);
      },
      recordStatus: (channelId, status, error) => {
        statuses.push({ channelId, status, error });
      },
    },
    channels: { deliver: (message, targets) => state.deliver(message, targets) },
    ...over,
  };
  installPipeline(deps);
  return {
    deps,
    history,
    statuses,
    delivered,
    frames,
    logger,
    useConfig: (patch = {}) => {
      state.config = configAt(patch);
    },
    onDeliver: (deliver) => {
      state.deliver = deliver;
    },
  };
}

afterEach(() => {
  releasePipeline();
  vi.useRealTimers();
});

describe("种类词汇表", () => {
  // 命名空间撞内置名被判成内置，等于绕过用户确认直接放行一条无归属的通知。
  it("isBuiltinKind 只认内置名；内置名一律不含冒号，与 `<命名空间>:<id>` 天然不相交", () => {
    for (const kind of BUILTIN_KINDS) {
      expect(isBuiltinKind(kind), kind).toBe(true);
    }
    // 撞上内置名的外部 kind 会被误判成内置，而误判方向恰好是「绕过用户确认直接放行」。
    for (const kind of ["ask:foo", "done:x", "ASK", "Ask", "ask ", " ask", "", "unknown"]) {
      expect(isBuiltinKind(kind), kind).toBe(false);
    }
    expect(BUILTIN_KINDS.filter((kind) => kind.includes(":"))).toEqual([]);
  });

  // 运行时白名单漏一档，合法强度会被静默判非法并回落缺省。
  it("强度白名单与值表互相覆盖：运行时白名单漏一档，合法强度会被静默判非法并回落缺省", () => {
    expect(NOTIFY_SEVERITIES).toEqual(["info", "success", "warning", "failure"]);
    for (const kind of BUILTIN_KINDS) {
      expect(NOTIFY_SEVERITIES, kind).toContain(KIND_SEVERITY[kind]);
    }
  });

  // 大小写或空白差异被放行，下游出口会拿到一个查不到映射的档位。
  it("isNotifySeverity 边界：大小写与未知档一律判非法（跨边界值不得被放行）", () => {
    for (const severity of NOTIFY_SEVERITIES) {
      expect(isNotifySeverity(severity), severity).toBe(true);
    }
    for (const value of ["", "Info", "INFO", "critical", " urgency", "info "]) {
      expect(isNotifySeverity(value), value).toBe(false);
    }
  });
});

describe("装配面：单例语义", () => {
  // 未装配时抛错会打断宿主事件链上别人的流程——本方法正是挂在事件链上的。
  it("未装配（或已卸载）时 submit 静默丢弃、release 幂等：宿主事件链上抛错会打断别人的流程", () => {
    expect(() => submit(requestOf())).not.toThrow();

    const harness = assemble();
    releasePipeline();
    expect(() => {
      submit(requestOf());
      releasePipeline();
    }).not.toThrow();
    expect(harness.history).toEqual([]);
    expect(harness.delivered).toEqual([]);
  });

  // 重复装配静默换掉能力面，会让同一进程里出现两套裁决配置。
  it("重复装配当场抛错：单例实例上再装一次是编程错误，不该静默换掉能力面", () => {
    assemble();
    expect(() => assemble()).toThrow(/只能装配一次/u);
  });
});

describe("归档：发出与压制只在载荷上分叉", () => {
  // 压制不落史，用户问「为什么没收到」时没有任何可查的证据。
  it("总开关关：记 suppressed=disabled 且零投递（用户看不到通知时，历史里要有理由）", () => {
    const harness = assemble({ enabled: false });
    submit(requestOf());

    expect(harness.delivered).toEqual([]);
    expect(harness.history).toHaveLength(1);
    expect(harness.history[0]!.suppressed).toBe("disabled");
    expect(harness.history[0]!.channels).toBeUndefined();
  });

  // 频道全关是合法配置，把它记成发送成功会掩盖「一条都没发出去」。
  it("一个目标都没有：记 suppressed=no-target，而不是一条空的成功记录", () => {
    const harness = assemble();
    harness.useConfig({ channels: builtinsOff() });
    submit(requestOf());

    expect(harness.delivered).toEqual([]);
    expect(harness.history[0]!.suppressed).toBe("no-target");
  });

  // 两处各取一次时刻，就会出现「历史 12:00:00、收到的通知 12:00:01」。
  it("发出归档：投递载荷与历史记录共用同一个 ts，文案逐字一致", async () => {
    const harness = assemble();
    harness.useConfig({ channels: [...builtinsOff(), barkChannel()] });
    const before = Date.now();
    submit(requestOf({ title: "标题", body: "正文" }));
    await settleMicrotasks();
    const after = Date.now();

    const entry = harness.history[0]!;
    const message = harness.delivered[0]!.message;
    // 两处各取一次时刻是真实的回归形态：历史显示 12:00:00，收到的通知却是 12:00:01。
    expect(entry.ts).toBe(message.ts);
    expect(entry.ts).toBeGreaterThanOrEqual(before);
    expect(entry.ts).toBeLessThanOrEqual(after);
    expect(message.title).toBe("标题");
    expect(message.body).toBe("正文");
    expect(entry.title).toBe("标题");
    expect(entry.message).toBe("正文");
    expect(entry.kind).toBe("done");
  });

  // 日志口径与归档口径不同词，排查时「按日志找记录」这一步就对不上。
  it("kindRoutes 指向已删除频道：warn 与归档同一口径（suppressed:no-target），不静默也不自称 skipped", () => {
    const harness = assemble();
    harness.useConfig({ channels: builtinsOff(), kindRoutes: { done: ["bark:gone"] } });
    submit(requestOf());

    expect(harness.delivered).toEqual([]);
    const archived = harness.history[0]!.suppressed;
    expect(archived).toBe("no-target");
    expect(harness.logger.warns).toHaveLength(1);
    expect(harness.logger.warns[0]).toContain("kindRoutes[done]");
    expect(harness.logger.warns[0]).toContain("bark:gone");
    // 日志点名的那条口径就是历史里记下的那条：`SuppressReason` 里没有 skipped 这个词。
    expect(harness.logger.warns[0]).toContain(`suppressed:${archived}`);
    expect(harness.logger.warns[0]).not.toContain("skipped");
  });

  // 有别的目标时通知照常发出，此时谎称「本条按 suppressed 归档」会把排查引向一条不存在的记录。
  it("stale 但仍有其它目标：其余目标照常投递，warn 不谎称本条通知按 suppressed 归档", async () => {
    const harness = assemble();
    harness.useConfig({
      channels: [...builtinsOff(), barkChannel()],
      kindRoutes: { done: ["bark:gone", "bark:a"] },
    });
    submit(requestOf());
    await settleMicrotasks();

    expect(harness.history[0]!.channels).toEqual([{ channelId: "bark:a", status: "ok" }]);
    expect(harness.logger.warns).toHaveLength(1);
    expect(harness.logger.warns[0]).toContain("bark:gone");
    expect(harness.logger.warns[0]).not.toContain("suppressed:");
  });

  // 节奏状态跨装配期存活，会把上一次运行窗口的节流带进新一次装配。
  it("release 清空逐频道节奏状态：卸载再装配后同一频道重新计时，节流不跨装配期存活", async () => {
    const harness = assemble();
    harness.useConfig(systemOnly());
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));

    submit(requestOf());
    await settleMicrotasks();
    expect(harness.delivered).toHaveLength(1);

    // 同一时刻的第二条：落在 system 出口的 1 秒节流窗口里，不产生第二次投递。
    submit(requestOf());
    await settleMicrotasks();
    expect(harness.delivered).toHaveLength(1);
    expect(harness.history).toHaveLength(2);

    releasePipeline();
    installPipeline(harness.deps);
    submit(requestOf());
    await settleMicrotasks();
    expect(harness.delivered).toHaveLength(2);
  });

  // 归档面违约发生在投递之后：不在这里收口，「通知发出去了但历史里没有」就只剩一个未捕获拒绝，
  // 而它挂在宿主事件链上，抛出去会打断别人的流程。
  it("归档面违约经「投递失败」告警收口：既不抛穿，也不静默（这是这条通知唯一的痕迹）", async () => {
    const logger = makeLogger();
    assemble({
      logger,
      stores: {
        appendHistory: () => {
          throw new Error("历史文件不可写");
        },
        recordStatus: () => {},
      },
    });

    submit(requestOf());
    await pollUntil(() => logger.warns.length === 1, "归档违约经日志收口");
    expect(logger.warns[0]).toContain("投递失败");
    expect(logger.warns[0]).toContain("历史文件不可写");
  });
});
