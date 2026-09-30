/**
 * shared/client/ui — 跨包客户端 UI 原语层（T1 五原语 + 共享类型面，单文件）。
 *
 * 档位：§2.4 档 C（跨包共享，仓库根 shared/）。从 dsh-provider-usage 的端内面
 * （src/client/shared/ui/）上提而来，生产消费方 ≥2（provider-usage / notifier），
 * 由 scripts/gate/verify-shared-fanin.mjs 按生产 src 口径实时派生，不手抄快照。
 *
 * 职责：把「按钮 / 字段 / 分段器 / 状态点与徽标 / 容器」五种最常复用的呈现收成
 * 一处定义；各包只剩 variant 与内容不同。文案走各包 locales.ts，色值走各自
 * style.css，本层零文案零色值。
 *
 * 【为什么是单文件（本层最容易被下一个人「好心拆开」的形状约束）】
 * verify-shared-fanin.mjs 的枚举口径是 **shared/ 下每个 .js / .d.ts 文件**（本仓
 * shared 是 TS 化 + 原地 emit，故枚举到的是 tsc 产物），每个文件聚成一个「模块」并
 * 各自要扇入 ≥2 包。R2 实测：在 shared/client/ 下放两个 0 消费的探针 .ts，tsc emit
 * 之后门禁立刻报
 *     FAIL 值面 client/probe-alpha.js | 0 包（下限 2）：（无）
 *     FAIL 值面 client/probe-beta.js | 0 包（下限 2）：（无）
 * 即 **shared/ 下任何 0 消费的 .ts 都会因 emit 成 .js 而成为独立模块并判红**。
 * 拆成 button/field/segmented/… 六个文件时，两个包都只从门面 index 导入，五个实现
 * 文件各自 0 消费者 → 直接判红。**单文件是门禁枚举粒度逼出来的唯一可行形状，不是
 * 风格偏好**；代价是本文件偏长，故按原语分段并各段自带文件内注释。
 * 将来若要拆文件，前置条件是先解决「每个文件都得有 ≥2 个包直接 import」这条约束
 * （例如把门面也变成按原语分片的多个入口，且两个包都逐一 import 每个分片）。
 *
 * 【React 为什么要值 import（本仓对 shared/client/** 的禁令与 JSX 运行时的冲突）】
 * 仓库根 tsconfig.base.json 定的是 `"jsx": "react"`（经典运行时，JSX 编译成
 * `React.createElement`），esbuild 侧同样是经典默认，故 JSX 文件作用域内必须有
 * `React` 标识符。改 `jsx: "react-jsx"` 也不成立：产物构建走 esbuild 的默认经典
 * 运行时，源码却按自动运行时写 → 运行时 React is not defined。
 * 故本文件保留 `import * as React from "react"`。这与 §2.4「client 面禁 bare
 * 第三方包」的**立法意图不冲突**：该禁令针对的是会被静默内联进浏览器产物的普通第三方
 * 包（dompurify 之类），而 React 在本仓是**宿主 loader 经 factory 注入的 external**
 * （build-client「React externals」路径，无全局 React、无内联副本），各包 .tsx 本来
 * 就这么写。本文件是 shared/client 下**唯一**允许的 bare import，范围仅此一个符号。
 * 其余一律禁止：禁第二个第三方包、禁任何 `node:*` 值引用。
 *
 * 冻结契约（四层，各原语段内复述自己那层）：
 *   1. 语义层冻结：role 与 aria-* 逐个列名，见各原语段注释。
 *      **永久禁用 `role="navigation"`**（宿主 `:not(:has([role=navigation]))` 规则，
 *      命中即整弹窗退回桌面 row 布局，手机内容区被压至约 106px）；SegmentedControl
 *      同时禁用 `role="tablist"`（与 keep-mounted + hidden 显隐形态冲突，且会把按钮
 *      语义换成标签页语义）。
 *   2. 样式钩子冻结：类名 `dsu-*` 与 `data-dsu-*`（dsh-ui 前缀，**包无关**）。
 *      消费包的领域类（provider-usage 的 `.dou-btn`、notifier 的 `.dn-*`）**不归本层**，
 *      由调用点经 className / itemClassName 传入——这正是它能跨包复用的前提。
 *   3. DOM 结构与第三方 `data-*` 都不是契约：改层级不得改语义层。
 *   4. props 面冻结：只冻结形状与默认值，不冻结内部实现。
 *
 * 取舍总纲：语义增强只做「原来就有可访问名、只是没落到语义树上」的那一类
 * （如 Field 的 label 包裹）；绝不借重构加 role 或改读屏播报次数。
 */
import * as React from "react";

/* ====================== 共享类型面（唯一类型事实源） ====================== */

/** 状态色调档：ok/warn/err 对齐宿主 --dsw-alias-state-*；off=无信号；neutral=中性提示。 */
export type Tone = "neutral" | "ok" | "warn" | "err" | "off";

/** 控件尺寸档（sm=紧凑行内，md=窗格主操作）。 */
export type Size = "sm" | "md";

/** 徽标尺寸档：sm=身份药丸（11px）；xs=行内成败小徽标（10px）。 */
export type BadgeSize = "sm" | "xs";

/** Surface 形态档：pane=设置窗格外层；card=整页外壳大卡。 */
export type SurfaceVariant = "pane" | "card";

/** 分段器档位键的取值域：热力范围是 number（天），其余分段器是 string，故两者都收。 */
export type SegmentedValue = string | number;

/**
 * SegmentedControl 形态档：
 *   bar   = 设置页顶部导航条（带下边框、横向滚动容器）
 *   pill  = 行内药丸筛选组
 *   plain = 朴素按钮组，项沿用消费包的按钮外观（类名由调用点给）
 * 三档而非两档：热力范围切换的项收敛前就是直角小钮，硬塞进 pill 档会把 999px
 * 圆角药丸强加到它身上，属视觉改版而非收敛。
 */
export type SegmentedVariant = "bar" | "pill" | "plain";

/** 分段器单个选项。disabled 由调用点按数据态给出（如热力图当前档位即禁用档）。 */
export interface SegmentedOption<T extends SegmentedValue> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
}

/* ============================== Button ============================== */

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  /**
   * 缺省 "button"。R3 修正：R2 交付时这里是 `Omit<..., "type">`——类型面宣称 type 不属于
   * 契约，实现面却把 {...rest} 整体透传、写在后面的 type 会覆盖前面写死的 type="button"，
   * 两面自相矛盾（且「传了 type 却可能不生效」比「不能传」更坏）。现把 type **显式纳回
   * 契约**并在实现里显式取值：缺省 button，只有显式传 submit/reset 才覆盖。
   * 收窄成三档联合而非原生 ButtonHTMLAttributes["type"]：menu/image 等取值对原生
   * <button> 无意义，放开只会让调用点写出静默无效的属性。
   */
  type?: "button" | "submit" | "reset";
}

/**
 * 职责：统一按钮的默认 type、尺寸档与样式钩子；不改点击/禁用语义。
 *
 * 冻结契约：语义层沿用原生 <button>，不注入 role（role=button 冗余，且会盖掉原生
 * 禁用态语义）；样式钩子 dsu-btn + data-dsu-btn；结构不冻结；props 面 = 原生 button
 * 属性 + size（默认 md），type 允许调用点覆盖。
 *
 * 取舍：**本层不挂任何消费包的按钮类**。R1 时 Button 硬编码了 provider-usage 的
 * `.dou-btn`（#128 触控热区按类名选中它，把窄屏 min-height:36px 外扩到约 44px 命中
 * 区），但档 C 的原语层一旦上提，那条类名就成了「provider-usage 的领域契约写在跨包
 * 层里」——notifier 挂上去只会得到一条永远命不中的死类。故领域类改由调用点经 className
 * 传入：provider-usage 的 8 处 Button 调用点各自补 `className="dou-btn"`，命中区
 * 规则（`.dou-panel[data-dou-bp="narrow"] .dou-btn::before`）与视觉本体原样不动。
 */
export function Button(props: ButtonProps): React.ReactElement {
  const size: Size = props.size ?? "md";
  // type 显式取出，不再靠 rest 透传：写死 type="button" 再被后面的 {...rest} 覆盖，
  // 是 R2 交付版本的矛盾点（类型说不能传、运行时却能传且会生效）。
  const { size: _size, className, type, ...rest } = props;
  const cls = `dsu-btn dsu-btn-${size}${className ? ` ${className}` : ""}`;
  return <button type={type ?? "button"} className={cls} data-dsu-btn={size} {...rest} />;
}

/* =============================== Field =============================== */

export interface FieldRowProps {
  className?: string;
  children?: React.ReactNode;
}

/**
 * 字段行：可换行横排容器（窄屏兜底的落点，flex-wrap 由它承担）。
 * 约 350px 内容宽度下 nowrap 横排必然溢出，内联 style 做不到媒体查询/换行控制。
 */
export function FieldRow(props: FieldRowProps): React.ReactElement {
  const cls = `dsu-field-row${props.className ? ` ${props.className}` : ""}`;
  return (
    <div className={cls} data-dsu-field-row="true">
      {props.children}
    </div>
  );
}

export interface NumberFieldProps {
  label: React.ReactNode;
  value: number;
  min: number;
  max: number;
  onValue: (value: number) => void;
}

/**
 * 冻结契约：字段一律 label 包裹控件（隐式关联），不引入 role/aria-*——原生隐式
 * 关联已足够，加显式 aria-labelledby 只会制造两份事实源。样式钩子 dsu-field /
 * dsu-input + data-dsu-field / data-dsu-input。结构不冻结。
 */
export function NumberField(props: NumberFieldProps): React.ReactElement {
  return (
    <label className="dsu-field" data-dsu-field="number">
      {props.label}
      <input
        className="dsu-input dsu-input-number"
        data-dsu-input="number"
        type="number"
        min={props.min}
        max={props.max}
        value={String(props.value)}
        onChange={(e: unknown) => {
          const v = Number((e as { target: { value: string } }).target.value);
          // 钳制留在原语内：调用点只给 min/max 与数据态，越界与非数字的兜底
          // 口径（回落到 min）三处字段共用一份，不逐个复制。
          props.onValue(
            Number.isFinite(v)
              ? Math.min(props.max, Math.max(props.min, Math.round(v)))
              : props.min,
          );
        }}
      />
    </label>
  );
}

export interface SelectFieldOption<T extends SegmentedValue> {
  value: T;
  label: React.ReactNode;
}

export interface SelectFieldProps<T extends SegmentedValue> {
  label: React.ReactNode;
  value: T;
  options: ReadonlyArray<SelectFieldOption<T>>;
  onValue: (value: T) => void;
}

export function SelectField<T extends SegmentedValue>(
  props: SelectFieldProps<T>,
): React.ReactElement {
  return (
    <label className="dsu-field-block" data-dsu-field="select">
      {props.label}
      <select
        className="dsu-input"
        data-dsu-input="select"
        value={String(props.value)}
        onChange={(e: unknown) =>
          props.onValue((e as { target: { value: string } }).target.value as T)
        }
      >
        {props.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ========================== SegmentedControl ========================== */

export interface SegmentedControlProps<T extends SegmentedValue> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  /** 分组可访问名（必填：无名分组对读屏用户等于一串孤立按钮）。 */
  label: string;
  variant: SegmentedVariant;
  /** 行内标签槽：置于项之前（「标签 + 药丸组同行」的历史写法）。 */
  leading?: React.ReactNode;
  /** 分组容器的排布差异（间距、外边距）交给调用点，形态归 variant。 */
  className?: string;
  /**
   * 项的领域类名（逐项追加）。R1 时 plain 档的项硬编码了 provider-usage 的
   * `.dou-btn`；上提到档 C 后改由调用点传入——本层不能替某个包挑按钮外观。
   * 不传时项只有 dsu-seg-item。
   */
  itemClassName?: string;
  /** 分组容器 ref：横滑容器需要外部做激活项 scrollIntoView。 */
  groupRef?: React.Ref<HTMLDivElement>;
}

/**
 * 冻结契约（本层最关键，语义层权重高于其余三层）：
 *   1. 容器固定 role="group" + aria-label（必填，调用点经 t() 求值后传入，本层不装配
 *      i18n）；项一律 <button type="button"> + aria-pressed 表态。禁 role="tablist"
 *      与 role="navigation"（理由见文件头）。
 *   2. 样式钩子：dsu-seg / dsu-seg-item + data-dsu-seg（形态档）、data-dsu-seg-active。
 *   3. 结构不冻结。4. props 面冻结（value/options/onChange/label/variant 必填）。
 *
 * 取舍：groupRef 外露而非在层内做 scrollIntoView——滚动可见性是「窄屏横滑条上激活档
 * 自动滚进视野」这条交互事实，归设置页根组件所有；本层只保证容器 ref 可拿，且激活项
 * 可经 aria-pressed 定位。激活项不用激活类名表达正是为了这一点：调用点滚进视野的查询
 * 走 [aria-pressed="true"]，换实现换皮肤都不会把窄屏滚动打坏。
 */
export function SegmentedControl<T extends SegmentedValue>(
  props: SegmentedControlProps<T>,
): React.ReactElement {
  const cls = `dsu-seg dsu-seg-${props.variant}${props.className ? ` ${props.className}` : ""}`;
  return (
    <div
      className={cls}
      data-dsu-seg={props.variant}
      data-dsu-seg-group="true"
      role="group"
      aria-label={props.label}
      ref={props.groupRef}
    >
      {props.leading}
      {props.options.map((o) => {
        const active: boolean = props.value === o.value;
        const itemCls = `dsu-seg-item${props.itemClassName ? ` ${props.itemClassName}` : ""}`;
        return (
          <button
            key={String(o.value)}
            type="button"
            className={itemCls}
            data-dsu-seg-item="true"
            data-dsu-seg-active={active ? "true" : undefined}
            aria-pressed={active}
            disabled={o.disabled === true}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ========================= Status / Badge ========================= */

export interface StatusProps {
  tone: Tone;
  /** 可访问名；缺省即装饰点（aria-hidden）。 */
  label?: string;
  className?: string;
}

/**
 * 冻结契约：无 label 时为 aria-hidden 装饰点（收敛前的状态点旁边总跟着文字说明，
 * 重复播报反而是噪音）；给了 label 才升级为 role="img" 带 aria-label。样式钩子
 * dsu-status + data-dsu-tone。结构不冻结。
 */
export function Status(props: StatusProps): React.ReactElement {
  const cls = `dsu-status${props.className ? ` ${props.className}` : ""}`;
  const a11y: Record<string, string> =
    props.label === undefined
      ? { "aria-hidden": "true" }
      : { role: "img", "aria-label": props.label };
  return <span className={cls} data-dsu-tone={props.tone} {...a11y} />;
}

export interface BadgeProps {
  tone?: Tone;
  size?: BadgeSize;
  /** 弱化态：三级文字色 + 虚线边（表达「有此项但当前未启用」）。 */
  muted?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * 冻结契约：纯文字容器，**不加 role**（加 role 需连带可访问名，那是行为变更）。
 * 样式钩子 dsu-badge + data-dsu-tone / data-dsu-size / data-dsu-muted。
 *
 * 取舍：muted 单独成 prop 而不塞进 Tone——它表达「弱化」（虚线边 + 三级文字色），
 * 与色调正交，混进 Tone 会让 ok-muted 之类的组合爆炸。
 */
export function Badge(props: BadgeProps): React.ReactElement {
  const tone: Tone = props.tone ?? "neutral";
  const size: BadgeSize = props.size ?? "sm";
  const cls = `dsu-badge${props.className ? ` ${props.className}` : ""}`;
  return (
    <span
      className={cls}
      data-dsu-tone={tone}
      data-dsu-size={size}
      data-dsu-muted={props.muted === true ? "true" : undefined}
    >
      {props.children}
    </span>
  );
}

/* ============================== Surface ============================== */

export interface SurfaceProps {
  variant: SurfaceVariant;
  className?: string;
  children?: React.ReactNode;
}

/**
 * 冻结契约：**不引入 role**（本原语只出裸容器，加 role 需连带可访问名，那是行为变更
 * 不是收敛）——这条同时是 role="navigation" 的最后一道防线。样式钩子 dsu-surface /
 * data-dsu-surface。结构不冻结；props 面 variant 必填、className/children 可选。
 *
 * 取舍：card 档连外壳卡的 max-width 一起收（它是壳宽约束而非通用卡片属性）；若日后
 * 出现第二种外壳卡，max-width 退回调用点 className 即可，本档不受影响。
 */
export function Surface(props: SurfaceProps): React.ReactElement {
  const cls = `dsu-surface dsu-surface-${props.variant}${props.className ? ` ${props.className}` : ""}`;
  return (
    <div className={cls} data-dsu-surface={props.variant}>
      {props.children}
    </div>
  );
}
