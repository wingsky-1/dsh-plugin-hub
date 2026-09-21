/** dsh-jev-decide — 纯显示格式函数（零依赖，可单测直连）。 */
export function fmtTime(ts: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  try {
    const d = new Date(ts);
    const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes()) +
      ":" +
      pad(d.getSeconds())
    );
  } catch {
    return "";
  }
}

/** 短 id（超长截断；完整值放 title）。 */
export function shortId(id: string, len = 8): string {
  if (id.length <= len) return id;
  return id.slice(0, len);
}
