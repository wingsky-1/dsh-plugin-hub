/**
 * dsh-notifier 客户端 —— 测试投递的状态收敛轮询（纯逻辑，零 React 零 DOM，可直测）。
 *
 * 背景（#912 症状2次因）：POST /test 是 fire-and-forget，只承诺“已受理”；旧客户端只做一次
 * 即时 loadStatus，必抢在“能力探测秒级 + 子进程投递秒级 + 状态落盘 debounce 500ms”之前，
 * 真失败（failed）因此显示为“尚未投递”。本模块把“等终态”收成一个可判据的有限轮询。
 *
 * 收敛判据：以目标频道的条目出现/lastTs 推进为准（调用方在 POST 前记下 prevTs）。
 * - 有限轮：默认 8 轮 x 1500ms，预算约 12s，常见覆盖“能力探测（probe 3s 预算）+ 子进程投递
 *   （spawn 8s 超时）+ 落盘 debounce 500ms”。注意 GET /status 读的是内存镜像（即时），
 *   预算里的大头是投递本身，不是落盘。最坏不覆盖：webhook 投递 clamp 上限 60s、冷启动能力探测
 *   8s 与 system kill 8s 串行最坏超 12s——耗尽是 fail-safe（保留旧态 + 刷历史，不谎报），
 *   不是正确性缺陷（常量未链接服务端超时事实源，记债 #912-T3，见 issue 债清单）。
 * - 只读轮询：轮询只打 GET /status，绝不重发 POST /test——重发会撞上 system 出口 1 秒节流窗，
 *   第二次受理变成 throttled 的 skipped（无状态可写），等于用一次“没投递”去等“投递结论”。
 *   间隔取 1500ms（> 1000ms 节流窗）是双保险：即使用户在轮询期间又点了一次测试，两次投递
 *   的结论也不会在同一节流窗里互 alias。
 * - 失败保留旧态：单轮 fetch 抛错只记“这次没拿到”，继续下一轮；全部轮次都没拿到（map 为 null）
 *   时调用方必须保留旧 statusMap（不清空状态行——瞬时抖动不该丢已展示的终态）。耗尽仍未收敛
 *   时返回最后一份成功读到的表（可能为 null），由调用方决定展示（旧态 + 刷新历史）。
 *
 * skipped 可见性决策（二选一，#912 要求 PR 内定、不混写）：选“历史直达”，不改 skipped 值域。
 * - 弃“改值域”：把 skipped 写进 status（ok/failed/skipped 三值）要同步改类型守卫
 *   （stores normalizeEntry）、落盘形态、dispatch settle 的三处判据与理由字典，属于 GET /status
 *   契约变更，影响面大；而“没有投递”本来就没有“最后一次投递结论”，写进去的是伪结论。
 * - 取“历史直达”：skipped 的明细与原因本来就在通知历史里（dispatch 如实归档），状态行在无
 *   条目时若历史中有该频道的 skipped，就把原因与“详情见通知记录”摆出来（见 parts/status.tsx
 *   的 statusText history 形参）。值域保持 ok/failed 锁死，dispatch.test.ts 的锁死判据不动。
 *   已知代价：poll 只收敛 status 不看 history，skipped 主导的测试必等满 12s 耗尽才刷历史
 *   出解释（先排除 failed 的设计代价，最小实现下可接受；后续可做 history 早收敛优化，
 *   记债 #912-T4，见 issue 债清单）。
 */

/** 状态表读视图（GET /status channels 元素的渲染子集；只取判定用得上的字段）。 */
export interface StatusEntryView {
  lastTs?: unknown;
  lastStatus?: unknown;
  lastError?: unknown;
}

/** 状态表视图（键为频道 id，内置裸 type、实例 type:id，与服务端 channelIdOf 同源）。 */
export type StatusMapView = Record<string, StatusEntryView | undefined>;

/** 轮询入参：轮次与间隔可配（测试注入 sleep 钉住时间，不真等）。 */
export interface StatusPollOptions {
  /** 最大轮次（含首轮即时读）。缺省 TEST_STATUS_ATTEMPTS。 */
  attempts?: number;
  /** 轮间间隔毫秒（首轮前不睡）。缺省 TEST_STATUS_INTERVAL_MS。 */
  intervalMs?: number;
  /** 睡眠端口（缺省走 setTimeout；测试注入假件）。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 轮询结论：是否等到新终态，以及最后一轮成功读到的表（全败时为 null）。
 * 泛型 M 让调用方拿回自己传入的表形态（ChannelStatusMap 是 StatusMapView 的结构子集），
 * 免得在 setState 处再做一次收窄断言。
 */
export interface StatusPollResult<M extends StatusMapView = StatusMapView> {
  converged: boolean;
  map: M | null;
}

/** 默认轮次：8 轮（含首轮）。 */
export const TEST_STATUS_ATTEMPTS = 8;

/** 默认轮间间隔：1500ms（> system 1 秒节流窗，见模块头）。 */
export const TEST_STATUS_INTERVAL_MS = 1500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 单表收敛判定：目标频道有条目且 lastTs 为数字，且（无 prevTs，或比 prevTs 新）。
 *
 * prevTs 缺席 = 点击时该频道无条目：此后出现的任何条目都是新证据；prevTs 存在 = 以严格变新
 * 为准（同毫秒重投的 lastTs 可能相等，那次不等，下一轮或耗尽处理——不等旧结论冒充新结论）。
 */
export function statusConverged(
  map: StatusMapView,
  channelKey: string,
  prevTs: number | undefined,
): boolean {
  const entry = map[channelKey];
  if (entry === undefined || entry === null) return false;
  if (typeof entry.lastTs !== "number") return false;
  return prevTs === undefined || entry.lastTs > prevTs;
}

/**
 * 有限轮询：首轮即时读，之后每轮先睡间隔再读；读到收敛即停，耗尽返回最后所见。
 *
 * 单轮 fetch 抛错不抛给调用方（记为本轮无果，继续下一轮）； options.attempts<=0 时一次也不读
 * （调用方显式关掉轮询的形态，返回未收敛 null——与“全败”同形，调用方同样保留旧态）。
 */
export async function pollChannelStatus<M extends StatusMapView>(
  fetchStatus: () => Promise<M>,
  channelKey: string,
  prevTs: number | undefined,
  options: StatusPollOptions = {},
): Promise<StatusPollResult<M>> {
  const attempts = options.attempts ?? TEST_STATUS_ATTEMPTS;
  const intervalMs = options.intervalMs ?? TEST_STATUS_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  let latest: M | null = null;
  for (let round = 0; round < attempts; round += 1) {
    if (round > 0) await sleep(intervalMs);
    let map: M;
    try {
      map = await fetchStatus();
    } catch {
      continue;
    }
    latest = map;
    if (statusConverged(map, channelKey, prevTs)) return { converged: true, map };
  }
  return { converged: false, map: latest };
}
