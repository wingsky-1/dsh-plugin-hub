# 8. 里程碑、测试与风险登记（子文件）

> 主文件：[dsh-opencode-usage-provider-adapter-plan.md](dsh-opencode-usage-provider-adapter-plan.md)（阶段总览）
> 本文件把 R1~R3+M3b 的验收标准、测试矩阵、兼容性矩阵与风险登记固化下来。

---

## 8.1 里程碑验收

| 里程碑 | 完成判定 |
| --- | --- |
| M0 (已实施) | 探针①②各给「成立」明确结论；记录决定 M1 路径的依据 |
| M1 (已实施) | 适配器注册表 + 内置 OpenCode Go 迁移；旧配置行为等价；适配器契约 smoke 通过 |
| M2 (已实施) | 配置入口可用；用户 JS 注入端到端跑通；加载降级矩阵各场景有 smoke |
| M3a (已实施) | 历史按 provider 分桶 v2；`/history?provider=` 过滤；后台遍历所有注册 provider |
| **R1** | 注册表候选+启用机制可用；`ProviderSummary`/`id`/`label`/`samplePoint` 结构化列声明契约通过；`stripSecrets` 扩展扫 summary 全部字段；`defineUsageAdapter` 工厂可用；snapshot 返回候选详情 |
| **R2** | `POST /adapters/select` 切换 + 缓存失效；`/stats` 内嵌 summary 子树 + 所有接口带 `adapterId`/`hasAdapter`；采样/取数解耦（缓存命中也采样）；后台遍历所有启用适配器；无启用适配器前台隐藏、60s 探测恢复；渲染器 `adapterId` 配对 + `pill` 钩子；历史 `(provider, adapterId)` **多文件分桶（每桶一文件，独立原子落盘）** |
| **R3** | 契约本文档（完整接入清单 + 启用/切换/后台说明）；示例中转站模板补 `summarize/samplePoint`；README 安全模型更新；smoke 三处同步 |
| **M3b** | `settings.section` 独立 tab 出现且四区可用（总览/可视化/适配器候选单选启用/配置编辑）；`settings` 持久化 enabled 选择（重启保留）；切换热生效 |

---

## 8.2 测试矩阵（smoke，全部无网络/无密钥）

| 组 | 用例 |
| --- | --- |
| 契约 | 宿主适配器 `version/providers/id/label/fetchUsage` 校验通过/失败；渲染器 `version/providers/render` 校验；`summarize`/`samplePoint` 可选校验 |
| 注册表 v2 | 同 provider 多候选注册（内置 + 用户）；`select` 切换启用；`get` 只返回启用；无启用条目返回 undefined；`snapshot` 返回候选详情（含 id/label/enabled/status） |
| 路由围栏 | `/stats`、`/history`、`/adapters.json`、`/user/<n>.js`、`POST /adapters/select` 非回环 403、方法错 405 |
| 切换 | `POST /adapters/select` 切换后 stats/history 缓存失效；渲染器 `adapterId` 配对生效；双键历史桶各自独立 |
| 语义分层 | `/stats` 响应含 `summary` 子树 + `adapterId` + `hasAdapter`；胶囊读 summary 不读 windows；面板读 windows/data |
| 采样/取数解耦 | 缓存命中仍 append 采样点；`(provider, adapterId)` 双键桶互不污染 |
| 无适配器隐藏 | 有启用 → 浮窗显示；无启用 → 浮窗隐藏 + 60s 探测恢复；`hasAdapter: false` 响应 |
| 后台 | 定时器遍历所有启用适配器；跳过禁用候选；各自独立采样入桶 |
| 加载 | 用户 js 文件缺失/语法错/版本不符 → warn + 该候选不注册，插件其余照常 |
| 历史 | `(provider, adapterId)` 多文件分桶；`?provider=&adapterId=` 过滤；同分钟去重按 (provider, adapterId) 双键；列数一致性校验；并发落盘隔离（不同桶独立文件不互相覆盖） |
| 割接 | ★ v1 单序列 → v3 多文件（opencode-go 归 builtin 桶）；★ v2 单文件分桶 → v3 多文件；opencode-go 旧历史三窗口列延续；迁移失败保留旧文件+.bak 且插件照常、下次重试（幂等）；重复启动不二次迁移；自定义适配器认领 opencode-go 时旧历史仍归 builtin 桶 |
| 缓存 | 按 `(provider, adapterId)` 维度 TTL/inflight 复用 |
| 护栏 | stripSecrets 覆盖 summary 全部字段 + 值模式匹配（`sk-`/`Bearer `脱敏） |
| 客户端契约 | `exports.apply/inject` 装配、build-client 产物断言（沿用现有 smoke-lib） |
| 设置 tab | `settings.section` 注册/卸载；`installSettingsNamespace` 命名空间被 serve；四区内容；适配器候选单选启用；持久化 enabled 重启保留 |
| 浮窗 | provider 识别随会话变化重渲染；切换适配器后重渲染；无启用适配器隐藏与恢复；竞态 token；双主题/窄屏回归 |

---

## 8.3 兼容性矩阵

| 场景 | 期望 |
| --- | --- |
| 旧配置（无 `adapters`） | 走内置 OpenCode Go（默认启用），行为不退化 |
| 旧客户端 | 不读 `/stats` 响应的 `summary` 子树，只读 `windows`，零影响 |
| 旧宿主（无 `/select` 路由） | 客户端不调用该接口，无影响 |
| 旧 history.json（v1/v2 单文件） | 启动迁移到多文件 v3（`(provider, adapterId)` 每桶一文件），旧文件备份 `.bak` 后移除 |
| 无 settings 服务 | 独立 tab 不注册，浮窗照常 |
| 无 connection/sessions | 回落内置 opencode-go（M0 回落路径） |
| 多节点 web | 各宿主独立采样落盘（沿用现状，不承诺跨机合并） |

---

## 8.4 发布与门禁顺序

1. R1 合入走全门禁：`pnpm build && pnpm test && pnpm contract && pnpm pack:check`
   （+ 聚合包 patch 重新生成 `node scripts/aggregate.ts`）。
2. R2/R3 新增用例并入 `test/smoke.ts` 与共享 smoke-lib。
3. 文档 README（中英）「安全模型」节 +「Provider 适配器开发指南」随代码同 PR。
4. 每阶段独立提交，不攒到一次性。

---

## 8.5 风险登记（评级：H/M/L；缓解）

| 风险 | 级 | 缓解 |
| --- | --- | --- |
| 多适配器 candidate 注册表未加锁并发访问 | H | 注册表操作为启动时同步加载，运行时只读 + 切换接口单次，无并发问题 |
| 切换后缓存失效遗漏 | H | 同一 provider 所有缓存键（stats/summary/history）统一清除，加 smoke 断言 |
| 采样/取数解耦 → 缓存命中 append 重复采样 | M | 同分钟去重仍是同一逻辑（`floor(ts/60000) === floor(lastTs/60000)` → 替换），不重复 |
| 双键历史桶列数不一致 | M | 首次写入记录列数，后续不一致 warn + 跳过（`1-contracts.md` §1.1 samplePoint 约定） |
| 多文件目录/同名冲突（provider/addapterId 含路径分隔符） | M | 文件名规范化：`provider`/`adapterId` 白名单字符（`[A-Za-z0-9._-]`），非法字符转义，杜绝目录穿越/同名覆盖 |
| `summarize` 误做独立网络请求 | M | 契约硬约束 + 代码评审；文档明示「禁止独立网络 IO」 |
| 用户适配器 `samplPoint` 列声明与渲染器列对齐断链 | M | 历史响应 `columns` 字段由 samplePoint 的结构化返回值提供，渲染器依次读取 |
| 无启用适配器隐藏后用户感知丢失 | M | 设置面板「用量统计」tab 始终可见（含无启用适配器的引导入口） |
| 过度设计 | L | 归一化模型压薄（D5）；工厂降载；R1/R2 不做 L2 多适配器并存，留演进点 |
| 第三方适配器供应链 | L | 仅本地文件加载；文档信任边界（`6-security.md` §6.3） |

---

## 8.6 交付物清单

- **代码**：R1 契约+注册表 v2 + stripSecrets 扩展；R2 切换/语义分层/后台多适配器/历史多文件分桶；R3 文档/示例；M3b 设置面板独立 tab。
- **文档**：README（中英）安全模型 + 适配器开发指南；本组 docs 子文件已更新；示例中转站模板补 `summarize/samplePoint`。
- **测试**：smoke 覆盖候选注册/切换/无启用隐藏/双键历史/路由围栏/护栏扩展。