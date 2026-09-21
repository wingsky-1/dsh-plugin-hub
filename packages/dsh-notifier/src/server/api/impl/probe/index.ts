/** api 域自检端点：发测试通知、报宿主平台。测试通知走的是**同一条**裁决管线（能力面的 `submit`），不另开旁路——
 * 否则「测试能响、真实事件不响」这类问题会被测试本身掩盖掉。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type JsonBodyInvalidReason,
  readJsonBodyOutcome,
} from "../../../../../../../shared/host-utils.js";
import type {
  ChannelPort,
  ConfigPort,
  HostCapabilities,
  LoggerPort,
  PipelinePort,
} from "../../deps.ts";
import { sendFailure, sendJson } from "../route/index.ts";
import type { RouteHandler } from "../route/type.ts";
import { streamHub } from "../stream/index.ts";
import { DryRunGate, executeDryRun, withDryRunBudget } from "./dry-run/index.ts";
import { DryRunInputError, DryRunTimeoutError, TEST_NOTIFICATION } from "./dry-run/type.ts";
import type { TestRequest } from "./type.ts";

/**
 * 请求体上限（字节）：16K，与 settings 端对齐（提案 B5）。draft 里带模板与自定义头时
 * 体积天然以此为界（B4「模板头体积以 BODY_LIMIT 为界」，无单字段上限）；超限 400 复用
 * invalidBodyDetail。无 draft 的老路不受影响（原来几十字，最多一个频道 id）。
 */
const BODY_LIMIT = 16 * 1024;

/** 畸形 body 的回应文案：与 settings/kinds 的 invalid-json 同族，并把成因说清（客户端会展示 details）。 */
function invalidBodyDetail(reason: JsonBodyInvalidReason, limit: number): string {
  if (reason === "too-large") return `请求体超出大小上限（${limit} 字节）`;
  if (reason === "not-object") return "请求体必须是 JSON 对象";
  if (reason === "unreadable") return "请求体读取失败";
  return "请求体不是合法 JSON";
}

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

  /** dry-run 并发门：实例字段（与真实投递的节奏表相互独立，见 DryRunGate）。 */
  private readonly dryRunGate = new DryRunGate();

  constructor(
    private readonly pipeline: PipelinePort,
    private readonly channels: ChannelPort,
    private readonly logger: LoggerPort,
    private readonly config: ConfigPort,
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
    // draft 出现即草稿测试（dry-run）：测眼前草稿、同步返回结果，全程零落盘。
    // 无 draft 时走老路（已保存配置的广播 / onlyChannel），语义一个字不改。
    if (body.draft !== undefined) {
      await this.testDraft(res, channelId, body.draft);
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
   * POST /test 的 dry-run 分支：单频道实测，同步返回 B3 schema。
   *
   * 禁写面落实在本函数：400 / 408 / 429 / 500 全部经 sendFailure / sendJson 直接回，
   * 永不调 logger（含路由收口的 500 兜底——execute 只抛 DryRunInputError 与预算超时，
   * 其余异常在这里就地收成固定文案的 500，不进日志）；stores / frames 本就没有入参，
   * 结构上够不着。槽位按 settle / 超时释放（finally），不按子进程退出（B7）。
   */
  private readonly testDraft = async (
    res: ServerResponse,
    channelId: unknown,
    draft: unknown,
  ): Promise<void> => {
    if (typeof channelId !== "string" || channelId.length === 0) {
      sendFailure(res, 400, {
        error: "草稿测试参数非法",
        details: "dry-run 只测单个频道：channelId 必须为非空字符串",
      });
      return;
    }
    if (!this.dryRunGate.tryAcquire()) {
      sendFailure(res, 429, {
        code: "dry-run-busy",
        error: "草稿测试并发已满，请稍后手动重试",
        details: "同时最多 2 个 dry-run（不排队）",
      });
      return;
    }
    try {
      const result = await withDryRunBudget(
        executeDryRun(
          { config: this.config, pipeline: this.pipeline, channels: this.channels },
          channelId,
          draft,
        ),
      );
      sendJson(res, 200, result);
    } catch (cause) {
      if (cause instanceof DryRunInputError) {
        sendFailure(res, 400, {
          error: "草稿测试参数非法",
          details: cause.message,
        });
      } else if (cause instanceof DryRunTimeoutError) {
        sendFailure(res, 408, {
          code: "dry-run-timeout",
          error: "草稿测试超时（15s），结果已丢弃",
          details: "在飞的投递无法撤回：若对方实际收到了，它不会出现在历史与状态里",
        });
      } else {
        sendFailure(res, 500, { error: "草稿测试内部错误" });
      }
    } finally {
      this.dryRunGate.release();
    }
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
