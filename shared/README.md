# shared/ —— 插件家族共享层

DSH 插件家族共用的模块（构建期 esbuild 内联进各插件包，不单独发布）。分两类：

- **宿主端**：各包 `src/*.ts` 相对 import，bundle-host 内联进 `lib/index.js`
  （loopback / host-utils / settings-namespace / dsh-home / sse-hub / upgrade-chain 等）。

  placement-math 已退役（#767 终轮收尾：mcp-manager 与 provider-usage 先后自持包内实现以满足
  shared-leaf 叶子约束，共享层仅剩单一消费者，触规则 1 下限；按规则 7 一次做完——删模块与
  声明，两包实现须保持逐行同构，靠评审保证）。
- **客户端**：各包 `src/client/*.ts` 相对 import，build-client 内联进 `lib/client.js`
  （client/i18n 活绑定等；每 bundle 一份独立副本，包间互不干扰）。

## 模块

| 文件 | 端 | 内容与行为契约 |
|------|----|------|
| `loopback.ts` | 宿主 | `isLoopbackRequest` 安全围栏（路由 loopback 校验单一事实源） |
| `host-utils.ts` | 宿主 | `writeJson` / `errorMessage` / `readBody`（限长显式化）/ `readJsonBody`（宽松版）/ `sseData`（SSE data 帧序列化 `data: <json>\n\n`；undefined / 含 `\n` payload 行为对齐历史消费方、非承诺契约）/ `guardLoopbackMethod`（loopback+方法白名单守卫；403 先于 405 为守卫自身执行顺序，仅适用于套守卫端点） |
| `settings-namespace.ts` | 宿主 | `installSettingsNamespace`（settings 服务面注入） |
| `dsh-home.ts` | 宿主 | `dshHome`（DSH home 解析单一事实源，#517：`DSH_HOME` 非空白原样采用、未设置或空白回落 `~/.dsh`——空白视同未设置对齐官方 `dsh-home-paths#resolveDshHome`；不 resolve/不展开 `~`，默认形态路径逐字节不变。豁免口径（非 dsh 生态凭据不跟随）与落盘纪律条款见 DEVELOPMENT.md §1，由 PR #523 承载）+ `userHome`（用户 home 接缝，#722：`HOME`（Windows 为 `USERPROFILE`）非空白原样采用、否则回落 `os.homedir()`；取值次序与 libuv 一致故默认形态逐字节不变，显式读 env 是为了在 worker_threads（Stryker 的 vitest-runner 强制 `pool: 'threads'`）下仍可被测试的 `process.env` 隔离） |
| `paths.ts` | 宿主 | `pluginHome`（包主目录拼装单一事实源：`join(base, ...segments)`，默认形态路径逐字节不变；只收敛包主目录直拼，legacy 旧根/settings 文档/resolve 对比/用户输入解析/credentials-userHome/展示脱敏/包内反推 7 类排除，provider 旧 `pluginHome` 保留包内 facade） |
| `upgrade-tick.ts` | 宿主 | `tickUpgradeVersion` 升级链空步单一事实源（立即完成、不碰存储；各包只登记版本号，不再为新版本加空函数） |
| `upgrade-chain.ts` | 宿主 | 升级链骨架单一事实源：`runUpgradeChain`（唯一 async 执行器，**逐步 await 保证串行**、**每步成功后立刻回写刻度**、任一步抛错即中止并带包名前缀与目标版本、`cause` 透传、对账落差只 `logger.warn` 不改动作）+ `createUpgradeRunner`（**三重守卫**：链跑成功后才标记已装配 → 重复装配即抛；另有在途标记，第二次 `install` 当场抛「正在装配中」而不是与第一次并跑——链是异步的，只靠前一条拦不住并发；在途标记随链结束在 finally 清零，失败不把 runner 锁死）+ `compareVersions` / `selectPendingSteps`（按目标版本升序、`fromVersion >= recorded` 即待办、不就地排序入参）/ `newestTargetVersion` / `diagnoseGap`（落后 / 步骤表超前 / 降级三态判词，包名前缀由调用方传第 4 参 `label`）/ `packageRootFrom` / `pluginVersion`（**收 `fromDir` 而非自定位 `import.meta.url`**：本模块内联进各包产物后运行时目录与源目录深度不同，自定位必有一种形态错且是静默回落 0.0.0 的那种错）。边界：刻度落在哪个文件、读不到刻度时 fail-safe 还是 fail-closed、迁移动作做什么，一律经 `ports` 注入，本模块只 await 不替消费方做业务决定；`run` 收 `void \| Promise<void>`——统一异步链不等于强迫所有 step 异步 |
| `sse-hub.ts` | 宿主 | `createSseHub` SSE 长连接枢纽单一事实源（#515：连接表 + 心跳 + stalled/maxAge 主动回收，取代各包自建连接表；#769 移除了连接上限机制：半开/僵尸连接此后只靠 stalled 收住，maxAge 只回收「长命且业务空闲」的正常连接）。行为契约：广播帧由调用方生成、hub 不感知业务语义；stalled 判据是「write 返回 false 连续超窗」而非 writableLength（背压不等价于僵尸）；心跳是 hub 级单 interval；健康明细**不进** `/health`（大小随连接数增长，而 `/health` 是常量大小聚合面） |
| `client/i18n.js` | 客户 | 共享 `t` 活绑定 + `bindLocale`（#348 → #378 抽取；未装配回落 key 本体） |
| `client/ensure-style.ts` | 客户 | 参数化 `ensureStyle({ id, cssText, version? })`（#477 收敛；按 id 幂等 / head 缺失静默 no-op 不抛 / version 变化重建 / 返回 disposer） |
| `client/ui/index.tsx` | 客户 | 跨包 UI 原语层（T1 五原语 + 共享类型面，R2 由 dsh-provider-usage 端内面上提到档 C）。**单文件**（原因见下方小节）。语义层/样式钩子/props 面逐项契约见下方「client/ui 行为契约登记」 |
| `client/ui/ui.css` | 客户 | 原语层表现面的**唯一副本**（R3）：Surface / Field / SegmentedControl / Status / Badge 的 dsu-* 规则。消费方式 = 各包 `src/client/index.*` 的 ts 侧拼接 `cssText: UI_CSS + STYLE`（顺序是契约，见下）。它不是 .ts，门禁不枚举 |

> 消费方由脚本实时派生输出（`node scripts/gate/verify-shared-fanin.mjs`，逐模块打印消费包集合），
> 本表只保留端别 / 内容 / 行为契约。为什么不在这里留一份人肉登记快照：实测它会漂移——上一次
> 快照把零引用的包登成消费方、漏登真实消费方、整行模块缺失，而漂移的登记比没有登记更误导读者。

### client/ui 行为契约登记（准入规则 5/6 的「同 PR 四齐」载体）

R3 起本层有两份资产，**改一处必须想到另一处**：

- `client/ui/index.tsx` —— 语义层 + props 面（role/aria-*、dsu-* 钩子、组件 API）。
- `client/ui/ui.css` —— 表现面。R3 之前它是「各包 style.css 里人手复制的第 N 份」，
  改一处要同步 N 处、漏改无任何测试报红；R3 起改为**唯一副本 + ts 侧拼接注入**。

拼接的两条硬约束（都写在本文件头注释里，此处登记是因为它们是跨包契约）：

1. **不能用 `@import`**。R3 实测：build-client 的 `loader: {".css": "text"}` 把 .css 当
   纯文本内联，esbuild 不解析 CSS，`@import` 会原样留在产物里，浏览器再按**页面相对
   URL** 去请求那个路径 → 404 → 规则静默消失，**而 build exit 0、测试全绿**。
2. **顺序必须是 `UI_CSS + STYLE`**（原语层在前当底座）。各包 style.css 里对 dsu 钩子的
   窄屏/领域覆盖（同优先级靠后者胜）要压得住原语默认值——dsh-provider-usage 的
   `@media (max-width: 480px)` 段正是靠这条覆盖 `.dsu-badge` 与 `.dsu-surface-pane`。

R2 把 T1 原语层从 dsh-provider-usage 的端内面（`src/client/shared/ui/`）上提到本层。
准入四齐在同一 PR 内齐备：**代码**（本层源码）+ **契约登记**（本表）+ **独立测试**
（`packages/dsh-provider-usage/test/client-dom/ui-primitives.test.ts`，直连本层**源码**
而非 emit 产物）+ **扇入 ≥ 2**（provider-usage / notifier，由 fanin 门禁实时派生）。

**冻结契约四层**（改动须先改本表）：

1. **语义层冻结**——role 与 aria-* 逐个列名：

   | 原语 | 语义层 |
   |------|--------|
   | Button | 原生 `<button type="button">`；**不注入 role**（冗余，且会盖掉原生禁用态语义） |
   | FieldRow / NumberField / SelectField | `label` 包裹控件的隐式关联；**不注入 role/aria-***（加显式 aria-labelledby 即制造两份事实源） |
   | SegmentedControl | 容器 `role="group"` + **必填** `aria-label`；项 `aria-pressed`（布尔）。**禁用 `role="tablist"` 与 `role="navigation"`** |
   | Status | 无 label → `aria-hidden="true"` 装饰点（旁边的文字承担播报）；有 label → `role="img"` + `aria-label` |
   | Badge | 纯文字容器，**不注入 role** |
   | Surface | 裸容器，**不注入 role** |

   `role="navigation"` 是本仓**最致命的失败模式**：宿主 `:not(:has([role=navigation]))`
   移动端规则一旦命中，整弹窗退回桌面 row 布局，手机内容区被压至约 106px。测试用
   `role="navigation"` 正面断言把它钉死（Surface 两种形态各一条）。

2. **样式钩子冻结**——类名 `dsu-*` 与状态钩子 `data-dsu-*`（dsh-ui 前缀，**包无关**）。
   消费包的领域类**不归本层**：provider-usage 的 `.dou-btn`、notifier 的 `.dn-*` 一律
   由调用点经 `className` / `itemClassName` 传入。跨包层替某个包挑外观是它不可复用的
   开始——R1 时 Button 硬编码 `.dou-btn`，上提时必须拆掉。
3. **DOM 结构与第三方 `data-*` 不是契约**：改层级不得改语义层。
4. **props 面冻结**：只冻结形状与默认值（`variant`/`size`/`tone` 等必填项与缺省值）。

**为什么是单文件（本层最容易被「好心拆开」的形状）**：
`verify-shared-fanin.mjs` 按 `shared/` 下**每个 `.js`/`.d.ts` 文件**枚举模块并各自要求
扇入 ≥2（shared 是 TS 化 + 原地 emit，枚举到的是 tsc 产物）。R2 实测：`shared/client/` 下
放两个 0 消费的探针 `.ts`，emit 之后门禁立刻报 `FAIL 值面 client/probe-alpha.js | 0 包`。
两包都只从门面导入时，拆成 button/field/… 会让五个实现文件各自 0 消费者判红，故单文件是
**当前门禁下的唯一可行形状**。将来要拆，前置条件是先解决「每个文件都得有 ≥2 个包直接
import」这条约束。

**两条已知治理缺口（如实登记，不假装闭合）**：
- `scripts/test/shared-ts-shape.test.ts` 的 ALLOWLIST 只收 `.ts`（`f.endsWith(".ts")`），
  本层的 `.tsx` **不在其冻结面内**——形态守卫对本层不生效。补该守卫要改 `scripts/test/**`，
  不在本轮授权内。
- `scripts/data/mutation-topology.json` 的 `ui-primitives` 段登记在
  `packages.dsh-provider-usage` 下、`mutate` 指向 `shared/client/ui/index.tsx`
  （段位随首个消费包走；`$rootShared` 段要求测试文件落在 `shared/test/*.mutation.test.ts`，
  而该目录不在任何 vitest project 的收集面内）。

## 使用约束

- shared 是**构建期源码依赖**：插件 src 以相对路径 import，构建时由 esbuild 内联进
  各包 lib/ 产物。**发布物必须自包含**——npm 包内不得残留 `../../shared` 运行时引用。
- 修改 shared 后回归：`pnpm build && pnpm test`（回归全部插件 smoke）+
  `pnpm typecheck`（shared 声明与消费方类型一致性）。
- **真 TypeScript 源码**（#1028 后续重构，取代此前的「js + d.ts 双写 / 不可 TS 化」）：
  shared 实现一律 `.ts`，声明由 tsc 产出、**原地 emit**（与源码同目录，已 gitignore）。
  - 为什么能原地 emit：消费方用相对说明符 `../../shared/paths.js`，而构建是两段式
    （包 tsc 出 lib → bundle-host 用 esbuild 打 lib/*.js），emit 出去的说明符必须指向
    磁盘上真实存在的 `.js`，所以产物必须与源码同目录。
  - 为什么不用 `dist/`：加路径段会牵动 rewrite-dts-paths 的 `../` 深度启发式与
    d.ts X1 的三个根（枚举根 / 落点根 / 改写目标根），只改其一会得到**自洽的假绿**。
  - 消费侧形态**一个字没改**：97 处 import、bundle-host 内联与 d.ts X1 拷贝、
    shared-dts-lib 枚举、verify-shared-fanin、pack-check 全部零改动——它们认的是
    「仓库根 shared/」这个位置，不是文件形态。
  - **composite + project references** 是防回退的关键：各包 tsconfig 的
    `references` 指到 shared，「改了 `.ts` 但没重建」会变成 TS6305 硬红。
  - 版本库里 shared/ **只允许 `.ts` 源码**（含 README.md 与 test/）；手写 `.js`/`.d.ts`
    对的回归由 `scripts/test/shared-ts-shape.test.ts` 冻结守卫判红。
- 新增 shared 模块须满足下方准入规则；退役按规则 7 一次做完（迁消费方 + 删模块与声明）。
- **发布面**：`.d.ts` 声明经 bundle-host **d.ts X1**（2a 引用改写 + 2b 副本随包）随每个
  消费包发布，pack:check 双向断言（查缺 + 查多 retired 残留）兜底——机制说明见
  [DEVELOPMENT.md d.ts X1 小节](../docs/DEVELOPMENT.md#user-content-dts-x1)，此处不重复。

## 准入规则（新增模块必须全部满足）

1. **≥2 稳定消费者**：至少两个插件包实际使用；单一消费者留在包内，不进 shared。
   由 `scripts/gate/verify-shared-fanin.mjs` 按生产 src 口径判红（类型面模块单列，
   单消费者合规）。**退役不豁免该下限**（维护者裁决 #792 D-A）：模块头标注 DEPRECATED
   不改变判据，退役中的模块照样按同一下限判——先把消费方迁走，再连同模块与声明一起移除。
2. **无包级常量依赖**：核心逻辑不得闭包引用包级常量（如 `DEFAULT_Z_INDEX_BASE`
   10 vs 40）；包差异经参数化（`panelZIndexFor(base, dflt)`）或薄 facade 注入。
3. **跨 apply 状态语义明确**（允许模块级可变状态的唯一形态——bundle 私有活绑定，
   如 `client/i18n.js` 的 `export let t`）：
   - 每 bundle 经 esbuild 内联独立副本，**不跨包共享实例**；
   - **显式生命周期契约**：bind/unbind 配对、disposer 必达（重复 apply 不累积旧回调）；
   - **不参与包间共享状态**：可变状态不得作为跨包通信载体。
4. **无跨 apply 泄漏**：不引入未经卸载监听/闭包/定时器累积（T4/T5 红线）。
5. **登记行为契约**：本表登记行为契约（如「未装配回落 key 本体」），
   smoke/单测锁定行为；消费方不在本表登记（由 `verify-shared-fanin` 实时派生）。
6. **独立测试**：新增模块须带独立单测（如 `scripts/test/shared-client-i18n.test.ts`）。
7. **退役一次做完（无观察期豁免）**：不存在「标注 DEPRECATED 后就地保留一段时间」这条口子
   ——观察期不改变扇入下限（判据同规则 1），因此正确顺序是**先迁移全部消费方**、**再连同
   `.js` 与 `.d.ts` 一起移除**，两步落在同一个改动里；不允许标注后长期留在共享层。
   与规则 1 的判据冲突时以判据为准：`scripts/gate/verify-shared-fanin.mjs` 不看 DEPRECATED。

> ⚠️ 活绑定语义依赖 **esbuild 同 bundle 内联**（每 bundle 独立副本、import 侧即时可见
> 重绑）。若未来客户端构建改为共享 chunk / 跨包复用产物，须重新验证该假设
> （见 `shared/client/i18n.js` 头注释）。
