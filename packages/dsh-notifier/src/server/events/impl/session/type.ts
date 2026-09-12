/** dsh-notifier events 域 —— 会话读取与归属判定自己的形状。 */

/** 一次轮次结束的证据：`turn/end` 的轮次号与成因。 */
export interface TurnEndEvidence {
  turn: number;
  /** 官方 `TurnEndReason` 联合可被插件 extend：按 string 存，不假装认识运行时给的取值。 */
  kind: string;
}

/** 会话标题：没有标题是新会话的常态，不是异常。 */
export type SessionTitle = { found: true; title: string } | { found: false };

export type TurnEndRead = { found: true; evidence: TurnEndEvidence } | { found: false };
