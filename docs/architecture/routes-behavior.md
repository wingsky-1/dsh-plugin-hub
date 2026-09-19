# 路由行为规格（3.6：现状冻结成文）

> 本片性质：纯规格片。现状冻结加成文，不新增抽象、不改路由、不改围栏语义、
> 不新增依赖、不碰公共 API，本片零源码改动。
>
> 证据基线：origin/main 7b8eb997。行号会随提交漂移，下文引用一律以符号名
> （导出名、键名、文件名）为准，可用符号搜索复核；行号只在注明处作基线快照。
>
> 语义分歧以门禁代码与源码为准，本文档只是现状记录。
>
> 快速上手（各包安装与配置）见各包 README；架构原理见同目录各包文档。
> 本文只记录各包已经落地的路由行为，不重复架构文档的内容。

## 1. 定位与范围

- 3.6 是纯规格片：把路由行为的现状写成文档，不做行为改动。
- 前置结论（主控已独立核验，本规格直接采用）：S0 零行为变更规格冻结；宿主围栏
  与客户端围栏是两套独立判据；无产物检查删除、无替代证明欠账；宿主与客户端的
  测试依赖是两套。
- GUI 子集逐项标注与 #769 的边界并排除在本片之外（见第 7 节）。本片判据只覆盖
  路由注册与围栏行为，GUI 渲染与客户端运行时不属于本片。
- 本片判据覆盖宿主端路由围栏与客户端路由来源两类行为（见第 3 节与第 4 节）；
  配置面的判据仍归包内配置行为规格，见 [pkg-config-behavior.md](pkg-config-behavior.md)。

## 2. 事实源

宿主围栏只有两份实现，均在仓库共享层：

- [shared/loopback.js](../../shared/loopback.js) 导出的 `isLoopbackRequest`：回环
  判定的唯一事实源，各包不得自抄一份。
- [shared/host-utils.js](../../shared/host-utils.js) 导出的 `guardLoopbackMethod`
  与 `writeJson`：围栏执行顺序与拒绝体写法的唯一事实源；`readJsonBody` 与
  `readJsonBodyOutcome` 只解决请求体读取口径，不参与围栏判定。

客户端围栏的事实源：

- 各包 `src/client` 入口导出的 `apply` 与 `inject`（干净模块形态）；
- [scripts/build/bundle-host.ts](../../scripts/build/bundle-host.ts) 的 `extraDefine`
  经 `__DSH_ROUTES__` 注入宿主路由表（构建期两端强一致）；
- 客户端契约判定的唯一事实源是
  [scripts/lib/client-contract-lib.ts](../../scripts/lib/client-contract-lib.ts)。

## 3. 宿主围栏口径

### 3.1 回环判定

`isLoopbackRequest` 的语义（四项缺一即拒绝）：

- 来源地址须为回环地址（`127.0.0.1`、`::1`、`::ffff:127.0.0.1` 三者之一）；
- `Host` 头须存在且可解析，其主机名须为回环主机（`127.0.0.1`、`localhost`、
  `[::1]` 三者之一）；缺失或非法即拒绝，不猜测放行；
- 跨站判定默认拒绝一切 `sec-fetch-site: cross-site` 请求；仅当显式传入
  `allowCrossSiteNoCors` 且请求带 `sec-fetch-mode: no-cors` 时放行。该放行只允许
  serve 类资源伺服路由使用，普通 `api` 路由必须保持默认拒绝；
- `Origin` 缺席即放行；存在时须与 `Host` 同源，否则拒绝。

### 3.2 执行顺序

`guardLoopbackMethod` 的顺序是：非 loopback 先回 403（`forbidden: loopback-only`），
方法不在白名单再回 405。该顺序仅对套本守卫的端点成立。拒绝体经 `writeJson`
写出，统一带 `referrer-policy` 头。

### 3.3 刻意例外

`mcp-manager` 的 `/config` 是端点级方法分流先于 loopback 的刻意例外，不适用
3.2 的顺序（实现见 `src/api/routes-controllers.ts` 的 `buildConfigRoute`）：

- `GET` 是只读 UI 配置接口，允许非 loopback 访问，便于远程页面读取非敏感的
  展示配置；
- `POST` 是写操作，只对 loopback 开放，套 `guardLoopbackMethod` 守卫；
- 白名单外方法由收尾分支直接回 405，不查 loopback：非 loopback 加白名单外方法
  返回 405 而非 403 是契约行为，禁止误套守卫纠正它。

除该端点外，本规格登记的所有端点均为 403 先于 405，无其他例外。

## 4. 客户端围栏口径

### 4.1 干净模块

有客户端面的包，其 `src/client` 入口均为干净模块：只导出 `apply` 函数与 `inject`
数组；样式独立 `src/client/style.css`（`worktree-sidebar` 无独立样式文件，见
5.5 节）；契约外壳由 [scripts/build/build-client.ts](../../scripts/build/build-client.ts)
统一生成，源码不写任何 loader。构建产物的硬契约（`load` 恰好一次、`load` 标识
须等于完整包名、`materialize` 后导出键集恰为 `apply` 加 `inject`）由
`client-contract-lib.ts` 判定。

### 4.2 路由单源

`bundle-host.ts` 在构建客户端前从 `lib/index.js` 读取 `ROUTES`，经 `extraDefine`
注入 `__DSH_ROUTES__`。未引用该标识符的客户端零影响；读取失败仅警告不阻断，
由各包 smoke 的一致性断言兜底。现状分两类：

- 注入型：经 `__DSH_ROUTES__` 取值，缺席时回落。`provider-usage` 的
  `src/client/core.ts` 与 `src/client/report.tsx` 以该方式覆盖其全部路由键；
  `worktree-sidebar` 的 `src/client/index.ts` 以 `typeof` 守卫读取注入值，缺席时
  回落到 `src/shared/contract.ts` 的 `ROUTES`（该守卫同时是其客户端单测的一条
  判据：非 bundle 环境里标识符根本不存在，裸引用会抛错）。
- 镜像型：客户端手写与宿主一致的路径字面量。`lan-proxy` 的
  `src/client/settings-card.tsx` 的 `CONFIG_ROUTE` 与 `HEALTH_ROUTE`；
  `mcp-manager` 的 `src/client/core/constants.ts` 的 `API`；`notifier` 的
  `src/client/index.tsx` 内的 `ROUTES` 常量。改路径须两端同改，无构建期强一致，
  只靠 smoke 兜底（见第 9 节）。

## 5. 逐包现状登记

### 5.1 lan-proxy

源码位置：`packages/dsh-lan-proxy/`，详见 [dsh-lan-proxy.md](dsh-lan-proxy.md)
与 [包 README](../../packages/dsh-lan-proxy/README.md)。

- 路由表 `ROUTES` 共 2 键（`health`、`config`），定义在
  `src/server/config/impl/routes.ts`，经 `src/server/config/interface.ts` 转发，
  由 `src/index.ts` 组合根对外导出；
- `config` 路由经 `buildConfigRoutes` 组装（`GET` 读快照、`PUT` 写 patch），
  `health` 路由在 `src/server/apply.ts` 注册；两者均套 `guardLoopbackMethod`
  守卫；
- 客户端为镜像型（见 4.2 节），设置卡片经回环配置路由提交增量 patch。

### 5.2 mcp-manager

源码位置：`packages/dsh-mcp-manager/`，详见 [dsh-mcp-manager.md](dsh-mcp-manager.md)
与 [包 README](../../packages/dsh-mcp-manager/README.md)。

- 路由表 `ROUTES` 共 11 键（`servers`、`config`、`session`、`resume`、`connect`、
  `disconnect`、`reconnect`、`importJson`、`events`、`health`、`toolDisable`），
  定义在 `src/api/routes.ts`，由组合根对外导出；
- 装配面为 `makeRoutes`（各端点控制器实现在 `src/api/routes-controllers.ts`）
  加 `makeEventsRoute`（SSE 通道）与 `makeHealthRoute`（健康检查）；除 `/config`
  的 3.3 节例外外，其余端点均套 `guardLoopbackMethod` 守卫；方法白名单按端点
  划分（`servers` 为 `GET` 加 `POST` 加 `PATCH` 加 `DELETE`，`toolDisable` 为
  `PATCH`，会话与连接类端点为 `POST`，`events` 与 `health` 为 `GET`）；
- 客户端为镜像型（见 4.2 节）。

### 5.3 notifier

源码位置：`packages/dsh-notifier/`，详见 [dsh-notifier.md](dsh-notifier.md)
与 [包 README](../../packages/dsh-notifier/README.md)。

- 端点表在 `src/server/api/impl/service/index.ts` 装配期构造，共 8 条：`config`
  （`GET` 加 `PUT`）、`history`（`GET` 加 `DELETE`）、`status`（`GET`）、`kinds`
  （`GET` 加 `POST`）、`test`（`POST`）、`health`（`GET`）、`diagnostics`（`GET`）、
  `events`（`GET`，SSE 通道）。本包无模块级 `ROUTES` 常量，路径以端点表为准；
- 围栏不套 `guardLoopbackMethod`，而由 `src/server/api/impl/route/index.ts` 的
  `registerEndpoints` 直接调 `isLoopbackRequest` 默认参数再查端点方法表，顺序
  同样是 403 先于 405；405 额外带 `Allow` 头列出支持的方法；
- 拒答体经 `sendRefused` 写出：`error` 保持裸字符串是刻意兼容（旧客户端靠它走
  状态码兜底），`code` 与 `status` 是与之并列的新增 sibling 字段。取值表为
  `src/shared/refusal.ts` 的 `REFUSAL_CODES`（`FORBIDDEN_LOOPBACK` 与
  `METHOD_NOT_ALLOWED`），读侧判定在 `src/client/api-error.ts`。凡涉及读侧
  判定扩展的表述归第 7 节的 #769 边界，本片只记录现状；
- 客户端为镜像型（见 4.2 节），其 8 键与端点表一致。

### 5.4 provider-usage

源码位置：`packages/dsh-provider-usage/`，详见
[dsh-provider-usage.md](dsh-provider-usage.md)
与 [包 README](../../packages/dsh-provider-usage/README.md)。

- 路由表 `ROUTES` 共 16 键（`stats`、`history`、`trend`、`adapters`、`select`、
  `inspect`、`add`、`health`、`uiConfig`、`events`、`reportConfig`、`reportModels`、
  `reports`、`reportDetail`、`reportGenerate`、`reportGenerateStatus`），定义在
  `src/apply/apply.ts`，经 `src/apply/index.ts` 对外导出；
- 处理器分散在 `src/domain1/routes`（用量与适配器面）与 `src/domain2/routes`
  （报表与界面面），均套 `guardLoopbackMethod` 守卫；
- 客户端为注入型（见 4.2 节），`core.ts` 与 `report.tsx` 合计覆盖全部 16 键。

### 5.5 worktree-sidebar

源码位置：`packages/dsh-worktree-sidebar/`，详见
[dsh-worktree-sidebar.md](dsh-worktree-sidebar.md)
与 [包 README](../../packages/dsh-worktree-sidebar/README.md)。

- 路由表 `ROUTES` 共 2 键（`bindings`、`health`），定义在
  `src/shared/contract.ts`（宿主与浏览器共享的唯一必须一致的两件事之一，
  另一件是绑定查询的响应形状），由 `src/index.ts` 组合根对外导出，同时是
  `__DSH_ROUTES__` 的键来源；
- 注册面为 `src/server/api/impl/route/index.ts` 的 `registerEndpoints`：以
  方法表键集合为白名单套 `guardLoopbackMethod` 守卫；注册语义为要么全上、
  要么全不上，中途失败回滚已挂路由后重抛；
- 客户端为注入型（见 4.2 节），无独立样式文件、无定时轮询，请求只在页签挂载、
  官方刷新与窗口可见性变化三类时机发出。

### 5.6 verify-isolated

源码位置：`packages/dsh-verify-isolated/`，包 README 见
[包 README](../../packages/dsh-verify-isolated/README.md)。

- 无路由面、无客户端面：宿主 `apply` 为空实现，能力由官方 provider 经
  `cordis.patch.yml` 挂载，围栏判据不适用。

### 5.7 dsh-plugins-all

聚合包，无自有路由面（聚合 patch 由构建链生成），见
[dsh-plugins-all.md](dsh-plugins-all.md)。行为细节不在本片。

## 6. 测试依赖现状

宿主与客户端的测试依赖是两套，无交叉：

- 宿主集：各包用假请求桩直调路由处理器，按路径断言 403、405 与 403 先于 405
  的顺序。`mcp-manager` 与 `provider-usage` 的 smoke 从 `lib/index.js` 构建产物
  导入 `ROUTES`（构建产物依赖）；`notifier` 的 `route.test.ts` 与
  `worktree-sidebar` 的 `api-routes.test.ts` 直连 `src` 源码面（含 405 `Allow`
  头与拒答体形状断言）；`mcp-manager` 与 `provider-usage` 的 smoke 另对 405
  围栏文案做逐字断言；
- 客户端集：[test/smoke-lib.ts](../../test/smoke-lib.ts) 的
  `assertClientProductContract` 与 `assertClientSourceContract`（复用
  `client-contract-lib.ts`，与门禁同源）对 `lib/client.js` 产物做执行断言；
  [scripts/gate/verify-npm-layout.ts](../../scripts/gate/verify-npm-layout.ts)
  对解包产物做同源断言（含带客户端面的包宿主入口须含 `ROUTES` 或路由字样）；
  `worktree-sidebar` 的客户端单测直调 `src/client` 的 `apply`（源码依赖，含
  `__DSH_ROUTES__` 缺席回落判据）。

## 7. GUI 子集与 #769 边界（本片除外）

下列逐项与 #769 同边界，均排除在本片之外，本规格只记录其现状事实：

- `notifier` 拒答体的 `code` 与 `status` sibling 字段及客户端 `api-error.ts` 的
  读侧判定扩展，归 #769，本片不展开读侧契约；
- `notifier` 客户端的通知展示策略、多标签租约、音频出口与事件会话行为，归 #769
  的客户端重构面，本片只登记其路由路径与围栏；
- 各包设置卡与面板的渲染与编辑面，归 #769 的 GUI 面，本片除外；
- 客户端覆盖率收窄口径（见 [docs/DEVELOPMENT.md](../DEVELOPMENT.md)），归 #769，
  与本片判据无关。

## 8. 判据与门禁归属

路由围栏无集中式判据矩阵（`pnpm contract` 的 config-matrix 段只覆盖配置面，
路由围栏不在其内）。现行判据分散在各包测试与产物门禁中：

- H1：非 loopback 请求一律 403；
- H2：方法不在端点白名单一律 405（`notifier` 另带 `Allow` 头）；
- H3：顺序为 403 先于 405；反向断言只允许一处：`mcp-manager` 的 `/config`
  非 loopback 加白名单外方法返回 405（3.3 节的刻意例外）；
- C1：客户端入口导出形态恰为 `apply` 函数加 `inject` 数组；
- C2：客户端 `load` 标识须等于完整包名；
- C3：注入型客户端取值键须在宿主 `ROUTES` 内，镜像型客户端字面量须与宿主路径
  一致；一致性只靠各包 smoke 兜底，无统一集中门禁。
- 执行点是各包 `vitest`（`e2e` 与 `unit` 项目）与 `verify-npm-layout`；本片
  （纯文档新增）的归属是 `pnpm docs:check`，对应 [docs/GATE.md](../GATE.md)
  改动类型矩阵中改文档的行。
- 门禁语义的唯一出处是门禁代码与源码本身（`verify-npm-layout.ts`、
  `client-contract-lib.ts`、`bundle-host.ts`、`loopback.js`、`host-utils.js`）；
  本文档是现状记录，语义分歧以它们为准。

## 9. 已知风险与缺口

1. 镜像型三包（`lan-proxy`、`mcp-manager`、`notifier`）的客户端路径与宿主路由
   无构建期强一致，改路径须两端同改；一致性只靠各包 smoke 兜底，未收口为集中
   门禁。
2. `notifier` 无模块级 `ROUTES` 常量，路径分散在服务端点表与客户端常量两处，
   对账须两处同查。
3. 跨站放行开关 `allowCrossSiteNoCors` 只允许 serve 类资源伺服路由使用；普通
   `api` 路由透传该开关属违规，本规格登记的 `api` 路由均未透传。
4. `mcp-manager` 的 `/config` 的 `GET` 开放是刻意例外（只读非敏感展示配置），
   不得推广为常规写法；新增只读开放端点须单独立项。
5. 行号锚点历史漂移：文档引用路由一律用 `ROUTES` 加键名的符号名，行号只允许作
   基线快照，不作长期锚点。

## 10. 非目标

- 不新增抽象、不改路由、不改围栏语义、不新增依赖、不碰公共 API；
- 不合并不属于本片的 GUI 改动（见第 7 节）；
- 不对第 9 节的已知风险做实现侧收敛，不新增集中判据；
- 不展开 #769 的读侧契约与客户端重构事项；
- 本片零源码改动：`packages` 下源码、`shared`、`scripts`、`.github`、测试、
  配置、依赖、公共 API 均不在本片触碰范围内。

## 11. 证据与复核方法

- 只读复核命令示例（均不写工作区）：
  `git status --porcelain`（本片只允许出现本文档路径）、
  `pnpm docs:check`（相对链接与命令引用校验）。
- 路由复核用符号搜索（均只读，不以行号为长期依据）：
  搜 `guardLoopbackMethod` 覆盖各包 `src`、搜 `__DSH_ROUTES__` 覆盖各包 `src`
  与共享层及构建链、搜 `isLoopbackRequest` 覆盖各包 `src`。
- 门禁语义的唯一出处是门禁代码与数据文件本身
  （[scripts/gate/verify-npm-layout.ts](../../scripts/gate/verify-npm-layout.ts)、
  [scripts/lib/client-contract-lib.ts](../../scripts/lib/client-contract-lib.ts)、
  [scripts/build/bundle-host.ts](../../scripts/build/bundle-host.ts)、
  [shared/loopback.js](../../shared/loopback.js)、
  [shared/host-utils.js](../../shared/host-utils.js)）；本文档是现状记录，
  语义分歧以它们为准。
