# 8. 里程碑、测试与风险登记（子文件）

> 主文件：[dsh-opencode-usage-provider-adapter-plan.md](dsh-opencode-usage-provider-adapter-plan.md)（阶段总览）
> 本文件把 M0–M3 的验收标准、测试矩阵（遵循仓库 smoke 门禁纪律：无网络、无密钥、
> 本地直跑）、兼容性矩阵与风险登记固化下来。

---

## 8.1 里程碑验收（结合主文件 §2）

| 里程碑 | 完成判定 |
| --- | --- |
| M0 | 探针①②各给「成立 / 不符及替代」明确结论；记录决定 M1 路径的依据（`2-…`） |
| M1 | 内置 OpenCode Go 迁入适配器框架；旧配置行为等价（浮窗渲染一致）；适配器契约 smoke 通过 |
| M2 | 配置入口可用；示例中转站端到端跑通（识别→拉数→渲染）；加载降级矩阵各场景有 smoke |
| M3 | 独立 tab 出现且四区可用；多 provider 各自历史/图表不混淆；v1→v2 迁移有回归用例 |

---

## 8.2 测试矩阵（smoke，全部无网络/无密钥）

| 组 | 用例 |
| --- | --- |
| 契约 | 宿主适配器 `version/providers/fetchUsage` 校验通过/失败；渲染器 `version/providers/render` 校验 |
| 路由围栏 | `/user/<n>.js`、`/adapters.json`、`/history?provider` 非回环 403、方法错 405 |
| 加载 | 用户 js 文件缺失/语法错/版本不符 → warn + 该 provider 回落，插件其余照常 |
| 注册表 | 用户覆盖内置（同 provider）；未命中 → no-adapter；多 provider 并存查表 |
| 历史 | v1→v2 迁移；按 provider 分桶；同分钟去重按桶；超龄裁剪按桶；`?provider` 过滤 |
| 缓存 | 按 (provider,baseUrl) 维度 TTL/inflight 复用 |
| 客户端契约 | `exports.apply/inject` 装配、build-client 产物断言（沿用现有 smoke-lib） |
| 设置 tab | `settings.section` 注册/卸载；`installSettingsNamespace` 命名空间被 serve |
| 浮窗 | provider 识别随会话变化重渲染；取消/竞态 token；双主题/窄屏回归（沿用现有） |

---

## 8.3 兼容性矩阵

| 场景 | 期望 |
| --- | --- |
| 旧配置（无 `adapters`） | 走内置 OpenCode Go，行为不退化 |
| 旧 history.json（v1） | 启动迁移到 v2 分桶，保留 .bak 备份 |
| 无 settings 服务 | 独立 tab 不注册，浮窗照常 |
| 无 connection/sessions（探针①失败回落） | providerHint 白名单兜底，核心不变 |
| 多节点 web | 各宿主独立采样落盘（沿用现状，不承诺跨机合并） |

---

## 8.4 发布与门禁顺序

1. M1 合入走全门禁：`pnpm build && pnpm test && pnpm contract && pnpm pack:check`
   （+ 聚合包 patch 重新生成 `node scripts/aggregate.ts`）。
2. M2/M3 新增用例并入 `test/smoke.ts` 与共享 smoke-lib。
3. 文档 README（中英）「安全模型」节 +「Provider 适配器开发指南」随代码同 PR。

---

## 8.5 风险登记（评级：H/M/L；缓解）

| 风险 | 级 | 缓解 |
| --- | --- | --- |
| 客户端能否拿 `SessionModels.current.provider` 未实测 | H | M0 探针①先行；失败回落 providerHint+标题兜底（2.2） |
| `settings.section` 注册无先例 | M | M0 探针②；降级为 plugin.item 卡片 + 引导 |
| React externals 重构引入移动端/双主题回归 | M | 现有 DOM 挂载保留作默认渲染对照；逐项回归 |
| 多 provider 采样归属（后台不知 GUI 选中会话） | M | 前台归属 + 后台多 provider 轮询 + v1 迁移（4.3） |
| 用户 js 时序/版本脆弱 | M | D4：插件主动加载 + 契约版本化（3.4） |
| 用户适配器回传密钥 | L→M | stripSecrets 护栏 + 安全文档化（6.2） |
| 过度设计 | L | 归一化模型压薄（1.2）/ 最小公约数 |
| 第三方适配器供应链 | L | 仅本地文件加载；文档信任边界（6.3） |

---

## 8.6 交付物清单（评审通过、用户确认后）

- 代码：宿主端（契约本 + 注册表 + 注入 + 内置迁移 + 历史分桶 + settings namespace）+
  客户端（渲染分派 + 内置渲染器迁移 + settings.section + 独立 tab 页）。
- 文档：README（中英）安全模型 + 适配器开发指南；本组 docs 子文件；示例中转站模板。
- 待确认（主文件 §8 之外）：单击卡交互验收样例（需用户给 1–2 个目标 provider）、
  是否要求旧配置完全无感升级（建议要求）。
