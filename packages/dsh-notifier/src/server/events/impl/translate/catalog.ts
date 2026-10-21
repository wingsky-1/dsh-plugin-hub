/**
 * dsh-notifier events 域 —— 6 个内置通知的双语产品文案。
 *
 * 正文结构只有一份，语言只替换产品词和时长单位；任务名、问题、理由与错误原文始终是数据。
 */
import type { NotificationLocale } from "../../../shared/interface.ts";
import type { KindText } from "./type.ts";

interface LocaleText {
  readonly askWithTask: (task: string, tool: string) => string;
  readonly askWithoutTask: (tool: string) => string;
  readonly reason: (reason: string) => string;
  readonly askFooter: string;
  readonly questionWithTask: (task: string) => string;
  readonly questionWithoutTask: string;
  readonly question: (question: string) => string;
  readonly questionFooter: string;
  readonly doneWithTask: (task: string) => string;
  readonly doneWithoutTask: string;
  readonly subagentDoneWithTask: (task: string) => string;
  readonly subagentDoneWithoutTask: string;
  readonly duration: (duration: string) => string;
  readonly hours: (value: number) => string;
  readonly minutes: (value: number) => string;
  readonly seconds: (value: number) => string;
  readonly errorWithTask: (task: string) => string;
  readonly errorWithoutTask: string;
  readonly errorTurn: (turn: number, step: number | undefined, message: string) => string;
  readonly errorMessage: (message: string) => string;
  readonly turnEndWithTaskTurn: (task: string, turn: number) => string;
  readonly turnEndWithTaskWithoutTurn: (task: string) => string;
  readonly turnEndWithoutTaskWithTurn: (turn: number) => string;
  readonly turnEndWithoutTaskWithoutTurn: string;
  readonly titles: Readonly<Record<TranslatedKind, string>>;
}

const ZH: LocaleText = {
  askWithTask: (task, tool) => `任务「${task}」等待审批（工具「${tool}」）`,
  askWithoutTask: (tool) => `工具「${tool}」等待审批`,
  reason: (reason) => `理由：${reason}`,
  askFooter: "请到 DSH 界面确认或拒绝",
  questionWithTask: (task) => `任务「${task}」需要你回答`,
  questionWithoutTask: "有提问需要你回答",
  question: (question) => `问题：${question}`,
  questionFooter: "请到 DSH 界面回答",
  doneWithTask: (task) => `任务「${task}」已完成`,
  doneWithoutTask: "后台任务已完成",
  subagentDoneWithTask: (task) => `子任务「${task}」已完成`,
  subagentDoneWithoutTask: "子任务已完成",
  duration: (duration) => `耗时：${duration}`,
  hours: (value) => `${value} 小时`,
  minutes: (value) => `${value} 分`,
  seconds: (value) => `${value} 秒`,
  errorWithTask: (task) => `任务「${task}」执行出错`,
  errorWithoutTask: "任务执行出错",
  errorTurn: (turn, step, message) => `第 ${turn} 轮${step ? `第 ${step} 步` : ""}：${message}`,
  errorMessage: (message) => `错误：${message}`,
  turnEndWithTaskTurn: (task, turn) => `任务「${task}」第 ${turn} 轮工作已完成`,
  turnEndWithTaskWithoutTurn: (task) => `任务「${task}」工作已完成`,
  turnEndWithoutTaskWithTurn: (turn) => `第 ${turn} 轮工作已完成`,
  turnEndWithoutTaskWithoutTurn: "工作已完成",
  titles: {
    ask: "DSH：等待审批",
    question: "DSH：向你提问",
    done: "DSH：任务完成",
    "subagent-done": "DSH：子任务完成",
    error: "DSH：任务出错",
    "turn-end": "DSH：轮次完成",
  },
};

const EN: LocaleText = {
  askWithTask: (task, tool) => `Approval needed for task "${task}" (tool "${tool}")`,
  askWithoutTask: (tool) => `Approval needed for tool "${tool}"`,
  reason: (reason) => `Reason: ${reason}`,
  askFooter: "Confirm or deny in the DSH window",
  questionWithTask: (task) => `Task "${task}" is waiting for your answer`,
  questionWithoutTask: "There is a question waiting for your answer",
  question: (question) => `Question: ${question}`,
  questionFooter: "Answer in the DSH window",
  doneWithTask: (task) => `Task "${task}" completed`,
  doneWithoutTask: "Background task completed",
  subagentDoneWithTask: (task) => `Subagent task "${task}" completed`,
  subagentDoneWithoutTask: "Subagent task completed",
  duration: (duration) => `Duration: ${duration}`,
  hours: (value) => `${value}h`,
  minutes: (value) => `${value}m`,
  seconds: (value) => `${value}s`,
  errorWithTask: (task) => `Task "${task}" failed`,
  errorWithoutTask: "Task failed",
  errorTurn: (turn, step, message) => `Turn ${turn}${step ? `, step ${step}` : ""}: ${message}`,
  errorMessage: (message) => `Error: ${message}`,
  turnEndWithTaskTurn: (task, turn) => `Turn ${turn} of task "${task}" completed`,
  turnEndWithTaskWithoutTurn: (task) => `A turn of task "${task}" completed`,
  turnEndWithoutTaskWithTurn: (turn) => `Turn ${turn} completed`,
  turnEndWithoutTaskWithoutTurn: "Turn completed",
  titles: {
    ask: "DSH: Approval needed",
    question: "DSH: Question for you",
    done: "DSH: Task completed",
    "subagent-done": "DSH: Subagent task completed",
    error: "DSH: Task failed",
    "turn-end": "DSH: Turn completed",
  },
};

const LOCALE_TEXT: Readonly<Record<NotificationLocale, LocaleText>> = { zh: ZH, en: EN };

function durationParts(ms: number): readonly [number, number, number] {
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  return [
    Math.floor(totalSeconds / 3600),
    Math.floor((totalSeconds % 3600) / 60),
    totalSeconds % 60,
  ];
}

/** 毫秒 → 指定语言的可读耗时。 */
export function formatDurationForLocale(ms: number, locale: NotificationLocale): string {
  const [hours, minutes, seconds] = durationParts(ms);
  const parts: string[] = [];
  const text = LOCALE_TEXT[locale];
  if (hours > 0) parts.push(text.hours(hours));
  if (minutes > 0) parts.push(text.minutes(minutes));
  if (seconds > 0 || parts.length === 0) parts.push(text.seconds(seconds));
  return parts.join(" ");
}

/** 毫秒 → 中文可读耗时；保留旧导出给现有调用方。 */
export function formatDuration(ms: number): string {
  return formatDurationForLocale(ms, "zh");
}

/** 工具 ID 原样展示；保留旧导出签名供现有消费方使用。 */
export function prettyToolName(name?: string): string {
  return name ?? "?";
}

export type TranslatedKind = "ask" | "question" | "done" | "subagent-done" | "error" | "turn-end";

/** 生成六类通知的同构字典；正文只实现一次，两个语言包只提供产品词。 */
export function getNotifyKinds(locale: NotificationLocale): Record<TranslatedKind, KindText> {
  const text = LOCALE_TEXT[locale];
  return {
    ask: {
      title: text.titles.ask,
      body: (detail) => {
        const lines = [
          detail.taskTitle
            ? text.askWithTask(detail.taskTitle, prettyToolName(detail.tool))
            : text.askWithoutTask(prettyToolName(detail.tool)),
        ];
        if (detail.reason) lines.push(text.reason(detail.reason));
        lines.push(text.askFooter);
        return lines.join("\n");
      },
    },
    question: {
      title: text.titles.question,
      body: (detail) => {
        const lines = [
          detail.taskTitle ? text.questionWithTask(detail.taskTitle) : text.questionWithoutTask,
        ];
        if (detail.question) lines.push(text.question(detail.question));
        lines.push(text.questionFooter);
        return lines.join("\n");
      },
    },
    done: {
      title: text.titles.done,
      body: (detail) => {
        const title = detail.taskTitle ? text.doneWithTask(detail.taskTitle) : text.doneWithoutTask;
        return [title, text.duration(formatDurationForLocale(detail.durationMs ?? 0, locale))].join(
          "\n",
        );
      },
    },
    "subagent-done": {
      title: text.titles["subagent-done"],
      body: (detail) => {
        const title = detail.taskTitle
          ? text.subagentDoneWithTask(detail.taskTitle)
          : text.subagentDoneWithoutTask;
        return [title, text.duration(formatDurationForLocale(detail.durationMs ?? 0, locale))].join(
          "\n",
        );
      },
    },
    error: {
      title: text.titles.error,
      body: (detail) => {
        const lines = [
          detail.taskTitle ? text.errorWithTask(detail.taskTitle) : text.errorWithoutTask,
        ];
        if (detail.turn) {
          lines.push(text.errorTurn(detail.turn, detail.step, detail.message ?? ""));
        } else if (detail.message) {
          lines.push(text.errorMessage(detail.message));
        }
        return lines.join("\n");
      },
    },
    "turn-end": {
      title: text.titles["turn-end"],
      body: (detail) =>
        detail.taskTitle
          ? detail.turn
            ? text.turnEndWithTaskTurn(detail.taskTitle, detail.turn)
            : text.turnEndWithTaskWithoutTurn(detail.taskTitle)
          : detail.turn
            ? text.turnEndWithoutTaskWithTurn(detail.turn)
            : text.turnEndWithoutTaskWithoutTurn,
    },
  };
}

/** 旧导出：中文默认字典。 */
export const NOTIFY_KINDS = getNotifyKinds("zh");
