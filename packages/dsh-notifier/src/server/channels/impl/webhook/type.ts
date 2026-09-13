/**
 * dsh-notifier channels 域 —— webhook 出口的投递参数与渲染形状。
 * 凭据由调用方解析后传入：本域不回显凭据、不做掩码往返。
 */
import type { ChannelExtras, NotifySeverity } from "../deliver/type.ts";

/** 预设：决定默认 body 模板与 {{priority}} 映射（配置层的 custom 即投递层的 raw）。 */
export type WebhookPreset = "raw" | "ntfy" | "gotify";

/** 已解析的凭据：与配置层存的「认证方式」不是同一个形状；只走请求头。 */
type WebhookAuth =
  { kind: "bearer"; token: string } | { kind: "basic"; user: string; password: string };

/** webhook 出口。 */
export interface WebhookTarget {
  type: "webhook";
  url: string;
  preset: WebhookPreset;
  auth?: WebhookAuth;
  headers?: Record<string, string>;
  /** JSON body 模板；空 / 缺省 = 走 preset 默认模板。 */
  template?: string;
  timeoutSec?: number;
  /** 实例里的未知键：只在生效设置里保留（body 由模板渲染，透传键不绕开模板语义）。 */
  extras?: ChannelExtras;
}

/** 模板渲染变量（`source` 恒空串，不在入参里）。 */
export interface WebhookRenderVars {
  title: string;
  message: string;
  kind: string;
  severity?: NotifySeverity;
  ts: number;
}

/** 模板 JSON 的节点：替换只作用于字符串值，容器原样重建。 */
export type WebhookTemplateNode =
  string | number | boolean | WebhookTemplateNode[] | { [key: string]: WebhookTemplateNode };
