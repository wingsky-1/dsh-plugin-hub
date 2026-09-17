/**
 * 组合根机制：把宿主上下文收窄成能力面、按依赖顺序成对装配各域、逆序释放。
 *
 * 为什么不在 `src/index.ts`：包入口的**任何新导出**都会让 `export-surface-snapshot` 判红
 * （B1.4 的硬判据是入口导出面零 diff），而写在入口又不导出的函数测试不可达——夹具域驱动的探针
 * 必须 import 得到它。入口仍然是组合根：B2 由它调用这里的三个函数
 * （`bindHost(ctx)` → `assemble(host, domains)` → `ctx.effect(() => () => safeDisposeAll(disposers))`）。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  AttachmentsPort,
  HostContextPort,
  HostFaces,
  ModelInfoPort,
  MountedPlugin,
  OfficialPluginModule,
} from "./host-faces.ts";

/**
 * 宿主 loader 服务的收窄面：本包不引官方 loader 的类型（`@deepseek-ai/cordis-plugin-loader` 不在
 * catalog、仓库内不可解析），只认运行时真要用到的那一个方法。
 */
interface ResolvedLoader {
  /** 按包名解析模块；官方实现可能同步返回，故一律按 `await` 消费。 */
  import(specifier: string): unknown;
}

/**
 * `ctx.plugin` 的编译期插件面。
 *
 * 为什么必须就地收窄转型：`ctx.plugin<P extends Plugin>` 的配置形参由 `GetPluginConfig<P>` 从
 * 插件体签名反推，而 `OfficialPluginModule` 的成员全可选——推不出 `Plugin.Object` 那一支，配置位
 * 退化成 `never`，结构类型因此直接过不去。运行时官方插件的契约只有「带 `apply` 的对象」一条，
 * 所以这里只替换编译期推导，不放宽任何运行时校验。
 */
interface MountableOfficialPlugin {
  apply(ctx: unknown, config: unknown): unknown;
}

/**
 * 一个域给组合根的装配对。
 *
 * `install` / `release` **成对**：`install` 收本域需要的外部能力，`release` 复位本域**自己的**
 * 装配标记并放开入参。没有配对的下半截，域就只能在下次装配时静默复用上一次的状态。
 */
export interface DomainSpec<Host = HostFaces> {
  /** 域标识：只用于装配错误文案，域内断言不依赖它。 */
  readonly name: string;
  /** 装配。入参是组合根收窄后的宿主能力面——域拿不到 `Context`。 */
  install(host: Host): void | Promise<void>;
  /** 释放：与 `install` 配对，复位本域标记；重复调用无害。 */
  release(): void;
}

/**
 * 把宿主上下文收窄成能力面。
 *
 * 交付的是**能力**而不是装配期算好的值：算一次的快照看起来与实时读取一模一样，却在用户改了设置
 * 之后继续用旧值（E.2 实测：`webServer.register` 的摘除器、`ctx.tools` 的注册表都是活对象）。
 */
export function bindHost(ctx: HostContextPort): HostFaces {
  return {
    logger: ctx.logger,
    logs: {
      capture: (handler) => {
        // 摘除器类型是 Disposable<Promise<void>>（宿主按 fiber 回收）；本包只承诺同步摘除语义，
        // 异步那一半由宿主自己的 effect 负责——把 Promise 递到域里只会让域多一个不该管的等待点。
        //
        // 必须显式给 levels：宿主的投递闸是
        // `(exporter.levels?.[name] ?? exporter.levels?.default ?? 发出方 level ?? 1) < level` 即丢，
        // 不写就落到发出方缺省 INFO(1)，而官方客户端的重连提示是 warn(2)——整条诊断面会只剩
        // error 级、把「正在退避重试」这类最需要让用户看到的话全丢掉。取 2（error/info/warn）：
        // debug(3) 是官方内部噪音，不属于诊断口径。
        const dispose = ctx.logger.exporter({
          levels: { default: 2 },
          export: (message) => handler(message),
        });
        return () => {
          void dispose();
        };
      },
    },
    register: { register: (route) => ctx.webServer.register(route) },
    tools: {
      register: (definition) => ctx.tools.register(definition),
      // 现读宿主注册表而不是装配期快照：六态投影靠它判「该 id 下已有注册工具」（设计 §3.1 输入面 B）。
      // scope 原样转交：省略 scope 是查询方的语义选择，绑定层不得替它把参数丢掉。
      schemas: (scope) => ctx.tools.schemas(scope),
    },
    prompt: { section: (section) => ctx.systemPrompt.section(section) },
    expose: { provide: (name, service) => ctx.provide(name, service) },
    events: {
      onPreStep: (handler) => ctx.on("agent/pre-step", handler),
      // agent 作用域边：restrict 只在**作用域**上下文上可用（全局调用被宿主当场拒），故这里把
      // agent 自己的 tools 面连同 id 一起交出去——域拿不到 Context，也就没有第二处作用域入口。
      onAgentCreated: (handler) =>
        ctx.on("agent/created", ({ agent }) => handler({ id: agent.id, tools: agent.ctx.tools })),
      onAgentDisposed: (handler) =>
        ctx.on("agent/disposed", ({ agent }) => handler({ id: agent.id })),
      onToolsChange: (handler) => ctx.on("tools/change", handler),
      // 装载时的全量 reconcile 用：同名服务缺席（假 ctx / 早期装配）时给空表，不抛。
      liveAgents: () => {
        // 假 ctx 常见：`get` 本身缺席（宿主服务查询面不可用）——给空表，不抛。
        if (typeof ctx.get !== "function") return [];
        const agents = ctx.get("agents") as { list(): readonly Agent[] } | undefined;
        return (agents?.list() ?? []).map((agent) => ({ id: agent.id, tools: agent.ctx.tools }));
      },
    },
    // 晚读 thunk（不是装配期快照）：attachments/llm 都是晚到服务，apply 期取恒 undefined。
    attachments: () => ctx.get("attachments") as AttachmentsPort | undefined,
    models: () => ctx.get("llm") as ModelInfoPort | undefined,
    loader: {
      load: async (specifier) => {
        // `loader` 不在 `Context` 类型面上，只能按名字现取；取不到就 fail closed——回落
        // `undefined` 会把「宿主没装配 loader」表现成「这个包名不存在」，把装配错误推迟到现场。
        const loader = ctx.get("loader") as ResolvedLoader | undefined;
        if (loader === undefined || loader === null) {
          throw new Error(
            "dsh-mcp-manager: 宿主未提供 loader 服务，无法按包名解析官方 MCP 客户端——" +
              "裸包名只有 loader 能解析（锚 ctx.baseUrl）",
          );
        }
        return (await loader.import(specifier)) as OfficialPluginModule;
      },
      mount: (module, config) => {
        const fiber = ctx.plugin(module as MountableOfficialPlugin, config);
        // dispose 只置位不回滚：晚到的 ready 结算据此判断还能不能改状态。
        const state = { disposed: false };
        const handle: MountedPlugin = {
          ready: fiber.await().then(() => undefined),
          get disposed() {
            return state.disposed;
          },
          async dispose() {
            state.disposed = true;
            await fiber.dispose();
          },
        };
        // 兜底回收链：宿主卸载本插件时跑。某个域漏了 release，官方实例也不会活到下一次装配——
        // 它持有的子进程与 serverName 预留都随此释放。
        ctx.effect(
          () => () => {
            void handle.dispose();
          },
          "dsh-mcp-manager: loader mount",
        );
        return handle;
      },
    },
  };
}

/**
 * 按依赖顺序装配各域，返回它们的释放函数（逆序交给 `safeDisposeAll`）。
 *
 * `install` 一律 `await`：`upgrade` 域的装配是异步的（落盘原语只有 Promise 面），不等待就等于
 * 让各域在存储迁移跑完之前去读旧布局——那时旧文件已被归档，读到的是空盘。
 *
 * 装配期不吞错：任一步抛错即中止，已装好的域保持已装状态——各域的 `install` 都保证「抛错等于没装」
 * （标记在最后一步才置位），宿主重试装配时从同一步重跑。
 */
export async function assemble<Host>(
  host: Host,
  domains: readonly DomainSpec<Host>[],
): Promise<Array<() => void>> {
  const seen = new Set<string>();
  const disposers: Array<() => void> = [];
  for (const domain of domains) {
    // 同一个域在一次装配里出现两次 = 装配表写错了，放过去就是两份能力挂在同一份状态上。
    if (seen.has(domain.name)) {
      throw new Error("dsh-mcp-manager: 装配表里 " + domain.name + " 域出现了两次");
    }
    seen.add(domain.name);
    await domain.install(host);
    disposers.push(() => {
      domain.release();
    });
  }
  return disposers;
}

/**
 * 逐个释放；单个释放失败不阻断其余（否则一个域的清理会拖垮整条卸载链）。
 *
 * **逆序**：后装的先释放，否则出口域会在别人已经放开的入参上继续服务。
 */
export function safeDisposeAll(disposers: readonly (() => void)[]): void {
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose();
    } catch {
      // 卸载阶段不做失败上报：首因已经发生，再抛一个只会把它盖掉。
    }
  }
}
