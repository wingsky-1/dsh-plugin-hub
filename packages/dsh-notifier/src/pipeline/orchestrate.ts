/**
 * dsh-notifier — 推送管线域：编排（渲染 → 裁决 → 统一脱敏 → 落史 + fail-soft 投递）。
 *
 * 本文件是调度层的编排半边（裁决半边在 adjudicate.ts、投递半边在 deliver.ts）：
 * - encodeBrowserSound：browser 帧级 sound 编码（纯函数，SSE 帧契约同源）；
 * - resolveChannelPool：投递池解析（内置频道按快照解析启用条件与播放决议，
 *   出站频道 fail-soft 并入）；
 * - createHandleDecision：裁决结果 → 受理结果，统一脱敏时点与 suppressed 分叉；
 * - createSendKind：kind 形态的统一通知管线（渲染 → 裁决 → 编排）。
 *
 * 依赖纪律：只 import config/text 的**值**与 sdk/pipeline 的**类型**
 * （sdk 域经 pipeline/interface.ts 值消费本域，本文件反向取值即构成值环）。
 */
import { BUILTIN_CHANNELS, resolveSoundSetting } from "../config/interface.ts";
import type { NotifyConfig, SoundId } from "../config/interface.ts";
import { KIND_SEVERITY, NOTIFY_KINDS, sanitizeNoticeContent } from "../text/interface.ts";
import type { NotifyDetail } from "../text/interface.ts";
import type { NotifyChannel, NotifyResult } from "../sdk/interface.ts";
import type {
  AdjudicateResult,
  ChannelPoolEntry,
  Deliverer,
  OrchestrateDeps,
  SendKindDeps,
} from "./interface.ts";

/** browser 帧级 sound 编码（BrowserDispatchSpec.sound；与 SSE 帧契约同源：
 *  false → silent；pop=true：true → system、SoundId → selfplay+tone；pop=false
 *  （只响不弹）：无 OS 通知实体可发声，true 也编码 selfplay（客户端默认旋律，编码需随 pop 决议，否则 system 模式会让客户端既不弹也不播）。 */
export function encodeBrowserSound(sound: NotifyConfig["browserSound"], pop: boolean): { mode: "silent" | "system" | "selfplay"; tone?: SoundId } {
  if (sound === false) return { mode: "silent", tone: undefined };
  if (sound === true) return pop ? { mode: "system", tone: undefined } : { mode: "selfplay", tone: undefined };
  return { mode: "selfplay", tone: sound };
}

/**
 * 投递池解析（裁决时随快照调用——单刻语义：启用条件与播放决议全部基于
 * 传入快照，派生闭包不得自行读 current）。内置频道按「弹窗开关 || 声音非静音」
 * 进入（弹窗关 + 声音开 → 只响不弹投递）；出站频道 enabled 过滤
 * 由装配层保证。
 * @param snapshot 裁决单刻快照（声音/弹窗开关读面）。
 * @param deps 投递池来源（内置实例由装配层注入；出站频道配置驱动）。
 */
export function resolveChannelPool(
  snapshot: NotifyConfig,
  deps: {
    builtinChannels: Array<{ id: string; channel: NotifyChannel }>;
    outboundChannels(): ChannelPoolEntry[];
    logger: { warn: (message: string) => void };
  },
): ChannelPoolEntry[] {
  const out: ChannelPoolEntry[] = [];
  const browser = deps.builtinChannels.find((c) => c.id === BUILTIN_CHANNELS.browser);
  const browserSound = resolveSoundSetting(snapshot, "browser");
  if (browser && (snapshot.browserNotify || browserSound !== false)) {
    const pop = snapshot.browserNotify === true;
    out.push({ ...browser, dispatch: { pop, sound: encodeBrowserSound(browserSound, pop) } });
  }
  const system = deps.builtinChannels.find((c) => c.id === BUILTIN_CHANNELS.system);
  const systemSound = resolveSoundSetting(snapshot, "system");
  if (system && (snapshot.systemNotify || systemSound !== false)) {
    out.push({ ...system, dispatch: { pop: snapshot.systemNotify === true, sound: systemSound } });
  }
  try {
    out.push(...deps.outboundChannels());
  } catch (error) {
    deps.logger.warn(`dsh-notifier: 出站频道读取失败（fail-soft 跳过）: ${error instanceof Error ? error.message : String(error)}`);
  }
  return out;
}

/**
 * 创建编排器：裁决结果 → 受理结果（suppressed：disabled 不落史/kind-pending、
 * quiet 落史 + skipped；deliver：stale warn + 全链投递 + 落史）。
 * 统一脱敏时点 = 渲染完成后、任何落史/投递前——裁决结果已携带快照
 * 解析的 sanitizeContent 开关（单刻契约：此处不得二次调用 current()），
 * 本函数按开关对结果文本统一脱敏一次后落入历史/投递。
 * @param deps 注入面（deliver / appendHistory / logger）。
 */
export function createHandleDecision(deps: OrchestrateDeps): (decision: AdjudicateResult) => NotifyResult[] {
  const { deliver, appendHistory, logger } = deps;
  return function handleDecision(decision: AdjudicateResult): NotifyResult[] {
    if (decision.decision === "suppressed") {
      const { kind, title, body, ts, reason, sanitizeContent } = decision;
      if (reason === "disabled") {
        return [{ channelId: "*", status: "skipped", error: "enabled=false" }];
      }
      const safe = sanitizeNoticeContent({ title, body }, sanitizeContent);
      if (reason === "quiet") {
        logger.info(`dsh-notifier: ${kind} 被免打扰拦截（未发出）：${safe.body.replace(/\n/g, " / ")}`);
      }
      appendHistory({ ts, kind, title: safe.title, message: safe.body, suppressed: reason });
      return [{ channelId: "*", status: "skipped", error: reason }];
    }
    const notice = decision.notice;
    for (const id of notice.stale) {
      logger.warn(`dsh-notifier: kindRoutes[${notice.kind}] 指向已删除频道 ${id}，记 skipped`);
    }
    const safe = sanitizeNoticeContent({ title: notice.title, body: notice.body }, notice.sanitizeContent);
    const results = deliver({ ...notice, title: safe.title, body: safe.body });
    logger.info(`dsh-notifier: ${notice.kind} ${safe.body.replace(/\n/g, " / ")}`);
    return results;
  };
}

/**
 * 创建统一通知管线（kind 形态）。外部 send() 与内置事件源都经它收敛——
 * send() 动态 kind 同样过裁决全链。渲染文本原样进裁决（其结果携带脱敏开关），
 * 统一脱敏在其后由编排器按开关执行——本工厂不读 current()（单刻契约）。
 * @param deps adjudicate（裁决器，由 sdk 装配其注入面）+ handleDecision（编排器）。
 * @returns sendKind(kind, detail, opts) → 受理结果数组（投递终态经历史落盘与
 *   wingsky-notify/sent 事件可见）。
 */
export function createSendKind(deps: SendKindDeps): (kind: string, detail?: NotifyDetail, opts?: { bypassQuiet?: boolean; onlyChannel?: string }) => NotifyResult[] {
  const { adjudicate, handleDecision } = deps;
  return function sendKind(kind: string, detail: NotifyDetail = {}, opts?: { bypassQuiet?: boolean; onlyChannel?: string }): NotifyResult[] {
    const spec = NOTIFY_KINDS[kind];
    const ts = Date.now();
    const title = spec?.title ?? "DSH 通知";
    const message = spec?.message({ ...detail, ts }) ?? detail.message ?? "";
    const decision = adjudicate({
      kind,
      title,
      body: message,
      severity: KIND_SEVERITY[kind],
      ts,
      bypassQuiet: opts?.bypassQuiet,
      onlyChannel: opts?.onlyChannel,
    });
    return handleDecision(decision);
  };
}

/** 历史落盘（fire-and-forget）包装：失败只 warn，不打断编排（落史抛错会漏投递）。 */
export function createAppendHistory(deps: {
  append(entry: { ts: number; kind: string; title: string; message: string; suppressed?: string }): void;
  logger: { warn: (message: string) => void };
}): OrchestrateDeps["appendHistory"] {
  return function appendHistory(entry: { ts: number; kind: string; title: string; message: string; suppressed?: string }) {
    try {
      deps.append(entry);
    } catch (error) {
      deps.logger.warn(`dsh-notifier: 历史落盘失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
