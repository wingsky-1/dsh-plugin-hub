/**
 * Webhook 实例卡（新增频道位，安卓经 ntfy / Gotify / 自建网关推送；默认停用）。
 *
 * 卡头同 Bark 实例卡形态；卡体：预设 / 名称 / 目标 URL / 认证（凭据掩码 + 显隐）/ 超时 / JSON 模板编辑器。
 * 依赖一律显式传参（瞬态草稿 delArmedId / revealMap / secretEdited 仍由 SettingsCard 顶层持有）：
 * 卡体不持有 state/ref/定时器，删除二次确认的 3 秒定时器也照搬原形态留在卡内 onClick 闭包里。
 */
import * as React from "react";
import { WEBHOOK_AUTHS, channelIdFor, webhookTemplateOf } from "../../../shared/interface.ts";
import type { Translate } from "../../locale.ts";
import { credentialFieldKey, credentialFieldView } from "../mask.ts";
import { chRow } from "../parts/rows.tsx";
import { numInput, switchToggle, textInput } from "../parts/controls.tsx";
import { delArmedBtn, failBadge, statusDotClass, statusText, testBtn } from "../parts/status.tsx";
import type { ChannelStatusMap } from "../parts/status.tsx";
import type { HistoryRecordView, SettingsChannelView } from "../types.ts";
import { iconEl } from "./channel-icon.tsx";

/**
 * webhook 频道预设：选择预设填充认证方式与消息模板；URL 不自动
 * 覆盖（避免丢用户已填内容——「仅空值填充」的变体：URL 只在为空时
 * 由用户填写，模板/认证随预设走且可再改）。模板渲染契约见 channel-webhook.ts：
 * 文本占位符 JSON-aware 转义、{{ts}} 数字直出、{{priority}} 频道感知映射。
 *
 * 模板字面量取 src/shared/webhooks.ts（两端共享面，本模块不再抄第二份：宿主端出口渲染读的是
 * 同一份，各写一份时的漂移症状是「设置页看到的模板与实际发出去的 body 不是同一份」）。
 * 认证**默认值**留在这里：宿主端没有「套用预设」这个动作，没有对应物可共享。
 */
const WEBHOOK_PRESETS: Record<string, { auth: string; template: string }> = {
  ntfy: { auth: "bearer", template: webhookTemplateOf("ntfy") },
  gotify: { auth: "bearer", template: webhookTemplateOf("gotify") },
  custom: { auth: "header", template: webhookTemplateOf("custom") },
};

/**
 * 认证方式取值：白名单外一律回落 none。
 * 白名单取 src/shared/webhooks.ts（两端共享面）：写入口径与设置页选项必须是同一份，
 * 各写一份时的症状是「页面选得到、宿主拒收」。
 */
function webhookAuthValue(auth: unknown): string {
  const value = String(auth || "none");
  return (WEBHOOK_AUTHS as readonly string[]).indexOf(value) !== -1 ? value : "none";
}

/** 认证字段区的入参：模式判定的下游全在这里，故整块收成一处。 */
interface WebhookAuthControlsProps {
  readonly authValue: string;
  readonly ch: SettingsChannelView;
  readonly t: Translate;
  readonly revealMap: Record<string, boolean>;
  readonly secretEdited: Record<string, boolean>;
  readonly markSecretEdited: (key: string) => void;
  readonly setRevealMap: (next: Record<string, boolean>) => void;
  readonly whPatch: (part: Record<string, unknown>) => void;
}

/**
 * 认证字段区：模式选择下拉 + 该模式下的动态字段。
 *
 * 逐模式的字段清单（bearer→token，basic→username+password，header→头名+头值，none→无）
 * 是这一处的**全部**变化来源，故整块单立：它与模板编辑器、超时钳制是三类互不相干的编辑面，
 * 卡内混写时「加一种认证方式」要穿过半个组件。
 *
 * 凭据输入的 value 走 credentialFieldView：未编辑时为空（占位符给「已配置」提示），
 * 服务端掩码不进 value——它一旦被改写就不再等于掩码，服务端会把它当新凭据落盘。
 */
function webhookAuthControls(props: WebhookAuthControlsProps): React.ReactNode[] {
  const { authValue, ch, t, revealMap, secretEdited, markSecretEdited, setRevealMap, whPatch } =
    props;
  const chId = String(ch.id);

  /** 凭据输入 + 显隐按钮。 */
  function secretField(field: string, placeholderKey: string) {
    const key = credentialFieldKey(chId, field);
    const shown = revealMap[key] === true;
    const fieldView = credentialFieldView(ch[field], secretEdited[key] === true, t(placeholderKey));
    const part: Record<string, unknown> = {};
    return (
      <span className="dn-secret" key={field}>
        <input
          type={shown ? "text" : "password"}
          className="dn-set-input dn-set-inputText"
          value={fieldView.value}
          placeholder={fieldView.placeholder}
          aria-label={t(placeholderKey)}
          onChange={function (e: React.ChangeEvent<HTMLInputElement>) {
            markSecretEdited(key);
            part[field] = e.target.value;
            whPatch(part);
          }}
        />
        <button
          type="button"
          className="dn-secret-reveal"
          onClick={function () {
            const next: Record<string, boolean> = Object.assign({}, revealMap);
            next[key] = !shown;
            setRevealMap(next);
          }}
        >
          {shown ? t("secretHide") : t("secretShow")}
        </button>
      </span>
    );
  }

  const controls: React.ReactNode[] = [
    <select
      key="auth-select"
      className="dn-set-input dn-set-select"
      value={authValue}
      aria-label={t("whAuth")}
      onChange={function (e: React.ChangeEvent<HTMLSelectElement>) {
        whPatch({ auth: e.target.value });
      }}
    >
      <option value="none">{t("whAuthNone")}</option>
      <option value="bearer">{t("whAuthBearer")}</option>
      <option value="basic">{t("whAuthBasic")}</option>
      <option value="header">{t("whAuthHeader")}</option>
    </select>,
  ];
  if (authValue === "bearer") {
    controls.push(secretField("token", "whAuthToken"));
    return controls;
  }
  if (authValue === "basic") {
    controls.push(
      plainInput("username", ch.username || "", t("whAuthUsername"), function (v) {
        whPatch({ username: v });
      }),
    );
    controls.push(secretField("password", "whAuthPassword"));
    return controls;
  }
  if (authValue === "header") {
    controls.push(
      plainInput("headerName", ch.headerName || "", t("whAuthHeaderName"), function (v) {
        whPatch({ headerName: v });
      }),
    );
    controls.push(secretField("headerValue", "whAuthHeaderValue"));
  }
  return controls;
}

/** 明文字段（用户名 / 头名）：形状固定，只是 key 与提示不同，故收成一个构造器。 */
function plainInput(
  key: string,
  value: string,
  label: string,
  onValue: (v: string) => void,
): React.ReactElement {
  return (
    <input
      key={key}
      type="text"
      className="dn-set-input dn-set-inputText"
      value={value}
      placeholder={label}
      aria-label={label}
      onChange={function (e: React.ChangeEvent<HTMLInputElement>) {
        onValue(e.target.value);
      }}
    />
  );
}

/**
 * 在模板编辑框的光标处插入占位符；取不到编辑框（未挂载）时追加到末尾。
 *
 * selectionStart 为 null（部分浏览器在失焦时）视同「没有光标信息」→ 追加末尾。
 */
function insertTokenAtCursor(
  chId: string,
  token: string,
  current: string,
  patch: (next: string) => void,
): void {
  const ta = document.getElementById("dn-tpl-" + chId) as HTMLTextAreaElement | null;
  if (!ta) {
    patch(current + token);
    return;
  }
  const at =
    ta.selectionStart === null || ta.selectionStart === undefined
      ? ta.value.length
      : ta.selectionStart;
  patch(ta.value.slice(0, at) + token + ta.value.slice(at));
}

/**
 * Webhook 实例卡（新增频道位，安卓经 ntfy / Gotify / 自建网关推送；默认停用）。
 * 卡头同 Bark 实例卡形态；卡体：预设（填充认证/模板，URL 不覆盖）/ 名称 / 目标 URL /
 * 认证（none|bearer|basic|header，动态字段凭据掩码）/ 投递超时（1-60s clamp）/
 * JSON 模板编辑器（占位符 chips 光标处插入）。渲染契约见 channel-webhook.ts。
 */
export function webhookCard(
  ch: SettingsChannelView,
  idx: number,
  delArmedId: string | null,
  setDelArmedId: (v: string | null) => void,
  revealMap: Record<string, boolean>,
  setRevealMap: (next: Record<string, boolean>) => void,
  secretEdited: Record<string, boolean>,
  markSecretEdited: (key: string) => void,
  chPatch: (idx: number, part: Record<string, unknown>) => void,
  chRemove: (idx: number) => void,
  sendTest: (id?: string) => void,
  statusMap: ChannelStatusMap,
  t: Translate,
  history: HistoryRecordView[] | null,
  testDirty?: boolean,
) {
  const channelKey = channelIdFor(ch);
  const armed = delArmedId === ch.id;
  const authValue = webhookAuthValue(ch.auth);
  const chId = String(ch.id);
  /** webhook 字段 patch（函数式基于最新 channels，防同帧后写覆盖）。 */
  const whPatch = (part: Record<string, unknown>): void => {
    chPatch(idx, part);
  };
  const authCtl = webhookAuthControls({
    authValue,
    ch,
    t,
    revealMap,
    secretEdited,
    markSecretEdited,
    setRevealMap,
    whPatch,
  });

  const textTokens = [
    "{{title}}",
    "{{message}}",
    "{{kind}}",
    "{{severity}}",
    "{{priority}}",
    "{{source}}",
  ];
  const insertTpl = (token: string): void => {
    insertTokenAtCursor(chId, token, ch.template || "", function (next) {
      chPatch(idx, { template: next });
    });
  };
  const tplChips: React.ReactNode[] = textTokens.map(function (tok: string) {
    return (
      <button
        type="button"
        key={tok}
        className="dn-tpl-chip"
        title={t("whTemplateHint")}
        onClick={function () {
          insertTpl(tok);
        }}
      >
        {tok}
      </button>
    );
  });
  tplChips.push(
    <button
      type="button"
      key="{{ts}}"
      className="dn-tpl-chip is-raw"
      title={"{{ts}} → " + String(Date.now()) + "（数字直出，不加引号）"}
      onClick={function () {
        insertTpl("{{ts}}");
      }}
    >
      {"{{ts}}"}
    </button>,
  );

  return (
    <details
      className={"dn-ch-card" + (ch.enabled ? "" : " dn-ch-off")}
      key={channelKey + ":" + (ch.enabled === true)}
      open={ch.enabled === true}
    >
      <summary>
        {iconEl("webhook")}
        <span className="dn-ch-name">{ch.name || ch.id}</span>
        <span className="dn-ch-type">webhook</span>
        <span className="dn-ch-stateTxt">
          {ch.enabled === true ? t("chStateOn") : t("chStateOff")}
        </span>
        <span className={"dn-ch-statusDot " + statusDotClass(channelKey, statusMap)} />
        <span className="dn-ch-statusTxt" title={statusText(channelKey, statusMap, t, history)}>
          {statusText(channelKey, statusMap, t, history)}
        </span>
        {failBadge(channelKey, statusMap, t)}
        <span className="dn-ch-summaryRight">
          {switchToggle(
            ch.enabled === true,
            function (v: boolean) {
              whPatch({ enabled: v });
            },
            (ch.enabled ? t("chToggleOff") : t("chToggleOn")) + (ch.name || ch.id),
          )}
        </span>
      </summary>
      <div className="dn-ch-body">
        {chRow(
          t("whPreset"),
          <select
            className="dn-set-input dn-set-select"
            value=""
            aria-label={t("whPreset")}
            onChange={function (e: React.ChangeEvent<HTMLSelectElement>) {
              const p = WEBHOOK_PRESETS[e.target.value];
              if (!p) return;
              // preset 落配置（{{priority}} 频道感知映射的依据）；认证与模板随预设填充，URL 不覆盖（防丢已填内容）
              whPatch({ preset: e.target.value, auth: p.auth, template: p.template });
            }}
          >
            <option value="">{t("whPreset")}</option>
            <option value="ntfy">{t("whPresetNtfy")}</option>
            <option value="gotify">{t("whPresetGotify")}</option>
            <option value="custom">{t("whPresetCustom")}</option>
          </select>,
          t("whPresetHint"),
        )}
        {chRow(
          t("chBarkName"),
          textInput(
            ch.name,
            function (v: string) {
              whPatch({ name: v });
            },
            { placeholder: t("chBarkNamePlaceholder"), ariaLabel: t("chBarkName") },
          ),
        )}
        {chRow(
          t("whUrl"),
          textInput(
            ch.url,
            function (v: string) {
              whPatch({ url: v });
            },
            { placeholder: t("whUrlPlaceholder"), ariaLabel: t("whUrl") },
          ),
          t("whUrlHint"),
        )}
        {chRow(t("whAuth"), <span className="dn-authFields">{authCtl}</span>, t("whAuthHint"))}
        {chRow(
          t("whTimeout"),
          numInput(
            ch.timeoutSec,
            function (v: number | undefined) {
              // UI 层先 clamp（1-60）；服务端 normalize 仍权威 clamp（防绕过 UI 的 PUT）
              whPatch({
                timeoutSec: v === undefined ? undefined : Math.min(60, Math.max(1, Math.round(v))),
              });
            },
            { ariaLabel: t("whTimeout"), min: 1, max: 60 },
          ),
          t("whTimeoutHint"),
        )}
        <div className="dn-ch-row" style={{ display: "block" }}>
          <div className="dn-ch-cap" style={{ marginBottom: "6px" }}>
            {t("whTemplate")}
          </div>
          <textarea
            id={"dn-tpl-" + chId}
            className="dn-tpl"
            spellCheck={false}
            aria-label={t("whTemplate")}
            value={ch.template || ""}
            onChange={function (e: React.ChangeEvent<HTMLTextAreaElement>) {
              whPatch({ template: e.target.value });
            }}
          />
          <div className="dn-tplChips">
            <span className="dn-tplCap">{t("routeCap") + ":"}</span>
            {tplChips}
            <button
              type="button"
              className="dn-set-btn dn-set-btnSmall"
              onClick={function () {
                // 恢复为当前预设（ch.preset 由预设下拉落配置；缺省 ntfy 与服务端默认一致）的默认模板
                const p = WEBHOOK_PRESETS[String(ch.preset || "ntfy")];
                if (p) whPatch({ template: p.template });
              }}
            >
              {t("whTplRestore")}
            </button>
          </div>
          <span className="dn-ch-hint">{t("whTemplateHint")}</span>
          <span className="dn-ch-hint">{t("whTemplateFailHint")}</span>
        </div>
        <div className="dn-ch-actions">
          {testBtn(channelKey, sendTest, t, testDirty)}
          {delArmedBtn(
            armed,
            ch.id,
            function () {
              chRemove(idx);
            },
            setDelArmedId,
            t,
          )}
        </div>
      </div>
    </details>
  );
}
