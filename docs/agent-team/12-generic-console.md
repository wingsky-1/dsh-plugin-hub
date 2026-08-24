# Agent Team 通用框架 —— Team Console（v2 修订）

> 配套：[10-generic-model.md](10-generic-model.md)、[11-generic-runtime.md](11-generic-runtime.md)
> v2 变更：单入口原则落地；通讯矩阵编辑器改为 **auto/explicit 双模**；建团向导降级到 G2；写路径收敛为两处并加围栏。

## 1. 页面结构

```text
Team Console
├── Teams 列表页              # 实例、保留态、活跃房间数
├── 运行视图（Monitor）        # 四层 drill-down（沿用，全只读）
│   ├── L1 树形房间框图        # 着色仅依赖保留态三元组
│   ├── L2 房间抽屉
│   ├── L3 成员时间线          # + archive_ref 归档关联渲染
│   └── L4 transcript 回放页   # session_id → DSH 原生记录
├── Gates 待办                # ★ 人机单入口之二：批准/驳回
└── 建团向导（Create）         # ★ G2 交付；此前用 team-cli + 手写 team.yaml
```

## 2. 单入口原则的 UI 落地

人只出现在两个地方：

1. **与 Tier-0 主控对话**（复用 dsh web 现有会话界面，Tier-0 即根会话角色）
2. **Gates 待办**（异步裁决）

其余一切对人是只读投影。Console 不提供任何"直接指挥子代理"的操作——指挥是 Tier-0 的职权，人的干预通过对话 Tier-0 或 Gate 裁决表达。

## 3. Gates 待办（Q2 裁决：走 dsh 原生任务/todo 能力，人绝不读文件）

- **展示层用原生**：Tier-0 巡场发现 pending Gate 时，通过原生 todo/任务能力把待审项写入其会话任务清单 → web GUI 原生渲染，维护者在熟悉的界面看到待办，不接触 `gates/` 目录
- 待办项内容 = 待审上下文本体（如批次清单表），就地可读，不必跳归档链接
- **批准入口双通道**：
  1. Web 批准按钮 → `POST team/gates/:id/resolve` 写 `gates/<id>.json`（事实源不变）
  2. 对话 Tier-0（"批准计划门"）→ Tier-0 经 `team_gate_resolve` 工具落账
- 唤醒链路：巡场下一轮读到 resolved → send_message 唤醒挂起子（见 11 文档 §4）
- 权限边界不变：`gates/*.json` 是唯一事实源，原生 todo 只是投影；agent 永远不能代写 approved

## 4. 建团向导（G2；auto 模式先行）

四步向导，产出实例快照 `team.yaml`：

| 步骤 | 内容 | v2 变更 |
|---|---|---|
| Step1 模板与层级 | 选模板；层级可配（默认 3，上限 `resources.max_tiers` 约束），每级可换 prompt（上传内容即内联入快照+hash） | 可配性优先，超限即时提示 token 风险 |
| Step2 角色池 | 勾选 roles、编辑 dod 结构化清单（将注入 judge 核验） | dod 有真实语义 |
| Step3 通讯拓扑 | 默认 **auto**（不出现任何编辑器）；切换 explicit 时才展示树形预览上的白名单勾选（只能收窄树边，越界即时红框） | ★ 替代原 CommMatrixEditor |
| Step4 归档与资源 | file/url 两型绑定、resources 上限（含 max_tiers）、Gate 勾选 → 快照确认 | 类型固定两种 |

服务端 `POST team/instances` 二次校验（模板闭合、白名单 ⊆ 树边、archive target 限位 TEAM_HOME 内、全局实例数上限），客户端校验仅为体验。

## 5. 运行视图泛化要点（相对原 03 文档）

- **着色只依赖保留态** running/blocked/done；业务子状态（building/review…）仅作文字徽标——任何模板下视图语义稳定
- **归档关联**：事件带 `archive_ref` 时时间线内联渲染（url 外跳按钮 / file 路径），无绑定则无该元素，不留死链 UI
- 其余沿用原 03 文档：drawer+路由混用、query 参数还原现场、移动端 sheet 降级、增量轮询、纯文本渲染安全约定

## 6. 供数 API

| 路由 | 方法 | 说明 |
|---|---|---|
| `team/overview` `team/events` `team/transcript` | GET | 只读，同前 |
| `team/gates` / `team/gates/:id/resolve` | GET / POST | Gate 待办与裁决 |
| `team/templates` | GET | 模板与 prompt 注册表（向导数据源，G2） |
| `team/instances` | POST | 实例化（G2；服务端强校验 + 围栏） |

全部路由 loopback 围栏。写路径仅 `gates resolve` 与 `instances` 两处。

## 7. 分期对齐（成本收益纪律）

| 阶段 | Console 交付 |
|---|---|
| G0/G1 | 无 Console 也完整可用（team-cli + 手写 yaml 是极客路径）；G1 附最小运行视图 + Gates 待办 |
| G2 | 建团向导（auto 先行）、explicit 编辑器、归档渲染增强 |

触发条件不变：**第二个异构模板真实跑通后**，向导的通用化投入才回本。

## 8. 验收要点

- [ ] 无 Console 时全流程可跑通（CLI 路径完备）
- [ ] auto 模式下向导不出现拓扑编辑器；explicit 收窄越界被客户端与服务端双重拦截
- [ ] Gate 批准实际解除挂起（端到端验证唤醒链路）
- [ ] 人无法从 Console 直接操作子代理（只读边界）
- [ ] 框架 UI 文案零业务词汇；暗色/浅色、移动端降级达标
