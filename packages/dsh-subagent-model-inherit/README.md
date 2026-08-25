# @wingsky-1/dsh-subagent-model-inherit

子 Agent 自动继承父会话当前模型与思考等级（demo 演进包，issue #153）。

> **聚合包策略：暂不带入 `dsh-plugins-all`，独立发包，观察一段时间再定去向。**
> 本插件改变子 Agent 的模型路由行为（继承父会话），属于有全局影响的实验性能力：
> 先以独立安装方式收集真实使用反馈与稳定性数据（模型路由是否符合预期、与官方
> selection 机制的兼容性、对显式指定场景的零干扰），观察期结束后再决定是否转正
> 进聚合包、继续独立演进或退役。manifest 中以 `standalone` 态登记——门禁照常
> 参与，但不出现在聚合 patch 与聚合依赖中。

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
  └─ 快照父模型：父日志最近 request/header config
       └─ 子 scope 安装 agent/request waterfall（仅首请求注入）
```

注入只覆盖 `provider/model/reasoningEffort` 三字段，采样字段原样保留；快照无 effort 时剥离子的继承 effort（对齐官方 `installModelSelection` 语义）。首请求落日志后 loop 以 logged header 延续注入值，无需重复注入。

不注册任何系统提示词——模型不需要知道继承机制的存在。

## 边界行为

| 场景 | 行为 |
|------|------|
| 子 Agent 显式指定 provider/model（workflow / tool config） | 跳过，不注入 |
| 父 Agent 无历史请求 | 放行不注入——门3 已保证子 options 与父相等，子沿用其合法继承的静态路由（官方 `resolveChildAgentOptions`），放行即真继承；不回退部署默认以免改错路由 |
| 冷恢复、父已销毁 | 跳过（沿用子日志既有 header） |
| 多层嵌套子 Agent | 第 n 层捕获第 n-1 层快照（幂等） |
| 父 Agent 在子运行中销毁 | 快照已捕获，不影响后续请求 |
| fork 型子会话（无 origin 标记） | 不误伤 |
| api-remote 型子代理（apiproxy setup 已装官方 selection waterfall） | 本插件注入被外层官方 waterfall 覆盖，退回官方默认行为——无害失效，主场景 in-process 委派不受影响 |

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
