/**
 * dsh-notifier pipeline 域 —— 裁决块：这条通知现在该不该发。
 *
 * 本块是**唯一裁决点**：总开关、事件开关、动态 kind 白名单、免打扰时段、同类合并
 * 都在这里判，别处不重复。判两遍的代价不是多算一次——是两个答案不一致时，用户看到
 * 的是「设置改了不起作用」，而没人会想到去看第二个判断点。
 *
 * 未实现时一律判「不发」，而不是抛错：本块挂在宿主事件链上，装配完成那一刻就可能
 * 有事件到达，抛出去等于让插件在正常运行中崩掉。骨架期的「还没做」在行为上就等于
 * 「不打扰」——想看出裁决没做，读这个文件比读日志可靠。
 *
 * 依赖方向：只引用本目录与 `../../deps.ts`，不引用 `interface.ts`。
 */
import type { EffectiveConfig, NotifyRequest } from "../../deps.ts";
import type { Verdict } from "./type.ts";

/**
 * 裁决：这条通知现在该不该发。
 *
 * 未实现。待填的四道判据，顺序即短路顺序：
 *
 * 1. 静态开关：`enabled`、该类事件的开关、动态 kind 是否已在 `allowKinds` 里确认；
 * 2. 免打扰：`quietHours` 命中时段时，只放行它自己那份 `allowKinds`；
 * 3. 合并窗口：`errorMergeWindowMs` / `doneMergeWindowMs` 内的同类只留先到的一条；
 * 4. 审批久等：`askRemindMin` 到点后**再产出一条请求**。
 *
 * 前三条只回答「留或弃」，第四条会额外产出请求，因此需要定时器——本块届时会从纯
 * 函数变成有状态块，清定时器的责任随之落到本域的生命周期上。
 */
export function judgeRequest(config: EffectiveConfig, request: NotifyRequest, enabled: boolean): Verdict {
  void config;
  void request;
  void enabled;
  return { ok: false, reason: "unimplemented" };
}
