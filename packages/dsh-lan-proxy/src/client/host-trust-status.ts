/**
 * dsh-lan-proxy — 客户端 host trust 观测（issue #856）。
 *
 * 宿主端注入（src/server/host-trust/impl/injection.ts）让非回环页面声明 `ownsHost`，从而恢复被上游按
 * `isLoopback` 降级掉的 Host 设置持久化面。本模块把「这个注入到底有没有生效」
 * 变成可观测事实——只看文字声明发现不了上游把 `ownsHost` 从 isLoopback 谓词里
 * 删掉/改名/重排。
 *
 * 三段判定用三个信号，缺一不可：
 * 1. `location.hostname`——区分「本机页面」与「非回环页面」：兼容模式下
 *    isLoopback 同为 true，光看它无法区分两者；
 * 2. 注入脚本落的 marker（`__DSH_LAN_PROXY_HOST_TRUST__`）——宿主侧注入是否真的
 *    落到了本页；
 * 3. 公开事实 `ctx.remote.$host.isLoopback`——上游是否据此把本页判为 Host 独占。
 *
 * 判定逻辑是纯函数（进 test/client-unit，不依赖 DOM），信号读取单独一个函数；
 * 调用侧（设置卡片）必须整段降级为 warn——client 插件 apply 抛错会影响页面启动。
 */

/** 兼容注入脚本在页面里落下的 marker（值与宿主端 HOST_TRUST_RUNTIME_MARKER 同源）。 */
export const HOST_TRUST_RUNTIME_MARKER = "__DSH_LAN_PROXY_HOST_TRUST__";

/**
 * ctx.remote 的防御式最小面（dsh 客户端 Typert Remote 网关）：
 * 仅声明本观测器消费的公开事实 `$host.isLoopback`。官方类型层不在本包依赖面内，
 * 与 packages/dsh-provider-usage/src/client/core.ts 的 RemoteLike 同一做法。
 */
export interface RemoteLike {
  $host?: { isLoopback?: boolean };
}

/** 三段判定所需的三个信号（缺省即「未知」，判定按 fail-closed 处理）。 */
export interface HostTrustSignals {
  /** 页面 authority 的主机名（`location.hostname`；IPv6 字面量保留方括号）。 */
  hostname?: string;
  /** 注入脚本是否真的写入过 transport。 */
  marker?: boolean;
  /** 上游公开事实：本页是否被判定为 Host 独占。 */
  isLoopback?: boolean;
}

/**
 * 观测到的四种状态：
 * - `loopback-page`：本机页（回环 authority，或上游已有 transport 声明 ownsHost 的
 *   宿主独占页）——设置持久化面正常，无需本开关，也不该告警；
 * - `compat-active`：非回环页 + marker 在 + `isLoopback` 为 true——兼容模式生效；
 * - `contract-drift`：非回环页 + marker 在 + `isLoopback` 仍非 true——上游契约已
 *   漂移（或 `ctx.remote` 不可读），显式告警，不静默；
 * - `compat-off`：非回环页 + marker 不在——开关关闭（或本页未被注入），设置面被
 *   上游降级为 memory scope。
 */
export type HostTrustStatus = "loopback-page" | "compat-active" | "contract-drift" | "compat-off";

/** 状态 → 设置卡片 i18n key（判定与展示分离：判定进变异面，文案留字典）。 */
export const HOST_TRUST_STATUS_KEY: Record<HostTrustStatus, string> = {
  "loopback-page": "hostTrustStatusLoopback",
  "compat-active": "hostTrustStatusCompat",
  "contract-drift": "hostTrustStatusDrift",
  "compat-off": "hostTrustStatusOff",
};

/**
 * 与上游 isLoopbackHostname 同口径的回环判据：`localhost` / `[::1]` / 整个 127/8。
 * 不用 `URL`：`location.hostname` 已是规范化后的主机名，再解析一次只会引入
 * 「空串/相对形式」这类无意义分支。
 */
export function isLoopbackHostname(hostname: string | undefined): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  if (typeof hostname !== "string") return false;
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/**
 * 三段判定的纯函数形态（表驱动判据的唯一被测对象）。
 *
 * @param signals - 三个观测信号。
 * @returns 四种状态之一。
 */
export function evaluateHostTrust(signals: HostTrustSignals): HostTrustStatus {
  if (isLoopbackHostname(signals.hostname)) return "loopback-page";
  if (signals.marker !== true) {
    // 非回环页却没有 marker：上游可能已自带 transport（desktop-host 一类宿主独占
    // 页，isLoopback 已为 true）——那是正常态，不是「开关关闭」。
    return signals.isLoopback === true ? "loopback-page" : "compat-off";
  }
  // marker 在但上游仍不认：契约漂移（isLoopback 未知同样按漂移告警，fail-closed）。
  return signals.isLoopback === true ? "compat-active" : "contract-drift";
}

/**
 * 四态判定 → 控制台告警文案（`null` = 该状态不告警）。
 *
 * 为什么需要这条独立出口：唯一原来的渲染面（设置卡片 `settings.plugin.item`）在非回环
 * authority 下根本不挂载——上游按 `isLoopback` 把设置面降级为 memory scope 时，官方设置
 * 插件列表为空（dsh-client-ui-settings-plugins 仅在 namespaces.length > 0 时 renderSlot），
 * 本插件卡片随之缺席。也就是说 `compat-off` 与 `contract-drift` 两个故障态在页面上不可达：
 * **同一枚 isLoopback 信号既决定卡片是否挂载、又决定判定结果**，越是需要这条判定的时候，
 * 承载它的卡片越不在场。devtools 控制台是故障态下唯一不依赖设置面、又随手可得的可见面
 * （issue #856 的原始排查方式）。文案与判定分离，函数保持纯函数形态以便表驱动单测。
 *
 * @param status - `evaluateHostTrust` 的判定结果。
 * @returns 告警正文（调用方补 `[dsh-lan-proxy]` 前缀），无告警时为 null。
 */
export function hostTrustAlert(status: HostTrustStatus): string | null {
  if (status === "contract-drift") {
    return (
      "host trust 契约漂移：注入 marker 已在页面上，但上游 isLoopback 仍非 true——" +
      "兼容注入很可能已失效，设置持久化面仍被上游降级，请按 dsh-upgrade 流程复核"
    );
  }
  if (status === "compat-off") {
    return (
      "host trust 兼容未生效：本页为非回环 authority 且未落注入 marker，上游把设置面降级为 " +
      "memory scope（设置不可持久化）。最常见原因是 ownsHostCompat 为默认关；需要时在宿主侧" +
      "开启（设置 → 插件 → dsh-lan-proxy 或 settings.yaml），或改用 ssh -L 走回环"
    );
  }
  return null;
}

/**
 * 读取运行期信号。DOM/全局访问集中在这里，使上面的判定在 node 环境可直接跑。
 *
 * @param remote - 客户端 ctx.remote（未声明 inject 或服务缺失时为 undefined）。
 */
export function readHostTrustSignals(remote: RemoteLike | undefined): HostTrustSignals {
  const nav = typeof globalThis.location === "undefined" ? undefined : globalThis.location;
  return {
    hostname: nav === undefined ? undefined : nav.hostname,
    marker: (globalThis as unknown as Record<string, unknown>)[HOST_TRUST_RUNTIME_MARKER] === true,
    isLoopback: remote?.$host?.isLoopback,
  };
}
