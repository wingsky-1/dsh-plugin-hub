/**
 * dsh-notifier stores 域 —— 通知历史实现（jsonl）。
 *
 * 本文件是历史这一块的唯一落点：写队列串行化、tmp+rename 原子写、滚动上限与按天
 * 过滤都在这里。前两者是对外承诺，后两者是读语义——都不上升为调用方的义务。
 *
 * 状态是实例字段，不是模块级变量：类本身可以被实例化多次，但域只装配一个——
 * 「唯一持久化实现」靠契约层不导出实例来保证，而不是靠把状态藏进闭包让别人够不着。
 *
 * 装配状态用判别联合而不是哨兵对象：入参里有一个配置域的面，抄一份哨兵等于把那份面
 * 维护两遍，而且它每增减一个成员都要跟着改。
 *
 * 依赖方向：只引用本目录、`../../../deps.ts`、包内共享层，不引用 `interface.ts`。
 */
import { HISTORY_FILE_NAME, notifierFile } from "../../../shared/paths.ts";
import type { HistoryDeps, HistoryEntry } from "./type.ts";

/** 通知历史滚动上限（行数；超出后从尾部截断重写）。 */
const HISTORY_LIMIT = 200;

/** 装配状态：未装配时连入参一起不存在，因此不需要哨兵去扮演一份假依赖。 */
type HistoryState = { installed: false } | { installed: true; deps: HistoryDeps };

/** 通知历史：jsonl 追加写，读时滚动截断与按天过滤。 */
class HistoryStore {
  /**
   * 落盘路径：DSH home 由环境决定、进程内不变，故随实例一次性定下。
   *
   * 装配口不再接收路径——路径是存储自己的知识，做成入参等于要求每个装配点都知道
   * 本域的文件叫什么、放哪里。
   */
  private readonly file = notifierFile(HISTORY_FILE_NAME);
  /** 装配状态；单例实例重复装配是编程错误，当场暴露。 */
  private state: HistoryState = { installed: false };
  /** 写队列串行化：并发「读-改-写」会互相覆盖丢记录。 */
  private queue: Promise<void> = Promise.resolve();

  /** 装配：单次生效。 */
  install(deps: HistoryDeps): void {
    if (this.state.installed) throw new Error("dsh-notifier: 历史存储只能装配一次");
    this.state = { installed: true, deps };
  }

  /** 追加一条记录：入队即返回（不阻塞通知主流程），失败仅经日志出口告警。 */
  append(entry: HistoryEntry): void {
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
