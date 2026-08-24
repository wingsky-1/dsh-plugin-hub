# Agent Team 前端架构 —— web team 视图

> 配套：[01-overview.md](01-overview.md)、[02-backend.md](02-backend.md)
> 定位：协作过程与进度的只读监控视图。**纯投影，不含任何写路径、不调 LLM。**

## 1. 载体与约束

做成 dsh 插件（hub 标准形态），在现有 `dsh web` GUI 内新增一个独立面板/页面入口，不另起服务：

- 客户端为干净模块：只 `export function apply(ctx)` + `export const inject`，样式独立 `src/client/style.css`，构建走 `build-client.ts`，patch id 用 `ui-agent-team`
- 数据一律来自宿主端三个只读路由（见 02 文档 §10），路由强制 loopback 围栏
- 多端兼容：桌面为主形态，移动端降级为全屏 sheet；暗色/浅色主题跟随宿主变量

## 2. 信息架构：四层 drill-down

```
L1 树形房间框图          L2 房间详情            L3 agent 会话摘要        L4 原始信息
┌──────────────┐  点击  ┌──────────────────┐  点击  ┌────────────────┐ 点击 ┌─────────────┐
│ ▣ 主控        │──────▶│ 参与agent列表     │──────▶│ 原始会话回放(跳转)│────▶│ transcript  │
│ ├─ issue-42 ● │ 抽屉  │  每人:角色+状态+   │ 弹窗  │ 会话摘要→弹窗    │     │ issue 评论   │
│ ├─ issue-43 ✓ │       │  会话摘要条目      │       │ 原始消息+关联评论 │     │ (外链GitHub) │
│ └─ issue-44 ⚠ │       │ 正在进行的事情     │       │                │     │             │
└──────────────┘       └──────────────────┘       └────────────────┘     └─────────────┘
```

每层只比上层多一个粒度，节点数据全部由事件日志归约，无独立状态：

- **L1 节点** = `{房间描述, current_activity}`；current_activity 由最后一条 `stage-change` + 最后一条 `handoff` 折叠而来
- **L1 着色承载主要信息**：运行中 / 阻塞（最醒目）/ 已完成 / 排队中
- **L2 条目** = 成员 `{actor, role, 状态, 最近凭据摘要}`
- **L3** = 该成员事件流时间线；每条摘要可弹窗看原始 payload + `github_url` 外链

## 3. 交互决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 中间层（房间/成员/摘要） | 右侧抽屉 drawer 或就地展开 | 监控场景需保持树上下文，看一眼即返 |
| 原始会话回放 | 路由跳转独立页 | 内容长需滚动阅读；可收藏/分享 |
| 现场还原 | 抽屉状态同步 query 参数（`?room=issue-42&actor=coder`） | 刷新/分享均可还原 |
| 移动端 | 抽屉自动降级全屏 sheet | 小屏可用性 |

## 4. 数据获取

- v1 前端轮询：`GET team/events?room=&since=<ts游标>` 增量拉取；overview 低频轮询（如 5s）、打开的房间高频（如 2s）
- 事件自带 ts，天然支持增量；无 WebSocket、无文件 watch（v2 再评估）
- transcript 回放页懒加载：仅在用户点进 L4 时请求 `team/transcript?session_id=`，宿主端解压返回

## 5. 视图模块划分

```text
src/client/
├── apply.ts            # 入口：注册面板路由与挂载点
├── api.ts              # 三个只读 API 的类型化封装
├── model.ts            # 事件流 → 视图模型的纯函数归约（可单测）
├── components/
│   ├── RoomTree.tsx        # L1 树形框图（SVG/CSS 布局）
│   ├── RoomDrawer.tsx      # L2 房间抽屉
│   ├── AgentTimeline.tsx   # L3 成员事件时间线
│   ├── TranscriptPage.tsx  # L4 会话回放页
│   └── common/             # 状态徽标、着色规则等
└── style.css
```

设计原则：`model.ts` 的归约逻辑是纯函数（输入 events.jsonl 切片，输出树/时间线模型），与 UI 解耦，可直接用 smoke 断言覆盖——视图正确性 = 归约正确性。

## 6. 渲染安全（硬性约定）

- 所有事件 payload、transcript 内容**一律纯文本渲染**：不解析 markdown、不自动展开链接/图片预览
- `github_url` 仅以显式"在 GitHub 打开"按钮形式外跳，不内嵌 iframe
- transcript 可能含环境输出等敏感内容：页面仅存在于 loopback 围栏之内，不新增任何出站请求

## 7. 验收要点

- [ ] 树总览一屏可见全部房间状态，阻塞房间的视觉权重最高
- [ ] 任一 agent 可三击内到达其原始会话回放
- [ ] 断网/后端不可用时优雅降级（保留最后一次快照 + 重试提示），不白屏
- [ ] 移动端宽度下四层 drill-down 全部可达
- [ ] 暗色 / 浅色主题下着色语义一致（阻塞红、完成绿等不依赖单一色相，辅以图标）
