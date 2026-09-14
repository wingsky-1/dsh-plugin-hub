/**
 * 包内共享默认值：宿主配置 schema 与转发器参数默认值的同一份来源。
 *
 * 它同时是「配置默认值」与「createLanProxy 参数默认值」，没有单一归属——归任一域都会
 * 造成反向依赖（归位前归引擎域，配置域因此值引 proxy.ts）。放在共享叶子两侧同向依赖它。
 *
 * 注意 cordis.patch.yml 的 `port: 3081` 是 bundle 层显式配置，与本默认值需保持一致。
 */
export const DEFAULT_OPTIONS = Object.freeze({
  host: "0.0.0.0",
  port: 3081,
  httpsPort: 3443,
  targetHost: "127.0.0.1",
});
