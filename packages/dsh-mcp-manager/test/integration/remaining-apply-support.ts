/**
 * dsh-mcp-manager — integration：apply 装配面共享夹具（#1174 shape 拆分产物）。
 *
 * 只承载**跨文件逐字重复**的夹具：apply 通用 fakeCtx 底座与临时目录账本。两者原在
 * apply-lifecycle.test.ts 内定义、被其 14 个 describe 逐字复用；按 shape 拆成多个自然职责
 * 文件后，重复即违反 testing skill §3「同一夹具在两个文件里逐字重复就该合并」。
 *
 * 归属说明：本模块是 support（mutation-topology 的 supportFiles 语义），**不入任何测试层、
 * 不计 --min、不进变异面**；仅被 integration 层测试静态导入。hook 不在此注册——各测试文件
 * 自行 afterEach 调 releaseTempDirs()，避免「模块顶层注册 hook」的隐式生命周期。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 临时目录账本：与原子文件 apply-lifecycle.test.ts 的 tempDirs 同形态（同 mkdtemp 隔离、同 afterEach 回收）。 */
const tempDirs: string[] = [];

export function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** afterEach 回收面：逐字保留原实现的 rmSync 实参与清空顺序。 */
export function releaseTempDirs() {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
}

/** apply 通用 fakeCtx 底座（各分支按需覆盖）。逐字保留原实现，含 exporter 日志面。 */
export function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    logger: {
      warn: () => {},
      info: () => {},
      error: () => {},
      // 装载窗口经 bindHost 的日志面挂导出器收官方错因；缺这一面，装载链会撞在「夹具没造全」上
      // 而不是被测行为上。
      exporter: () => () => {},
    },
    tools: { register: () => () => {} },
    webServer: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    inject: () => () => {},
    on: () => () => {},
    effect: (fn: () => () => void) => {
      const disposer = fn();
      return () => {
        disposer();
      };
    },
    // Cordis 4.1 的公开服务隔离口。结构夹具只记录挂载调用，不执行 wrapper apply，
    // 因而复用自身作为子 Context 即可保持既有 apply 接线测试的观测面。
    isolate() {
      return this;
    },
    ...overrides,
  };
}

interface FakePluginModule {
  readonly name?: string;
  apply?(ctx: unknown, config: unknown): unknown;
}

export interface FakePluginFiber {
  await(): Promise<FakePluginFiber>;
  dispose(): Promise<void>;
}

/**
 * 结构宿主上的 plugin 桥：复刻生产接线需要的两层 ownership。
 *
 * 无 config 的调用是 attachments wrapper；有 `serverName` 的 config 是 wrapper 内的官方 child。
 * 只模拟 fiber readiness/dispose，不重写 facade 或 cap 判定——那些由真 Cordis 测试守。
 */
export function fakePluginBridge(
  ctx: Record<string, unknown>,
  onOfficial: (module: FakePluginModule, config: { serverName: string }) => void,
) {
  const bridge = (module: FakePluginModule, config?: unknown): FakePluginFiber => {
    let loading: unknown;
    if (
      typeof config === "object" &&
      config !== null &&
      "serverName" in config &&
      typeof config.serverName === "string"
    ) {
      onOfficial(module, config as { serverName: string });
      loading = module.apply?.(ctx, config);
    } else {
      loading = module.apply?.({ ...ctx, plugin: bridge, provide: () => () => {} }, config);
    }
    const fiber: FakePluginFiber = {
      async await() {
        await loading;
        return fiber;
      },
      async dispose() {},
    };
    return fiber;
  };
  return bridge;
}
