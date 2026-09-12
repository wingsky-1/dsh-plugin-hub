/**
 * dsh-notifier pipeline 域 —— 路由：这条通知该发给谁（纯函数，判据全来自设置）。
 * 目标身份由客户端锁定：`bark:<id>` / `webhook:<id>` / 内置 `browser`、`system`。
 */
import type { EffectiveConfig } from "../../deps.ts";
import { toastScriptPath } from "../../../shared/paths.ts";
import type { LoggerPort } from "../../../shared/type.ts";
import type { NotifyKind } from "../service/kinds.ts";
import type { NotifyRequest } from "../service/type.ts";
import type {
  BarkConfig,
  BarkTarget,
  BarkTextKey,
  ChannelConfig,
  RouteDeps,
  RouteOutcome,
  RoutedTarget,
  WebhookConfig,
  WebhookTarget,
} from "./type.ts";

/** 内置频道 id：与客户端频道卡同名（客户端已锁定）。 */
const BUILTIN_CHANNELS = { browser: "browser", system: "system" } as const;

/** 配置里的预设 → 投递层的预设：`custom` 在投递层叫 `raw`。 */
const PRESET_MAP: Record<NonNullable<WebhookConfig["preset"]>, WebhookTarget["preset"]> = {
  ntfy: "ntfy",
  gotify: "gotify",
  custom: "raw",
};

/**
 * 路由：按 kind 与设置选出本次要投递的目标。
 * 内置频道「开关开 或 声音非静音」就进池——弹窗关而声音开就是只响不弹。
 */
export function routeTargets(
  deps: RouteDeps,
  config: EffectiveConfig,
  request: NotifyRequest,
): RouteOutcome {
  return narrowRoutes(config, request, resolvePool(deps, config, request.kind));
}

/** 投递池：本次请求可用的全部目标（路由收窄之前的全集），顺序为内置在前、出站随后。 */
function resolvePool(deps: RouteDeps, config: EffectiveConfig, kind: NotifyKind): RoutedTarget[] {
  const pool: RoutedTarget[] = [];
  const browserSound = config.browserSound;
  if (config.browserNotify || browserSound !== false) {
    pool.push({
      channelId: BUILTIN_CHANNELS.browser,
      target: {
        type: "browser",
        pop: config.browserNotify === true,
        sound: browserSound,
        // kind 随帧一起出去：客户端靠它选图标与颜色。
        emitFrame: (frame) => deps.frames.emit({ kind, frame }),
      },
    });
  }
  const systemSound = config.systemSound;
  if (config.systemNotify || systemSound !== false) {
    pool.push({
      channelId: BUILTIN_CHANNELS.system,
      target: {
        type: "system",
        pop: config.systemNotify === true,
        sound: systemSound,
        toastScript: toastScriptPath(),
        logger: deps.logger,
      },
    });
  }
  pool.push(...outboundTargets(config.channels, kind, deps.logger));
  return pool;
}

/** 出站频道池：只收启用实例；读配置 fail-soft，一个坏项不该吃掉整条通知。 */
function outboundTargets(
  channels: ChannelConfig[],
  kind: NotifyKind,
  logger: LoggerPort,
): RoutedTarget[] {
  const targets: RoutedTarget[] = [];
  try {
    for (const channel of channels) {
      if (!channel.enabled) continue;
      if (channel.type === "bark") {
        targets.push({ channelId: `bark:${channel.id}`, target: barkTarget(channel, kind) });
      } else {
        targets.push({ channelId: `webhook:${channel.id}`, target: webhookTarget(channel) });
      }
    }
  } catch (cause) {
    logger.warn(
      `dsh-notifier: 出站频道读取失败（fail-soft 跳过）: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return targets;
}

/** bark 配置 → 投递参数；空串是归一化表达「没配置」，投递层的缺省才是真缺省。 */
function barkTarget(channel: BarkConfig, kind: NotifyKind): BarkTarget {
  const target: BarkTarget = {
    type: "bark",
    baseUrl: channel.baseUrl,
    deviceKey: channel.deviceKey,
  };
  const level = channel.levels?.[kind] ?? channel.level;
  assignText(target, "level", level ?? "");
  assignText(target, "group", channel.group ?? "");
  assignText(target, "sound", channel.sound ?? "");
  assignText(target, "icon", channel.icon ?? "");
  assignText(target, "url", channel.url ?? "");
  // badge 是数字（0 有语义：清掉角标），所以「有值就带」而不是「非零才带」。
  if (channel.badge !== undefined) target.badge = channel.badge;
  if (channel.timeoutMs !== undefined && channel.timeoutMs > 0) {
    target.timeoutMs = channel.timeoutMs;
  }
  return target;
}

/** 可选文本字段：空串即「没配置」，不带进目标。 */
function assignText(target: BarkTarget, key: BarkTextKey, value: string): void {
  if (value.length > 0) target[key] = value;
}

/** webhook 配置 → 投递参数；凭据在这里解析成投递层的对象。 */
function webhookTarget(channel: WebhookConfig): WebhookTarget {
  const target: WebhookTarget = {
    type: "webhook",
    url: channel.url,
    preset: presetOf(channel),
  };
  // 自定义模板留空即用预设默认模板，所以空串不带进目标。
  if (channel.template !== undefined && channel.template.length > 0) {
    target.template = channel.template;
  }
  // 自定义头先落配置里的那份，认证头随后并入：同名时认证头是更强的事实。
  const headers = { ...channel.headers };
  if (channel.auth === "bearer" && channel.token !== undefined && channel.token.length > 0) {
    target.auth = { kind: "bearer", token: channel.token };
  }
  if (channel.auth === "basic" && channel.username !== undefined && channel.username.length > 0) {
    target.auth = { kind: "basic", user: channel.username, password: channel.password ?? "" };
  }
  if (channel.auth === "header") {
    const name = channel.headerName;
    const value = channel.headerValue;
    if (name !== undefined && name.length > 0 && value !== undefined && value.length > 0) {
      headers[name] = value;
    }
  }
  if (Object.keys(headers).length > 0) target.headers = headers;
  if (channel.timeoutSec !== undefined && channel.timeoutSec > 0) {
    target.timeoutSec = channel.timeoutSec;
  }
  return target;
}

/** 缺 preset 回落 `ntfy`：归一化后恒有值，这里是脏配置的兜底（与旧实现同口径）。 */
function presetOf(channel: WebhookConfig): WebhookTarget["preset"] {
  const preset = channel.preset;
  return preset === undefined ? "ntfy" : PRESET_MAP[preset];
}

/**
 * 路由裁决：`onlyChannel` 直接命中一处并绕过 `kindRoutes`；`kindRoutes[kind]` 非空则把
 * 结果收窄到命中的 id；空或缺省 = 广播全部启用频道。
 */
function narrowRoutes(
  config: EffectiveConfig,
  request: NotifyRequest,
  pool: RoutedTarget[],
): RouteOutcome {
  const only = request.onlyChannel;
  if (only !== undefined) return { targets: pool.filter((t) => t.channelId === only), stale: [] };
  const routes: string[] = config.kindRoutes[request.kind] ?? [];
  if (routes.length === 0) return { targets: pool, stale: [] };
  const wanted = new Set(routes);
  // 停用不算「已删除」：旧实现只对配置里根本不存在的 id 报 stale，否则用户一停用频道
  // 就会收到一串「指向已删除频道」的误导告警。
  const known = knownChannelIds(config);
  return {
    targets: pool.filter((t) => wanted.has(t.channelId)),
    stale: routes.filter((id) => !known.has(id)),
  };
}

/** 已存在的频道 id：内置两个 + 配置里的全部实例（含停用的）。 */
function knownChannelIds(config: EffectiveConfig): Set<string> {
  const known = new Set<string>([BUILTIN_CHANNELS.browser, BUILTIN_CHANNELS.system]);
  for (const channel of config.channels) known.add(`${channel.type}:${channel.id}`);
  return known;
}
