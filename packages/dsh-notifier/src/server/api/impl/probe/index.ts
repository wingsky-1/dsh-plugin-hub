/**
 * dsh-notifier api 域 —— 自检端点：发测试通知、报宿主平台。
 *
 * 测试通知走的是**同一条**裁决管线（能力面的 `submit`），不另开旁路——否则「测试能响、
 * 真实事件不响」这类问题会被测试本身掩盖掉。
 *
 * 依赖方向：只引用本目录、`../route/`、`../stream/` 与 `../../deps.ts`，不引用
 * `interface.ts`。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../../../../../../../shared/host-utils.js";
import type { NotifyRequest, PipelinePort } from "../../deps.ts";
import { sendFailure, sendJson } from "../route/index.ts";
import type { RouteHandler } from "../route/type.ts";
import { streamHub } from "../stream/index.ts";
import type { TestRequest } from "./type.ts";

/** 请求体上限（字节）：它最多带一个频道 id。 */
const BODY_LIMIT = 4 * 1024;

/**
 * 测试通知的固定文案。
 *
 * 不引入自由文本面：它验证的是链路本身，不是文案。取值沿用重写前的文案——用户看到的
 * 那两句不该因为一次内部重构而变。
 */
const TEST_NOTIFICATION: NotifyRequest = {
  kind: "test",
  title: "DSH：测试通知",
  body: "通知链路工作正常（此通知来自测试按钮）",
};

/** 自检端点。能力在装配期接上，此后每个请求只读实例字段。 */
export class ProbeEndpoints {
  constructor(private readonly pipeline: PipelinePort) {}

  /**
   * POST /test：造一条 `test` 通知交给裁决管线。
   *
   * 只承诺「已受理」：`submit` 不返回结果，投递结果要去频道状态里看。响应里的
   * `sseConnections` 是**服务端未释放的句柄数**而不是投递计数——两者混起来，会让
   * 「测试发出去了但计数没动」这种正常现象看起来像故障。
   */
  readonly test: RouteHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const raw = await readJsonBody(req, BODY_LIMIT);
    // body 可选，读不到就按全频道测试处理：客户端的两个按钮一个发 `{}`、一个发
    // `{channelId}`，没有第三种形态。
    const body = (raw ?? {}) as TestRequest;
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

  /** GET /health：宿主平台。客户端据此写系统通道的平台提示——不能拿浏览器 OS 猜。 */
  readonly health: RouteHandler = (_req: IncomingMessage, res: ServerResponse): void => {
    sendJson(res, 200, { ok: true, plugin: "dsh-notifier", platform: process.platform });
  };
}
