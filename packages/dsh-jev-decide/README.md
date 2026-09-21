# dsh-jev-decide

JEV 决策网关：frozen 预设模板 + 双轨密钥 + 本地密形预检 + SystemOne 官方调用。

一键安装（安装后重启 `dsh web` 生效）：

```sh
dsh plugin --profile web add @wingsky-1/dsh-jev-decide
```

- 模型工具：`ws_jev_decide`（决议）、`ws_jev_list_presets`（只读清单）。
- 回环路由：`/api/dsh-jev-decide/health|config|presets|history|test-connection`。
- 5 预设 frozen（templateVersion 恒为 1）：general / secret-leak（默认关闭）/ plan-review / risk-check / custom。

## 最短上手

1. 安装并重启 `dsh web`（见顶部命令）；设置页出现 dsh-jev-decide 卡片，连接 tab 显示服务可用即宿主端已挂载。
2. 配密钥（二选一）：把已导出的 ENV 名填入 `apiKeyRef`（推荐，值永不落盘）；或展开明文折叠，输入密钥并二次确认（`confirm:true`）。
3. 点测试连接（`POST /test-connection`，空体合法）：回 `ok` + `latencyMs` 即端到端可用；报 `NO_KEY` 先检查 ENV 是否导出或明文是否保存。

## 配置

三文件独立存放于 `~/.dsh/@wingsky-1/dsh-jev-decide/`（感知 `DSH_HOME`，目录 0700 / 文件 0600 / 原子写）：

- `config.json`：`{version:1, connection:{apiKeyRef?,hasPlaintextKey,timeoutMs:8000,maxConcurrency:4,truncBudget:32000}, presets:[5 个 id+enabled+automationCap(0|1|2)], history:{perSession:200,totalSessions:50}}`；
- `presets.json`：开关覆盖层；`secrets.json`：明文密钥唯一落盘处；`VERSION`：存储版本刻度。

PUT `/config`：`apiKeyRef` 须匹配 `^[A-Z][A-Z0-9_]{1,63}$`；与 `apiKeyPlaintext` 互斥；明文须 `confirm:true` 二次确认；形状拒收 400 仅回类别；`baseUrl` 等退役键 400。

## 安全模型

- **离境数据**：仅当本地密形预检未命中且密钥可用时，才向官方基址发送截断后正文 + 题目；命中密形（如 `sk-…`、`AKIA…`、`ghp_…`、私钥块、`password=`）即不离境、直转人工（`appliedSource: local-precheck`）。
- **双轨密钥**：ENV 引用（`apiKeyRef`）优先于明文；切到 ENV 轨即折叠清空 `secrets.json`；明文写入须二次确认，服务端同样校验互斥。
- **0600/0700**：命名空间目录 0700，三文件 0600，经临时文件 + rename 原子写入。
- **掩码面**：GET `/config` 只回 `apiKeyRef` 名与 `hasPlaintextKey`，密钥原文永不回显；形状拒收 400 仅回 `empty|too-short|charset` 类别。
- **secret 预设警告**：`secret-leak` 默认关闭（启用后仍先过本地预检）；历史 `snippetRedacted` 先脱敏后截断 ≤200 字，原始密钥永不入库。
- **BaseURL 写死**：`https://api.typesafe.ai/v1/systemone` 为加载断言常量，不接受任何配置覆盖；PUT 遇 `baseUrl` 类键直接 400。

## 历史

按（工作目录指纹 rootHash，sessionId）分文件 jsonl：每会话 200 条轮转，总会话 50（只保数量语义，mtime 并列时不钉删谁）。查询 `root` 可传完整路径、`rootHash`，或仅传 basename（按 `rootDisplay` 匹配）；删除仅支持单会话（`root` 与 `sessionId` 双必填，basename 多命中即 400）。

## 验证与排障

- 存活：`GET /api/dsh-jev-decide/health` 回 `ok` / `version` / `templateVersion`。
- 围栏：非本机回环一律 403，方法不在表里 405（先判 403 再判 405）。
- 常见失败：`NO_KEY`（无可用密钥）、`PRESET_DISABLED`（预设被关）、`MUTUALLY_EXCLUSIVE`（`apiKeyRef` 与明文同传）、密钥形状 400 仅回 `empty|too-short|charset` 类别。
- 历史查不到：`root` 传完整路径或 `rootHash` 最稳（basename 按 `rootDisplay` 匹配，删除多命中即 400）；`GET /history` 缺省 100 条、上限 500。

## 后续项（deferred，非本版实现）

- **启动自检迁移**：装配期升级链现只做版本锚定（缺席播种/已锚定空转/未来版本拒绝启动）；配置形态自检与旧盘迁移留待加步骤时再写。客户端二次确认（明文写入 `confirm:true`）保留，服务端同样强制。
- **三文件非组写**：config/presets/secrets 三次独立原子写，非事务组写；进程在写盘间隙崩溃可能留下新旧混搭（读侧以“缺口补默认”收敛），该崩溃窗口被容忍，不做预写日志。
