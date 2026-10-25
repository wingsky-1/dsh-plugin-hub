/**
 * dsh-notifier pipeline dispatch tests —— 共享装配夹具。
 *
 * 只伪造 pipeline/deps.ts 声明的端口并记录观测事实；测试决策仍留在四个自然职责文件中。
 */
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import type { NotifyConfig } from "../../../src/server/config/impl/model/type.ts";
import type { DeliverReason } from "../../../src/server/shared/interface.ts";
import type {
  ChannelsPort,
  HistoryEntry,
  NotifyMessage,
  OutgoingFrame,
  PipelineDeps,
} from "../../../src/server/pipeline/deps.ts";
import { installPipeline } from "../../../src/server/pipeline/interface.ts";
import type { NotifyRequest } from "../../../src/server/pipeline/interface.ts";
import { makeLogger } from "../../helpers.ts";

type ChannelConfig = NotifyConfig["channels"][number];
type BarkConfig = Extract<ChannelConfig, { type: "bark" }>;
type WebhookConfig = Extract<ChannelConfig, { type: "webhook" }>;
type DeliveryTarget = Parameters<ChannelsPort["deliver"]>[1][number];

/** 默认表里的内置频道：泛型只为把「按 type 找到的那条」收窄成对应型号——查找条件就是 type 相等。 */
function builtinOf<T extends "browser" | "system">(type: T): Extract<ChannelConfig, { type: T }> {
  const found = DEFAULT_CONFIG.channels.find((channel) => channel.type === type);
  if (found === undefined) throw new Error(`默认表里缺内置频道 ${type}`);
  return found as Extract<ChannelConfig, { type: T }>;
}

/**
 * 关掉两条内置出口：本块要数的是出站频道的投递次数与节奏。
 *
 * 停用只能写在 `channels` 的条目上：`browserNotify` 一类顶层键现在是读面派生出来的只读投影，
 * 改它们不会让内置出口少投一次，计数用例会凭空多出两次投递。
 */
export function builtinsOff(): ChannelConfig[] {
  return [
    { ...builtinOf("browser"), enabled: false },
    { ...builtinOf("system"), enabled: false },
  ];
}

/** 装配面夹具：只伪 `pipeline/deps.ts` 声明的那几个端口，顺手记下四件观测物。 */
export interface Harness {
  readonly history: HistoryEntry[];
  readonly statuses: Array<{
    channelId: string;
    status: "ok" | "failed";
    error: DeliverReason | undefined;
    soundWarning: DeliverReason | undefined;
  }>;
  readonly logger: ReturnType<typeof makeLogger>;
  readonly useConfig: (patch?: Partial<NotifyConfig>) => void;
  readonly onDeliver: (deliver: ChannelsPort["deliver"]) => void;
  /** 让某个频道的状态写面违约（状态文件不可写）：观测面自己坏掉时的行为另算一档。 */
  readonly breakStatusWrites: (channelId: string) => void;
}

export function requestOf(over: Partial<NotifyRequest> = {}): NotifyRequest {
  return { kind: "done", title: "标题", body: "正文", ...over };
}

export function barkChannel(over: Partial<BarkConfig> = {}): BarkConfig {
  return {
    type: "bark",
    id: "a",
    enabled: true,
    baseUrl: "http://127.0.0.1:40281/bark",
    deviceKey: "dk",
    ...over,
  };
}

export function webhookChannel(over: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    type: "webhook",
    id: "w",
    enabled: true,
    url: "http://127.0.0.1:40281/hook",
    auth: "none",
    ...over,
  };
}

/** 只留 system 出口的设置：节流用例要「唯一目标」才数得清投递次数。 */
export function systemOnly(): Partial<NotifyConfig> {
  return {
    channels: [
      { ...builtinOf("browser"), enabled: false },
      { ...builtinOf("system"), enabled: true, popup: true, sound: false },
    ],
  };
}

export function assemble(): Harness {
  const history: HistoryEntry[] = [];
  const statuses: Harness["statuses"][number][] = [];
  const frames: OutgoingFrame[] = [];
  const logger = makeLogger();
  const brokenStatus = new Set<string>();
  const state: { config: NotifyConfig; deliver: ChannelsPort["deliver"] } = {
    config: DEFAULT_CONFIG,
    deliver: async (_message: NotifyMessage, targets: DeliveryTarget[]) =>
      targets.map(() => ({ status: "ok", stage: "delivered" })),
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
      recordStatus: (channelId, status, error, soundWarning) => {
        if (brokenStatus.has(channelId)) throw new Error("状态写面违约");
        statuses.push({ channelId, status, error, soundWarning });
      },
    },
    channels: { deliver: (message, targets) => state.deliver(message, targets) },
  };
  installPipeline(deps);
  return {
    history,
    statuses,
    logger,
    useConfig: (patch = {}) => {
      state.config = { ...DEFAULT_CONFIG, ...patch };
    },
    onDeliver: (deliver) => {
      state.deliver = deliver;
    },
    breakStatusWrites: (channelId) => {
      brokenStatus.add(channelId);
    },
  };
}
