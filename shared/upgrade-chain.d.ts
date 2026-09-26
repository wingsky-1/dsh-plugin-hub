// dsh 插件家族共享层 —— 升级链骨架类型面。
//
// 实现是 .js（构建期 esbuild 内联进各包），类型只活在这份 d.ts。deps 的形状各包不同（窄面宽度、
// 路径面、日志端口都不一样），故一切吃 deps 的形状都带泛型 `D`：让消费方的窄面类型原样穿过步骤
// 与执行器，而不是在共享层先擦成 unknown 再让每个消费方各自断言一次。

/**
 * 一步升级：把存储从 `fromVersion` 的形态推进到 `targetVersion`。两端都写出来而不是只写目标——
 * 「这一步管的是哪一段」要靠与前后步骤比对才能推出来。
 *
 * 步骤是**刻度**而不是迁移动作的别名：没有数据要改的版本也给一步（`run` 空实现），否则存储刻度
 * 永远停在旧值上。
 */
export interface UpgradeStep<D> {
  /** 起点版本：这一步处理的存储形态对应的版本（升级**前**的那个版本）。 */
  readonly fromVersion: string;
  /** 目标版本：这一步完成后**回写**进刻度的值。由链驱动统一回写而不是步骤自己写——「数据改了一半、
   * 刻度已经前进」的存储没有任何办法退回。 */
  readonly targetVersion: string;
  /**
   * 迁移动作；入参是本域的外部依赖。失败即抛，链随之中止。
   *
   * 收窄为 `void | Promise<void>` 而不是 `Promise<void>`：统一异步链不等于强迫所有 step 异步
   *（同步写的业务 step 传进来同样正确，执行器 await 立即 resolve）；但也**不收成 `void`**——那等于
   * 要求消费方把真异步的迁移动作写成一个浮起的 Promise，串行性当场失效。
   */
  run(deps: D): void | Promise<void>;
}

/** 链跑完后的对账结论。`message` 已含调用方传入的包名前缀，可直接交给 logger。 */
export interface GapDiagnosis {
  /**
   * 落差分类，只有三种可能：`behind` = 存储落后于插件版本（漏写升级步骤）；`ahead-of-steps` =
   * 存储超前且步骤表本身也超前（步骤表与 package.json 不同步）；`downgrade` = 存储超前而步骤表
   * 没超前（装的是更旧的包）。
   *
   * 「存储超前于插件目标」是 gap>0 的**总类**，不作为取值：判词要告诉人去改哪里，总类名什么也没说，
   * 故按成因落成后两项。联合里不预留不产生的成员——那等于让消费方写出永远走不到、也没法测的分支。
   */
  readonly kind: "behind" | "ahead-of-steps" | "downgrade";
  readonly message: string;
}

/** 链驱动要的一切端口。刻度落在哪个文件、fail-safe 还是 fail-closed、logger 是哪个端口，都由消费方决定。 */
export interface UpgradePorts<D> {
  /** 包名：错误与告警文案的前缀。 */
  readonly label: string;
  /** 步骤表；升序还是降序声明都行，执行顺序由本模块按目标版本排序决定。 */
  readonly steps: readonly UpgradeStep<D>[];
  /** 原样透传给每一步 `run` 的依赖面。 */
  readonly deps: D;
  /** 读存储刻度。读不到时给什么（0.0.0 起算还是抛）由消费方决定——两种取舍都成立，本模块不判断。 */
  readScale(): string | Promise<string>;
  /** 写存储刻度；一步 `run` 成功后立刻调用。抛错即中止这一次升级。 */
  writeScale(version: string): void | Promise<void>;
  /** 插件版本（对账的目标）。 */
  readonly targetVersion: string;
  /** 只要求 `warn`：对账落差走告警面、不影响启动成败，故本模块不要求消费方给出更宽的日志端口。 */
  readonly logger: { warn(message: string): void };
}

/** 升级域装配器：安装期跑链，卸载时复位。 */
export interface UpgradeRunner<D> {
  /** 装配：先跑链，成功后才标记已装配。 */
  install(deps: D): Promise<void>;
  /** 复位标记（卸载 / 让重装能再走一遍完整的链）。 */
  release(): void;
}

/**
 * 版本号比较：逐段数值比较，缺位补零，预发布后缀不参与比较，段非纯数字归零（不抛）。
 * 归一化到 -1 / 0 / 1，调用方只比符号。
 */
export function compareVersions(left: string, right: string): number;

/** 刻度还停在这一步起点或更早的待办步，按**目标版本升序**。返回新数组，不就地排序入参。 */
export function selectPendingSteps<D>(
  steps: readonly UpgradeStep<D>[],
  recorded: string,
): UpgradeStep<D>[];

/** 步骤表里最高的目标版本；空表返回空串。 */
export function newestTargetVersion<D>(steps: readonly UpgradeStep<D>[]): string;

/**
 * 链跑完后的对账：返回 `{ kind, message }`，一致时返回 `null`。
 *
 * `label` 是第 4 参而不是从入参推导：三条判词都以包名开头，而步骤表里没有包名，调用方是唯一知道
 * 自己叫什么的地方。放在末位是为了让前三个参数与「步骤 / 刻度 / 目标」的自然读序保持一致。
 */
export function diagnoseGap<D>(
  steps: readonly UpgradeStep<D>[],
  recorded: string,
  target: string,
  label: string,
): GapDiagnosis | null;

/** 从 `fromDir` 向上找最近的含 `package.json` 的目录（上限 8 层）；走到根返回 `undefined`。 */
export function packageRootFrom(fromDir: string): string | undefined;

/**
 * 从 `fromDir` 向上定位包根读 `package.json` 的 `version`；取不到回落 `"0.0.0"`，不抛。
 *
 * 收 `fromDir` 而不读 `import.meta.url`：本模块会被内联进各包产物，运行时目录与源目录深度不同，
 * 「自己定位自己」在两种加载形态里必有一种错，且是静默回落成 0.0.0 的那种错。
 */
export function pluginVersion(fromDir: string): string;

/**
 * 跑完一条升级链：读刻度 → 取待办步 → 逐步 `await` 执行并逐步回写刻度 → 与插件版本对账（只告警）。
 * 任何一步失败即抛（`cause` 透传）；返回 `undefined`。
 */
export function runUpgradeChain<D>(ports: UpgradePorts<D>): Promise<void>;

/**
 * 升级域装配器：返回 `{ install, release }`。三重守卫，缺一不可：
 * 1. **重复装配**：`install` 跑成功后再标记，重复 `install` 抛「只能装配一次」（链抛错时这次装配
 *    等于没发生，宿主重试才有机会重跑链）；
 * 2. **并发装配**：另有在途标记，让第二次 `install` 当场抛「正在装配中」而不是安静地与第一次并跑
 *    ——链是异步的，只靠第 1 条拦不住（第一次在 `await` 处让出时标记还没置）。
 * 3. **失败不卡死**：在途标记随链结束（含抛错）在 finally 里清零，失败不把 runner 永久锁住。
 */
export function createUpgradeRunner<D>(
  label: string,
  run: (deps: D) => void | Promise<void>,
): UpgradeRunner<D>;
