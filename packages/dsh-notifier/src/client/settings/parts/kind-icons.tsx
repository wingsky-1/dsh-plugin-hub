/**
 * 设置卡 icon 原子：事件 kind / 分段 tab / 历史 severity 的单色线稿。
 *
 * kind id 事实源 = src/shared/kinds.ts 的 BUILTIN_KINDS
 * （ask | question | done | subagent-done | error | turn-end | test），
 * 与开关键名 notifyTaskDone 无关。内联 SVG 零外部资源；三页共用 CSS .dn-ico。
 */
import * as React from "react";

type PathDef = React.ReactElement[];

function wrap(paths: PathDef, extraCls?: string, title?: string) {
  return (
    <span
      className={"dn-ico" + (extraCls ? " " + extraCls : "")}
      aria-hidden={title ? undefined : "true"}
      title={title}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
        {paths}
      </svg>
    </span>
  );
}

/** 事件 kind → 图标（键必须与 BUILTIN_KINDS / 外部 kind 字符串一致）。 */
export function kindIcon(kind: string, extraCls?: string) {
  let paths: PathDef;
  if (kind === "ask") {
    paths = [
      <path d="M8 10h8M8 14h5" key="t" />,
      <path
        d="M7 5h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-4l-4 3v-3H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"
        key="b"
      />,
    ];
  } else if (kind === "question") {
    paths = [
      <circle cx="12" cy="12" r="8" key="c" />,
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.2 2.4c-.7.2-1.2.9-1.2 1.6v.3" key="q" />,
      <circle cx="12" cy="17" r=".8" fill="currentColor" stroke="none" key="d" />,
    ];
  } else if (kind === "done") {
    paths = [<path d="M5 12l4 4L19 6" key="p" />];
  } else if (kind === "subagent-done") {
    paths = [
      <circle cx="9" cy="10" r="3" key="a" />,
      <circle cx="16" cy="12" r="2.5" key="b" />,
      <path d="M5 18c.8-2 2.2-3 4-3s3.2 1 4 3" key="p" />,
    ];
  } else if (kind === "error") {
    paths = [<circle cx="12" cy="12" r="8" key="c" />, <path d="M12 8v5M12 16h.01" key="p" />];
  } else if (kind === "turn-end") {
    paths = [<path d="M7 7h10v4l3 2-3 2v2H7v-2l-3-2 3-2V7z" key="p" />];
  } else if (kind === "test") {
    paths = [<path d="M9 3h6M10 3v6l-4 8a3 3 0 0 0 2.6 4.5h6.8A3 3 0 0 0 18 17l-4-8V3" key="p" />];
  } else {
    // 外部注册 kind / 未知 id：通用铃铛，不误判为内置事件专属图
    paths = [
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" key="a" />,
      <path d="M13.7 21a2 2 0 0 1-3.4 0" key="b" />,
    ];
  }
  return wrap(paths, extraCls);
}

/** 分段 tab 图标。 */
export function tabIcon(which: "events" | "channels" | "history") {
  if (which === "events") {
    return wrap([
      <path d="M12 3v3M8 6h8l1 3H7l1-3z" key="a" />,
      <path d="M6 9h12v7a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V9z" key="b" />,
    ]);
  }
  if (which === "channels") {
    return wrap([
      <rect x="4" y="5" width="16" height="12" rx="2" key="r" />,
      <path d="M8 21h8" key="p" />,
    ]);
  }
  return wrap([<circle cx="12" cy="12" r="8" key="c" />, <path d="M12 8v4l2.5 2.5" key="p" />]);
}

/** 历史 severity → 图标（色相只作图标描边，不靠左侧色条）。 */
export function sevIcon(sev: string, extraCls?: string) {
  let paths: PathDef;
  if (sev === "failure" || sev === "error") {
    paths = [<circle cx="12" cy="12" r="8" key="c" />, <path d="M12 8v5M12 16h.01" key="p" />];
  } else if (sev === "warning") {
    paths = [<path d="M12 4l9 16H3L12 4z" key="t" />, <path d="M12 10v4M12 17h.01" key="p" />];
  } else if (sev === "success") {
    paths = [<path d="M5 12l4 4L19 6" key="p" />];
  } else {
    paths = [<circle cx="12" cy="12" r="8" key="c" />, <path d="M12 11v5M12 8h.01" key="p" />];
  }
  return wrap(paths, extraCls, "severity: " + sev);
}
