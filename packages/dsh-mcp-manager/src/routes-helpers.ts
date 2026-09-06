/**
 * dsh-mcp-manager — 路由层共享辅助（#592 消峰拆分：routes ↔ controllers 公共面）。
 *
 * queryParam 从 routes.ts 提升至此，供 routes.ts 与 routes-controllers.ts
 * 双向消费，避免 controllers 反向 import routes 造成装配层与实现层耦合。
 */

/** 读取 URL 查询参数（缺失返回 undefined）。 */
export function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}
