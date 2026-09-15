/**
 * dsh-mcp-manager — server/config/impl/env/index.ts：配置模板预展开与凭据词根（#767 S1-1）。
 *
 * ${ENV} 模板必须在配置交给连接层之前展开：官方 dsh-mcp-client 的 env / headers 只接受
 * 字面量，而落盘配置又必须保持模板形态（展开结果含明文凭据，写盘即泄漏）。展开点归本域，
 * 是因为「哪些字段含模板」是配置面知识；连接域不再持有第二份定义。
 *
 * 凭据词根（SECRET_ENV_NAME）随本块一并迁入：它是 stdio 子进程环境过滤的判据，与
 * ${ENV} 展开同属「配置值出入子进程」这一件事。
 */

import type { ServerConfig } from "../model/type.ts";

/** 凭据形状的环境变量名（父进程环境不自动透传给 MCP 子进程）。 */
export const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** 展开字符串中的 ${ENV_NAME} 引用（未设置 → 空字符串），用于 header/env 值。 */
export function expandEnv(value: unknown): string {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
    const resolved = process.env[name];
    return resolved !== undefined ? resolved : "";
  });
}

/** 递归展开对象值中的 ${ENV_NAME} 引用。 */
export function expandEnvObject(
  input: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    out[key] = expandEnv(value);
  }
  return out;
}

/**
 * 展开一条服务器配置的 env 与 headers 模板，其余字段原样带上。
 *
 * 恒返回新对象：调用方拿着落盘配置就地改写，会让展开后的明文凭据随下一次 store.save()
 * 落进配置文件——模板落盘、连接时才展开是本插件的凭据面不变量。
 */
export function expandServerEnv(server: ServerConfig): ServerConfig {
  const next: ServerConfig = { ...server };
  if (server.env !== undefined) next.env = expandEnvObject(server.env);
  if (server.headers !== undefined) next.headers = expandEnvObject(server.headers);
  return next;
}
