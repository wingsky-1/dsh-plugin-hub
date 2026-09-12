/** sdk 域对外服务面的形状，即本插件的 ABI：**只有两个口**（登记与发送）——清单与确认回答的是「用户答不答应」，
 * 挂上上下文等于任何插件都能替用户点头。与本插件管线域的同名 `NotifyRequest` 不是一回事：那个是域内陈述。 */
import type { NotifyKind, NotifySeverity } from "../../deps.ts";
import type { KindRegistration } from "../registry/type.ts";

/** 外部通知请求（服务面 `send` 的入参）。 */
export interface NotifyRequest {
  /** 种类：自己登记的动态 kind，或内置种类（内置的照走内置那一套开关与路由）。 */
  kind: NotifyKind;
  /** 展示强度；缺省即「没指定」，各出口回落自己的默认。 */
  severity?: NotifySeverity;
  /** 标题；缺省时本域补一个中性标题——调用方常常只有正文。 */
  title?: string;
  body: string;
}

/** `wingsky.notifier` 服务面：本插件对兄弟插件开放的全部能力。 */
export interface NotifierService {
  /** ABI 版本：消费方可据此判断自己面对的是哪一版服务面。2 = 服务面收敛版：确认与清单上收到设置端点，`registerChannel`
   * 退役，`send` 不再返回受理数组（数组里的 `ok` 是「已受理」而不是「已送达」）。 */
  readonly apiVersion: 2;
  /** 登记一种动态通知种类。登记不等于放行：用户要在设置页上确认过才会真正发出去——不给插件自我放行的能力，是因为
   * 「要不要被这个插件打扰」是用户的决定。@throws id 形态非法或命名空间撞上内置种类名时抛错。 */
  registerKind(registration: KindRegistration): void;
  /** 发送一条通知。受理即返回：**发不发、发去哪、送没送到都不从返回值出去**——那三件事属于裁决管线，而它只有一个。
   * @throws 请求形状非法时 reject，调用方应在调用点 catch——插件不该因为自己发错一条通知让宿主看到未捕获拒绝。 */
  send(request: NotifyRequest): Promise<void>;
}
