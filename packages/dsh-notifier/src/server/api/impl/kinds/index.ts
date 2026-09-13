/**
 * api 域动态种类端点：清单与确认。两个动作都走 sdk 域的管理面，本块不自己读设置、不自己写名单——确认态的写入
 * 路径只能有一条，写两份的表现是「设置页上点了允许，通知还是不发」。存在性在本块判（未登记 → 404）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../../../../../../../shared/host-utils.js";
import type { KindPort } from "../../deps.ts";
import { sendFailure, sendJson } from "../route/index.ts";
import type { RouteHandler } from "../route/type.ts";
import type { KindPatchRequest } from "./type.ts";

/** 请求体上限（字节）：它最多带一个种类 id 与一个布尔。 */
const BODY_LIMIT = 4 * 1024;

/** 写面结果：不额外请 sdk 域导出名字，它的形状经能力面的签名可达。 */
type ConfirmOutcome = Awaited<ReturnType<KindPort["confirmKind"]>>;

/** 动态种类端点。能力在装配期接上，此后每个请求只读实例字段。 */
export class KindsEndpoints {
  constructor(private readonly kinds: KindPort) {}

  /** GET /kinds：清单（登记项 × 确认态）。 */
  readonly read: RouteHandler = (_req: IncomingMessage, res: ServerResponse): void => {
    sendJson(res, 200, { ok: true, kinds: this.kinds.listKinds() });
  };

  /**
   * POST /kinds：确认 / 撤销一个动态种类。四态逐态映射而不是压成一两个状态码（未登记 404、
   * 参数非法 400、版本冲突 409、服务不可用 503）——压扁之后用户看到的就只剩「操作失败」。
   * 成功体带回**新修订号**：客户端确认之后要同步自己那份 meta，否则紧接着的一次保存会拿着旧
   * 修订号提交、凭空造出一次冲突，而用户会以为自己刚才的确认没生效。
   */
  readonly confirm: RouteHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const raw = await readJsonBody(req, BODY_LIMIT);
    if (raw === undefined) {
      sendFailure(res, 400, {
        code: "invalid-json",
        details: "请求体不是合法 JSON 对象（或超出大小上限）",
      });
      return;
    }
    // 断言只声明「这里有这两个字段」，不校验它们是什么——校验是紧接着的一步。
    const body = raw as KindPatchRequest;
    const kind = body.kind;
    const confirmed = body.confirmed;
    if (typeof kind !== "string" || kind.length === 0 || typeof confirmed !== "boolean") {
      sendFailure(res, 400, {
        code: "invalid",
        details: "需为 { kind: string, confirmed: boolean }",
      });
      return;
    }
    if (!this.kinds.listKinds().some((entry) => entry.id === kind)) {
      sendFailure(res, 404, { code: "not-found", details: `未注册的动态种类: ${kind}` });
      return;
    }
    respond(res, this.kinds, await this.kinds.confirmKind(kind, confirmed));
  };
}

/**
 * 写面结果 → 响应。与设置端点同款映射：同一个写面出来的失败，在两个端点上给出不同的答复，
 * 只会让客户端按路径分叉处理同一件事。
 */
function respond(res: ServerResponse, kinds: KindPort, result: ConfirmOutcome): void {
  if (result.ok) {
    sendJson(res, 200, { ok: true, kinds: kinds.listKinds(), revision: result.view.revision });
    return;
  }
  if (result.reason === "invalid") {
    sendFailure(res, 400, { error: `配置校验失败: ${result.error.key}`, hint: result.error.hint });
    return;
  }
  if (result.reason === "conflict") {
    // 客户端按 `code` 分流而不是按文案：文案会翻译，code 不会。
    sendFailure(res, 409, { error: "版本冲突", code: "SETTINGS_CONFLICT" });
    return;
  }
  sendFailure(res, 503, { error: "设置服务不可用", code: "settings-unavailable" });
}
