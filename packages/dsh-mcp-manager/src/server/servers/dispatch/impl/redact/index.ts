/**
 * dsh-mcp-manager — servers/dispatch/impl/redact/index.ts：调用错误文案的凭据脱敏出口。
 *
 * 为什么独立一块而不是复用 middleware 的 `redact`：那一个的消费面是连接/发现路径（不属本域），
 * 两者共用的底层是 pipeline 的 `createRedactor`——各自一个薄封装，避免两块互相直引。
 *
 * 官方 dsh-mcp-client 不做错误文案脱敏，换引擎后这一层仍必须由我方保留（设计 §2.5）；脱敏源（#770-8 全集快照
 * （全局 store + 全部 projectStores 缓存 + runtimeRegistry，含 disabled/unconnected）由调用方递入取值结果（中间层转供宿主 redactionServers，与 manager/middleware 同一秘密源），本域不持有服务器表。
 */
import type { ServerConfig } from "../../../../config/interface.ts";
import type { DispatchPipelinePort } from "../../deps.ts";

/** 把调用错误文案里的凭据抹掉；服务器表按值传入，每次现建脱敏器（与旧 `hostRedact` 同口径）。 */
export function redactMcpError(
  pipeline: DispatchPipelinePort,
  servers: readonly ServerConfig[],
  text: string,
): string {
  const redactor = pipeline.createRedactor([...servers]);
  return redactor(new Error(text));
}
