/** sdk 域服务面与生命周期：把服务对象挂上宿主上下文、把外部请求送进裁决管线、管好动态种类的确认态（本域只是**边界**）。
 * **对外**只有登记与发送，**对内**才是清单与确认——合成一个对象交出去，兄弟插件就能替用户确认自己的通知种类。 */
import type {
  BuiltinKind,
  ConfigPort,
  ExternalKind,
  NotifyKind,
  PipelinePort,
  SdkDeps,
} from "../../deps.ts";
import { kindRegistry } from "../registry/index.ts";
import type { KindRegistration, RegisteredKind } from "../registry/type.ts";
import type { NotifierService, NotifyRequest } from "./type.ts";

/** 提交体与写面结果：不额外请上游域导出名字，它们的形状经能力面的签名可达。 */
type SubmitRequest = Parameters<PipelinePort["submit"]>[0];
type WriteOutcome = Awaited<ReturnType<ConfigPort["writeConfig"]>>;

/** 缺省标题。不留空标题：系统通知里标题为空的表现是整条通知看起来像一条残缺记录；取值沿用重写前对外发送的缺省
 * 文案——用户看到的东西不该因为一次内部重构而变。 */
const DEFAULT_TITLE = "DSH 通知";

/** 未装配的告警文案：占位能力被真的读到，说明装配守卫有洞。 */
const NOT_INSTALLED = "dsh-notifier: 对外服务面尚未装配";

/** 服务名：本插件对兄弟插件开放的 ABI 名。事实源在这里而不在组合根——组合根硬编码字面量，改名漏改时消费方
 * `ctx.get` 会拿到空，一个本包门禁照不到的失败。包入口的声明合并仍要写一遍字面量（TS 接口成员名不能是变量）。 */
export const NOTIFIER_SERVICE = "wingsky.notifier" as const;

/** 未装配时的占位。占位成抛错而不是空实现：真被读到时「没装配」应当当场暴露，而不是让一条通知静默地消失在
 * 空实现里——那种失败没有任何线索指向装配。 */
const UNINSTALLED: SdkDeps = {
  expose: {
    provide: () => {
      throw new Error(NOT_INSTALLED);
    },
  },
  config: {
    readConfig: () => {
      throw new Error(NOT_INSTALLED);
    },
    writeConfig: () => Promise.reject(new Error(NOT_INSTALLED)),
  },
  pipeline: {
    submit: () => {
      throw new Error(NOT_INSTALLED);
    },
    isBuiltinKind: (kind: string): kind is BuiltinKind => {
      void kind;
      throw new Error(NOT_INSTALLED);
    },
  },
};

/** 是不是「命名空间限定」的形态：冒号两侧都非空。`x:` 与 `:x` 在模板字面量类型里合法，到了裁决层却是两个查不到
 * 归属的键，而它在设置页上显示成一行空名字。 */
function isNamespaceQualified(value: string): boolean {
  const separator = value.indexOf(":");
  return separator > 0 && separator < value.length - 1;
}

/** 命名空间：冒号之前的部分。只在形态判过之后调用——不含冒号时它没有意义。 */
function namespaceOf(value: string): string {
  return value.slice(0, value.indexOf(":"));
}

/** 收窄成受命名空间限定的种类 id。模板字面量类型在运行时无从判断，所以这里是本域作为边界的一次收窄（`as` 是这个
 * 位置唯一诚实的写法）。除形态外还要挡住**命名空间撞上内置种类名**（`ask:foo`）：查询事件开关时前缀会被当成内置种类。 */
function toExternalKind(value: string, pipeline: PipelinePort): ExternalKind {
  if (!isNamespaceQualified(value)) {
    throw new Error(`dsh-notifier: 动态通知种类 id 非法 —— ${value}（需为 <命名空间>:<id>）`);
  }
  if (pipeline.isBuiltinKind(namespaceOf(value))) {
    throw new Error(`dsh-notifier: 动态通知种类的命名空间不能是内置种类 —— ${value}`);
  }
  return value as ExternalKind;
}

/** 这个种类是我们认识的吗：内置的，或命名空间限定的外部种类。判据与 `registerKind` 一致——`ask:foo` 不是外部
 * 种类（命名空间撞了内置名），发它只会得到一条查不到开关的通知。 */
function isSendableKind(kind: string, pipeline: PipelinePort): kind is NotifyKind {
  if (pipeline.isBuiltinKind(kind)) return true;
  return isNamespaceQualified(kind) && !pipeline.isBuiltinKind(namespaceOf(kind));
}

/** 对外服务面：装配期构造，装配期交出去。它只拿得到裁决管线的能力——兄弟插件该有的能力只有登记与发送这两样；
 * 多给一样，就是把本域的内部状态变成公共 API，而公共 API 从此不能再改。 */
class HostedService implements NotifierService {
  /** 类型取自契约上的字面量：改一处不改另一处是编译错误。 */
  readonly apiVersion: NotifierService["apiVersion"] = 2;

  constructor(private readonly pipeline: PipelinePort) {}

  /** 登记一种动态通知种类。非法入参**抛错**而不是静默忽略：静默的代价不在本插件——插件作者看到的现象是「通知没
   * 发出去」，而设置页上根本没有他那一项，没有任何线索指向「你的 id 拼错了」。 */
  registerKind(registration: KindRegistration): void {
    const id = registration.id;
    if (typeof id !== "string") {
      throw new Error("dsh-notifier: registerKind 需要一个 <命名空间>:<id> 形式的 id");
    }
    const label = registration.label;
    kindRegistry.register({
      id: toExternalKind(id, this.pipeline),
      // 展示名缺省用 id：设置页上宁可显示一串 id（至少说得出是谁注册的），也不要显示一行空白。
      label: typeof label === "string" && label.length > 0 ? label : id,
    });
  }

  /** 发送一条通知。声明成 `async` 而不是同步方法：消费方写的是 `.send(...).catch(...)`，同步返回 `undefined` 会让
   * 那一行在运行时抛 `TypeError`——一个由本插件引起、却出现在别人代码里的崩溃。形状守卫只做一次收窄，不判该不该发：
   * 那是唯一裁决点的事，在本域再判一遍就是第二个答案。 */
  async send(request: NotifyRequest): Promise<void> {
    const kind = request.kind;
    if (typeof kind !== "string" || !isSendableKind(kind, this.pipeline)) {
      throw new Error(
        `dsh-notifier: 通知种类非法 —— ${String(kind)}（需为内置种类或 <命名空间>:<id>）`,
      );
    }
    const body = request.body;
    if (typeof body !== "string") {
      throw new Error("dsh-notifier: 通知正文必须是字符串");
    }
    const title = request.title;
    const submit: SubmitRequest = {
      kind,
      title: typeof title === "string" && title.length > 0 ? title : DEFAULT_TITLE,
      body,
    };
    const severity = request.severity;
    if (severity !== undefined) submit.severity = severity;
    this.pipeline.submit(submit);
  }
}

/** sdk 域：生命周期与**对内**的管理面。清单与确认留在这里而不是服务面上：它们回答的是「用户答不答应」，只有设置页该问。 */
class SdkService {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 装配入参：宿主出口与两个域的能力面。 */
  private deps: SdkDeps = UNINSTALLED;
  /** 摘除器：本域挂在宿主上的东西只有服务面一件，但按清单收口，将来多一件不用改结构。 */
  private disposers: Array<() => void> = [];

  /** 装配：构造服务对象并交出去。 */
  install(deps: SdkDeps): void {
    if (this.installed) throw new Error("dsh-notifier: sdk 域只能装配一次");
    this.installed = true;
    this.deps = deps;
    this.disposers.push(deps.expose.provide(new HostedService(deps.pipeline)));
  }

  /** 卸载：把服务面从上下文上收回来。重复调用无害——卸载链可能走到不止一次。 */
  release(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.installed = false;
    this.deps = UNINSTALLED;
  }

  /** 清单：登记项合并确认名单（确认名单实时读设置，不取装配期快照）。 */
  listKinds(): RegisteredKind[] {
    return kindRegistry.list(this.deps.config.readConfig().allowKinds);
  }

  /** 确认 / 撤销一个动态种类。确认态落在设置的 `allowKinds` 里（跨重启保留）而不是注册表（它随进程生灭）；写的是
   * **整份名单**而不是增量——设置写面按「这一份是当前想要的」理解，传增量会让两次并发写互相覆盖。不传期望修订号：
   * 这是一次点击，为它引入「基于旧内容」的失败只会让用户看到莫名其妙的冲突。
   * @throws 该种类未登记时抛错——设置端点会先查清单以给出 404，走到这里说明有人绕过它。 */
  async confirmKind(id: string, confirmed: boolean): Promise<WriteOutcome> {
    if (!kindRegistry.has(id)) {
      throw new Error(`dsh-notifier: 未登记的通知种类 —— ${id}`);
    }
    const allowed = this.deps.config.readConfig().allowKinds;
    const next = confirmed ? [...new Set([...allowed, id])] : allowed.filter((kind) => kind !== id);
    return this.deps.config.writeConfig({ allowKinds: next });
  }
}

/** 本域唯一的装配实例：类不外放，外面 `new` 不出第二份服务面。 */
export const sdkService = new SdkService();
