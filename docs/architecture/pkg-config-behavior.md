# 包内配置行为规格（3.2：现状冻结成文）

> 本片性质：纯规格片。现状冻结加成文，不新增抽象、不改配置格式、
> 不新增依赖、不碰公共 API，本片零源码改动。
>
> 证据基线：origin/main 0ca6e5b4。行号会随提交漂移，下文引用一律以符号名
> （导出名、键名、文件名）为准，可用符号搜索复核；行号只在注明处作基线快照。
>
> 快速上手（各包安装与配置键）见各包 README；架构原理见同目录各包文档。
> 本文只记录各包已经落地的包内配置行为，不重复架构文档的内容。

## 1. 定位与范围

- 3.2 是纯规格片：把包内配置行为的现状写成文档，不做行为改动。
- 前置结论（主控已独立核验，本规格直接采用）：#830（d7f87d85，lan-proxy 目录
  结构重排）已合并，本规格描述的是重排后的结构；#769 还开着，但跟 GUI 无关，
  不阻塞本片；推荐方案是现状冻结加成文。
- GUI 子集逐项标注依赖 3.1 并排除在本片之外（见第 7 节）。本片判据只覆盖
  服务端与组合层行为，GUI 差集只记录现状，不含 GUI 改动。
- 判据沿用 manifest 加 N1-N4 加 L1/L2（见第 8 节），由 `pnpm contract`
  的 config-matrix 段执行。

## 2. 唯一接线事实源

官方 settings 存储的接线只有一份实现：[shared/settings-namespace.js](../../shared/settings-namespace.js)
导出的 `installSettingsNamespace(ctx, ns, schema, entry, hooks)`
（类型见配套的 `shared/settings-namespace.d.ts`）。各包不得自抄一份，
notifier 与 lan-proxy 曾各复刻的 `warnLog` 已经统一到这个导出（见该文件顶部注释）。

接线语义（等值复刻官方 `installSettingsSection`，零包依赖，走服务面注入）：

- 以组合层 `entry` 为回落值；只有 `settings.describe()` 已服务 canonical
  namespace `ns` 时，才把读写交给 owner scope。动态 `ctx.inject(["settings"])`
  只证明 settings 服务到场，不证明插件条目已经 active；
- 先订阅 `settings/document-updated`；owning fiber 经 `await()` 确认 ACTIVE 后，
  再由 `settings.describe()` 确认 `ns` 已被服务并一次性调用
  `hooks.onScope(scope, settings)`（供存量迁移与写路径装配）。启动时已经 ACTIVE+已服务
  则仍先于 `setSource`；事件只兜底后续重载/替换，并受同步重入与 disposed 门控；
- 随后调用 `hooks.setSource(() => scope.get())` 与一次 `hooks.onChange()`；
  同 namespace 值变化时继续触发 `onChange`；
- 仅在 settings 服务消失且插件自身未卸载时回落到 `entry`（插件自身卸载时不回落，
  随 fiber 注销）；
- settings 服务缺失、`ctx.inject` 不可用或 namespace 始终未服务时静默降级
  （设置卡片不渲染，插件主体功能不受影响）。

当前已接线的包：

- lan-proxy 经 `src/server/config` 的命名空间薄包装转发，canonical 命名空间为
  `ui-dsh-lan-proxy`；
- dsh-mcp-manager 在 `src/index.ts` 接线，canonical 命名空间为
  `ui-dsh-mcp-manager`；
- dsh-provider-usage 在 `src/apply/apply.ts` 注册，命名空间为
  `dsh-provider-usage`，`base` 为组合层原始配置；
- dsh-notifier 不调用该函数：自持 `config.json`（见
  `src/server/shared/paths.ts` 的 `CONFIG_FILE_NAME`），官方 settings
  仅作迁移来源（见 `src/server/upgrade/impl/legacy`，按命名空间
  `dsh-notifier` 读取文档分节做存量迁移输入）。

缺口：notifier 侧 settings 命名空间相关调用点本规格未逐行枚举，记为缺口，
见第 9 节。

## 3. lan-proxy 配置行为

源码位置：`packages/dsh-lan-proxy/`，详见 [dsh-lan-proxy.md](dsh-lan-proxy.md)
与 [包 README](../../packages/dsh-lan-proxy/README.md)。

### 3.1 八段结构

变异与功能共 8 段：entry（`src/index.ts` 组合根与 `src/server/apply.ts`
装配）、`src/server/config`（模型、命名空间、路由）、`src/server/host-trust`、
`src/server/migrate`、`src/server/proxy`、`src/server/shared`、
`src/server/tls`、`src/client`（含 `client/shared/defaults.ts` 的
`DEFAULTS` 与设置卡片；卡片渲染面依赖 3.1，本片除外）。

### 3.2 L1：三表 18 键全等

`src/server/config/impl/model.ts` 内三张平行表键集全等，共 18 键：

`enabled`、`host`、`port`、`httpsEnabled`、`httpsPort`、
`tlsCertFile`、`tlsKeyFile`、`targetHost`、`targetPort`、
`printBanner`、`wsBridgeEnabled`、`wsCompressEnabled`、
`wsCompressPaths`、`wsDeflatePolicy`、`httpCompressEnabled`、
`httpCompressLevel`、`injectToken`、`ownsHostCompat`。

- `Config`：schemastery schema，事实源头，默认值只写在这里；
- `FILE_CONFIG_VALIDATORS`：存量迁移过滤与客户端 patch 校验共用；
- `SETTING_FIELD_HINTS`：校验失败时指明合法范围的人话文案。
- `DEFAULT_CONFIG` 由 `Config({})` 归一化空输入派生，共 15 键：
  无默认值的 `tlsCertFile`、`tlsKeyFile`、`targetPort` 在结果里被省略，
  这是 schemastery 语义下的事实，不是缺口；N1 与 N2 锁的正是这条不变式。
- `BOOLEAN_KEYS` 共 8 键（`enabled`、`httpsEnabled`、`printBanner`、
  `wsBridgeEnabled`、`wsCompressEnabled`、`httpCompressEnabled`、
  `injectToken`、`ownsHostCompat`），与 schema 里的布尔字段一一对应。
- `COUNT_LIMITS` 共 3 项：`port` 上界 65535、`httpsPort` 上界 65535、
  `httpCompressLevel` 上界 3，与 schema 里的 `max` 同值；无默认值的
  `targetPort` 不在列。

### 3.3 L2：客户端 DEFAULTS 与豁免

- 客户端 `DEFAULTS` 必须是 schema 的子集；在 schema 之外多键即红
  （多出的键会被宿主白名单静默丢弃，造成保存了但没生效）。
- schema 有而 `DEFAULTS` 没有的键，必须恰为豁免集合，当前 4 键：
  `host`、`targetHost`、`targetPort`（三者为组合层装配键：绑定地址、
  回环上游主机与随 web 端口装配的上游端口，GUI 卡片不编辑）、
  `wsDeflatePolicy`（服务端压缩协商子结构，GUI 无对应控件；路径白名单
  `wsCompressPaths` 已可编辑，覆盖了实际使用面）。以上豁免是现状事实记录，
  卡片本身的改动依赖 3.1，本片除外。
- 豁免表唯一事实源是 [scripts/data/dsh-lan-proxy-ui-exempt.json](../../scripts/data/dsh-lan-proxy-ui-exempt.json)，
  门禁不再内嵌条目；条目数上限 8 是策略，留在门禁代码里；每条 `reason`
  须含文件加行号且该行必须是该键在 `Config` 里的真实定义行（行号锚点历史
  上连续漂移过两次，门禁现按文本核验真身；文档引用一律用 `Config.<键>`
  符号名）；豁免键出现在 `DEFAULTS` 里属豁免残留，同样判红。

### 3.4 写面与迁移行为

- `sanitizeSettings`：只接受已知键；任一已知键类型非法则整体拒绝并返回
  空（避免静默丢键）；空字符串证书路径按未设置处理后剔除。
- 旧档位迁移：`httpCompressLevel` 的整数 4 到 9 视为高档并归一为 3。
- 旧 WS 压缩白名单迁移：与旧默认无序等价时归一为新默认
  `DEFAULT_WSS_COMPRESS_PATHS`，其余原样保留。
- `targetHost` 只接受回环目标（防开放转发），由共享层判定。

## 4. provider-usage 配置行为

源码位置：`packages/dsh-provider-usage/src/shared/config.ts`，详见
[dsh-provider-usage.md](dsh-provider-usage.md)、包内
[docs/architecture.md](../../packages/dsh-provider-usage/docs/architecture.md)
与 [包 README](../../packages/dsh-provider-usage/README.md)。

- `DEFAULT_CONFIG` 共 13 键：`adapter`、`staticPath`、`provider`、
  `apiEndpoint`、`apiKey`、`historyDir`、`warmupIntervalMs`、
  `cacheDurationMs`、`fetchTimeoutMs`、`autoReload`、`maxAgeDays`、
  `maxSizeMB`、`trendRetentionDays`。
- `NormalizedConfig` 接口与默认表同为 13 键同集。
- `Config`（schemastery schema）共 11 字段：与默认表相比缺 `apiKey`
  与 `historyDir`。
- 已知不一致（如实登记，实现另议，本片不改）：`apiKey` 与 `historyDir`
  在默认表、`NormalizedConfig` 与 `normalizeConfig` 白名单里存在，
  但不在 `Config` schema 里。任何一侧的单方改动都必须先立项，不得在本片
  顺手对齐。
- `BOOLEAN_KEYS` 为 `["autoReload"]`；`COUNT_LIMITS` 为
  `maxAgeDays` 上界 365、`maxSizeMB` 上界 500、`trendRetentionDays`
  上界 3650。
- `normalizeConfig` 钳制：`warmupIntervalMs` 下界 60000，
  `cacheDurationMs` 下界 5000，`fetchTimeoutMs` 固定 5 秒不开放配置，
  `maxAgeDays` 仅接受正整数且上界 365，`maxSizeMB` 上界 500，
  `trendRetentionDays` 仅接受正整数且上界 3650；非法输入回落默认值。
- 浏览器侧展示面（轮询胶囊与面板注入）依赖 3.1，本片除外。

## 5. notifier 配置行为

源码位置：`packages/dsh-notifier/`，详见 [dsh-notifier.md](dsh-notifier.md)
与 [包 README](../../packages/dsh-notifier/README.md)。

- 自持 `config.json` 为写面与读面的事实源；官方 settings 只在升级域做
  存量迁移输入，不保存新配置（settings 仍是启动迁移的必需依赖）。
- `DEFAULT_CONFIG`（`src/server/config/impl/model`）顶层共 11 键：
  `notifyAsk`、`notifyQuestion`、`notifyTaskDone`、`notifySubagentDone`、
  `notifyTaskError`、`notifyTurnEnd`、`quietHours`、`channels`、
  `kindRoutes`、`allowKinds`、`historyMaxAgeDays`；其中 `channels`
  默认即带 browser 与 system 两条内置条目。
- `CONFIG_KEYS` 由 `Object.keys(DEFAULT_CONFIG)` 派生，不另抄清单。
- `BOOLEAN_KEYS` 共 6 键（六个通知开关）；`COUNT_LIMITS` 为
  `historyMaxAgeDays` 上界 3650。
- 退役键 `RETIRED_KEYS` 共 9 键：0.2.3 的 8 个顶层渠道键（已搬进 `channels`
  内置条目）与随 SSE 连接上限机制一并移除的 `maxConnections`；写面一律
  拒收并逐键给出拒收话术，不静默放行。
- 读面：坏 JSON 与非对象输入回落为空设置，设置坏掉不拖垮插件装配；
  计数键越界视为非法并拒绝（与 lan-proxy 的截断钳制不同，两包行为差异
  在此如实记录，不统一）。
- 客户端事件开关、频道卡与渲染读取面依赖 3.1，本片除外。

## 6. 其余包的登记

声明输入面是 [scripts/data/plugins-manifest.json](../../scripts/data/plugins-manifest.json)
的 `configSurfaces`（3.2 范围只登记存在性，行为细节不在本片）：

- dsh-mcp-manager 有用户配置面（默认表、归一化、布尔键清单在
  `src/config/model/config-schema.ts`；计数上界表当前为空对象），
  经 `installSettingsNamespace` 注册 `dsh-mcp-manager`。
- dsh-verify-isolated 与 dsh-worktree-sidebar 显式声明无用户配置面
  （前者宿主侧无可配置项，后者唯一的 enabled 是挂载点总开关），跳过
  N1 到 N4，但必须回显理由。

## 7. GUI 子集（依赖 3.1，本片除外）

下列逐项依赖 3.1，均排除在本片之外，本规格只记录其现状事实：

- lan-proxy 设置卡片的渲染与编辑面（含 `DEFAULTS` 缺键即 GUI 未覆盖的
  对应关系），依赖 3.1，本片除外；
- 豁免 4 键的 GUI 不渲染现状（见 3.3），依赖 3.1，本片除外；
- lan-proxy 的 HTTP 压缩运行快照等 GUI 可见状态，依赖 3.1，本片除外；
- notifier 客户端事件开关、频道卡与设置读取面，依赖 3.1，本片除外；
- provider-usage 浏览器侧展示面，依赖 3.1，本片除外。

## 8. 判据

判据沿用 manifest 加 N1-N4 加 L1/L2，执行点是 `pnpm contract` 的
config-matrix 段（声明读不到或结构不合法即红，不退化为跳过）：

- N1：`configSurfaces.defaults` 导出的默认表必须是非空对象；
- N2：`normalizeConfig({})` 的键集双向等于默认表键集（丢键与凭空造键都红）；
- N3：`BOOLEAN_KEYS` 的每个键都是真实配置键，且其默认值确是布尔值
  （反向不断言：布尔默认值不一定在只接受布尔值的清单里）；
- N4：`COUNT_LIMITS` 的每个键都是真实配置键，上界是非负整数，
  且默认值不超过该上界；
- L1：lan-proxy 三表两两全等（18 键）；
- L2：lan-proxy 客户端 `DEFAULTS` 为 schema 子集，差集恰为豁免集合，
  豁免结构自检通过（见 3.3）；
- README 配置表缺键仅为提示，不判红。
- lan-proxy 同时受 L1/L2（源码文本断言）与 N1-N4（声明驱动的运行时取值
  断言）两层约束；其余有配置面的包受 N1-N4 约束。
- 新增或修改配置键须四同步：事实源表、校验器与提示文案、归一化白名单与
  透传排除、客户端渲染与编辑加 smoke 断言加 README 配置节；补齐后重跑
  `pnpm contract`。

## 9. 已知不一致与缺口

1. provider-usage 键差：默认表 13 键对 schema 11 字段，`apiKey` 与
   `historyDir` 在默认表与 `NormalizedConfig` 而不在 schema。
   已知不一致，实现另议，本片仅登记（见第 4 节）。
2. notifier settings 命名空间调用点未逐行枚举：缺口。现状只登记到第 2 节
   的粒度（自持 `config.json` 加 legacy 迁移读面），逐行调用点枚举留待
   后续补齐，不在本片。
3. 历史数字口径：issue 相关讨论中出现过的 notifier 旧键数表述，属 #733
   配置域搬迁前的文本提取口径；现行门禁已重建为声明驱动加运行时取值，
   旧数字不得再当现行判据引用。
4. 豁免行号锚点历史漂移：文档引用配置键一律用 `Config.<键>` 符号名，
   行号只允许作基线快照，不作长期锚点。

## 10. 非目标

- 不新增抽象、不改配置格式、不新增依赖、不碰公共 API；
- 不合并不属于本片的 GUI 改动（见第 7 节）；
- 不对第 9 节的已知不一致做实现侧对齐；
- 本片零源码改动：`packages/*/src`、`shared`、`scripts`、
  `.github`、配置格式与依赖均不在本片触碰范围内。

## 11. 证据与复核方法

- 只读复核命令示例（均不写工作区）：
  `git status --porcelain`（本片只允许出现本文档路径）、
  `pnpm docs:check`（相对链接与命令引用校验）。
- 配置键复核用符号搜索（如 `grep -rn "apiKey" packages/dsh-provider-usage/src/shared/config.ts`），
  不以行号为长期依据。
- 门禁语义的唯一出处是门禁代码与数据文件本身（`scripts/lib/config-matrix-gate.ts`、
  `scripts/lib/config-matrix-lib.ts`、`scripts/data/plugins-manifest.json`、
  `scripts/data/dsh-lan-proxy-ui-exempt.json`）；本文档是现状记录，
  语义分歧以它们为准。
