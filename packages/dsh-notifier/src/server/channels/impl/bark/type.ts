/**
 * dsh-notifier channels 域 —— bark 出口的投递参数与对端形状。
 * 只描述投递需要什么；enabled、校验、默认值属配置层。
 */

/** bark 出口。 */
export interface BarkTarget {
  type: "bark";
  baseUrl: string;
  deviceKey: string;
  level?: string;
  group?: string;
  sound?: string;
  icon?: string;
  url?: string;
  badge?: number;
  timeoutMs?: number;
}

/** POST `/push` 的请求体：device_key 与正文同走 body，绝不进 URL。 */
export interface BarkPushBody {
  device_key: string;
  title: string;
  body: string;
  level?: string;
  sound?: string;
  group?: string;
  icon?: string;
  url?: string;
  badge?: number;
}

/** `/push` 的响应体：只读成功判定用到的两键（部分反代会用 200 包一张错误页）。 */
export interface BarkPushResponse {
  code?: number;
  message?: string;
}
