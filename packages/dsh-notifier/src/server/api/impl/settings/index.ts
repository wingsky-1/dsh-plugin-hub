/** api 域设置端点：读设置视图、写设置。写面把请求**形状**与设置**内容**分开把关——`patch` 是不是对象、
 * `expectedRevision` 是不是非负整数是线协议的事，本域判；字段值合不合法、掩码要不要还原由 config 域写面回答。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../../../../../../../shared/host-utils.js";
import type { ConfigPort, RawSettingValue } from "../../deps.ts";
import { sendFailure, sendJson } from "../route/index.ts";
import type { RouteHandler } from "../route/type.ts";
import type { PatchRequest } from "./type.ts";

/** 请求体上限（字节）：设置是几百字节的 JSON，16KB 已远超合理值。 */
const BODY_LIMIT = 16 * 1024;

/** 写面结果：不额外请 config 域导出一个类型名，它的形状经能力面的签名可达。 */
type WriteOutcome = Awaited<ReturnType<ConfigPort["writeConfig"]>>;

/**
 * 设置端点。用类而不是返回闭包的工厂：闭包会把「这个处理函数从哪拿到 config 域」藏进词法环境，
 * 而类把它摊在构造签名上，于是「这个端点依赖什么」在文件里就能读到。
 */
export class SettingsEndpoints {
  constructor(private readonly config: ConfigPort) {}

  /** GET /config：一次取齐视图的四个事实（分开取会让界面拿旧修订号提交，凭空造出冲突）。 */
  readonly read: RouteHandler = (_req: IncomingMessage, res: ServerResponse): void => {
    sendJson(res, 200, { ok: true, ...this.config.readSettingsView() });
  };

  /**
   * PUT /config：写用户设置。四态逐态映射而不是压成一两个状态码：`invalid` 要让界面定位到出错的
   * 那一行，`conflict` 要触发「加载最新 / 覆盖提交」的恢复流程，`unavailable` 要把表单整体置灰
   * ——压扁之后用户看到的就只剩「保存失败」，而三种原因要做的事完全不同。
   */
  readonly write: RouteHandler = async (
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
    // 断言只声明「这里有这两个字段」，不校验它们是什么——校验是紧接着的两步。
    const body = raw as PatchRequest;
    if (!isPatch(body.patch)) {
      sendFailure(res, 400, {
        error: "配置校验失败: patch",
        hint: "需至少包含一个配置键（patch 不能为空）",
      });
      return;
    }
    const patch = body.patch;
    const revision = body.expectedRevision;
    if (revision === undefined) {
      respond(res, await this.config.writeConfig(patch));
      return;
    }
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
      sendFailure(res, 400, {
        error: "配置校验失败: expectedRevision",
        hint: "expectedRevision 必须为非负整数或省略",
      });
      return;
    }
    respond(res, await this.config.writeConfig(patch, revision));
  };
}

/** 提交体里的 `patch` 是不是一份可用的记录。不判形状就会被上面的断言一路放行：`{patch: "abc"}` 在设置域里是三个
 * 「陌生键」，而陌生键是刻意放行的（透传保留），于是一次非法请求会把 "0"/"1"/"2" 写进配置文件。空 patch 也归为不可用
 * ——它在设置域是一次「无变化的写」，在界面上却是一次点击，两者对不上时用户会以为这次保存丢了。 */
function isPatch(value?: RawSettingValue): value is { readonly [key: string]: RawSettingValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).length > 0;
}

/**
 * 写面结果 → 响应。成功体只回 `user` 与 `revision`：`effective` 是这次合并的结果，界面用自己刚
 * 提交的草稿就能推出来，多回一份只会多一个可能与本地草稿不一致的「服务端版本」。
 */
function respond(res: ServerResponse, result: WriteOutcome): void {
  if (result.ok) {
    sendJson(res, 200, { ok: true, user: result.view.user, revision: result.view.revision });
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
