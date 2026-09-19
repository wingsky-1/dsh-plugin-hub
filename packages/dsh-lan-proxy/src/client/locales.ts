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
  caCertFile: "CA 公钥文件（PEM，仅读）",
  caCertPlaceholder: "留空 = 无 CA 可下发（自签/孤叶子不下发）",
  caDownload: "移动设备安装证书",
  caDownloadLink: "下载证书（.cer）",
  caDownloadHint:
    "iPhone 用 Safari 点下载：安装描述文件后去“设置→通用→关于本机→证书信任设置”打开信任；Android 在“设置→安全→安装 CA 证书”（自包 WebView 需放行用户 CA）；Windows 双击 .cer 装进“受信任的根证书颁发机构（本地计算机）”。装完重开即零警告；无 CA 时链接 404（属正常：先一键生成本地 CA，或按提示配置 CA）。",
  printBanner: "启动时打印访问地址",
  wsBridge: "WebSocket 桥接（保活，默认开）",
  wsCompress: "WebSocket 压缩（事件流）",
  wsPaths: "压缩路径（逗号分隔）",
  wsPathsHint: "仅控制压缩范围；清空 = 桥接不压缩，保活不受影响（手机端不再频繁断连重连）",
  httpCompress: "HTTP 响应压缩（Brotli/gzip）",
  compressLevel: "压缩档位",
  level0: "默认（gzip 6 / br 4）",
  level1: "低（最快：gzip 1 / br 2）",
  level2: "中（均衡：gzip 5 / br 5）",
  level3: "高（最高压缩比：gzip 9 / br 9）",
  injectToken: "局域网免 token 直入",
  injectTokenOnHint:
    "已开启：局域网内任何能访问该端口的设备都无需登录 token 即可完整控制 dsh（含终端命令执行），等效信任整个局域网。仅在可信家庭/办公内网开启；关闭后已登录设备的会话在有效期内仍然有效（约 30 天），不即时吊销。",
  ownsHostCompat: "向非回环页面声明 ownsHost（兼容）",
  ownsHostCompatHint:
    "已开启：向非回环页面声明 ownsHost，等同伪造上游拓扑事实位——远程页与本机页在界面上不再可区分。解锁的行为：设置持久化落盘 <DSH_HOME>/settings.yaml（文件不存在时新建）、宿主原生「打开配置文件」动作。这不是服务端授权变化（/api 围栏与 launch token / 会话 cookie 认证不变）。仅在你清楚后果时开启；零伪造替代路径见 README「安全模型」的 ssh -L 方案。",
  hostTrustStatusLoopback: "拓扑事实位：本机页，设置持久化可用（无需兼容开关）",
  hostTrustStatusCompat: "拓扑事实位：兼容模式已生效（本页已声明 ownsHost）",
  hostTrustStatusDrift:
    "拓扑事实位告警：注入 marker 在，但上游 isLoopback 仍非 true——上游契约可能已漂移，本次注入很可能已失效，请按 dsh-upgrade 流程复核",
  hostTrustStatusOff:
    "拓扑事实位：本页设置面不可用（上游已按非回环页面降级为内存 scope）。开启上方兼容开关并重新加载本页即可恢复持久化设置。",
  hostTrustHostFacts: "宿主侧事实：兼容开关 {compat}",
  hostTrustOn: "开",
  hostTrustOff: "关",
  bodyHint:
    "保存即热更新（配置写入宿主统一设置存储，无需重启 dsh web）。修改后内网设备访问新端口，旧端口立即失效。",
  // HTTP 压缩状态行
  compressOff: "HTTP 响应压缩：已关闭",
  compressInactive: "HTTP 响应压缩：未生效",
  compressOn: "HTTP 响应压缩：已启用 · 协商 {neg} 次 · 直通 {pass} 次",
  // 一键 CA（issue #930 Phase 2；en 须全量对齐，tsc 锁平衡）
  caModeSelfSigned: "证书状态：自签模式（无 CA，下载不可用）",
  caModeManaged: "证书状态：托管 CA（下载可用）",
  caModeCustom: "证书状态：自定义证书（一键生成已禁用）",
  caConfigError: "证书状态：配置异常（三键不完整或托管文件缺失）",
  caDisabledNoCa: "未配置可用 CA：下载链接将 404。先一键生成本地 CA，或配置 CA 公钥。",
  caFilesMissing: "托管文件缺失或三键不完整：清空证书三键回自签后可重新生成，或恢复缺失文件。",
  caGenerate: "一键生成本地 CA",
  caRotate: "轮换叶子证书",
  caRotateCa: "轮换 CA（危险）",
  caConfirmTitle: "确认证书操作",
  caConfirmCancel: "取消",
  caClearSelfSigned: "一键清空回自签",
  caRevisionStale: "配置版本未知，请刷新后重试",
  caConfirmBody:
    "继续将覆盖现有证书材料（旧材料保留最近一次备份）。默认仅轮换叶子：CA 续用，已装设备零操作；轮换 CA 将使已装设备的信任全部失效，需逐台重新安装。",
  caIpChanged: "局域网 IP 已变化（当期 {ips}）：叶子 SAN 未覆盖，建议轮换叶子（CA 不变）",
  caExpiring: "叶子证书即将到期（{date}）：建议轮换叶子（CA 不变）",
  caGeneratedOk: "证书已生成并生效",
  caGenerateFail: "生成失败：{msg}",
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
  caCertFile: "CA public cert file (PEM, read-only)",
  caCertPlaceholder: "Empty = no CA served (self-signed/orphan leaf never served)",
  caDownload: "Install certificate on mobile devices",
  caDownloadLink: "Download certificate (.cer)",
  caDownloadHint:
    "iPhone: tap the link in Safari to install the profile, then enable trust in Settings → General → About → Certificate Trust Settings; Android: Settings → Security → Install CA certificate (self-packaged WebViews must opt in to user CAs); Windows: double-click the .cer into Trusted Root Certification Authorities (Local Machine). Zero warnings after reopening; a 404 without a CA is expected — generate a local CA first or configure the CA per the hint.",
  printBanner: "Print access URLs at startup",
  wsBridge: "WebSocket bridge (keep-alive, on by default)",
  wsCompress: "WebSocket compression (event stream)",
  wsPaths: "Compression paths (comma-separated)",
  wsPathsHint:
    "Controls compression scope only; empty = bridged without compression, keep-alive unaffected (no more frequent mobile reconnects)",
  httpCompress: "HTTP response compression (Brotli/gzip)",
  compressLevel: "Compression level",
  level0: "Default (gzip 6 / br 4)",
  level1: "Low (fastest: gzip 1 / br 2)",
  level2: "Medium (balanced: gzip 5 / br 5)",
  level3: "High (best ratio: gzip 9 / br 9)",
  injectToken: "Token-free LAN access",
  injectTokenOnHint:
    "On: any device that can reach this port on the LAN gets full control of dsh (including terminal command execution) without a login token — equivalent to trusting the entire LAN. Only enable on trusted home/office networks; after turning off, already-signed-in devices stay valid until session expiry (~30 days), no instant revocation.",
  ownsHostCompat: "Declare ownsHost to non-loopback pages (compat)",
  ownsHostCompatHint:
    'On: non-loopback pages are told to declare ownsHost — equivalent to forging an upstream topology fact. Remote pages and local pages become indistinguishable in the UI. Unlocked behaviours: settings persistence to <DSH_HOME>/settings.yaml (created when missing) and the host-native "open settings file" action. This is not a server-side authorization change (/api fences and launch-token / session-cookie auth are unchanged). Enable only if you accept the consequences; see the ssh -L zero-forgery alternative in the README Security Model.',
  hostTrustStatusLoopback:
    "Topology fact: local page — settings persistence available (no compat switch needed)",
  hostTrustStatusCompat: "Topology fact: compat mode is in effect (this page declared ownsHost)",
  hostTrustStatusDrift:
    "Topology fact WARNING: the injection marker is present but upstream isLoopback is still not true — the upstream contract may have drifted and this injection is likely dead; re-check per the dsh-upgrade flow",
  hostTrustStatusOff:
    "Topology fact: this page has no settings surface (upstream downgraded the non-loopback page to memory scope). Turn on the compat switch above and reload this page to restore persistent settings.",
  hostTrustHostFacts: "Host-side facts: compat switch {compat}",
  hostTrustOn: "on",
  hostTrustOff: "off",
  bodyHint:
    "Saving hot-reloads the forwarder (config goes to the host settings store, no restart needed). After the port changes, LAN devices use the new port and the old one stops immediately.",
  compressOff: "HTTP response compression: off",
  compressInactive: "HTTP response compression: not active",
  compressOn: "HTTP response compression: on · negotiated {neg} · passthrough {pass}",
  caModeSelfSigned: "Certificate state: self-signed (no CA, download unavailable)",
  caModeManaged: "Certificate state: managed CA (download available)",
  caModeCustom: "Certificate state: custom certificate (one-click generation disabled)",
  caConfigError:
    "Certificate state: misconfigured (incomplete key triple or missing managed files)",
  caDisabledNoCa:
    "No usable CA configured: the download link yields 404. Generate a local CA first, or configure a CA public key.",
  caFilesMissing:
    "Managed files are missing or the key triple is incomplete: clear the three certificate keys back to self-signed to regenerate, or restore the missing files.",
  caGenerate: "Generate local CA",
  caRotate: "Rotate leaf certificate",
  caRotateCa: "Rotate CA (dangerous)",
  caConfirmTitle: "Confirm certificate operation",
  caConfirmCancel: "Cancel",
  caClearSelfSigned: "Clear back to self-signed",
  caRevisionStale: "Settings revision unknown. Refresh and retry.",
  caConfirmBody:
    "This overwrites the existing certificate materials (the most recent backup is kept). Only the leaf is rotated by default: the CA is reused and installed devices keep working; rotating the CA invalidates trust on all installed devices and each must reinstall it.",
  caIpChanged:
    "LAN IPs changed (current {ips}): the leaf SANs do not cover them; rotating the leaf is recommended (CA unchanged)",
  caExpiring:
    "The leaf certificate is expiring ({date}): rotating the leaf is recommended (CA unchanged)",
  caGeneratedOk: "Certificate generated and live",
  caGenerateFail: "Generation failed: {msg}",
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
