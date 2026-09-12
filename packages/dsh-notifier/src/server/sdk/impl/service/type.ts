/**
 * dsh-notifier sdk 域 —— 对外服务面的形状。
 *
 * 服务面就是本插件的 ABI：它经宿主上下文暴露给兄弟插件，因此**只有两个口**——登记与
 * 发送。清单与确认不在这里：那两件事回答的是「用户答不答应」，挂在上下文上等于任何插件
 * 都能替用户点头，而设置页上那份确认清单随之失去意义。
 *
 * 与裁决管线的同名请求不是一回事：那个是**域内**的陈述（`pipeline` 域的 `NotifyRequest`），
 * 这个是**包外**的调用。分开写而不是直接复用，是为了让两者能按各自的节奏演进——把域内
 * 类型当 ABI，域内改一个字段就是一次对外破坏。
 */
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
  /** 正文。 */
  body: string;
}

/** `wingsky.notifier` 服务面：本插件对兄弟插件开放的全部能力。 */
export interface NotifierService {
  /**
   * ABI 版本：消费方可据此判断自己面对的是哪一版服务面。
   *
   * 2 = 服务面收敛版：确认与清单上收到设置端点（`api` 域），`registerChannel` 退役
   * （它承诺了一个从未入库的频道贡献模型），`send` 不再返回受理数组（那个数组里的
   * `ok` 是「已受理」而不是「已送达」，读错方向比没有返回值更贵）。只用 `registerKind`
   * 与 `send` 的消费方不受影响。
   */
  readonly apiVersion: 2;
  /**
   * 登记一种动态通知种类。
   *
   * 登记不等于放行：用户要在设置页上确认过，这种通知才会真正发出去。不给插件自我放行的
   * 能力，是因为「要不要被这个插件打扰」是用户的决定，插件没有立场替他做这个决定。
   *
   * @throws id 不是 `<命名空间>:<id>` 形态，或命名空间撞上内置种类名时抛错。
   */
  registerKind(registration: KindRegistration): void;
  /**
   * 发送一条通知。
   *
   * 受理即返回：**发不发、发去哪、送没送到都不从返回值出去**——那三件事的答案属于裁决
   * 管线，而它只有一个。要读结果就去读通知历史与频道状态，它们是同一份事实的落点。
   *
   * @throws 请求形状非法时 reject。调用方应在调用点 catch——插件不该因为自己发错一条
   *   通知，让宿主看到一次未捕获的拒绝。
   */
  send(request: NotifyRequest): Promise<void>;
}
