/**
 * 出站转发目标仅允许回环（防开放转发/SSRF）。targetHost 本应只指向回环 web 服务器。
 *
 * 两个正当消费者：配置校验器（拒绝非回环 targetHost）与引擎入口（最后一道防线）。
 * 各写一份会让这条安全红线出现两个答案，故由共享叶子承载同一份实现。
 */
export function isLoopbackTarget(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return (
    host === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "::ffff:127.0.0.1"
  );
}
