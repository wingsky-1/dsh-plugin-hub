/**
 * dsh-lan-proxy — 客户端文案字典（issue #348：复用官方 dsh-client-locale）。
 *
 * 双语平衡：`zh` 为 key 源；`en` 必须覆盖全部 key（编译期锁平衡）。
 * 动态数据用 `{name}` 占位模板，渲染期由 t 插值。
 * 宿主端稳定标识/事件名/配置键/console 日志不翻译（官方原则：数据不翻译）。
 */

/** 简体中文字典（key 源）。 */
export const zh = {
  // 卡片头
  settingsName: "局域网访问（dsh-lan-proxy）",
  settingsDescription: "LAN 端口 / HTTPS / 证书 / 响应压缩 / 启动横幅",
  settingsLoading: "局域网访问：加载中…",
  // 表单
  enable: "启用",
  lanPort: "LAN 端口（HTTP）",
  httpsCoexist: "HTTPS 并存",
  httpsPort: "HTTPS 端口",
  certFile: "证书文件（PEM）",
  certPlaceholder: "留空 = 自动生成自签名证书",
  keyFile: "私钥文件（PEM）",
  keyPlaceholder: "与证书文件成对",
  printBanner: "启动时打印访问地址",
  wsCompress: "WebSocket 压缩（事件流）",
  wsPaths: "压缩路径（逗号分隔）",
  httpCompress: "HTTP 响应压缩（Brotli/gzip）",
  compressLevel: "压缩档位",
  level0: "默认（gzip 6 / br 4）",
  level1: "低（最快：gzip 1 / br 2）",
  level2: "中（均衡：gzip 5 / br 5）",
  level3: "高（最高压缩比：gzip 9 / br 9）",
  injectToken: "局域网免 token 直入",
  injectTokenOnHint:
    "已开启：局域网内任何能访问该端口的设备都无需登录 token 即可完整控制 dsh（含终端命令执行），等效信任整个局域网。仅在可信家庭/办公内网开启；关闭后已登录设备的会话在有效期内仍然有效（约 30 天），不即时吊销。",
  bodyHint:
    "保存即热更新（配置写入宿主统一设置存储，无需重启 dsh web）。修改后内网设备访问新端口，旧端口立即失效。",
  // HTTP 压缩状态行
  compressOff: "HTTP 响应压缩：已关闭",
  compressInactive: "HTTP 响应压缩：未生效",
  compressOn: "HTTP 响应压缩：已启用 · 协商 {neg} 次 · 直通 {pass} 次",
  // 保存反馈
  loadFail: "设置加载失败：{msg}",
  portRangeFail: "保存失败：LAN 端口（HTTP）需为 1-65535 的整数",
  httpsPortRangeFail: "保存失败：HTTPS 端口需为 1-65535 的整数",
  levelRangeFail: "保存失败：压缩档位需为 0-3 的整数",
  unchanged: "未修改",
  savedOk: "已保存，已热更新",
  saveFailConflict: "保存失败：{msg}（请关闭本卡片重新打开后重试）",
  saveFail: "保存失败：{msg}",
  save: "保存",
} as const;

/** 字典 key 并集（LocaleNamespaceMap 声明合并用）。 */
export type LanProxyLocaleKey = keyof typeof zh;

/** 英文词典：必须与 zh key 完整对齐。 */
export const en: Record<LanProxyLocaleKey, string> = {
  settingsName: "LAN access (dsh-lan-proxy)",
  settingsDescription: "LAN port / HTTPS / certificate / compression / banner",
  settingsLoading: "LAN access: loading…",
  enable: "Enabled",
  lanPort: "LAN port (HTTP)",
  httpsCoexist: "HTTPS coexistence",
  httpsPort: "HTTPS port",
  certFile: "Certificate file (PEM)",
  certPlaceholder: "Empty = auto-generate self-signed certificate",
  keyFile: "Private key file (PEM)",
  keyPlaceholder: "Paired with the certificate file",
  printBanner: "Print access URLs at startup",
  wsCompress: "WebSocket compression (event stream)",
  wsPaths: "Compression paths (comma-separated)",
  httpCompress: "HTTP response compression (Brotli/gzip)",
  compressLevel: "Compression level",
  level0: "Default (gzip 6 / br 4)",
  level1: "Low (fastest: gzip 1 / br 2)",
  level2: "Medium (balanced: gzip 5 / br 5)",
  level3: "High (best ratio: gzip 9 / br 9)",
  injectToken: "Token-free LAN access",
  injectTokenOnHint:
    "On: any device that can reach this port on the LAN gets full control of dsh (including terminal command execution) without a login token — equivalent to trusting the entire LAN. Only enable on trusted home/office networks; after turning off, already-signed-in devices stay valid until session expiry (~30 days), no instant revocation.",
  bodyHint:
    "Saving hot-reloads the forwarder (config goes to the host settings store, no restart needed). After the port changes, LAN devices use the new port and the old one stops immediately.",
  compressOff: "HTTP response compression: off",
  compressInactive: "HTTP response compression: not active",
  compressOn: "HTTP response compression: on · negotiated {neg} · passthrough {pass}",
  loadFail: "Failed to load settings: {msg}",
  portRangeFail: "Save failed: LAN port (HTTP) must be an integer 1-65535",
  httpsPortRangeFail: "Save failed: HTTPS port must be an integer 1-65535",
  levelRangeFail: "Save failed: compression level must be an integer 0-3",
  unchanged: "No changes",
  savedOk: "Saved, hot-reloaded",
  saveFailConflict: "Save failed: {msg} (close and reopen this card, then retry)",
  saveFail: "Save failed: {msg}",
  save: "Save",
};
