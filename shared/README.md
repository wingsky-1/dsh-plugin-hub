# shared/ —— 插件家族共享层

DSH 插件家族共用的模块（构建期 esbuild 内联进各插件包，不单独发布）。分两类：

- **宿主端**：各包 `src/*.ts` 相对 import，bundle-host 内联进 `lib/index.js`
  （loopback / host-utils / frontmatter / settings-namespace / placement-math 等）。
- **客户端**：各包 `src/client/*.ts` 相对 import，build-client 内联进 `lib/client.js`
  （client/i18n 活绑定等；每 bundle 一份独立副本，包间互不干扰）。

## 模块

| 文件 | 端 | 内容 | 消费方（登记快照） |
|------|----|------|------|
| `loopback.js` | 宿主 | `isLoopbackRequest` 安全围栏（路由 loopback 校验单一事实源） | lan-proxy / mcp-manager / notifier / provider-usage / web-file-preview |
| `host-utils.js` | 宿主 | `writeJson` / `errorMessage` / `readBody`（限长显式化）/ `readJsonBody`（宽松版） | lan-proxy / mcp-manager / notifier / provider-usage / web-file-preview |
| `frontmatter.js` | 宿主 | `parseFrontmatter` / `parseFrontmatterAll` / `setFrontmatterField` / `parseYamlBool` | 历史：commands-files / skill-explorer 同源复制统一；现生产消费已退役（verify-isolated 测试仍引用） |
| `settings-namespace.js` | 宿主 | `installSettingsNamespace`（settings 服务面注入） | lan-proxy / mcp-manager / notifier / provider-usage |
| `mcp-manager-service.d.ts` | 宿主 | MCP 管理器服务契约类型面（消费方只走公开入口） | mcp-manager / codegraph |
| `host/plugin-skeleton.js` | 宿主 | `definePlugin` 骨架 | 无生产调用（见 DEPRECATED） |
| `host/mount-once.js` | 宿主 | 防重复 apply 挂载围栏 | 机制性随包（pack-check 断言副本存在） |
| `placement-math.js` | 双端 | 浮窗/胶囊定位/层级/断点纯函数（#128 → #378 抽取，含 `panelTopForAnchor` 与参数化 `panelZIndexFor(base, dflt)`） | mcp-manager / provider-usage |
| `client/i18n.js` | 客户 | 共享 `t` 活绑定 + `bindLocale`（#348 → #378 抽取；未装配回落 key 本体） | mcp-manager / provider-usage / web-file-preview |

> 消费方登记为快照，新增共享模块必须同步登记消费者与行为契约（准入规则 6）。

## 使用约束

- shared 是**构建期源码依赖**：插件 src 以相对路径 import，构建时由 esbuild 内联进
  各包 lib/ 产物。**发布物必须自包含**——npm 包内不得残留 `../../shared` 运行时引用。
- 修改 shared 后回归：`pnpm build && pnpm test`（回归全部插件 smoke）+
  `pnpm typecheck`（shared 双写 d.ts 与消费方类型一致性）。
- **js + d.ts 双写**（tsc rootDir 硬约束）：shared 实现一律 `.js` + `.d.ts`（不可 TS 化），
  类型经 d.ts 解析、实现经 esbuild 内联；client 侧同理（`shared/client/`）。
- 新增 shared 模块须满足下方准入规则；废弃走 DEPRECATED 两步走。
- **发布面**：`.d.ts` 声明经 bundle-host **d.ts X1**（2a 引用改写 + 2b 副本随包）随每个
  消费包发布，pack:check 双向断言（查缺 + 查多 retired 残留）兜底——机制说明见
  [DEVELOPMENT.md d.ts X1 小节](../docs/DEVELOPMENT.md#user-content-dts-x1)，此处不重复。

## 准入规则（新增模块必须全部满足）

1. **≥2 稳定消费者**：至少两个插件包实际使用；单一消费者留在包内，不进 shared。
2. **无包级常量依赖**：核心逻辑不得闭包引用包级常量（如 `DEFAULT_Z_INDEX_BASE`
   10 vs 40）；包差异经参数化（`panelZIndexFor(base, dflt)`）或薄 facade 注入。
3. **跨 apply 状态语义明确**（允许模块级可变状态的唯一形态——bundle 私有活绑定，
   如 `client/i18n.js` 的 `export let t`）：
   - 每 bundle 经 esbuild 内联独立副本，**不跨包共享实例**；
   - **显式生命周期契约**：bind/unbind 配对、disposer 必达（重复 apply 不累积旧回调）；
   - **不参与包间共享状态**：可变状态不得作为跨包通信载体。
4. **无跨 apply 泄漏**：不引入未经卸载监听/闭包/定时器累积（T4/T5 红线）。
5. **登记消费者与行为契约**：本表登记消费方 + 行为契约（如「未装配回落 key 本体」），
   smoke/单测锁定行为。
6. **独立测试**：新增模块须带独立单测（如 `scripts/test/shared-client-i18n.test.ts`）。
7. **显式废弃两步走**：先在模块头标注 DEPRECATED 并观察期保留，再移除并迁移全部消费方。

> ⚠️ 活绑定语义依赖 **esbuild 同 bundle 内联**（每 bundle 独立副本、import 侧即时可见
> 重绑）。若未来客户端构建改为共享 chunk / 跨包复用产物，须重新验证该假设
> （见 `shared/client/i18n.js` 头注释）。

## DEPRECATED

- `host/plugin-skeleton.js`：`definePlugin` 骨架无生产调用（T12：试点迁移或归档二选一，
  不长期悬置）。