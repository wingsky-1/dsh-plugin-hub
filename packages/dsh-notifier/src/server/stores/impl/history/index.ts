/**
 * dsh-notifier stores 域 —— 通知历史实现（jsonl）。
 *
 * 本文件是历史这一块的唯一落点：写队列串行化、tmp+rename 原子写、滚动上限与按天
 * 过滤都在这里。前两者是对外承诺，后两者是读语义——都不上升为调用方的义务。
 *
 * 状态是实例字段，不是模块级变量：类本身可以被实例化多次，但域只装配一个——
 * 「唯一持久化实现」靠契约层不导出实例来保证，而不是靠把状态藏进闭包让别人够不着。
 *
 * 保留天数不经装配入参传进来，而是每次读时经 `../../deps.ts` 取当前设置：它是一条
 * 会变的设置，装配期取一次的快照会在用户改设置后失效。
 *
 * 依赖方向：只引用本目录与包内共享层；设置读面经装配入参拿，不直连 config 域。
 */
import { HISTORY_FILE_NAME, notifierFile } from "../../../shared/paths.ts";
import type { HistoryDeps, HistoryEntry } from "./type.ts";

/**
 * 未装配时的占位。
 *
 * 装配是必经路径（`installed` 守卫），占位值不会被真正读到；它的作用是让字段有确定
 * 的类型，从而不必让每个使用点都先判一次空。能力占位成抛错而不是空实现：真被读到时，
 * 「没装配」这个事实应当当场暴露，而不是静默按默认设置去清理用户的历史。
 */
const UNINSTALLED: HistoryDeps = {
  logger: { warn: () => {} },
  config: {
    readConfig: () => {
      throw new Error("dsh-notifier: 历史存储尚未装配");
    },
  },
};

/** 通知历史：jsonl 追加写，读时滚动截断与按天过滤。 */
class HistoryStore {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /**
   * 落盘路径：DSH home 由环境决定、进程内不变，故随实例一次性定下。
   *
   * 装配口不再接收路径——路径是存储自己的知识，做成入参等于要求每个装配点都知道
   * 本域的文件叫什么、放哪里。
   */
  private readonly file = notifierFile(HISTORY_FILE_NAME);
  /** 装配入参（失败出口）。 */
  private deps: HistoryDeps = UNINSTALLED;
  /** 写队列串行化：并发「读-改-写」会互相覆盖丢记录。 */
  private queue: Promise<void> = Promise.resolve();

  /** 装配：单次生效。 */
  install(deps: HistoryDeps): void {
    if (this.installed) throw new Error("dsh-notifier: 历史存储只能装配一次");
    this.installed = true;
    this.deps = deps;
  }

  /** 卸载：放开装配入参。在飞的写入不等待——它们各有自己的失败出口。 */
  release(): void {
    this.installed = false;
    this.deps = UNINSTALLED;
  }

  /** 追加一条记录：入队即返回（不阻塞通知主流程），失败仅经日志出口告警。 */
  append(entry: HistoryEntry): void {
    void entry;
    throw new Error("not implemented: HistoryStore.append");
  }

  /** 最近记录（尾部最多 `HISTORY_LIMIT` 条；保留期 > 0 时先按天过滤）。 */
  async read(): Promise<HistoryEntry[]> {
    throw new Error("not implemented: HistoryStore.read");
  }

  /** 清空全部记录，返回被清空条数。 */
  async clear(): Promise<number> {
    throw new Error("not implemented: HistoryStore.clear");
  }
}

/** 本域唯一的存储实例：类不外放，外面 `new` 不出第二份写队列。 */
export const historyStore = new HistoryStore();
