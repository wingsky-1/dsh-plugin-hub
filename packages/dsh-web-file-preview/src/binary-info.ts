/**
 * dsh-web-file-preview — 二进制占位卡纯函数（issue #630；双端可用、无 DOM 依赖）。
 *
 * 供 client/binary-card.ts 组件与 smoke/unit 直测；刻意与组件分离——组件依赖
 * dom.ts（style.css 打包链），宿主 index.ts 不得引 DOM 模块进宿主 bundle。
 */

/** 人类可读大小（B/KB/MB 自适应；非法输入回退空串由调用方省略显示）。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 组装下载 URL：在 /file 地址上追加 dl=1（宿主仅对嗅探判二进制的分支响应
 * attachment，其余分支忽略该参数）。URL 已含 query 直接 & 追加，否则补 ?。
 */
export function downloadUrlOf(fileUrl: string): string {
  return fileUrl.includes("?") ? `${fileUrl}&dl=1` : `${fileUrl}?dl=1`;
}
