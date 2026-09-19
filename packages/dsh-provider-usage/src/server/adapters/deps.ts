/**
 * dsh-provider-usage — server/adapters 域依赖声明（#768 D4 注入面）。
 *
 * 本文件是纯类型面（import type 零运行时；转译后无可杀止变异体，
 * 变异面按 type-only 口径排除，见 mutation-topology.json）；
 * 窄面形状（运行时零出口 + 可装配性）由
 * test/integration/adapters/composition-root.test.ts 锁定。
 *
 * 窄面 = 可测接缝两项（宿主能力，无业务实例）：
 * - utils：三内置 .mjs 经 FetchContext.utils / PanelInput.utils 实际消费的
 *   工具键（8 键：miniAreaSvg/fin/dayKey/lastNDayKeys/escHtml/escAttr/
 *   niceDomain/trendOf——逐键有 .mjs 内 U.<key>/utils.<key> 消费实证，
 *   AdapterUtils 余下 4 键 timeTicks/resetTicks/downsample/smoothPath
 *   无消费即不收口）。宿主管线按调用注入（见 server/pipeline/v2.ts），
 *   无注入时 .mjs 回退文件内私有兜底副本；
 * - register：内置装配的注册窄面（注册表 register 的 Pick 收窄，
 *   fail-fast 只用到 builtin 一源；user-file 路径仍走 registry 门面直调）。
 *
 * 源码允许的纯面复用（非实例调用，不经本文件注入）：
 * - shared 的 UsageStatsAdapter 等契约类型经 shared/interface.ts 以 type
 *   复用（零运行时；register.ts 的 fail-fast 形参即此口径——静态声称契约、
 *   运行时逐个校验，声明层撒谎即抛）；
 * - .mjs 自包含零 import（构建期原样拷入 lib/server/adapters/，
 *   见包内 scripts/prepare-lib-entry.ts），不经本文件取任何能力。
 *
 * 故本域不设聚合 AdapterDeps：utils 随调用输入走（FetchContext/PanelInput
 * 字段，本域不另包一层），注册窄面随装配参数走——聚合体会成为
 * 无消费者的导出（最小导出纪律）。
 */
import type { AdapterUtils } from "../../shared/interface.ts";
import type { AdapterRegistry } from "../registry/interface.ts";

/** 适配器域的宿主工具窄面（管线按调用注入；8 键逐键有 .mjs 消费实证）。 */
export type AdapterHostUtils = Pick<
  AdapterUtils,
  | "miniAreaSvg"
  | "fin"
  | "dayKey"
  | "lastNDayKeys"
  | "escHtml"
  | "escAttr"
  | "niceDomain"
  | "trendOf"
>;

/** 适配器域的内置注册窄面（注册表 register 的 Pick 收窄；只走 builtin 一源）。 */
export type BuiltinRegistryPort = Pick<AdapterRegistry, "register">;
