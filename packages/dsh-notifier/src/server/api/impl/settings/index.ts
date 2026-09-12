/**
 * dsh-notifier api 域 —— 设置端点：读设置视图、写设置。
 *
 * 依赖方向：只引用本目录与 `../../deps.ts`，不引用 `interface.ts`。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readSettingsView } from "../../deps.ts";
import { sendJson } from "../route/index.ts";

/** GET /config：一次取齐视图的四个事实（分开取会让界面拿旧修订号提交，凭空造出冲突）。 */
export function readSettings(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, readSettingsView());
}

/**
 * PUT /config：写用户设置。
 *
 * 未实现。待填：读 JSON 体 → 取 `patch` 与 `expectedRevision` → `writeConfig` → 按
 * `WriteResult` 的四态映射状态码（ok 200 / invalid 400 / conflict 409 / unavailable
 * 503）。四态各有各的界面处置，压成一两个就会丢掉「该刷新重试」与「这个字段填错了」
 * 的区别。
 */
export async function writeSettings(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  void res;
  throw new Error("not implemented: api 设置写入");
}
