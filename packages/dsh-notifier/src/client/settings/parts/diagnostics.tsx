/**
 * 能力自检与浏览器权限的呈现原子。
 *
 * 判定与文案都在 capabilities.ts / reason-text.ts：这里只把视图模型投影成 JSX。t、平台、诊断
 * 视图与授权回调全部显式传参——原子层不读卡片状态，也不自取浏览器事实（安全上下文由调用方
 * 传入，与卡片内其他判定同源）。
 */
import * as React from "react";
import type { ClientDiagnosticsView } from "../../capabilities.ts";
import type { Translate } from "../../locale.ts";

/**
 * 浏览器通知权限状态行（从全局降级区移入「浏览器通知」频道卡）。
 * 三态文案 + 未授权时的「请求通知权限」按钮（手势内请求，完成后刷新状态）；
 * 非安全上下文/无 Notification API 时返回 null（对应降级文案仍在全局 notes）。
 */
export function browserPermLine(
  t: Translate,
  secureContext: boolean,
  onRequestPermission: () => void,
) {
  if (!("Notification" in window) || !secureContext) return null;
  let text = "";
  let pending = false;
  if (Notification.permission === "granted") text = t("permGranted");
  else if (Notification.permission === "denied") text = t("permDenied");
  else {
    text = t("permDefault");
    pending = true;
  }
  return (
    <div className="dn-ch-perm">
      <span className="dn-ch-permText">{text}</span>
      {pending ? (
        <button
          type="button"
          className="dn-set-btn dn-set-btnSmall"
          onClick={function () {
            onRequestPermission();
          }}
        >
          {t("requestPerm")}
        </button>
      ) : null}
    </div>
  );
}

/** 平台提示行：宿主平台差异说明——Windows SoundPlayer 语义、macOS
 *  NSSound、Linux 自播；/health 拉取失败/未知平台回落通用说明。 */
export function systemPlatformHint(hostPlatform: string | null, t: Translate) {
  let text: string;
  if (hostPlatform === "win32") text = t("sysPlatformWin");
  else if (hostPlatform === "darwin") text = t("sysPlatformMac");
  else if (hostPlatform === "linux") text = t("sysPlatformLinux");
  else text = t("sysPlatformOther");
  return <div className="dn-set-note-inline">{text}</div>;
}

/**
 * 宿主能力自检块（系统频道卡体）。为什么落在卡体而不是卡头 `.dn-ch-statusTxt`：窄屏下
 * 卡头那行被 display:none 收起，而手机恰是最需要知道「为什么没响」的地方。
 * 这里只做机械投影——结论、处置建议、明细的文案都来自 capabilities.ts。
 */
export function hostDiagnosticsBlock(diag: ClientDiagnosticsView) {
  const view = diag.host;
  if (!view) return null;
  return (
    <div className={"dn-ch-diag dn-ch-diag-" + view.tone}>
      <span className="dn-ch-diagText">{view.line}</span>
      {view.unknownLine ? <span className="dn-ch-diagText">{view.unknownLine}</span> : null}
      {view.remediationLines.length === 0 ? null : (
        <div>
          <span className="dn-ch-diagCap">{view.remediationTitle}</span>
          <ul className="dn-ch-diagItems">
            {view.remediationLines.map(function (text, i) {
              return <li key={"rem-" + i}>{text}</li>;
            })}
          </ul>
        </div>
      )}
      {/* 明细折叠（沿用通知记录里 dn-ch-reasonRaw 的折叠范式）；来源标注在展开区首行 */}
      <details className="dn-ch-reasonRaw">
        <summary>{view.detailsLabel}</summary>
        <div className="dn-ch-reasonRawText">
          <div className="dn-ch-diagSrc">{view.sourceLabel}</div>
          {view.details.map(function (row, i) {
            return (
              <div className="dn-ch-diagDetail" key={"det-" + i}>
                <span className="dn-ch-diagDetailCap">{row.label}</span>
                <span>{row.value}</span>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

/** 浏览器面自检行（浏览器频道卡体）：宿主算不出来的那几个事实（权限、音频解锁）在这里成一句话。 */
export function browserDiagnosticsLine(diag: ClientDiagnosticsView) {
  const view = diag.browser;
  return (
    <div className={"dn-ch-diag dn-ch-diag-" + view.tone}>
      <span className="dn-ch-diagText">{view.line}</span>
      <span className="dn-ch-diagSrc">{view.sourceLabel}</span>
    </div>
  );
}
