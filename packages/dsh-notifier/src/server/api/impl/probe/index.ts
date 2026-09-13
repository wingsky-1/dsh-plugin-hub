/** api 域自检端点：发测试通知、报宿主平台。测试通知走的是**同一条**裁决管线（能力面的 `submit`），不另开旁路——
 * 否则「测试能响、真实事件不响」这类问题会被测试本身掩盖掉。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type JsonBodyInvalidReason,
  readJsonBodyOutcome,
} from "../../../../../../../shared/host-utils.js";
import type {
  ChannelPort,
  HostCapabilities,
  LoggerPort,
  NotifyRequest,
  PipelinePort,
} from "../../deps.ts";
import { sendFailure, sendJson } from "../route/index.ts";
import type { RouteHandler } from "../route/type.ts";
import { streamHub } from "../stream/index.ts";
import type { TestRequest } from "./type.ts";

/** 请求体上限（字节）：它最多带一个频道 id。 */
const BODY_LIMIT = 4 * 1024;

/** 畸形 body 的回应文案：与 settings/kinds 的 invalid-json 同族，并把成因说清（客户端会展示 details）。 */
function invalidBodyDetail(reason: JsonBodyInvalidReason, limit: number): string {
  if (reason === "too-large") return `请求体超出大小上限（${limit} 字节）`;
  if (reason === "not-object") return "请求体必须是 JSON 对象";
  if (reason === "unreadable") return "请求体读取失败";
  return "请求体不是合法 JSON";
}

/** 测试通知的固定文案。不引入自由文本面：它验证的是链路本身而不是文案；取值沿用重写前的文案，用户看到的那两句
 * 不该因为一次内部重构而变。 */
const TEST_NOTIFICATION: NotifyRequest = {
  kind: "test",
  title: "DSH：测试通知",
  body: "通知链路工作正常（此通知来自测试按钮）",
};

/**
 * 能力自检的总预算（毫秒）。探测是串行的（先跑平台命令探测，再逐个试 D-Bus CLI），单次超时叠加起来
 * 最坏可以到十几秒，而 `/health` 是「随时可打」的探活面——超过预算就如实回「无法判定」，并且把这条
 * 结论缓存下来：不缓存会让每个请求都重新等一遍，那是拿用户机器当靶场。
 */
const CAPABILITY_BUDGET_MS = 8000;

/** 给一个 Promise 套总预算；超时即拒绝（调用方按「无法判定」兜底）。 */
function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`能力自检超出 ${ms}ms 预算`)), ms);
    // 预算是兜底不是任务：它不该拖住进程退出（测试里尤其明显）
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

/** 自检端点。能力在装配期接上，此后每个请求只读实例字段。 */
export class ProbeEndpoints {
  /** 能力自检的共享缓存。两条路由共用同一次探测：探测会起子进程，每请求各探一次就是拿用户机器当靶场。 */
  private hostCapabilities?: Promise<HostCapabilities>;

  constructor(
    private readonly pipeline: PipelinePort,
    private readonly channels: ChannelPort,
    private readonly logger: LoggerPort,
  ) {}

  /**
   * 取（必要时首次发起）能力自检。
   *
   * 兜底必须在**这里**：`/health` 是探活面，探测失败若继续往上抛，端点会连 `ok`/`platform`/`sseEvicts`
   * 一起丢掉，一个诊断附属面把主面拖成 500——那比「暂时不知道宿主能力」糟得多。
   */
  private capabilities(): Promise<HostCapabilities> {
    this.hostCapabilities ??= this.probeWithinBudget();
    return this.hostCapabilities;
  }

  private async probeWithinBudget(): Promise<HostCapabilities> {
    try {
      return await withBudget(this.channels.probeCapabilities(), CAPABILITY_BUDGET_MS);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.logger.warn(`dsh-notifier: 能力自检未给出结论（${reason}），按「无法判定」上报`);
      return this.channels.undeterminedCapabilities();
    }
  }

  /**
   * POST /test：造一条 `test` 通知交给裁决管线。只承诺「已受理」：`submit` 不返回结果，投递结果
   * 要去频道状态里看。响应里的 `sseConnections` 是**服务端未释放的句柄数**而不是投递计数——两者
   * 混起来，会让「测试发出去了但计数没动」这种正常现象看起来像故障。
   */
  readonly test: RouteHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const outcome = await readJsonBodyOutcome(req, BODY_LIMIT);
    // body 可选（缺席 = 全频道测试），但**畸形 body 不等于「没有 body」**：这个端点有副作用，
    // 把截断的半包、超限体、非对象 JSON 当缺省处理，等于拿垃圾输入真发一条通知出去。
    if (outcome.kind === "invalid") {
      sendFailure(res, 400, {
        code: "invalid-json",
        details: invalidBodyDetail(outcome.reason, BODY_LIMIT),
      });
      return;
    }
    const body = (outcome.kind === "json" ? outcome.value : {}) as TestRequest;
    const channelId = body.channelId;
    if (channelId !== undefined && (typeof channelId !== "string" || channelId.length === 0)) {
      sendFailure(res, 400, {
        error: "测试通知参数非法",
        details: "channelId 必须为非空字符串或省略",
      });
      return;
    }
    this.pipeline.submit(
      channelId === undefined
        ? TEST_NOTIFICATION
        : { ...TEST_NOTIFICATION, onlyChannel: channelId },
    );
    sendJson(res, 200, { ok: true, sseConnections: streamHub.size() });
  };

  /**
   * GET /health：宿主平台 + 连接回收计数 + 能力面**摘要**。平台值供客户端写系统通道提示（不能拿浏览器 OS 猜）；
   * `sseEvicts` 是 README 承诺的 churn 排障面——只有聚合计数（常量大小），per-conn 明细不上这里。
   * 能力面同样只给结论与维度状态（常量大小），明细（探测了哪些维度、缺哪个包）归 `/diagnostics`。
   */
  readonly health: RouteHandler = async (
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const host = await this.capabilities();
    sendJson(res, 200, {
      ok: true,
      plugin: "dsh-notifier",
      platform: this.channels.hostPlatform(),
      sseEvicts: streamHub.evictStats(),
      capabilities: { host: hostSummary(host) },
    });
  };

  /** GET /diagnostics：完整探测面。与 `/health` **共用同一次探测**，不在这里各探各的。 */
  readonly diagnostics: RouteHandler = async (
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const host = await this.capabilities();
    sendJson(res, 200, {
      ok: true,
      plugin: "dsh-notifier",
      platform: this.channels.hostPlatform(),
      capabilities: { host },
    });
  };
}

/** `/health` 的能力面摘要：只留结论与维度状态。`checked`/`players`/`remediation` 不上聚合面。 */
function hostSummary(host: HostCapabilities): unknown {
  return {
    verdict: host.verdict,
    unknownDimensions: host.unknownDimensions,
    popup: { state: host.popup.state },
    sound: { state: host.sound.state },
  };
}
