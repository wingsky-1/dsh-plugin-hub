# dsh-mcp-manager 中间层工具设计规范（业界实践调研固化）

> 依据：issue #312 维护者要求「设计 tool 多参考业界优秀实践，输入输出、异常提示」。
> 本规范指导新增 ws_mcp_list / ws_mcp_detail，并**回溯优化既有 ws_mcp_search / ws_mcp_call**。
> 关联 issue：[#312](https://github.com/wingsky-1/dsh-plugin-hub/issues/312)

## 1. 业界实践调研结论（含参考链接）

### 1.1 两级/渐进式工具发现（meta-tool 模式）——本次新增工具的骨架

**Giant Swarm Muster**（[Meta-tools and tool discovery](https://docs.giantswarm.io/overview/ai-agents/meta-tools/)）
是当前最完整的落地范例，管理集群可暴露数百个 MCP 工具，用 meta-tool 间接层避免
上下文污染：

| Muster meta-tool | 用途 | 对应本项目 |
|---|---|---|
| `list_tools` | 发现全部工具 | **ws_mcp_list** |
| `filter_tools` | 廉价筛选：按名/描述/自然语言/标签，返回**有界摘要页** + `truncated` 信号 | ws_mcp_search（优化点） |
| `describe_tool` | 权威完整描述 + schema（**唯一的完整 schema 来源**） | **ws_mcp_detail** |
| `call_tool` | 按名执行 | ws_mcp_call |

关键设计（直接采纳）：
- **摘要页 vs 权威详情分离**：列表只给一行摘要 + `truncated: true` 分页信号，
  完整 schema 只经 describe 按需拉取 → 上下文成本随任务触达，不随平台规模膨胀。
- **懒发现**：服务器未启动时不加载其工具定义；启动后 list 立即反映新能力。
- **命名前缀**：`x_<server>_<tool>` 避免跨服务器冲突（本项目 `@root/server` 全名同理）。

**mcp2cli**（[npm](https://www.npmjs.com/package/@weibaohui/mcp2cli)）：
「按需加载工具 schema + 把 discover-then-call 解析为单次调用——把工具定义挡在
上下文窗口之外」，印证摘要/详情分离的价值。

**OpenBB Progressive Tool Discovery**（[DeepWiki](https://deepwiki.com/MagnusS0/openbb-pydantic-ai/5.4-progressive-tool-discovery)）：
同样「先摘要后详情」的渐进发现，避免一次性注入全部 schema。

### 1.2 工具描述规范（Anthropic 官方，[Tool Design — Writing Tools Claude Uses Correctly](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/mcp-server-dev/skills/build-mcp-server/references/tool-design.md)）

**描述是契约**——它是 Claude 在决定是否调用前唯一读的东西。要求：
1. 说清**做什么** + **返回什么** + **不做什么**（防止错误调用）。
2. **兄弟工具互引**：相似工具各自描述「什么时候用另一个」。
3. **参数收紧**：每个约束都是少一次运行时错误的机会——
   `limit` 给 `int().min(1).max(100).default(20)`，选择给 `enum`，可选参数给默认值说明。
4. **描述每个参数**：`.describe()` 文本直接进 schema，省略 = 浪费。
5. **返回形状可解析**：结构化数据返回 JSON；截断大 payload 并明说
   （`"Showing 10 of 847 results"`）。
6. **错误给下一步**：`"Item X not found. Use search_items to find valid IDs."` ——
   把死路变成下一步。
7. **工具数量**：30+ 时切换 search+execute（本插件正是此形态）。

**MCP 官方 Client Best Practices**（[modelcontextprotocol.org](https://modelcontextprotocol.org/docs/2025-06-18/develop/clients/client-best-practices)）：
客户端应缓存工具列表、处理分页、尊重服务器能力声明。

### 1.3 输入输出设计（业界共识）

| 维度 | 共识 | 落实 |
|---|---|---|
| 输入 | 参数收紧：类型/范围/枚举/默认/描述全显式 | 新增工具 parameters 全字段 describe |
| 输出 | 结构化 JSON（模型可解析）+ render 人类可读文本 | output.schema + render |
| 截断 | 大 payload 截断并**明示**（`truncated`/`Showing N of M`） | list 的 `toolsTruncated` |
| 错误 | 显式异常 + 下一步提示，不静默空 | 新增工具错误三分 + 下一步 |
| 幂等/并发 | 纯读声明 readOnlyHint / isConcurrencySafe | 新增工具 `isConcurrencySafe: () => true` |

### 1.4 对既有工具的优化点（本 issue 顺带落地）

对照上述规范，`ws_mcp_search` / `ws_mcp_call` 现状与差距：

| 现状 | 规范要求 | 优化 |
|---|---|---|
| search 描述「空 query 返回能力摘要表」——实际受 limit 截断且无语义区分 | 摘要页应给 `truncated` 信号 | search 输出补 `truncated` 字段（是否因 limit 截断）；描述明确「盘点用 ws_mcp_list、检索用本工具」 |
| search `limit` 默认 5/上限 10 | 参数收紧 + 显式默认 | 保持（兼容），描述补「上限 10」；文档引导大盘点走 list |
| call 描述「server/tool 来自 ws_mcp_search」 | 兄弟工具互引 | 描述补「来自 ws_mcp_search / ws_mcp_list」；错误分支补「用 ws_mcp_list 盘点、ws_mcp_detail 查 schema」的下一步 |
| call 错误「未连接或连接失败，请先 ws_mcp_search」 | 错误给下一步 | 补「请先 ws_mcp_search 或 ws_mcp_list 确认 server 已连接」 |
| 无 readOnlyHint / destructiveHint | 注解 | 新增工具补 `readOnlyHint: true`（宿主支持时）；call 保持无（会执行远端） |
| MCP_GUIDANCE / 目录消息只教 search+call | 引导完整工具面 | 补「盘点用 ws_mcp_list、查 schema 用 ws_mcp_detail」 |

## 2. 新增工具设计（最终稿）

### ws_mcp_list —— 盘点（对应 Muster list_tools）

```
参数（全部可选）：
  server: string         全名 @<root>/<server> 或裸名；全名 root 不属于当前
                         工作空间 → 抛路由一致性错误（防跨空间串台）
  perServerLimit: number 每服务器工具条数上限（默认 50，上限 500；超限
                         toolsTruncated=true，模型可按需调大）
输出（结构化 JSON）：
  {
    workspace: string,       // 当前工作空间 root；all 模式无项目 cwd 时为 "@global"
    mode: "project" | "all", // 中间层模式（模型据此理解可见范围）
    servers: [
      {
        server: string,       // @<root>/<server> 全名
        disabled?: boolean,   // 用户已禁用（工具来自 last-good 目录缓存）
        unavailable?: string, // 发现失败原因
        tools: [ { tool: string, description: string } ],
        toolsTruncated: boolean,  // 该服务器工具数超 perServerLimit
      }
    ],
    totalServers: number,
    totalTools: number,
    toolsTruncated: boolean,  // 任一服务器截断即为 true（分页信号）
    message?: string,         // 空返回时明确提示（区分无配置/发现中）
  }
```

### ws_mcp_detail —— 权威 schema（对应 Muster describe_tool）

```
参数（必填）：
  server: string  必须：@<root>/<server> 全名（来自 ws_mcp_list）
  tool:   string  必须：远端工具裸名（兼容 mcp__<server>__<tool> 前缀）
输出：
  {
    server: string,
    tool: string,
    description: string,
    inputSchema: Record<string, unknown>,  // 完整 schema（唯一权威来源）
    fresh: boolean,                         // 目录是否新鲜（TTL 内）
    disabled?: boolean,                     // 用户已禁用
  }
错误（显式 + 下一步）：
  - server 发现失败：`server X 发现失败：<原因>。可稍后重试或检查服务器配置`
  - server 未连接/未发现：`server X 未连接或未发现。先 ws_mcp_list 确认已连接`
  - tool 不存在：`server X 无工具 Y。用 ws_mcp_list 查看该服务器全部工具`
```

### all 模式全局可见性（维护者要求 + 对抗评审 A）

`findProjectRoot` 恒返回非 undefined → `resolveRoot` 的 @global fallback 仅无 cwd
时触发；all 模式全局 supervisor 已停、mcp__ 不注册 → **有 cwd 的会话中全局服务器
不可见**（既有缺陷）。修复：
- search/list/detail 在 all 模式合并查询「项目 root 单元 + @global 单元」；
- call 放行 `parsed.root === "@global"`（全局配置跨工作空间共享）；
- off/project 模式行为不变。

## 3. 落地清单

1. `middleware-utils.ts`：`listCatalog` / `findToolDetail` / `searchCatalogMulti` 纯函数
2. `middleware-types.ts`：`ListServerEntry` / `ListToolEntry` / `ToolDetail` 类型
3. `middleware-const.ts`：`LIST_DEFAULT_TOOLS_PER_SERVER=50` / `LIST_MAX_TOOLS_PER_SERVER=500`
4. `middleware-register.ts`：注册两工具 + search/call 描述与错误优化 + mode 分支
5. `apply.ts`：传 mode；MCP_GUIDANCE 同步
6. `catalog.ts`：目录消息引导同步
7. 测试：unit-middleware（纯函数 + 场景）/ smoke（注册 4 工具 + 路由断言）
8. 文档：README 中英 + 工具描述契约
