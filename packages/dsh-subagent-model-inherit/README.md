# @wingsky-1/dsh-subagent-model-inherit

子 Agent 自动继承父会话当前模型与思考等级（demo 演进包，issue #153；独立发包，不进 `dsh-plugins-all` 聚合）。

## 解决什么问题

dsh 0.1.1-rc.2 的子 Agent 模型链路存在两处断裂：

1. `reasoningEffort` 不在 `AgentOptions`（仅 provider/model/maxTokens），子 Agent 创建时无法携带父的思考等级；
2. 父 Agent 的动态模型选择（GUI 切换走 `installModelSelection` waterfall，不写回 options）不传递给子 Agent，子只用静态基值。

后果：用户切换模型后新建的子 Agent 仍用旧模型；思考等级始终为缺省值。

## 工作机制

```
agent/created（根上下文监听）
  ├─ 门1：session.header.origin === 'subagent' 且 parentSession 存在
  ├─ 门2：ctx.agents.get(parentSession) 找到活父（冷恢复跳过）
  ├─ 门3：子 options.provider/model 与父相等（显式覆盖 → 跳过）
  └─ 快照父模型：父日志最近 request/header config → agentDefaultModel.currentSelection()
       └─ 子 scope 安装 agent/request waterfall（仅首请求注入）
```

注入只覆盖 `provider/model/reasoningEffort` 三字段，采样字段原样保留；快照无 effort 时剥离子的继承 effort（对齐官方 `installModelSelection` 语义）。首请求落日志后 loop 以 logged header 延续注入值，无需重复注入。

不注册任何系统提示词——模型不需要知道继承机制的存在。

## 边界行为

| 场景 | 行为 |
|------|------|
| 子 Agent 显式指定 provider/model（workflow / tool config） | 跳过，不注入 |
| 父 Agent 无历史请求（新会话） | 回退 `agentDefaultModel.currentSelection()` |
| 冷恢复、父已销毁 | 跳过（沿用子日志既有 header） |
| 多层嵌套子 Agent | 第 n 层捕获第 n-1 层快照（幂等） |
| 父 Agent 在子运行中销毁 | 快照已捕获，不影响后续请求 |
| fork 型子会话（无 origin 标记） | 不误伤 |

### 已知限制

- 「未指定模型」与「显式指定了恰好等于父基值的模型」在合并结果上不可区分（requested 原始值不过事件面）。后者会被注入父快照——当父 GUI 切换过模型时该注入违背「显式指定优先」，触发条件苛刻、影响限于首请求路由。根治需上游在 durable header 记录 requested overrides 标志。
- 父的 GUI 实时选择（picked）是 apiproxy 私有状态，插件只能读到已落盘的 header config；两者在父未切换时一致。

## 安全模型

本插件不涉及密钥/凭据/远程执行/令牌。它只做模型路由覆盖：读取父 Agent 会话日志中的 request header 配置（provider/model/reasoningEffort 标量），并写回到子 Agent 首个 LLM 请求的路由字段。无网络监听、无文件写入、无 RPC 路由（纯宿主端事件面插件，无客户端半）。

## 开发

```sh
pnpm build   # tsc + bundle-host
pnpm test    # smoke + unit
```

门禁与仓库规范见仓库根 [CONTRIBUTING.md](../../CONTRIBUTING.md) 与 [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md)。
