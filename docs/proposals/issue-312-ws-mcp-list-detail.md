# Issue #312 方案 v2（对抗评审修订版）：中间层新增 ws_mcp_list / ws_mcp_detail

> 状态：对抗评审已完成，本版为修订稿
> 范围：packages/dsh-mcp-manager 中间层（ws_mcp_search / ws_mcp_call 同风格扩展）

## 背景与问题

`ws_mcp_search` 空 query 本应返回「能力摘要表」，但实现受 `limit`（默认 5、上限 10）
截断——服务器/工具数超限时只能看到前 N 条，无法盘点工作空间到底配了哪些 MCP、
每个有哪些工具；`SearchHit.inputSchema` 虽在目录缓存中，但无「按 server+tool 精确命中、
返回完整 schema」的独立入口。

## 目标

1. **ws_mcp_list**：列出当前工作空间全部 MCP 服务器 + 每台服务器完整工具清单
   （server、tool、description），不受关键词/limit 截断；支持 server 过滤；
   空返回给出明确提示。
2. **ws_mcp_detail**：按 `@<root>/<server>` + tool 裸名精确查询单个工具详情，
   返回完整 `inputSchema`（properties / required / enum / description）。
3. 兼容性：不改变现有 `ws_mcp_search` / `ws_mcp_call` 在 off/project 模式的行为；
   策略 guard（deny 优先）对新增工具一视同仁。
4. **用户级 MCP（维护者要求）**：all 模式下新增工具必须能看到/查询全局服务器。

## 对抗评审结论（已吸收）

独立 subagent 评审发现并已纳入本版：

| # | 评审发现 | 本版决策 |
|---|---|---|
| A | all 模式 + 有 cwd 会话中全局服务器不可见（resolveRoot 的 @global fallback 仅在无 cwd 时触发；all 模式全局 supervisor 已停、mcp__ 不注册）——「用户级 MCP」未满足 | **修复路由**：search/list/detail 在 all 模式合并查询「项目 root 单元 + @global 单元」；call 在 all 模式放行 `@global` root（全局配置跨工作空间共享，语义成立）。off/project 模式行为不变 |
| B | list 输出 `status` 字段无数据源（disabled 服务器无 connection entry） | 砍掉 `status`；保留 `unavailable`（发现失败原因）；`userDisabled` 的服务器标 `disabled: true`（工具来自 last-good 目录，明示） |
| C | 「上限 500 可全量」数值错误（目录采集上限 512 工具 / 256KB 总量） | 输出加 `toolsTruncated`（per-server + 全局汇总）；默认 50 / 上限 500 入 const 具名常量；文档明确目录是「采集边界内的 last-good 快照」 |
| D | 首次调用竞态：list/detail 不等待 in-flight 发现会空/未命中 | 与 search 对齐：等待 in-flight（8s 预算），超时不阻塞（返回已有目录） |
| E | detail 错误分支不全 | 三分：`unavailable`（发现失败，附原因）/ 服务器未发现 / 工具不存在 |
| F | detail 的 tool 无归一化（call 有 mcp__ 前缀容错） | detail 复用 `normalizeToolName` |
| G | limit 同名不同义（search 全局上限 vs list 每服务器上限） | list 参数改名 `perServerLimit`，描述强制区分 |
| H | server 过滤语义分裂 | list 支持全名/裸名；全名 root 不属于当前 roots → 抛路由一致性错误（与 call 口径一致，防跨空间串台）；search 行为不变 |
| I | MCP_GUIDANCE / README / 目录消息未同步 | 全部同步（见「文档同步」节） |
| J | 常量魔法数 | `LIST_DEFAULT_TOOLS_PER_SERVER` / `LIST_MAX_TOOLS_PER_SERVER` 入 middleware-const.ts |
| K | all 模式全局配置变更不重建 @global 单元（既有缺陷） | 本 issue 不修（既有行为，另开跟踪）；文档注明「全局服务器增删改后重启/触达才刷新目录」 |

## 业界实践（维护者要求：参考优秀实践，确保 agent 好用）

- **两级工具发现（list → detail）**是 MCP 生态标准形态：
  [MCP tool discovery（The Neural Base）](http://theneuralbase.com/function-calling/learn/intermediate/mcp-tool-discovery/)、
  [MCP Protocol Tools（Claude Code 参考）](https://mintlify.wiki/sanbuphy/claude-code-source-code/reference/tools/mcp-tools)、
  [Meta-tools and tool discovery（Giant Swarm）](https://docs.giantswarm.io/overview/ai-agents/meta-tools/)：
  列表只给摘要防上下文膨胀，详情按需拉取完整 schema。
- **工具描述规范**（[Writing Effective MCP Tool Definitions](https://docs.unique.ai/administrators/mcp/the-mcp-hub/writing-effective-mcp-tool-definitions)、
  [Tool Schema Design for Agents](https://apidog.com/blog/designing-api-tool-schemas-for-agents/)）：
  描述写明「何时用我、怎么用、返回什么、失败怎么办」；输出结构化 JSON；
  参数必填/可选、默认值、上限全部显式。
- **错误显式化**：参数校验失败、路由不一致、未找到——一律抛带原因的错误，
  不静默返回空（避免模型误判「无配置」）。

## 工具设计

### ws_mcp_list

```
参数（全部可选）：
  server: string        可选：@<root>/<server> 全名或裸名过滤（全名 root 不属于
                        当前工作空间 → 抛路由一致性错误）
  perServerLimit: number 可选：每服务器工具条数上限（默认 50，上限 500；
                        超过置 toolsTruncated=true，模型可按需调大）
输出：
  {
    workspace: string,      // 当前工作空间 root；all 模式无项目 cwd 时为 "@global"
    mode: "project" | "all",// 中间层模式（模型据此理解可见范围）
    servers: [
      {
        server: string,     // @<root>/<server> 全名
        disabled?: boolean, // 用户已禁用（工具来自 last-good 目录缓存）
        unavailable?: string, // 发现失败原因
        tools: [ { tool: string, description: string } ],
        toolsTruncated: boolean,
      }
    ],
    totalServers: number,
    totalTools: number,
    toolsTruncated: boolean, // 任一服务器截断即为 true
    message?: string,       // 空返回时：无项目级 MCP 配置（project）/ 无可用服务器（all）
  }
```

- **不受 limit 截断服务器**：每台服务器完整列出（工具数受 perServerLimit 保护）。
- all 模式：项目 root 单元 + @global 单元合并；project 模式仅项目单元。
- 空返回 message 区分场景（无配置 vs 发现中——in-flight 等待后仍空）。

### ws_mcp_detail

```
参数（必填）：
  server: string  必须：@<root>/<server> 全名（来自 ws_mcp_list）
  tool:   string  必须：远端工具裸名（兼容 mcp__<server>__<tool> 前缀，复用 normalizeToolName）
输出：
  {
    server: string,
    tool: string,
    description: string,
    inputSchema: Record<string, unknown>,  // 完整 schema（properties/required/enum/description）
    fresh: boolean,                         // 目录是否新鲜（TTL 内）
    disabled?: boolean,                     // 用户已禁用
  }
```

- 精确命中：不做关键词打分、不受 limit 截断。
- 错误三分：`server 发现失败：<原因>` / `server 未连接或未发现` / `tool 不存在`。
- all 模式：允许查询 @global 单元（同 call 口径）。
- 复用目录缓存，与 search 同数据源；等待 in-flight 发现（8s 预算）后再查。

### 路由修复（评审 A，all 模式全局可见）

- search：all 模式合并查询项目 root + @global 单元（off/project 不变）。
- call：all 模式放行 `parsed.root === "@global"`（全局配置跨工作空间共享）。
  仍拒绝非当前 root 的其他项目 root（防跨空间串台）。
- registerMiddlewareTools 新增 `mode` 参数（apply.ts 传入 middlewareMode）。

### 策略 guard

新增工具纯读本地目录（不执行远端工具），与 ws_mcp_search 一致不触达策略 guard；
ws_mcp_call 仍唯一受策略约束（deny 优先）。README 安全模型节注明此边界。

## 实现要点

1. `middleware-utils.ts` 新增纯函数：
   - `listCatalog(units, roots, serverFilter, toolLimit)` → 完整服务器+工具清单
   - `findToolDetail(units, root, server, tool)` → 单工具详情（含 schema）
   - `searchCatalogMulti(units, roots, query, limit)` → 多单元合并检索
     （searchCatalog 保持单 root 包装，兼容既有测试）
2. `middleware-types.ts`：`ListServerEntry` / `ListToolEntry` / `ToolDetail` 类型。
3. `middleware-const.ts`：`LIST_DEFAULT_TOOLS_PER_SERVER` / `LIST_MAX_TOOLS_PER_SERVER`。
4. `middleware-register.ts`：注册 ws_mcp_list / ws_mcp_detail；search/call 按 mode
   修复 all 模式全局可见性。
5. `apply.ts`：registerMiddlewareTools 传 mode；MCP_GUIDANCE 补 list/detail 引导。
6. `catalog.ts`：renderMcpCatalogMessage 引导补「完整盘点用 ws_mcp_list」。
7. 测试：
   - `unit-middleware.test.ts` / `.src.test.ts`：listCatalog / findToolDetail /
     searchCatalogMulti 纯函数单测（完整清单 / 过滤 / 空返回 / 截断标志 /
     unavailable / disabled / detail 三分错误 / tool 归一化）
   - `smoke.ts`：注册 4 工具断言；list/detail execute 路由断言（agent-less 拒绝、
     空返回提示、all 模式 @global 覆盖、call all 模式放行 @global）
8. 文档：README.md / README.en.md 工具列表 + 配置节 + 安全模型节同步。

## 兼容性

- off/project 模式：search/call 行为完全不变；新增工具纯增量。
- all 模式：search/call 修复全局可见性（既有缺陷修复，非破坏）。
- 无新增依赖；无 Config 变更；inject / ROUTES / 契约不变。

## 验收标准

1. ws_mcp_list 返回工作空间全部服务器与每台工具清单（不受 search 的 limit 截断）；
   支持 server 过滤；空返回有明确 message。
2. ws_mcp_detail 按 server+tool 精确返回完整 inputSchema；错误三分清晰。
3. all 模式：list/search 能看到全局服务器，call 可调用 @global 服务器；
   project 模式：全局仍走 mcp__ 直呼（不经中间层，list 不列全局）。
4. 策略 guard 对新增工具不拦截（纯读）；ws_mcp_call 仍受策略约束。
5. 五连门禁全绿；新增 smoke/unit 断言覆盖上述场景。
