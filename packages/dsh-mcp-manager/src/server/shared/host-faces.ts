/**
 * 宿主能力面的类型定义处（I1 白名单点名的第二处）。
 *
 * 域拿不到 cordis `Context`，只能声明「我要什么能力」；能力的**形状**因此只在这里定义一次——
 * 宿主升级换形时改这一处，域 `deps.ts` 与组合根递进去的对象两侧同时跟随。`Context` 在本包只出现
 * 两处：这里（把它收窄成能力面）与包入口（组合根）。
 *
 * 收哪几条按附录 E.2 的宿主能力实测落定，不收的也有理由：
 * - `settings` 是**晚到服务**（`ctx.inject(["settings"], …)` 的回调里才取得到），`bindHost` 那一刻
 *   拿不到，它的能力面只能由接线点自己声明；
 * - `sessions` 在 E.2 的实测表里零命中，不预置一条没人用过、形状也没验过的门面。
 */
import type { Context, Events } from "@deepseek-ai/cordis";
// 宿主服务面靠声明合并挂到 `Context` 上：少了这几行，下面的 `Context["tools"]` 等取不到成员。
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type { ToolDefinition, ToolRuntime } from "@deepseek-ai/dsh-tools";

/**
 * 模型面内容块：官方词表的所有者是 dsh-llm，本包不引它，形状自 `ToolDefinition` 的
 * `finalizeContent` 接缝派生（返回 `ContentBlock[] | undefined`）。
 *
 * 为什么派生而不是直引 `@deepseek-ai/dsh-llm`：本包只为一处类型新增一个 npm 依赖（还要进
 * catalog、随宿主升版）不划算；若维护者日后要求直引，换法只是把这条别名换成
 * `import type { ContentBlock } from "@deepseek-ai/dsh-llm"`。
 */
export type ModelContentBlock = NonNullable<
  ReturnType<NonNullable<ToolDefinition["finalizeContent"]>>
>[number];

/** 附件引用：模型面图片块携带的那个类型（本包同样不引 `dsh-attachment`，自块形状派生）。 */
export type ModelAttachmentRef = Extract<ModelContentBlock, { type: "image" }>["attachment"];

/**
 * 一次图片落库的入参：与官方 `SaveImageAttachment` 逐字段一致，`mediaType` 收窄成四值
 * 字面量联合（宿主白名单）。自持声明而不是引官方包，理由同上一条。
 */
export interface SaveImageInput {
  readonly data: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  readonly name?: string;
}

/**
 * 附件库（`ctx.get("attachments")`）的最小面。**晚读**：服务可能缺席（宿主未挂
 * `dsh-attachment-local`），且 apply 期的早读恒得 undefined——故只能经 thunk 在调用时刻现取。
 */
export interface AttachmentsPort {
  saveImages(inputs: readonly SaveImageInput[]): Promise<readonly ModelAttachmentRef[]>;
}

/**
 * 模型目录（`ctx.get("llm")`）的最小面：只问该路由声明了哪些输入模态。**晚读**，理由同上。
 */
export interface ModelInfoPort {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ inputModalities?: readonly string[] }>;
}

/**
 * 一个活 agent 的模型可见面句柄：`restrict` 是宿主给的**作用域**原语（全局调用会被拒），
 * 故本包必须经 agent 自己的作用域上下文调用它——见 visibility 域。
 */
export interface AgentFace {
  readonly id: string;
  readonly tools: Pick<ToolRuntime, "restrict">;
}

/** 宿主日志出口的收窄面：本包只在诊断处出声，且不因为出声改变动作。 */
export interface LoggerPort {
  warn(message: string): void;
}

/** 宿主路由注册口（`ctx.webServer`）：只取注册一样，摘除器由宿主自己返回。 */
export type RegisterPort = Pick<Context["webServer"], "register">;

/**
 * 宿主工具注册表（`ctx.tools`）：只取注册与**注册面查询**两样。
 *
 * `schemas` 是六态投影里唯一能观测「已连上」的输入面（设计 §3.1 输入面 B）：官方
 * dsh-mcp-client 不暴露任何状态 API，工具注册面是它留给外界的唯一正向证据。两样都是活能力
 * （每次调用现读宿主注册表），不是装配期快照——注册表会随服务器连接与断开变化。
 */
export type ToolsPort = Pick<Context["tools"], "register" | "schemas">;

/** 宿主提示词组装口（`ctx.systemPrompt`）：只取分节一样。 */
export type PromptPort = Pick<Context["systemPrompt"], "section">;

/** 宿主出口（`ctx.provide`）：服务的**名字**归提供方所有，这里只负责把服务挂上上下文。 */
export interface ExposePort {
  provide(name: string, service: unknown): () => void;
}

/**
 * 宿主事件面：只放本插件真的订阅的那一条。
 *
 * `agent/pre-step` 是 **waterfall**：处理完必须把判定交还给续行，漏掉就等于替所有人短路了这一步
 * ——所以端口把续行原样递给订阅方，让它在看得见事件的地方决定怎么续（本插件要在这一步注入能力目录）。
 */
export interface EventsPort {
  onPreStep(
    handler: (
      payload: Parameters<Events["agent/pre-step"]>[0],
      next: Parameters<Events["agent/pre-step"]>[1],
    ) => ReturnType<Events["agent/pre-step"]>,
  ): () => void;
  /**
   * 一个新 agent 完成装配（模型视野还完整）——隐藏面必须在这里补上限制。
   *
   * 为什么单列一条而不是复用 `agent/pre-step`：限制只在 agent 的**调用时刻**才被读到
   * （宿主 restriction 是快照语义），而 pre-step 在装配之后、每轮都会跑，挂在那里会把
   * 「装配面」和「每轮」混成一条路径；`agent/created` 是宿主为这件事提供的正解时点。
   */
  onAgentCreated(handler: (agent: AgentFace) => void): () => void;
  /** 一个 agent 离开注册表：它那条限制随作用域一起失效，但要显式摘除并清记忆。 */
  onAgentDisposed(handler: (agent: { id: string }) => void): () => void;
  /**
   * 注册面或限制面变化（宿主原话：无载荷、故意不做作用域过滤，每个监听者都看得到别人的变更）。
   * restriction 是**调用时刻的快照**，后注册的 `mcp__*` 不在旧快照里——重同步只能靠这条。
   */
  onToolsChange(handler: () => void): () => void;
  /** 当前全部活 agent（装载时做一次全量 reconcile；服务缺席给空表）。 */
  liveAgents(): readonly AgentFace[];
}

/**
 * 一条宿主日志记录的收窄面：只声明本包真的会读的四个字段。
 *
 * 为什么不直接引 cordis 的 `Message`：本包对宿主类型一律"自持声明形状、只认运行时真要用到
 * 的部分"（与 `ResolvedLoader` 同思路），宿主加字段不会波及域代码；而少声明一个已用字段会
 * 在消费点编译期暴露，不会静默读到 undefined。
 */
export interface LogRecord {
  /** 记录名：官方 MCP 客户端固定为 `mcp-client`（见共享层常量）。 */
  readonly name: string;
  /** 记录类型（error / warn / info / debug）。 */
  readonly type: string;
  /** 数值级别；排序与过滤用。 */
  readonly level: number;
  /** 格式化参数：官方把可读文案放在字符串参数里。 */
  readonly args: readonly unknown[];
}

/**
 * 宿主日志面：把「日志导出器」这一条能力递进域里。
 *
 * 为什么需要它（换引擎后才有）：官方 dsh-mcp-client 不暴露任何状态 API，成功连接零日志，
 * 失败与放弃重连才说话——这些原话是本插件唯一能拿到的错因，而宿主默认既不打印也不落盘
 * （实测：dsh.log 只有一行 URL，shipped web-app 无日志消费者）。没有这条面，首连失败对
 * 用户就是静默的。
 *
 * 为什么用 `capture(handler)` 而不是 `tail()`：导出器是**活**订阅（挂上即开始收），域自己
 * 决定何时摘除；宿主 ring buffer 的读取面不在本包里（那是宿主的实现细节，不是契约）。
 */
export interface LogsPort {
  /**
   * 挂一个日志导出器。返回摘除器：日志面是诊断功能，**摘除器必须总能拿到**——官方实例已经
   * 拆了却还占着导出器，是比"少一条日志"严重得多的问题。
   */
  capture(handler: (record: LogRecord) => void): () => void;
}

/**
 * 官方插件的模块面：官方 MCP 客户端的**命名空间**形态（`name` / `inject` / `apply` /
 * `Config`，无 `default`）。成员全可选是因为这里只描述「我方见到的那份包长什么样」，
 * 不重复官方自己的必填约束——自持声明的价值在于形状只有这一处，不作为校验面。
 */
export interface OfficialPluginModule {
  readonly name?: string;
  readonly inject?: readonly string[];
  readonly apply?: (ctx: unknown, config: unknown) => unknown;
  readonly Config?: unknown;
}

/**
 * 一次装载的句柄：**我方账本**的条目，不是 loader 的 entry。
 *
 * 刻意不含配置内容，也不含账本键：键由调用方（lifecycle 域）自己按 `(scope, name)` 持有，
 * 端口因此对 `unknown` 的配置保持无感知——否则端口就得反过来窥探配置长什么样。
 */
export interface MountedPlugin {
  /**
   * 首次连接尝试结束（成功或失败都 settle）。**不等于 connected**：官方在
   * `failOnStartupError: false` 下即使首连失败也让 `apply` 正常 resolve。
   */
  readonly ready: Promise<void>;
  /** 是否已 dispose：晚到的 ready 结算据此判断还能不能改状态（对齐现有代际守卫语义）。 */
  readonly disposed: boolean;
  /** 释放：官方 `apply` 里注册的 effect 会断开连接、注销工具、释放 serverName 预留。 */
  dispose(): Promise<void>;
}

/**
 * 官方引擎的装载口。
 *
 * 只收两样：按包名解析模块、把模块挂成我方拥有的实例。不收 loader 的 create / update /
 * remove——那三者末端都会写 loader 配置树（`EntryTree.create` 末行 `tree.write()`），把运行期
 * 的 `command` / `args` / `env` 暴露进用户 profile。
 */
export interface LoaderPort {
  /** 按包名解析官方插件模块：裸包名只有 loader 能解析（锚 `ctx.baseUrl`），是本包唯一合规入口。 */
  load(specifier: string): Promise<OfficialPluginModule>;
  /** 以本插件为父挂载一个官方插件实例，返回自持账本句柄。 */
  mount(module: OfficialPluginModule, config: unknown): MountedPlugin;
}

/**
 * 组合根允许触碰的宿主上下文面：把 `Context` 收窄成九条能力的 `Pick`，`bindHost` 的入参到此为止，
 * 域拿不到更宽的上下文。
 *
 * `loader` 服务本身**不在这里**：它的类型面由不在 catalog 的官方 loader 包经声明合并提供，本包
 * 取不到，`Pick<Context, "loader">` 会直接判 tsc 红；取它走 `get`（见 `compose.ts` 的 `load`）。
 */
export type HostContextPort = Pick<
  Context,
  "logger" | "webServer" | "tools" | "on" | "systemPrompt" | "provide" | "effect" | "plugin" | "get"
>;

/** 组合根收窄后递给各域的宿主能力面：域再从中 `Pick` 自己那一份。 */
export interface HostFaces {
  readonly logger: LoggerPort;
  readonly logs: LogsPort;
  readonly register: RegisterPort;
  readonly tools: ToolsPort;
  readonly prompt: PromptPort;
  readonly expose: ExposePort;
  readonly events: EventsPort;
  readonly loader: LoaderPort;
  /** 附件库：**晚读** thunk，调用时刻才向宿主现取（服务缺席/apply 期早读都取不到）。 */
  readonly attachments: () => AttachmentsPort | undefined;
  /** 模型目录：**晚读** thunk，同上。 */
  readonly models: () => ModelInfoPort | undefined;
}
