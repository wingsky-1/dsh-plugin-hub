/**
 * 频道卡体行原子：纯渲染函数（返回 JSX），依赖一律显式传参。
 *
 * 为什么保持普通函数而不改成组件：这些是卡体排版原子，调用点在渲染期直接调用；改成组件会
 * 引入组件边界与新的 reconciliation 语义（key/位置、hooks 归属），本批只做搬家、行为零变化。
 */
import * as React from "react";
import { deliveryViewOf, type DeliveryView } from "../../reason-text.ts";
import type { Translate } from "../../locale.ts";

/** 频道卡体行（cap + 控件 + 可选 hint；CSS dn-ch-row/dn-ch-cap/dn-ch-ctl）。 */
export function chRow(cap: string, control: React.ReactNode, hint?: string) {
  return (
    <div className="dn-ch-row">
      <span className="dn-ch-cap">{cap}</span>
      <span className="dn-ch-ctl">{control}</span>
      {hint ? <span className="dn-ch-hint">{hint}</span> : null}
    </div>
  );
}

/** 折叠区行（cap + 控件；CSS dn-adv-row）。 */
export function advRow(cap: string, control: React.ReactNode) {
  return (
    <div className="dn-adv-row">
      <span className="dn-adv-cap">{cap}</span>
      {control}
    </div>
  );
}

/**
 * 逐出口投递明细：状态标签 + 主理由 + 宿主原文（原文折叠，并标注它的来源）。
 * 数据本来就随 `/history` 到了客户端（`archive(..., { channels })`），此前只是没人渲染——
 * 「投递成功却没声音」这类结论因此完全不可见，状态行在 `skipped` 后还不会变。
 */
export function deliveryLines(r: { channels?: unknown }, t: Translate) {
  const list: unknown[] = Array.isArray(r.channels) ? r.channels : [];
  const views: DeliveryView[] = [];
  list.forEach(function (delivery: unknown) {
    const view = deliveryViewOf(delivery, t);
    if (view) views.push(view);
  });
  if (views.length === 0) return null;
  return (
    <div className="dn-set-historyChannels">
      {views.map(function (view, j: number) {
        return (
          <div
            className={"dn-ch-delivery dn-ch-delivery-" + view.status}
            key={view.channelId + "-" + j}
          >
            <span className="dn-ch-deliveryName">{view.channelId}</span>
            <span className="dn-ch-deliveryStatus">{view.statusText}</span>
            {view.reason ? <span className="dn-ch-deliveryReason">{view.reason}</span> : null}
            {view.detail ? (
              <details className="dn-ch-reasonRaw">
                <summary>{t("reasonDetailLabel")}</summary>
                <div className="dn-ch-reasonRawText">{view.detail}</div>
              </details>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
