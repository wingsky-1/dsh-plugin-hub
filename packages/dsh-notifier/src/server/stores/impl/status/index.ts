/**
 * dsh-notifier stores 域 —— 频道投递状态落盘实现。
 *
 * 与历史互补：事件流负责实时性，本文件负责「重启后仍成立」的持久事实。写入范式与
 * 历史同源（写队列串行化 + tmp+rename 原子写），另加 debounce 合并——通知风暴时
 * 避免每条通知一次整文件重写。内存镜像是本类的单一事实源，故冷启动要先把文件读
 * 进内存再对外服务。
 *
 * 依赖方向：只引用本目录与包内共享层，不引用 `interface.ts`。
 */
import { STATUS_FILE_NAME, notifierFile } from "../../../shared/paths.ts";
import type { ChannelStatusEntry, StatusDeps } from "./type.ts";

/** 状态条目上限（防已删频道残留键无限累积；超出时最旧先出）。 */
const STATUS_MAX_ENTRIES = 64;

/** 落盘 debounce 窗口（毫秒）：窗口内的多次 record 合并为一次整文件写。 */
const STATUS_DEBOUNCE_MS = 500;

/**
 * 未装配时的占位。
 *
 * 装配是必经路径（`installed` 守卫），占位值不会被真正读到；它的作用是让字段
 * 有确定的类型，从而不必让每个使用点都先判一次空。
 */
const UNINSTALLED: StatusDeps = { logger: { warn: () => {} } };

/** 待落盘状态：有改动尚未落盘时才持有定时器。 */
type PendingFlush = { pending: false } | { pending: true; timer: ReturnType<typeof setTimeout> };

/** 频道投递终态：内存镜像即时更新，落盘延后合并。 */
class StatusStore {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 落盘路径：DSH home 由环境决定、进程内不变，故随实例一次性定下。 */
  private readonly file = notifierFile(STATUS_FILE_NAME);
  /** 装配入参（失败出口）。 */
  private deps: StatusDeps = UNINSTALLED;
  /** 内存镜像：本类的单一事实源，冷启动从文件加载；空表即「尚未加载」。 */
  private mirror: Record<string, ChannelStatusEntry> = {};
  /** 落盘 debounce：窗口内多次 record 合并为一次整文件写。 */
  private flush: PendingFlush = { pending: false };

  /** 装配：单次生效。 */
  install(deps: StatusDeps): void {
    if (this.installed) throw new Error("dsh-notifier: 投递状态只能装配一次");
    this.installed = true;
    this.deps = deps;
  }

  /** 记录一次投递终态：内存立即更新，落盘延后合并（失败仅经日志出口告警）。 */
  record(channelId: string, status: "ok" | "failed", error?: string): void {
    throw new Error("not implemented: StatusStore.record");
  }

  /** 读取全部频道状态（内存镜像优先，冷启动回落文件）。 */
  async read(): Promise<Record<string, ChannelStatusEntry>> {
    throw new Error("not implemented: StatusStore.read");
  }
}

/** 本域唯一的存储实例：类不外放，外面 `new` 不出第二份内存镜像。 */
export const statusStore = new StatusStore();
