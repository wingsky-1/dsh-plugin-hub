/**
 * 频道类型图标原子：三张频道卡（内置 / bark / webhook）共用的卡头图标。
 *
 * 为什么单独成模块：三张卡都要它，任何一张卡持有都会让另两张反向依赖那张卡；它是纯渲染原子，
 * 只由 channelType 决定输出，没有卡片状态可读。
 */
import * as React from "react";

/**
 * 频道类型图标（设计上刻意保留；内联 SVG 零外部资源）。
 * browser=地球 / system=显示器 / webhook=闪电 / 其余（bark）=铃铛。
 */
export function iconEl(channelType: string) {
  let paths: any[];
  if (channelType === "browser") {
    paths = [
      <circle cx={12} cy={12} r={9} key="c" />,
      <path
        d="M3 12h18M12 3c2.5 2.6 4 5.7 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.7-4-9s1.5-6.4 4-9z"
        key="p"
      />,
    ];
  } else if (channelType === "system") {
    paths = [
      <rect x={3} y={4} width={18} height={12} rx={2} key="r" />,
      <path d="M8 20h8M12 16v4" key="p" />,
    ];
  } else if (channelType === "webhook") {
    paths = [<path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8z" key="p" strokeLinejoin="round" />];
  } else {
    paths = [
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" key="a" />,
      <path d="M13.7 21a2 2 0 0 1-3.4 0" key="b" />,
    ];
  }
  return (
    <span className="dn-ch-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        {paths}
      </svg>
    </span>
  );
}
