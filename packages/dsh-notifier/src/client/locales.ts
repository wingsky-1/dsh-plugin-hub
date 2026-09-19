/**
 * dsh-notifier — 客户端文案字典（复用官方 dsh-client-locale）。
 *
 * 双语平衡：`zh` 为 key 源；`en` 必须覆盖全部 key（编译期锁平衡）。
 * 不进字典：console 日志、宿主端错误消息（跨端契约原文匹配「版本冲突」保持）、
 * 通知 kind 动态数据、toast.ps1 宿主端 PowerShell 固定文案（维护者拍板保留并文档明示）
 * （官方原则：数据不翻译）。
 */

import type { BuiltinKind } from "../shared/interface.ts";

/** 简体中文字典（key 源）。 */
export const zh = {
  // 事件开关（EVENT_KEYS label）
  evtAsk: "审批等待",
  evtQuestion: "向你提问",
  evtTaskDone: "任务完成",
  evtSubagentDone: "子任务完成",
  evtTaskError: "任务出错",
  evtTurnEnd: "轮次完成",
  // 通道开关（CHANNEL_KEYS label）
  chSystemNotify: "系统通知",
  chBrowserNotify: "浏览器通知",
  chWhenVisible: "页面可见时也弹",
  chPopup: "弹窗",
  chSound: "声音",
  // 每通道声音行与三态
  chStateOn: "启用",
  chStateSound: "仅声音",
  chStateOff: "已停用",
  chSoundFollow: "跟随系统默认",
  chSoundFollowHint:
    "系统卡：Windows 用系统通知音 / macOS Glass / Linux 自播默认事件音；浏览器卡：交给操作系统发声（不 silent）。",
  chSoundTone: "音色",
  chSoundPreview: "试听",
  chSoundOnlyNote: "弹窗已关、声音开启：本频道只响不弹（不打扰界面）。",
  chPopupSoundOffNote:
    "弹窗与声音都已关闭：本频道不会有任何提醒（要停用请用卡头开关，它是唯一的「发不发」判据）。",
  toneDing: "叮（Ding）",
  toneBell: "铃（Bell）",
  toneChime: "钟琴（Chime）",
  tonePop: "啵（Pop）",
  sysPlatformWin:
    "宿主平台 Windows：系统提示音走 toast 系统音；选音色后经 SoundPlayer 播放内置 wav（近似映射，与系统设置音可不同）。",
  sysPlatformMac:
    "宿主平台 macOS：系统提示音经 osascript/NSSound（Glass/Tink/Sosumi/Pop 近似映射），受系统「允许通知声音」设置约束。",
  sysPlatformLinux:
    "宿主平台 Linux：不依赖桌面守护进程的发声支持——声音由插件自播，按 paplay → pw-play → aplay → ffplay 依次回退且首个成功即停；主题事件音缺失时改用运行时合成的提示音。只命中 paplay/pw-play 时，没有声音服务的宿主听不到声音（两种情形都仍需宿主有音频设备）。",
  sysPlatformOther: "系统提示音随宿主平台尽力而为；此处试听为浏览器本地合成，仅作听感参考。",
  // kind 标签（历史列表）
  kAsk: "审批等待",
  kQuestion: "向你提问",
  kDone: "任务完成",
  kSubagentDone: "子任务完成",
  kError: "任务出错",
  kTurnEnd: "轮次完成",
  kTest: "测试",
  // 403 引导（accessHint）
  lanAccessHint:
    "（若为局域网直连访问，通知服务仅允许回环调用而被拒：请用 dsh-lan-proxy 的 https://<局域网IP>:3443 或 ssh -L 3080:127.0.0.1:3080 隧道访问后刷新）",
  // 设置卡
  settingsLoading: "通知：加载中…",
  settingsUnavailable: "设置服务不可用",
  loadFail: "设置加载失败：{msg}{hint}",
  unchanged: "未修改",
  savedOk: "已保存",
  conflictReloadFail: "冲突恢复失败：未能拉取最新配置，请重试保存",
  saveFail: "保存失败：{msg}",
  saveTimeout: "保存超时：网络请求未在 15 秒内完成，请重试",
  // 409 冲突双动作横幅
  conflictTitle: "配置已在其他窗口被修改：",
  conflictChannels: "频道配置已在其他窗口被修改：",
  conflictLoadLatest: "加载最新（放弃我的修改）",
  conflictOverwrite: "保留我的修改并覆盖",
  conflictIgnore: "忽略",
  conflictLoadedLatest: "已加载最新配置",
  // 测试/清理动作
  testSent: "测试通知已发送（服务端未释放句柄 {n} 条）",
  testFail: "发送测试通知失败：{msg}{hint}",
  cleared: "已清空 {n} 条通知记录",
  clearFail: "清空失败：{msg}{hint}",
  // 配置行
  historyRetention: "历史保留天数（0=不按天清理）",
  dndEnable: "启用免打扰",
  dndStart: "开始时间",
  dndEnd: "结束时间",
  dndStillLabel: "免打扰仍提醒",
  // 免打扰豁免候选：label 复用事件文案（KIND_KEYS），另加未启用提示与快捷项
  allowDisabledHint: "事件未启用",
  allowFollowEnabled: "跟随已启用事件",
  allowResetDefault: "恢复默认（审批/提问/出错）",
  // 权限/降级说明
  settingsSvcDown:
    "设置服务不可用：当前无法保存配置（settings 服务未挂载）。插件通知功能不受影响，但更改将被拒绝。",
  httpDegraded:
    "当前为局域网 HTTP 访问（非安全上下文），浏览器禁止系统级弹窗，已启用「页面内横幅 + 提示音 + 标题提醒」降级通道。如需系统弹窗，请改用 dsh-lan-proxy 的 https://<局域网IP>:3443 或 localhost 隧道访问（如 ssh -L 3080:127.0.0.1:3080）后刷新页面。",
  permGranted: "浏览器通知权限：已授权 ✓",
  permDenied: "浏览器通知权限：已拒绝（请在浏览器站点设置中允许本页通知）",
  permDefault: "浏览器通知权限：未授权（点击下方按钮在浏览器弹窗中允许）",
  iosUnsupported:
    "当前设备不支持系统级通知（如 iOS Safari 普通标签页无 Web Notifications）。可用通道：页面可见时的横幅 + 提示音（需保持页面打开），或经 dsh-lan-proxy 的 https://<局域网IP>:3443 访问并「添加到主屏幕」后获得 PWA 级通知能力。",
  // 动作区
  clearConfirm: "确认清理记录？",
  clearLabel: "清理记录",
  requestPerm: "请求通知权限",
  permRequested: "权限请求完成",
  sendTest: "发送测试通知",
  refresh: "刷新",
  // 历史区
  historyTitle: "通知记录（最近 10 条）",
  historyEmpty: "暂无通知记录（点「发送测试通知」可生成一条）",
  historySuppressed: "免打扰拦截未发出",
  // 逐出口投递明细（通知记录里展开到「这一条投递到了哪些出口、各自结论」）
  chStatusOk: "已投递",
  chStatusFailed: "投递失败",
  chStatusSkipped: "未发出",
  reasonDetailLabel: "来自宿主原文",
  // 投递理由：服务端只给 code，文案在这里（本包 code 与 key 同名，见 reason-text.ts 的完整表）
  reasonLegacy: "升级前的记录",
  reasonUnknown: "原因未知（未能识别这条记录）",
  reasonSkipConfig: "弹窗与声音都已关闭，本次没有可投递的内容",
  reasonSkipEnvironment: "本机没有可用的通知通道（缺系统通知工具或音频播放器），本次未发出",
  reasonSystemPopupFailed: "系统通知命令执行失败（{bin}）",
  reasonSystemSoundFailed: "提示音播放命令执行失败（{bin}）",
  reasonSystemToastScriptMissing: "插件自带的 Windows 通知脚本缺失（打包缺陷），本次未发出",
  reasonSystemToneUnwritable: "系统提示音无法写入临时目录，本次未发声",
  reasonBarkRequestFailed: "Bark 请求失败（网络或超时）",
  reasonBarkHttp: "Bark 服务返回 HTTP {status}",
  reasonBarkRejected: "Bark 拒绝这次推送（业务码 {code}）",
  reasonBarkBodyUnreadable: "Bark 响应体读取失败（推送可能已经发出）",
  reasonWebhookTemplateInvalid: "Webhook 模板渲染失败（模板不是合法 JSON）",
  reasonWebhookRequestFailed: "Webhook 请求失败（网络或超时）",
  reasonWebhookHttp: "Webhook 目标返回 HTTP {status}",
  reasonUnknownTarget: "未知的投递目标类型（{kind}）",
  reasonChannelThrew: "投递出口内部错误",
  reasonThrottled: "距上一条不足 1 秒，本次未投递（结论见上一条记录）",
  // 分区/tab（设置卡 title/副标题已移除；secEvents/secChannels 现为
  // 卡内双 tab 文案，术语统一为「通知频道」）
  secEvents: "通知事件",
  secChannels: "通知频道",
  secDedup: "参数上限",
  tabLabel: "通知中心",
  save: "保存",
  saving: "保存中…",
  saveChannels: "保存频道",
  channelsDomainHint: "仅保存频道改动，不影响事件/参数等未保存修改",
  // ===== 频道卡 =====
  chTest: "发送测试",
  chLastOk: "最近投递成功",
  chLastFail: "最近投递失败",
  chNeverSent: "尚未投递",
  chSkippedSeeHistory: "（详情见通知记录）",
  chAdvanced: "高级参数",
  chDelete: "删除",
  chDeleteConfirm: "确认删除？再次点击执行",
  chAddBark: "添加 Bark 推送",
  chBarkName: "显示名称",
  chBarkNamePlaceholder: "如：我的 iPhone",
  chBarkBaseUrl: "服务器地址",
  chBarkBaseUrlHint: "Bark 服务器地址（http/https），如 https://api.day.app 或自建地址",
  chBarkDeviceKey: "Device Key",
  chBarkDeviceKeyPlaceholder: "粘贴 Bark App 里的 Device Key",
  chBarkDeviceKeyHint: "Bark App 内查看；留空即不修改已保存的值，输入新值将替换",
  chBarkSound: "铃声 sound",
  chBarkGroup: "分组 group",
  chBarkGroupHint: "同组通知在手机上折叠展示",
  chBarkIcon: "图标 icon",
  chBarkIconHint: "图片 URL，需手机网络可访问；iOS 17+ 支持 SVG；留空用 Bark 默认图标",
  chBarkUrl: "跳转 url",
  chBarkBadge: "角标 badge",
  chBarkLevel: "默认紧急度 level",
  chBarkLevelHint:
    "实例级紧急度（缺省按事件强度自动映射）；下方「按类型紧急度映射」命中时优先于本项",
  chLevelAuto: "按事件强度自动映射",
  // ===== levels（kind→level 稀疏映射矩阵）=====
  chLevelsHint: "按事件类型指定 Bark 紧急度，优先于「默认紧急度」与自动映射；未配置的类型走默认",
  chLevelsKindPlaceholder: "如 question",
  chLevelsAdd: "添加映射",
  chLevelsRemove: "移除",
  chLevelsEmpty: "未配置按类型映射（全部事件走默认紧急度）",
  chLevelsUnknown: "未知事件类型（可能不生效，请确认拼写）",
  // ===== 路由复选组 =====
  // ===== 动态 kind 确认 =====
  kindsTitle: "通知类型",
  kindsHint: "其他插件注册的通知类型需你确认后才会投递",
  kindAllow: "允许",
  kindDeny: "拒绝",
  kindsEmpty: "没有待处理的通知类型",
  // ===== 保存/测试反馈 =====
  testChannelOk: "测试已受理（投递结果见「通知记录」）",
  kindConfirmOk: "已更新通知类型确认状态",
  kindConfirmFail: "确认失败：{msg}",
  chNewBarkName: "Bark 推送",
  // ===== 三 tab / switch / 路由 chips / 脏状态保存栏 =====
  secHistory: "通知记录",
  evtSwitch: "事件开关：{name}",
  chToggleOn: "启用频道：",
  chToggleOff: "停用频道：",
  chTypeBuiltin: "内置",
  kindRevoke: "撤销允许",
  routeCap: "投递到",
  routeDefaultState: "跟随默认 · 全部启用频道",
  routeDefaultStateTitle: "未自定义路由：投递到全部已启用频道（随频道启停动态变化）",
  routeCustomState: "自定义 · {n} 频道 · 恢复默认",
  routeCustomStateTitle: "已自定义路由（冻结快照）；点击恢复跟随默认",
  routeStaleChip: "已删除",
  routeStaleTitle: "该频道已删除，路由条目残留；投递时自动跳过（残留条目不会自动移除）",
  routeDisabledHint: "频道未启用：先在上方「通知频道」启用后才能配置投递",
  dirtySome: "有 {n} 处未保存修改",
  discardChanges: "放弃更改",
  discardOk: "已放弃未保存修改",
  secretShow: "显示",
  secretHide: "隐藏",
  // ===== 动态 kind 路由 =====
  kindRouteHint: "允许后可像内置事件一样配置投递频道",
  // ===== webhook 频道（安卓推送） =====
  chAddWebhook: "添加 Webhook（安卓 / 自建）",
  chNewWebhookName: "Webhook 推送",
  whPreset: "预设",
  whPresetNtfy: "ntfy（ntfy.sh 或自建）",
  whPresetGotify: "Gotify",
  whPresetCustom: "自建推送网关",
  whPresetHint: "预设填充 URL 形态 / 认证方式 / 消息模板",
  whUrl: "目标 URL",
  whUrlPlaceholder: "https://ntfy.sh/<topic>",
  whUrlHint: "POST JSON；仅允许 http(s) 且 URL 不得内嵌凭据；ntfy 主题名建议带随机后缀防遍历",
  whAuth: "认证",
  whAuthNone: "无",
  whAuthBearer: "Bearer Token（Authorization 头）",
  whAuthBasic: "Basic 用户名/密码",
  whAuthHeader: "自定义请求头",
  whAuthHint:
    "凭据只走请求头（ntfy / Gotify 均支持 Authorization 头，不拼 URL）；仅存本机配置并掩码回显；留空即不修改已保存的凭据",
  whAuthToken: "访问令牌",
  whAuthUsername: "用户名",
  whAuthPassword: "密码",
  whAuthHeaderName: "请求头名（如 X-Gotify-Key）",
  whAuthHeaderValue: "头值（令牌）",
  whTimeout: "投递超时",
  whTimeoutHint: "秒 · 1–60（超限按边界取值，默认 10）；超时与失败均落记录，不自动重试",
  whTemplate: "消息模板（JSON body，占位符点击插入）",
  whTemplateHint:
    "{{priority}} 由服务端按频道映射渲染（ntfy：info→default / success→low / warning→high / failure→urgent）；文本占位符 JSON-aware 转义，{{ts}} 数字直出",
  whTemplateFailHint: "模板非法或渲染失败按该频道投递失败落记录，不阻断其他频道",
  whTplRestore: "恢复预设模板",
  // ===== 能力自检（宿主能力面读 /diagnostics，浏览器面在本页本地判定）=====
  diagHostLine: "宿主能力自检：{verdict} · 弹窗 {popup} · 声音 {sound}",
  diagVerdictOk: "可用",
  diagVerdictDegraded: "降级可用",
  diagVerdictUnreachable: "不可用",
  diagVerdictUnknown: "无法判定",
  diagDimPopup: "弹窗",
  diagDimSound: "声音",
  diagUnknownLine: "以下维度无法判定：{dimensions}",
  diagRemediationTitle: "处置建议",
  diagRemediationUnknown: "宿主给出了一条本版本客户端不认识的处置建议，请升级插件后重试",
  diagRemHostNoDbusSession:
    "宿主没有 D-Bus 会话总线：系统弹窗需要桌面会话（图形登录）或由 dbus-launch 提供的会话总线",
  diagRemHostPopupNoDaemon:
    "宿主有 notify-send 但没有通知守护进程：安装并启动一个桌面通知服务（如 dunst、mako）后弹窗才可见",
  diagRemHostNoNotifySend:
    "宿主缺少 notify-send：安装提供它的通知工具（Debian/Ubuntu 上是 libnotify-bin，Fedora/Arch 上是 libnotify）后弹窗才可见",
  diagRemHostNoSoundServerAndPlayer:
    "宿主没有探测到任何可用播放器：安装 {packages}（{packagemanager}）后可自播默认事件音（dnf 系上 ffmpeg 来自 RPM Fusion）",
  diagRemHostNoSoundServerAndPlayerNoPkg:
    "宿主没有探测到任何可用播放器：安装一个不依赖声音服务的播放器（如 alsa-utils 或 ffmpeg）后可自播默认事件音",
  diagRemHostOnlySoundServerPlayers:
    "宿主只探测到依赖声音服务的播放器（paplay / pw-play）：安装 {packages}（{packagemanager}）后可直连 ALSA 自播默认事件音（dnf 系上 ffmpeg 来自 RPM Fusion）",
  diagRemHostOnlySoundServerPlayersNoPkg:
    "宿主只探测到依赖声音服务的播放器（paplay / pw-play）：安装一个不依赖声音服务的播放器（如 alsa-utils 或 ffmpeg）后可直连 ALSA 自播默认事件音",
  diagRemHostNoPlayer: "宿主有声音服务但缺少播放器：安装对应播放器后可自播默认事件音",
  diagRemHostNoToneFile:
    "宿主缺少默认事件音色文件：补齐该平台的音色资源后可自播默认事件音（Linux 上主题缺失会改用合成提示音，不再走这条建议）",
  diagRemHostManagedByOthers:
    "弹窗与发声都已由宿主上的其他组件接管：本插件的系统通道在这台机器上会静默跳过，请改用浏览器通知或移动端推送",
  diagDetailsLabel: "探测明细与来源",
  diagSourceHost: "来源：宿主能力自检（GET /api/dsh-notifier/diagnostics，服务端所在机器）",
  diagSourceBrowser: "来源：本页浏览器本地判定",
  diagCheckedLabel: "已探测",
  diagPlayersLabel: "候选播放器",
  diagToneFileLabel: "音色文件",
  diagToneFileYes: "已就位",
  diagToneFileNo: "缺失",
  diagNone: "无",
  diagCheckedNotifySend: "notify-send 命令",
  diagCheckedDbusNameOwner: "D-Bus 名称所有者",
  diagCheckedDbusActivatable: "D-Bus 可激活服务",
  diagCheckedSessionBus: "会话总线",
  diagCheckedPlayers: "播放器候选",
  diagCheckedToneFile: "音色文件",
  diagBrowserLine: "本页浏览器：弹窗 {popup} · 声音 {sound}",
  diagBrowserNoNotificationApi: "此浏览器没有通知 API，系统级弹窗不可用",
  diagBrowserInsecureContext: "非安全上下文（明文 HTTP），浏览器禁止系统级弹窗",
  diagBrowserPermissionDenied: "通知权限已被拒绝，请在浏览器站点设置中允许",
  diagBrowserPermissionDefault: "通知权限尚未请求，可点「请求通知权限」授权",
  diagBrowserAudioNeverUnlocked: "音频尚未解锁：页面还没有过用户点击，点击页面后即可自播",
  diagBrowserAudioAutoSuspended:
    "音频上下文被浏览器挂起：曾经解锁过，或本次恢复被浏览器拒绝，下次用户交互时会再尝试",
  diagBrowserAudioClosed: "音频上下文已关闭，本页生命周期内无法再自播提示音",
  diagBrowserAudioUnsupported: "此浏览器不支持 Web Audio，插件无法自播提示音",
} as const;

/** 字典 key 并集（LocaleNamespaceMap 声明合并用）。 */
export type NotifierLocaleKey = keyof typeof zh;

/** 英文词典：必须与 zh key 完整对齐。 */
export const en: Record<NotifierLocaleKey, string> = {
  evtAsk: "Approval pending",
  evtQuestion: "Question for you",
  evtTaskDone: "Task completed",
  evtSubagentDone: "Subtask completed",
  evtTaskError: "Task failed",
  evtTurnEnd: "Turn completed",
  chSystemNotify: "System notification",
  chBrowserNotify: "Browser notification",
  chWhenVisible: "Also banner when visible",
  chPopup: "Popup",
  chSound: "Sound",
  chStateOn: "Enabled",
  chStateSound: "Sound only",
  chStateOff: "Disabled",
  chSoundFollow: "Follow system default",
  chSoundFollowHint:
    "System card: Windows uses the toast system sound / macOS Glass / Linux self-plays the default event sound; browser card: lets the OS play (not silent).",
  chSoundTone: "Tone",
  chSoundPreview: "Preview",
  chSoundOnlyNote: "Popup off, sound on: this channel plays sound only (no popup).",
  chPopupSoundOffNote:
    "Popup and sound are both off: this channel shows nothing (use the header switch to disable it — the switch is the only send/don't-send gate).",
  toneDing: "Ding",
  toneBell: "Bell",
  toneChime: "Chime",
  tonePop: "Pop",
  sysPlatformWin:
    "Host platform Windows: system sound uses the toast default; with a tone selected it plays a built-in wav via SoundPlayer (approximate mapping, may differ from system-settings sounds).",
  sysPlatformMac:
    'Host platform macOS: system sound goes through osascript/NSSound (Glass/Tink/Sosumi/Pop approximate mapping), subject to the system "Allow notification sounds" setting.',
  sysPlatformLinux:
    "Host platform Linux: does not rely on desktop daemon sound support — the plugin self-plays, falling back through paplay → pw-play → aplay → ffplay and stopping at the first success; when the themed event sound is missing it uses a tone synthesized at runtime. When only paplay/pw-play are found, a host without a sound server stays silent (both cases still need an audio device on the host).",
  sysPlatformOther:
    "System sound is best-effort on the host platform; the preview here is synthesized locally in your browser as a listening reference.",
  kAsk: "Approval pending",
  kQuestion: "Question for you",
  kDone: "Task completed",
  kSubagentDone: "Subtask completed",
  kError: "Task failed",
  kTurnEnd: "Turn completed",
  kTest: "Test",
  lanAccessHint:
    " (If you are on a LAN connection: the notify service only accepts loopback calls — open via dsh-lan-proxy https://<LAN-IP>:3443 or an ssh -L 3080:127.0.0.1:3080 tunnel, then refresh)",
  settingsLoading: "Notifier: loading…",
  settingsUnavailable: "Settings service unavailable",
  loadFail: "Failed to load settings: {msg}{hint}",
  unchanged: "No changes",
  savedOk: "Saved",
  conflictReloadFail: "Conflict recovery failed: could not fetch the latest config — retry saving",
  saveFail: "Save failed: {msg}",
  saveTimeout: "Save timed out: request did not complete within 15s, please retry",
  // 409 conflict resolution banner
  conflictTitle: "Configuration was changed in another window:",
  conflictChannels: "Channel configuration was changed in another window:",
  conflictLoadLatest: "Load latest (discard my changes)",
  conflictOverwrite: "Keep my changes and overwrite",
  conflictIgnore: "Ignore",
  conflictLoadedLatest: "Loaded latest configuration",
  testSent: "Test notification sent ({n} unreleased server handles)",
  testFail: "Failed to send test notification: {msg}{hint}",
  cleared: "Cleared {n} history entries",
  clearFail: "Clear failed: {msg}{hint}",
  historyRetention: "History retention (days, 0=no daily cleanup)",
  dndEnable: "Enable do-not-disturb",
  dndStart: "Start time",
  dndEnd: "End time",
  dndStillLabel: "Still notify during DND",
  allowDisabledHint: "Not enabled",
  allowFollowEnabled: "Follow enabled events",
  allowResetDefault: "Reset default (approval/question/error)",
  settingsSvcDown:
    "Settings service unavailable: cannot save configuration (settings service not mounted). Plugin notifications are unaffected, but changes will be rejected.",
  httpDegraded:
    "You are on a LAN HTTP connection (insecure context) — the browser blocks system notifications; in-page banner + sound + title reminders are active instead. For system notifications, use dsh-lan-proxy https://<LAN-IP>:3443 or a localhost tunnel (e.g. ssh -L 3080:127.0.0.1:3080), then refresh.",
  permGranted: "Browser notification permission: granted ✓",
  permDenied:
    "Browser notification permission: denied (allow notifications for this site in the browser site settings)",
  permDefault:
    "Browser notification permission: not asked (click the button below and allow in the browser prompt)",
  iosUnsupported:
    'This device does not support system notifications (e.g. iOS Safari in a normal tab). Available channels: in-page banner + sound while the page is open, or PWA-grade notifications via dsh-lan-proxy https://<LAN-IP>:3443 with "Add to Home Screen".',
  clearConfirm: "Clear history?",
  clearLabel: "Clear history",
  requestPerm: "Request permission",
  permRequested: "Permission request completed",
  sendTest: "Send test notification",
  refresh: "Refresh",
  historyTitle: "History (last 10)",
  historyEmpty: 'No history yet (click "Send test notification" to create one)',
  historySuppressed: "Suppressed by do-not-disturb",
  chStatusOk: "Delivered",
  chStatusFailed: "Failed",
  chStatusSkipped: "Not sent",
  reasonDetailLabel: "Raw host output",
  reasonLegacy: "Recorded before upgrade",
  reasonUnknown: "Reason unknown (unrecognized record)",
  reasonSkipConfig: "Popup and sound are both off — nothing to deliver this time",
  reasonSkipEnvironment:
    "No usable notification channel on this host (no system notifier or audio player); nothing was sent",
  reasonSystemPopupFailed: "System notification command failed ({bin})",
  reasonSystemSoundFailed: "Sound playback command failed ({bin})",
  reasonSystemToastScriptMissing:
    "The plugin's bundled Windows notification script is missing (packaging defect); nothing was sent",
  reasonSystemToneUnwritable:
    "Could not write the synthesized tone to the temp directory; nothing was played",
  reasonBarkRequestFailed: "Bark request failed (network or timeout)",
  reasonBarkHttp: "Bark server returned HTTP {status}",
  reasonBarkRejected: "Bark rejected this push (business code {code})",
  reasonBarkBodyUnreadable:
    "Could not read the Bark response body (the push may have gone through)",
  reasonWebhookTemplateInvalid: "Webhook template rendering failed (template is not valid JSON)",
  reasonWebhookRequestFailed: "Webhook request failed (network or timeout)",
  reasonWebhookHttp: "Webhook target returned HTTP {status}",
  reasonUnknownTarget: "Unknown delivery target type ({kind})",
  reasonChannelThrew: "Delivery channel raised an internal error",
  reasonThrottled: "Less than 1s since the previous one; not delivered (see the previous record)",
  secEvents: "Events",
  secChannels: "Channels",
  secDedup: "Limits",
  tabLabel: "Notification center",
  save: "Save",
  saving: "Saving…",
  saveChannels: "Save channels",
  channelsDomainHint: "Saves channel changes only; other unsaved edits stay untouched",
  chTest: "Send test",
  chLastOk: "Last delivery OK",
  chLastFail: "Last delivery failed",
  chNeverSent: "Not delivered yet",
  chSkippedSeeHistory: "(see History for details)",
  chAdvanced: "Advanced",
  chDelete: "Delete",
  chDeleteConfirm: "Confirm delete? Click again",
  chAddBark: "Add Bark push",
  chBarkName: "Display name",
  chBarkNamePlaceholder: "e.g. My iPhone",
  chBarkBaseUrl: "Server URL",
  chBarkBaseUrlHint: "Bark server URL (http/https), e.g. https://api.day.app or self-hosted",
  chBarkDeviceKey: "Device Key",
  chBarkDeviceKeyPlaceholder: "Paste the Device Key from the Bark app",
  chBarkDeviceKeyHint:
    "Find it in the Bark app; leave empty to keep the saved value, type a new one to replace it",
  chBarkSound: "Sound",
  chBarkGroup: "Group",
  chBarkGroupHint: "Notifications of the same group collapse on the phone",
  chBarkIcon: "Icon",
  chBarkIconHint: "Image URL reachable from the phone; SVG needs iOS 17+; empty uses Bark default",
  chBarkUrl: "URL to open",
  chBarkBadge: "Badge",
  chBarkLevel: "Default level",
  chBarkLevelHint:
    'Instance-level urgency (auto-mapped from event severity when unset); a matching row in "Per-type level map" below wins over this',
  chLevelAuto: "Auto-map from event severity",
  chLevelsHint:
    "Set a Bark urgency per event type; takes precedence over the default level and auto-mapping. Types without a row use the default",
  chLevelsKindPlaceholder: "e.g. question",
  chLevelsAdd: "Add mapping",
  chLevelsRemove: "Remove",
  chLevelsEmpty: "No per-type mapping (all events use the default level)",
  chLevelsUnknown: "Unknown event type (may not take effect — check the spelling)",
  kindsTitle: "Notification types",
  kindsHint: "Types registered by other plugins are delivered only after your confirmation",
  kindAllow: "Allow",
  kindDeny: "Deny",
  kindsEmpty: "No notification types to review",
  testChannelOk: 'Test accepted (the delivery result appears under "History")',
  kindConfirmOk: "Notification type confirmation updated",
  kindConfirmFail: "Confirmation failed: {msg}",
  chNewBarkName: "Bark push",
  // ===== tabs / switch / routing chips / dirty-save bar =====
  secHistory: "History",
  evtSwitch: "Event toggle: {name}",
  chToggleOn: "Enable channel: ",
  chToggleOff: "Disable channel: ",
  chTypeBuiltin: "Built-in",
  kindRevoke: "Revoke",
  routeCap: "Deliver to",
  routeDefaultState: "Follow default · all enabled channels",
  routeDefaultStateTitle:
    "Not customized: delivered to all enabled channels (dynamic as channels toggle)",
  routeCustomState: "Custom · {n} channels · reset",
  routeCustomStateTitle: "Route customized (frozen snapshot); click to reset to default",
  routeStaleChip: "deleted",
  routeStaleTitle:
    "This channel was deleted but its route entry remains; skipped at delivery (the stale entry is not removed automatically)",
  routeDisabledHint:
    "Channel not enabled: enable it under Notify channels first to configure delivery",
  dirtySome: "{n} unsaved change(s)",
  discardChanges: "Discard changes",
  discardOk: "Unsaved changes discarded",
  secretShow: "Show",
  secretHide: "Hide",
  // ===== dynamic kind routes =====
  kindRouteHint: "Once allowed, delivery channels can be configured like built-in events",
  // ===== webhook channel (Android push) =====
  chAddWebhook: "Add Webhook (Android / custom)",
  chNewWebhookName: "Webhook push",
  whPreset: "Preset",
  whPresetNtfy: "ntfy (ntfy.sh or self-hosted)",
  whPresetGotify: "Gotify",
  whPresetCustom: "Custom push gateway",
  whPresetHint: "Preset fills URL shape / auth method / message template",
  whUrl: "Target URL",
  whUrlPlaceholder: "https://ntfy.sh/<topic>",
  whUrlHint:
    "POST JSON; http(s) only, no embedded credentials in the URL; add a random suffix to ntfy topic names",
  whAuth: "Auth",
  whAuthNone: "None",
  whAuthBearer: "Bearer Token (Authorization header)",
  whAuthBasic: "Basic username/password",
  whAuthHeader: "Custom header",
  whAuthHint:
    "Credentials go in request headers only (ntfy / Gotify both support the Authorization header), never in the URL; stored locally and shown masked; leave empty to keep the saved value",
  whAuthToken: "Access token",
  whAuthUsername: "Username",
  whAuthPassword: "Password",
  whAuthHeaderName: "Header name (e.g. X-Gotify-Key)",
  whAuthHeaderValue: "Header value (token)",
  whTimeout: "Delivery timeout",
  whTimeoutHint:
    "seconds · 1–60 (clamped, default 10); timeouts and failures are recorded, no auto-retry",
  whTemplate: "Message template (JSON body, click to insert placeholders)",
  whTemplateHint:
    "{{priority}} is rendered by the server per-channel map (ntfy: info→default / success→low / warning→high / failure→urgent); text placeholders are JSON-aware escaped, {{ts}} is raw number",
  whTemplateFailHint:
    "Invalid template or render failure counts as a failed delivery for this channel only; other channels are unaffected",
  whTplRestore: "Reset preset template",
  diagHostLine: "Host capability self-check: {verdict} · popup {popup} · sound {sound}",
  diagVerdictOk: "available",
  diagVerdictDegraded: "degraded",
  diagVerdictUnreachable: "unavailable",
  diagVerdictUnknown: "undetermined",
  diagDimPopup: "Popup",
  diagDimSound: "Sound",
  diagUnknownLine: "These capabilities could not be determined: {dimensions}",
  diagRemediationTitle: "Suggested fixes",
  diagRemediationUnknown:
    "The host reported a fix this client version does not recognize; update the plugin and retry",
  diagRemHostNoDbusSession:
    "The host has no D-Bus session bus: system popups need a desktop session (graphical login) or a session bus from dbus-launch",
  diagRemHostPopupNoDaemon:
    "The host has notify-send but no notification daemon: install and start a desktop notification service (e.g. dunst, mako) for popups to appear",
  diagRemHostNoNotifySend:
    "The host is missing notify-send: install a notification tool that provides it (libnotify-bin on Debian/Ubuntu, libnotify on Fedora/Arch) and popups become visible",
  diagRemHostNoSoundServerAndPlayer:
    "The host exposed no usable player: install {packages} ({packagemanager}) to self-play the default event sound (on dnf-family hosts ffmpeg comes from RPM Fusion)",
  diagRemHostNoSoundServerAndPlayerNoPkg:
    "The host exposed no usable player: install a player that does not need a sound server (e.g. alsa-utils or ffmpeg) to self-play the default event sound",
  diagRemHostOnlySoundServerPlayers:
    "The host only exposed sound-server players (paplay / pw-play): install {packages} ({packagemanager}) to self-play the default event sound straight through ALSA (on dnf-family hosts ffmpeg comes from RPM Fusion)",
  diagRemHostOnlySoundServerPlayersNoPkg:
    "The host only exposed sound-server players (paplay / pw-play): install a player that does not need a sound server (e.g. alsa-utils or ffmpeg) to self-play the default event sound straight through ALSA",
  diagRemHostNoPlayer:
    "The host has a sound server but no player: install a matching player to play the default event sound",
  diagRemHostNoToneFile:
    "The host is missing the default event sound file: provide this platform's sound resources to self-play it (on Linux a missing theme now falls back to a synthesized tone, so this advice no longer applies there)",
  diagRemHostManagedByOthers:
    "Popup and sound are already handled by other components on the host: this plugin's system channel silently skips on this machine, so use browser notifications or mobile push instead",
  diagDetailsLabel: "Probe details and source",
  diagSourceHost:
    "Source: host capability self-check (GET /api/dsh-notifier/diagnostics, the machine running the server)",
  diagSourceBrowser: "Source: judged locally in this browser page",
  diagCheckedLabel: "checked",
  diagPlayersLabel: "Player candidates",
  diagToneFileLabel: "Tone file",
  diagToneFileYes: "present",
  diagToneFileNo: "missing",
  diagNone: "none",
  diagCheckedNotifySend: "notify-send command",
  diagCheckedDbusNameOwner: "D-Bus name owner",
  diagCheckedDbusActivatable: "D-Bus activatable service",
  diagCheckedSessionBus: "Session bus",
  diagCheckedPlayers: "Player candidates",
  diagCheckedToneFile: "Tone file",
  diagBrowserLine: "This browser page: popup {popup} · sound {sound}",
  diagBrowserNoNotificationApi:
    "this browser has no notification API, so system popups are unavailable",
  diagBrowserInsecureContext: "insecure context (plain HTTP), the browser blocks system popups",
  diagBrowserPermissionDenied:
    "notification permission was denied; allow it in the browser site settings",
  diagBrowserPermissionDefault:
    'notification permission has not been requested; click "Request permission" to grant it',
  diagBrowserAudioNeverUnlocked:
    "audio is not unlocked yet: the page has not seen a user click; a click enables self-playback",
  diagBrowserAudioAutoSuspended:
    "the audio context is suspended by the browser: it was unlocked before, or this resume was refused; the next user interaction retries",
  diagBrowserAudioClosed:
    "the audio context is closed; this page cannot self-play sounds for the rest of its lifetime",
  diagBrowserAudioUnsupported:
    "this browser does not support Web Audio, so the plugin cannot self-play sounds",
};

/** kind → 字典 key（未知 kind 回落 kind 本体显示，数据不翻译）。刻意留在客户端：
 *  这是「kind → i18n 文案 key」，文案属客户端面，宿主端没有翻译。含 test——自检通知没有
 *  事件开关，但历史行要显示它。
 *
 *  `satisfies Record<BuiltinKind, …>` 是覆盖信号：shared 的 BUILTIN_KINDS 新增一项而这里漏配
 *  文案就是编译失败，而不是让历史行渲染出一个取不到文案的 key。
 *
 *  导出面仍声明为 `Record<string, string>`：kind 在运行期还可能是外部注册的种类
 *  （`<命名空间>:<id>`），三个消费方都要按任意 string 查表、查不到就回落 kind 本体
 *  （bark-card.tsx:56/67 的 levels 建议与行标签、panes/events.tsx:204 的豁免 chips、
 *  panes/history.tsx:78 的历史行）；把导出收窄成 BuiltinKind 索引会让这些读取全部编译失败。 */
const KIND_KEY_TABLE = {
  ask: "kAsk",
  question: "kQuestion",
  done: "kDone",
  "subagent-done": "kSubagentDone",
  error: "kError",
  "turn-end": "kTurnEnd",
  test: "kTest",
} satisfies Record<BuiltinKind, NotifierLocaleKey>;

export const KIND_KEYS: Record<string, string> = KIND_KEY_TABLE;
