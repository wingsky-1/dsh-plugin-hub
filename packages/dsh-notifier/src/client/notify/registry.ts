/**
 * dsh-notifier 客户端 —— 已弹出的系统通知登记。
 *
 * 保留最近 NOTIFICATION_KEEP 条、超出即关最旧的；卸载时全关。通知是瞬时提醒，插件卸载后没有
 * 可归属的宿主，所以「全关」是本包的既有语义（不是按实例分账）。
 *
 * 用模块级 const 容器承载：同一页面只有一组弹出通知，按实例各存一份会让「最多 5 条」变成
 * 「每实例 5 条」。
 */

/** 同时保留的弹出通知条数。 */
export const NOTIFICATION_KEEP = 5;

const shown: { close(): void }[] = [];

/** 登记一条已弹出的通知，超出上限即关掉最旧的那条。 */
export function trackNotification(notification: { close(): void }): void {
  shown.push(notification);
  if (shown.length > NOTIFICATION_KEEP) shown.shift()?.close();
}

/** 关闭并清空登记（卸载路径）。关闭失败的单个通知不影响其余。 */
export function closeAllNotifications(): void {
  for (const notification of shown) {
    try {
      notification.close();
    } catch {
      // 关闭失败不影响卸载
    }
  }
  shown.length = 0;
}
