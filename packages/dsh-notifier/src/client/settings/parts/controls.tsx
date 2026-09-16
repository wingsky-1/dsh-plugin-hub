/**
 * 设置项输入原子：switch / 文本 / 数字的纯渲染函数。
 *
 * settings 与 patch 由调用方传入——客户端唯一的 settings 写入口是卡片里的 patch（updater 内
 * 同步 settingsRef），原子层不持有写路径，也不读卡片状态。
 */
import * as React from "react";

/** switch 开关底层（track 40×22 + 透明 input 覆盖 44×32 触控区；
 *  aria-label 提供可访问名——switch 无内联文本，WCAG 4.1.2）。 */
export function switchToggle(checked: boolean, onChange: (v: boolean) => void, ariaLabel: string) {
  return (
    <label className="dn-switch">
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked === true}
        onChange={function (e: any) {
          onChange(e.target.checked === true);
        }}
      />
      <span className="dn-switch-track" />
    </label>
  );
}

/** 顶层布尔设置键的 switch（switchToggle 的设置键薄封装）。
 *  统一走 patch 写入口（settingsRef 同步），不再裸 setSettings。 */
export function switchControl(
  key: string,
  ariaLabel: string,
  settings: Record<string, unknown>,
  patch: (p: (prev: Record<string, unknown>) => Record<string, unknown>) => void,
) {
  return switchToggle(
    settings[key] === true,
    function (v: boolean) {
      patch(function (prev: any) {
        const next = Object.assign({}, prev);
        next[key] = v;
        return next;
      });
    },
    ariaLabel,
  );
}

export function textInput(
  value: any,
  onChange: (v: string) => void,
  opts?: { type?: string; placeholder?: string; ariaLabel?: string },
) {
  return (
    <input
      type={(opts && opts.type) || "text"}
      className="dn-set-input dn-set-inputText"
      value={value === undefined || value === null ? "" : String(value)}
      placeholder={opts && opts.placeholder}
      aria-label={(opts && opts.ariaLabel) || (opts && opts.placeholder) || undefined}
      onChange={function (e: any) {
        onChange(e.target.value);
      }}
    />
  );
}

export function numInput(
  value: any,
  onChange: (v: number | undefined) => void,
  opts?: { ariaLabel?: string; min?: number; max?: number },
) {
  return (
    <input
      type="number"
      step={1}
      className="dn-set-input dn-set-numInput"
      min={opts && opts.min}
      max={opts && opts.max}
      aria-label={opts && opts.ariaLabel}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={function (e: any) {
        onChange(e.target.value === "" ? undefined : Number(e.target.value));
      }}
    />
  );
}
