/**
 * dsh-notifier pipeline 域 —— 路由：这条通知该发给谁（纯函数，判据全来自设置）。
 * 目标身份由客户端锁定：`bark:<id>` / `webhook:<id>` / 内置 `browser`、`system`。
 *
 * 本块对每个频道**只有一个判断：`enabled`**（发不发）。发什么——弹窗、声音、只响不弹、还是什么都
 * 不发——由出口按传到手上的配置自己决定；管线只搬配置，不预设形态。
 */
import type { EffectiveConfig } from "../../deps.ts";
import { BUILTIN_CHANNELS, channelIdOf, deliveryPresetOf } from "../../../../shared/interface.ts";
import { toastScriptPath } from "../../../shared/interface.ts";
import type { NotifyKind } from "../service/kinds.ts";
import type { NotifyRequest } from "../service/type.ts";
import type {
  BarkConfig,
  BarkTarget,
  BarkTextKey,
  BrowserConfig,
  RouteDeps,
  RouteOutcome,
  RoutedTarget,
  SystemConfig,
  WebhookConfig,
  WebhookTarget,
} from "./type.ts";

// 内置频道 id、频道对外 id 规则与「配置层预设 → 投递层预设」的改名都是两端契约，事实源在
// src/shared/{channels,webhooks}.ts（客户端消费同一份）：两端各写一份时的漂移症状是「用户勾了
// 频道却收不到」与「设置页看到的模板不是实际发出去的那份」。

/** 路由：按 kind 与设置选出本次要投递的目标。 */
export function routeTargets(
  deps: RouteDeps,
  config: EffectiveConfig,
  request: NotifyRequest,
): RouteOutcome {
  return narrowRoutes(config, request, resolvePool(deps, config, request.kind));
}

/**
 * 投递池：本次请求可用的全部目标（路由收窄之前的全集），顺序即 `channels` 顺序（内置恒在最前）。
 *
 * 唯一的判据是 `enabled`：弹窗与声音都关掉的频道照样进池，由出口回答「这次没有可发的内容」
 * ——那既不是在这里替出口判形态，也不会被伪装成一次投递成功。
 *
 * 整段包在 try 里：读配置 fail-soft，一个脏项不该吃掉整条通知（配置坏与出口失败是两回事——
 * 后者是返回值，前者只能在这里拦住）。已收进池的目标照常投递。
 */
function resolvePool(deps: RouteDeps, config: EffectiveConfig, kind: NotifyKind): RoutedTarget[] {
  const pool: RoutedTarget[] = [];
  try {
    for (const channel of config.channels) {
      if (!channel.enabled) continue;
      switch (channel.type) {
        case "browser":
          pool.push(browserTarget(channel, deps, kind));
          break;
        case "system":
          pool.push(systemTarget(channel, deps));
          break;
        case "bark":
          pool.push({ channelId: channelIdOf(channel), target: barkTarget(channel, kind) });
          break;
        case "webhook":
          pool.push({ channelId: channelIdOf(channel), target: webhookTarget(channel) });
          break;
      }
    }
  } catch (cause) {
    deps.logger.warn(
      `dsh-notifier: 频道读取失败（fail-soft 跳过）: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return pool;
}

/** 浏览器内置频道 → 目标：配置原样搬运，播放决议由出口解析。
 *
 * 导出给草稿测试（dry-run）复用同一份映射：它跳过 enabled 门直构单目标，映射本身必须与
 * 路由一致，否则「测得通、存下来不通」。 */
export function browserTarget(
  channel: BrowserConfig,
  deps: RouteDeps,
  kind: NotifyKind,
): RoutedTarget {
  return {
    channelId: BUILTIN_CHANNELS.browser,
    target: {
      type: "browser",
      popup: channel.popup,
      sound: channel.sound,
      whenVisible: channel.whenVisible,
      // kind 随帧一起出去：客户端靠它选图标与颜色。
      emitFrame: (frame) => deps.frames.emit({ kind, frame }),
    },
  };
}

/** 系统内置频道 → 目标；脚本路径由组合层推导后传入，出口不做路径猜测。
 *
 * 导出理由同 browserTarget：dry-run 直构单目标时复用同一份映射。 */
export function systemTarget(channel: SystemConfig, deps: RouteDeps): RoutedTarget {
  return {
    channelId: BUILTIN_CHANNELS.system,
    target: {
      type: "system",
      popup: channel.popup,
      sound: channel.sound,
      toastScript: toastScriptPath(),
      logger: deps.logger,
    },
  };
}

/** bark 配置 → 投递参数；空串是归一化表达「没配置」，投递层的缺省才是真缺省。
 *
 * 导出理由同 browserTarget：dry-run 直构单目标时复用同一份映射。 */
export function barkTarget(channel: BarkConfig, kind: NotifyKind): BarkTarget {
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
  assignBarkOptional(target, channel);
  return target;
}

/**
 * 有值才带的三格。它们的「带」判据三样各别（badge 认 undefined、timeoutSec 认正数、
 * extras 认整袋），故与上面那五格文本字段分开——改一格的判据不会牵动另外两格。
 */
function assignBarkOptional(target: BarkTarget, channel: BarkConfig): void {
  // badge 是数字（0 有语义：清掉角标），所以「有值就带」而不是「非零才带」。
  if (channel.badge !== undefined) target.badge = channel.badge;
  if (channel.timeoutMs !== undefined && channel.timeoutMs > 0) {
    target.timeoutMs = channel.timeoutMs;
  }
  // 未知键整袋带走：出口把它原样写进推送体（前向兼容），这里不做逐键判断。
  if (channel.extras !== undefined) target.extras = channel.extras;
}

/** 可选文本字段：空串即「没配置」，不带进目标。 */
function assignText(target: BarkTarget, key: BarkTextKey, value: string): void {
  if (value.length > 0) target[key] = value;
}

/** webhook 配置 → 投递参数；凭据在这里解析成投递层的对象。
 *
 * 导出理由同 browserTarget：dry-run 直构单目标时复用同一份映射。 */
export function webhookTarget(channel: WebhookConfig): WebhookTarget {
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
  assignAuth(target, channel);
  assignAuthHeader(headers, channel);
  if (Object.keys(headers).length > 0) target.headers = headers;
  if (channel.timeoutSec !== undefined && channel.timeoutSec > 0) {
    target.timeoutSec = channel.timeoutSec;
  }
  // 未知键只保留在生效设置里（webhook 的 body 由模板渲染，透传键不绕开模板语义）。
  if (channel.extras !== undefined) target.extras = channel.extras;
  return target;
}

/** bearer / basic 凭据写进目标；空串与缺省同义（都没配），此时不带认证。 */
function assignAuth(target: WebhookTarget, channel: WebhookConfig): void {
  if (channel.auth === "bearer" && channel.token !== undefined && channel.token.length > 0) {
    target.auth = { kind: "bearer", token: channel.token };
    return;
  }
  if (channel.auth === "basic" && channel.username !== undefined && channel.username.length > 0) {
    target.auth = { kind: "basic", user: channel.username, password: channel.password ?? "" };
  }
}

/** header 认证的头并入自定义头；名或值为空即没配全，与「认证方式不是 header」一样不带。 */
function assignAuthHeader(headers: Record<string, string>, channel: WebhookConfig): void {
  if (channel.auth !== "header") return;
  const name = channel.headerName;
  const value = channel.headerValue;
  if (name !== undefined && name.length > 0 && value !== undefined && value.length > 0) {
    headers[name] = value;
  }
}

/** 缺 preset 回落 `ntfy`：归一化后恒有值，这里是脏配置的兜底（与旧实现同口径）。 */
function presetOf(channel: WebhookConfig): WebhookTarget["preset"] {
  const preset = channel.preset;
  return preset === undefined ? "ntfy" : deliveryPresetOf(preset);
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
  const known = new Set<string>();
  // 内置条目与实例走同一条 id 规则（`channelIdOf` 对内置取裸 `type`），这里不为它们开分支：
  // 归一化保证两条内置条目恒在场，所以 `browser` / `system` 一定被收进来。
  for (const channel of config.channels) known.add(channelIdOf(channel));
  return known;
}
