// dsh 插件家族共享层 —— 升级链骨架（单一事实源）。
//
// 为什么有这一层：mcp-manager / notifier / provider-usage 三个包各有自己的 upgrade 域
// （存储版本迁移），而链驱动是复制出来的——步骤筛选与排序、版本比较、失败文案、刻度原语、
// 装配器全部同构（实测 mcp-manager 与 provider-usage 两份逐字相同，reportGap 骨架三包同构、
// 只差包名前缀）。副本的代价是同一个缺陷要修 N 次、判据要写 N 遍，且三处随时会漂移成三种行为。
//
// 边界：这里只放**跨包骨架**（筛选、比较、刻度原语、链驱动、装配器）。各包差异——刻度落在
// 哪个文件、迁移动作做什么、logger 是哪个端口、读不到刻度时 fail-safe 还是 fail-closed——
// 一律经 ports 注入，本模块一概不碰：shared 只 await，不替消费方做业务决定。
//
// 为什么只有一个 async 执行器：链必须严格串行（后一步读的是前一步改完的存储，漏掉串行就是
// 让一步读着另一步的半成品），而串行只由「执行器 await 每一步」保证。**统一异步链不等于
// 强迫所有 step 异步**：step.run 与刻度读写保持 `void | Promise<void>` 宽形态，同步写的业务
// step 传进来同样正确——执行器里的 await 对同步返回值立即 resolve。
//
// 为什么每步成功后立刻回写刻度：刻度是「这一步做完了」的凭证，先写等于把凭证发给一件还没
// 做完的事，而失败时那个刻度会让下次启动跳过它。失败的那一步根本不走到回写（run 抛错即中止），
// 已完成的步也不必因为后面某步失败而整体作废重跑——历史形态「全链末一次回写」把粒度对齐到
// 整条链，等于要求每一步都幂等到能安全重跑。取舍：跨多步的一次性改写不适合这个骨架，那种
// 改写应收进单一步骤内部、由该步自己保证重入。
//
// 类型面与实现同源：类型声明就在本文件（对外的 .d.ts 由 tsc 产出，不再手写一份）。deps 的形状
// 各包不同（窄面宽度、路径面、日志端口都不一样），故一切吃 deps 的形状都带泛型 `D`：让消费方的
// 窄面类型原样穿过步骤与执行器，而不是在共享层先擦成 unknown 再让每个消费方各自断言一次。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 读不到包版本时的兜底。包清单读不出来不该阻断启动——升级链空转一轮而已。 */
const UNKNOWN_VERSION = "0.0.0";

/**
 * 向上搜索包根的层数上限。真实产物形态只差 1 层（内联进 `lib/index.js`），白盒单测的加载点
 * 更深；不设边界就等于允许一路走到文件系统根，去撞一个与本包无关的 `package.json`。
 */
const PACKAGE_ROOT_MAX_DEPTH = 8;

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
   * （同步写的业务 step 传进来同样正确，执行器 await 立即 resolve）；但也**不收成 `void`**——那等于
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
 * 刻度还停在这一步起点或更早的待办步，按**目标版本升序**（声明顺序只是便于阅读，不是执行
 * 顺序——漏排序会让后一步读到前一步尚未改进的形态）。返回新数组：入参是各包模块级的 STEPS
 * 常量，就地排序等于让下一次运行的起点依赖上一次运行的痕迹。
 */
export function selectPendingSteps<D>(
  steps: readonly UpgradeStep<D>[],
  recorded: string,
): UpgradeStep<D>[] {
  return [...steps]
    .sort((left, right) => compareVersions(left.targetVersion, right.targetVersion))
    .filter((step) => compareVersions(step.fromVersion, recorded) >= 0);
}

/** 步骤表里最高的目标版本；空表时给空串（空串是「没有步骤可谈」的哨兵，不参与版本比较）。 */
export function newestTargetVersion<D>(steps: readonly UpgradeStep<D>[]): string {
  let newest = "";
  for (const step of steps) {
    if (newest === "" || compareVersions(step.targetVersion, newest) > 0) {
      newest = step.targetVersion;
    }
  }
  return newest;
}

/**
 * 链跑完后的对账。三种落差分开报，因为它们要人去改的地方完全不同：落后 = 这一步的升级函数
 * 还没写（开发期漏项）；超前且步骤表本身也超前 = 步骤表与 package.json 没同步；超前而步骤表
 * 没超前 = 装的是更旧的包（降级）。一致时返回 `null`（无需告警）。
 *
 * 返回 `{ kind, message }` 而不是直接写 logger：判定与呈报是两件事，让调用方决定用什么口吻
 * 说（告警 / 报错 / 记指标），本模块才不必被绑死到某个 logger 端口上。三条判词里的包名由
 * `label` 注入——它逐字继承 mcp-manager 现有文案，故告警在多个包之间可直接比对。
 *
 * `label` 是第 4 参而不是从入参推导：三条判词都以包名开头，而步骤表里没有包名，调用方是唯一知道
 * 自己叫什么的地方。放在末位是为了让前三个参数与「步骤 / 刻度 / 目标」的自然读序保持一致。
 */
export function diagnoseGap<D>(
  steps: readonly UpgradeStep<D>[],
  recorded: string,
  target: string,
  label: string,
): GapDiagnosis | null {
  const gap = compareVersions(recorded, target);
  if (gap === 0) return null;

  if (gap < 0) {
    return {
      kind: "behind",
      message: `${label}: 存储版本 ${recorded} 落后于插件版本 ${target}，缺少对应的升级步骤`,
    };
  }

  const newest = newestTargetVersion(steps);
  if (newest !== "" && compareVersions(newest, target) > 0) {
    return {
      kind: "ahead-of-steps",
      message: `${label}: 升级链的目标版本 ${newest} 高于插件版本 ${target}（存储已升到 ${recorded}）——步骤表与 package.json 不同步`,
    };
  }
  return {
    kind: "downgrade",
    message: `${label}: 存储版本 ${recorded} 高于插件版本 ${target}，本插件的升级链不回退`,
  };
}

/**
 * 版本号比较：逐段数值比较。段数不同按缺位补零（`0.3` 等价 `0.3.0`）；预发布后缀（`-rc.1`）
 * 不参与比较——本仓的版本序列只用到 `主.次.修订`，为一个不会出现的输入引一套 semver 语义，
 * 换来的是又一处需要跟着上游走的依赖。段非纯数字归零（不抛，见 `parseVersion`）。归一化到
 * -1 / 0 / 1：调用方只比符号，不需要知道「差多少」——按差值判断的代码在跨段比较时会漏掉一半情况。
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function parseVersion(text: string): number[] {
  // 预发布后缀显式剥离；段非纯数字仍归零——未知输入按 0.0.0 起算跑整条链（各步幂等自查），
  // 不抛：启动期读盘数据不可信，抛即崩，归零方向恒为 fail-safe。
  const core = text.split("-")[0] ?? "";
  return core.split(".").map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : 0));
}

/**
 * 从 `fromDir` 向上找最近的含 `package.json` 的目录；走到层数上限（8 层）仍没有则 `undefined`。
 */
export function packageRootFrom(fromDir: string): string | undefined {
  let current = fromDir;
  for (let depth = 0; depth < PACKAGE_ROOT_MAX_DEPTH; depth += 1) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * 本插件当前版本：读包根的 `package.json`。**不写成常量**——常量与发布版本之间没有任何机制
 * 保证同步，而漂移的那一次会让升级链永远停在旧刻度上（「版本没变」与「升级没做完」外部表现
 * 一模一样）。取不到即回落 `0.0.0`，不抛。
 *
 * 包根按**最近的一个 `package.json`** 解析而不是固定 `..`：产物形态经 bundle-host 全部内联进
 * `lib/index.js`（上一级即包根），而白盒单测直接加载 src 深处（深好几级）；写死层数只有一种
 * 形态成立，另一种会让版本静默回落到兜底值——不抛，只是永远对不上，最难查的一类故障。
 *
 * **`fromDir` 由调用方传入，不读 `import.meta.url`**（与包内原实现唯一的形态差异）：本模块经
 * esbuild 内联进各包产物后，运行时 `import.meta.url` 指向的是**包产物目录**，而白盒单测加载的
 * 是 shared 源文件或包内 src 深处——两者深度不同，且随构建形态变化。自己定位自己，在这两种
 * 形态里必有一种定位错地方；把起点交给调用方传，深度差异就不再是本模块的隐式知识。
 */
export function pluginVersion(fromDir: string): string {
  const root = packageRootFrom(fromDir);
  if (root === undefined) return UNKNOWN_VERSION;
  try {
    // `JSON.parse` 的返回类型是 any，故立刻收进 unknown 再用守卫取字段：包清单是读盘数据，
    // 不可信的部分（顶层不是对象、没有 version 字段、version 不是字符串）一律回落兜底值。
    const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
      return UNKNOWN_VERSION;
    }
    const version: unknown = parsed.version;
    return typeof version === "string" ? version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/**
 * 跑完一条升级链：读刻度 → 取待办步 → 逐步执行并回写刻度 → 与插件版本对账。
 * **任何一步失败即抛出，调用方随之中止**（`cause` 透传；存储没升完就被按错误形态解释，比不启动糟得多）。
 * 返回 `undefined`：链跑完没有产物可言，刻度才是产物。
 *
 * 对账只告警、不改变动作：三种落差都不是迁移动作失败，而静默地把刻度改成看起来对的值更糟。
 */
export async function runUpgradeChain<D>(ports: UpgradePorts<D>): Promise<void> {
  const recorded = await ports.readScale();
  for (const step of selectPendingSteps(ports.steps, recorded)) {
    await applyStep(step, ports);
  }
  const gap = diagnoseGap(ports.steps, await ports.readScale(), ports.targetVersion, ports.label);
  if (gap !== null) ports.logger.warn(gap.message);
}

/**
 * 执行一步：`run` 成功后回写刻度。回写在 `run` **之后**而不是之前——刻度是「这一步做完了」的凭证，
 * 先写等于把凭证发给一件还没做完的事，而失败时那个刻度会让下次启动跳过它。失败与回写失败都带上
 * 目标版本，是为了让「哪一步」出现在启动失败的现场。
 */
async function applyStep<D>(step: UpgradeStep<D>, ports: UpgradePorts<D>): Promise<void> {
  try {
    await step.run(ports.deps);
  } catch (cause) {
    throw new Error(`${ports.label}: 存储升级到 ${step.targetVersion} 失败 — ${reasonOf(cause)}`, {
      cause,
    });
  }
  try {
    await ports.writeScale(step.targetVersion);
  } catch (cause) {
    throw new Error(
      `${ports.label}: 存储版本号回写失败（${step.targetVersion}）— ${reasonOf(cause)}`,
      { cause },
    );
  }
}

/** 失败现场要的是消息，不是异常对象本身；非 Error 抛出物（字符串、undefined）也要落到文案里。 */
function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 升级域装配器：`install` 在各域装配**之前**跑完升级链（升级会重写存储，先装配就等于让各域先
 * 读到旧形态，再让它们带着旧形态继续跑）。类不外放，闭包持有装配标记——外面 `new`
 * 不出第二份升级流程，也就没有「两域各跑一遍链」这种形态。
 *
 * 标记在**链跑完之后**才置：链抛错时这次装配等于没发生，宿主重试装配才有机会重跑链（链是幂等的，
 * 重跑不会累积归档名、也不会拿旧文件盖回目标）。反过来先置标记，链失败后重试就会被自己挡在门外。
 *
 * **为什么还要一个在途标记**：单靠「跑完才置」的门拦不住**并发**。链是异步的（逐步 await），
 * 第一次 `install` 在 `await` 处让出时 `installed` 仍是 false，宿主此刻再调一次 `install` 就会
 * 一起进链——两条链并发读写同一批存储文件，而升级链的每一步都建立在前一步改完的形态上。
 * 实测过：只有这一个门时两次并发 `install` 都跑完（链跑了两遍）。链本身幂等、不至于写坏数据，
 * 但「同一批文件被搬两次、刻度被两条链交错回写」是真实症状，与本文件头「漏掉串行就是让一步读着
 * 另一步的半成品」是同一类风险。在途标记让门对并发也成立：第二个调用当场抛，而不是安静地并跑。
 *
 * 这也意味着**消费方组合根里的 `releaseUpgrade()` 不能当并发保护用**——它只复位 `installed`，
 * 对在途中的那一次毫无作用。
 *
 * 三重守卫，缺一不可：**重复装配**——`install` 跑成功后再标记，重复 `install` 抛「只能装配一次」
 * （链抛错时这次装配等于没发生，宿主重试才有机会重跑链）；**并发装配**——另有在途标记，让第二次
 * `install` 当场抛「正在装配中」而不是安静地与第一次并跑；**失败不卡死**——在途标记随链结束
 * （含抛错）在 finally 里清零，失败不把 runner 永久锁住。
 */
export function createUpgradeRunner<D>(
  label: string,
  run: (deps: D) => void | Promise<void>,
): UpgradeRunner<D> {
  let installed = false;
  let installing = false;
  return {
    async install(deps) {
      if (installed) throw new Error(`${label}: upgrade 域只能装配一次`);
      if (installing) throw new Error(`${label}: upgrade 域正在装配中，不能并发装配`);
      installing = true;
      try {
        await run(deps);
        installed = true;
      } finally {
        installing = false;
      }
    },
    /** 卸载：本域没有需要释放的东西——它只写了文件；复位标记是为了让重装走完整的链。 */
    release() {
      installed = false;
    },
  };
}
