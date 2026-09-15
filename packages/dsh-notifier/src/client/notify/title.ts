/**
 * dsh-notifier 客户端 —— 标题闪烁（页面隐藏时的降级提醒）。
 *
 * document.title 是页面级共享事实（一个页面只有一份标题），所以恢复缓存用 const 容器承载，
 * 而不是每个实例各存一份。
 *
 * 恢复有两条路径：回前台、卸载。少任何一条都会让标题永久卡在「🔔 …」——「隐藏时收到通知、
 * 随后插件被卸载」正是那条容易漏掉的路径，所以 restore 必须幂等且可重复调用。
 *
 * 归属判定是必须的：热更或重复 apply 时旧实例的 disposer 仍会执行，若它无条件 restore，
 * 就会摘掉新实例刚点亮的闪烁——「隐藏页收到通知」的提示就此消失，而这条降级通道是通知被
 * 静音/无权限时唯一的可见提醒。故闪烁记下归属者，只有归属者自己的 restore 才还原。
 */
export interface TitlePorts {
  get(): string;
  set(value: string): void;
}

export interface TitleFlasher {
  flash(title: string, owner: object): void;
  restore(owner: object): void;
}

export function createTitleFlasher(ports: TitlePorts): TitleFlasher {
  let saved: string | null = null;
  let owner: object | null = null;
  return {
    flash(title: string, caller: object): void {
      // 恢复缓存只记第一次的原文（连续闪烁时被覆盖的应该是同一份原始标题）；归属者则跟随最近
      // 一次闪烁——后装/最近的实例才是当前闪烁的主人，否则旧实例的 disposer 一 restore 就把它摘了。
      if (saved === null) saved = ports.get();
      owner = caller;
      ports.set("🔔 " + String(title).slice(0, 40));
    },
    restore(caller: object): void {
      if (saved === null || owner !== caller) return;
      ports.set(saved);
      saved = null;
      owner = null;
    },
  };
}

/** 本页的标题闪烁器（跨实例共享同一份恢复缓存与归属者）。 */
export const titleFlasher = createTitleFlasher({
  get: () => document.title,
  set: (value) => {
    document.title = value;
  },
});
