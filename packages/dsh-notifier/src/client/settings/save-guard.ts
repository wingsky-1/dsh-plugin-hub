/**
 * dsh-notifier 客户端 —— 保存串行 guard（同一时刻仅一个在途保存请求）。
 *
 * exhaustMap + trailing 语义：在途期间再点保存不丢弃意图——记 pending（含入口标识），由调用方
 * 在本轮在途结束（end）后按同一入口补发一次（补发是完整保存，是否仍有脏由调用方的 diff 空
 * 检查兜底，天然不循环）。
 *
 * 为什么 pending 记入口而不是布尔：有两个保存入口——foot 全量（"all"）与频道 tab 域保存
 * （"channels"），语义不同。在途期间被拒的入口必须原样补发：若「保存频道」被拒却补发全量，
 * 会把事件 tab 的半成品草稿一并提交。同一次在途多次点击不同入口时记最后一次意图
 * （end 只返回一个入口，天然不风暴）。
 */

export interface SaveGuard {
  /** 空闲则占用并返回 true；在途则记 pending=entry 并返回 false。 */
  tryBegin(entry: string): boolean;
  isBusy(): boolean;
  /** 释放占用；返回「在途期间最后一次被拒的入口」（调用方据此同入口补发一次），无则 null。 */
  end(): string | null;
}

/**
 * 必须与 tryBegin 成功一一配对（放 finally），任何路径都释放，防按钮永久卡死。
 */
export function createSaveGuard(): SaveGuard {
  let busy = false;
  let pending: string | null = null;
  return {
    tryBegin(entry: string): boolean {
      if (busy) {
        pending = entry;
        return false;
      }
      busy = true;
      return true;
    },
    isBusy(): boolean {
      return busy;
    },
    end(): string | null {
      busy = false;
      const last = pending;
      pending = null;
      return last;
    },
  };
}
