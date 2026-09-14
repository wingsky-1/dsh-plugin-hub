/**
 * dsh-notifier 客户端 —— 标题闪烁（页面隐藏时的降级提醒）。
 *
 * document.title 是页面级共享事实（一个页面只有一份标题），所以恢复缓存用 const 容器承载，
 * 而不是每个实例各存一份。
 *
 * 恢复有两条路径：回前台、卸载。少任何一条都会让标题永久卡在「🔔 …」——「隐藏时收到通知、
 * 随后插件被卸载」正是那条容易漏掉的路径，所以 restore 必须幂等且可重复调用。
 */
export interface TitlePorts {
  get(): string;
  set(value: string): void;
}

export interface TitleFlasher {
  flash(title: string): void;
  restore(): void;
}

export function createTitleFlasher(ports: TitlePorts): TitleFlasher {
  let saved: string | null = null;
  return {
    flash(title: string): void {
      // 只记第一次：连续闪烁时被覆盖的应该是同一份原始标题
      if (saved === null) saved = ports.get();
      ports.set("🔔 " + String(title).slice(0, 40));
    },
    restore(): void {
      if (saved === null) return;
      ports.set(saved);
      saved = null;
    },
  };
}

/** 本页的标题闪烁器（跨实例共享同一份恢复缓存）。 */
export const titleFlasher = createTitleFlasher({
  get: () => document.title,
  set: (value) => {
    document.title = value;
  },
});
