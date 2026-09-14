/**
 * 客户端展示缺省值（单一事实源）。
 *
 * 此前同一张 13 键表在 client/index.ts 与 settings-card.tsx 各存一份拷贝，且无任何
 * 门禁比对——两份可以各自漂移而无人察觉（settings-card 那份还是导出后零消费者的
 * fallback）。收敛到端内共享叶子后只剩一份；config-matrix 门禁也从本文件取表
 * （AST 解析顶层 `DEFAULTS`），路径改动见 runLanProxy 的 clientPath。
 *
 * 口径：它是「界面展示缺省」而非宿主 schema——键集必须是 Config 的子集，且
 * schema − DEFAULTS 的差集必须恰为 UI 豁免表（两条都由 config-matrix 门禁强制）。
 * 注意它不等于宿主 DEFAULT_OPTIONS：后者只覆盖 host / port / httpsPort / targetHost。
 */
export const DEFAULTS: Record<string, any> = {
  enabled: true,
  port: 3081,
  httpsEnabled: true,
  httpsPort: 3443,
  tlsCertFile: "",
  tlsKeyFile: "",
  printBanner: true,
  wsBridgeEnabled: true,
  wsCompressEnabled: true,
  wsCompressPaths: ["/api/remote.mux"],
  httpCompressEnabled: true,
  httpCompressLevel: 1,
  injectToken: true,
};
