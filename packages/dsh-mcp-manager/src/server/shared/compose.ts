/**
 * 组合根机制：把宿主上下文收窄成能力面、按依赖顺序成对装配各域、逆序释放。
 *
 * 为什么不在 `src/index.ts`：包入口的**任何新导出**都会让 `export-surface-snapshot` 判红
 * （B1.4 的硬判据是入口导出面零 diff），而写在入口又不导出的函数测试不可达——夹具域驱动的探针
 * 必须 import 得到它。入口仍然是组合根：B2 由它调用这里的三个函数
 * （`bindHost(ctx)` → `assemble(host, domains)` → `ctx.effect(() => () => safeDisposeAll(disposers))`）。
 */
import type { HostContextPort, HostFaces } from "./host-faces.ts";

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
    register: { register: (route) => ctx.webServer.register(route) },
    tools: { register: (definition) => ctx.tools.register(definition) },
    prompt: { section: (section) => ctx.systemPrompt.section(section) },
    expose: { provide: (name, service) => ctx.provide(name, service) },
    events: { onPreStep: (handler) => ctx.on("agent/pre-step", handler) },
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
