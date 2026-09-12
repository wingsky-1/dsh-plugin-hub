/**
 * dsh-notifier channels 域 —— webhook 出口的投递参数。
 *
 * 凭据由调用方解析后传入：本域不回显凭据、不做掩码往返。
 */

/** webhook 认证方式：已解析的凭据对象，与配置层存的「认证方式」不是同一个形状。 */
type WebhookAuth =
  | { kind: "bearer"; token: string }
  | { kind: "basic"; user: string; password: string }
  | { kind: "query"; name: string; value: string };

/** webhook 出口。 */
export interface WebhookTarget {
  type: "webhook";
  url: string;
  preset: "raw" | "ntfy" | "gotify";
  auth?: WebhookAuth;
  headers?: Record<string, string>;
  timeoutSec?: number;
}
