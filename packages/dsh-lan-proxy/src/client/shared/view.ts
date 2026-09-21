/**
 * dsh-lan-proxy 客户端 —— 端内共享视图类型（服务端快照经 HTTP 到客户端后的读形态）。
 *
 * 为什么在这里镜像而不 `import type` 宿主侧形状（LanProxyConfig / HttpCompressSnapshot）：
 * 跨端面的是 HTTP 快照，脏数据（旧版本/手改存储）本就可能缺键，读侧一律按可选字段 +
 * 调用点收窄使用；字段类型锚在服务端契约的对应字段上，改动即两端同改。
 * 本模块只放类型（零运行时）：不新增覆盖率负担，不参与导出面值块比对。
 */

/** 设置草稿（GET /config effective/user 合并后的客户端视图；数字键在编辑态可短暂持字符串）。 */
export type LanProxySettingsView = {
  [key: string]: unknown;
  enabled?: boolean;
  port?: number | string;
  httpsEnabled?: boolean;
  httpsPort?: number | string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  tlsCaCertFile?: string;
  printBanner?: boolean;
  wsBridgeEnabled?: boolean;
  wsCompressEnabled?: boolean;
  wsCompressPaths?: string[];
  httpCompressEnabled?: boolean;
  httpCompressLevel?: number | string;
  injectToken?: boolean;
  ownsHostCompat?: boolean;
};

/** HTTP 压缩运行快照（GET /config compress 附带；服务端 HttpCompressSnapshot 的读子集）。 */
export type CompressSnapshotView = {
  httpCompressEnabled?: unknown;
  httpCompressMounted?: unknown;
  httpCompressStats?: { compressed?: unknown; passthrough?: unknown };
};

/** GET /config 快照体的读子集（失败体不带 error 段：本卡 load 路径不看 r.ok，见 loadCard）。 */
export type ConfigSnapshotView = {
  user?: Record<string, unknown>;
  effective?: Record<string, unknown>;
  revision?: unknown;
  compress?: CompressSnapshotView | null;
};

/** PUT /config 响应体（调用点只读 revision；失败体的 error 段见 error 注释）。 */
export type PutResultView = {
  revision?: unknown;
  error?: string | { details?: string; code?: string };
};
