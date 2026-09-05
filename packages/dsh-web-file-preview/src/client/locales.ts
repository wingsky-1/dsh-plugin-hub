/**
 * dsh-web-file-preview — 客户端文案字典（issue #348：复用官方 dsh-client-locale）。
 *
 * 双语平衡：`zh` 为 key 源；`en` 必须覆盖全部 key（编译期锁平衡）。
 * 不进字典：console 日志、错误明细（宿主/浏览器动态消息）、URL/路径样例
 * （官方原则：数据不翻译）。
 */

/** 简体中文字典（key 源）。 */
export const zh = {
  // 复制反馈（dom.ts copyPathText）
  copyPath: "复制路径",
  copied: "已复制",
  copyFail: "复制失败",
  openRawTab: "在新标签打开原文",
  // 全屏/放大（fullscreen-math.ts fullscreenLabel + viewer.ts 灯箱）
  fsExit: "退出全屏",
  fsEnter: "全屏",
  zoomFallbackActive: "退出放大",
  zoomFallbackIdle: "放大预览",
  zoomIn: "放大",
  zoomOut: "缩小",
  reset: "重置",
  resetZoom: "重置缩放",
  closeLightbox: "关闭灯箱",
  // 通用状态/错误视图
  loading: "加载中…",
  fetchFail: "请求失败（无法访问文件预览服务）",
  // HTML 预览
  htmlBootFail: "HTML 预览启动失败（响应异常）",
  htmlSandboxTitle: "HTML 预览（沙箱内渲染，不执行脚本）",
  // issue #507：交互式预览（opt-in 脚本执行）
  tabInteractive: "交互",
  htmlInteractiveTitle: "交互式预览（已启用脚本执行；不访问宿主页面）",
  htmlInteractiveBadge: "脚本已启用",
  interactiveConfirm: "「交互」预览会执行文件内脚本（受沙箱限制：读不到宿主页面、不能弹出窗口），确认启用？",
  // 图片
  imageAria: "图片预览",
  imageZoomHint: "点击放大",
  imageDecodeFail: "图片解码失败（文件已获取，但无法作为图片显示）",
  imgFailHint: "图片加载失败（可在新标签打开原文查看）",
  // mermaid
  chartAria: "图表预览",
  mermaidFailNote: "图表渲染失败，已回退为代码展示",
  // 拦截
  dirNoPreview: "文件夹无法在 web 端预览，请使用文件树打开",
  // 预览 Modal
  navBack: "← 返回",
  navBackAria: "返回上一个预览",
  close: "关闭",
  tabPreview: "预览",
  tabRaw: "原始",
  tabContent: "内容",
  diffUnavailable: "Diff 不可用",
  diffProbeFail: "git diff 探测失败（网络或仓库异常），可能无法显示变更",
  // 文本/diff
  untrackedNoDiff: "未跟踪的新文件（git 无基线，无法对比；完整内容见“内容/原始”）",
  noDiff: "无可用 diff",
} as const;

/** 字典 key 并集（LocaleNamespaceMap 声明合并用）。 */
export type FilePreviewLocaleKey = keyof typeof zh;

/** 英文词典：必须与 zh key 完整对齐。 */
export const en: Record<FilePreviewLocaleKey, string> = {
  copyPath: "Copy path",
  copied: "Copied",
  copyFail: "Copy failed",
  openRawTab: "Open raw in new tab",
  fsExit: "Exit fullscreen",
  fsEnter: "Fullscreen",
  zoomFallbackActive: "Exit zoom",
  zoomFallbackIdle: "Zoom preview",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  reset: "Reset",
  resetZoom: "Reset zoom",
  closeLightbox: "Close lightbox",
  loading: "Loading…",
  fetchFail: "Request failed (file preview service unreachable)",
  htmlBootFail: "HTML preview failed to start (unexpected response)",
  htmlSandboxTitle: "HTML preview (rendered in sandbox, scripts not executed)",
  tabInteractive: "Interactive",
  htmlInteractiveTitle: "Interactive preview (scripts enabled; host page not accessible)",
  htmlInteractiveBadge: "Scripts enabled",
  interactiveConfirm: "Interactive preview runs scripts inside this file (sandboxed: cannot read the host page, no popups). Enable?",
  imageAria: "Image preview",
  imageZoomHint: "Click to zoom",
  imageDecodeFail: "Image decode failed (file fetched but cannot be displayed as an image)",
  imgFailHint: "Image failed to load (open original in a new tab)",
  chartAria: "Diagram preview",
  mermaidFailNote: "Diagram rendering failed — falling back to code view",
  dirNoPreview: "Folders cannot be previewed on the web — open them from the file tree",
  navBack: "← Back",
  navBackAria: "Back to previous preview",
  close: "Close",
  tabPreview: "Preview",
  tabRaw: "Raw",
  tabContent: "Content",
  diffUnavailable: "Diff unavailable",
  diffProbeFail: "git diff probe failed (network or repository error) — changes may not be shown",
  untrackedNoDiff: "Untracked new file (no git baseline to diff; see Content/Raw for the full text)",
  noDiff: "No diff available",
};
