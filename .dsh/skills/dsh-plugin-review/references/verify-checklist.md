# 验证证据检核表（curl / 浏览器 MCP / smoke）— 唯一事实源

> 用途：评审与实施的「实测验证」证据检核表——**P0/P1 级断言（阻断/安全洞/数据损坏/
> 明显功能错）必须给实测证据，禁止只引代码推理**；P2/P3 允许静态证据并标注「未验证」。
> 各 skill（dsh-plugin-review / dsh-plugin-hub-dev）在验证节引用本文件，
> 不各自内联。来源：dsh-web-file-preview / dsh-notifier 工作流复盘。

---

## 0. 证据分级原则

| 断言级别 | 证据要求 |
|---|---|
| P0 / P1（阻断、安全洞、数据损坏、明显功能错） | **必须实测**：至少一种真实运行证据（curl / 浏览器 / node smoke） |
| P2 / P3（局部体验、可维护性、打磨） | 允许代码引用 + 标注「未验证」 |

每种实测证据要给**证据类型**标注（`证据: curl@431` / `证据: playwright@overlay` /
`证据: smoke@merge-window`），便于复核与回溯。

---

## 1. curl 类检核（宿主路由/围栏/长度/安全头）

- 路由围栏：非回环请求 → 预期 403；方法错 → 预期 405；正常路由 → 200。
- 请求体/路径长度边界：长路径实测命中真实失败码（如 Node 431@~16KB）——**以实测为准，
  不凭文档或推理**。
- 安全头/响应体：敏感面响应无意外泄漏（token/绝对路径/内部信息）。
- health 路由：`/api/<名>/health` 返回 `{ ok: true, ... }`，覆盖状态摘要字段。

## 2. 浏览器 MCP 类检核（client 交互改动用真实浏览器验证）

- 场景：overlay/弹窗、URL 重写、blob 化、Modal 内跳转、DOM 增删、多端形态、
  浅色/暗色双主题——**仅 node smoke 覆盖不到的 DOM 行为必须真点/查 DOM**。
- 做法：构造 fixture（样例 md/图/链接等放工作区如 `fwp-verify/`，**不纳入发布包**）；
  playwright/浏览器 MCP 真实点击 + 断言 DOM 结果（不是只 smoke 纯函数）。
- 多端验证矩阵：哪些可 DevTools 模拟，哪些**必须真机**（iOS/iPad/Windows），
  按 [dimensions.md](dimensions.md) D 维执行。
- 双主题：浅色/暗色各查一遍（`--dsw-alias-*` 变量生效、无硬编码单色）。

## 3. node smoke 类检核（纯函数/契约/围栏）

- 每新增行为配 smoke 断言（fake ctx，无网络）；含 403/405 围栏用例、两端路由一致性。
- 产物契约：`assertClientSourceContract` / `assertClientProductContract`（hub 三种产物形态）；
  零运行时依赖、无游离 css、`lib/` 是构建产物不手改。
- 窗口/批次类逻辑：独立 apply + 短窗口配置 + 短 await；定时器 `unref()` 防吊死测试进程。

## 4. 运行时=最新产物确认（改 client 后必做）

1. 构建产物（build 后 `lib/`）→ 记录 bundle rev/size；
2. 核对运行进程实际加载的产物与构建产物一致（rev/size 比对）；
3. 不一致 → 说明改动**需重启 dsh web 才生效**——**红线：由用户/平台重启，
   agent 不代操作**；提示用户重启后再验证。
> 本项防「验证时改的没生效却误判功能 OK/失败」的假象（实测踩坑：进程未重启
> 导致 413 不生效、600KB 仍 200 的误判）。

## 5. fixture 约定

- 样例数据（md/图/链接/多图）放**工作区目录**（如 `fwp-verify/`），不纳入发布包
  （files 白名单只含 lib/shared 类型/README/LICENSE 等）。
- fixture 命名带用途前缀（如 `sample.md` + `part2.md` 内链目标），便于浏览器验证引用。