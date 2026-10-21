# dsh-decision-gateway 退役说明（归档）

状态：已决定退役，**不保留任何兼容版本**——无 deprecated 导出、无 shim / 过渡层、无 tombstone 包。
决策与实施范围见 [#1147](https://github.com/wingsky-1/dsh-plugin-hub/issues/1147)。本页是归档说明，
不是迁移指南：该插件没有直接替代品。

## 定位（曾是做什么的）

`@wingsky-1/dsh-decision-gateway` 是一个通用辅助决策网关，JEV 为首个 provider：

- 模型工具：`ws_request_verdict`（决议）、`ws_list_verdict_guides`（只读清单）；
- 回环路由：`/api/dsh-decision-gateway/health|config|presets|history|test-connection`；
- 5 个 frozen 出题规范（general / secret-leak（默认关闭）/ plan-review / risk-check / custom），
  调用方自带全量题目；支持自建预设；
- 双轨密钥（ENV 引用优先 / 明文回退）、本地密形预检、按（工作目录指纹，sessionId）落历史。

它只给建议等级，不持执行器；不适用于自动执行、开放式推理、可靠消息队列。

## 退役理由

1. 原计划是把该独立包适配 DSH `0.2.1-rc.2`（原 Issue 标题即“独立插件适配 0.2.1-rc.2 运行时与工作目录契约”），
   经决策改为**退役**，原适配范围整体作废；对应适配 PR #1155 已关未合入，**作废**，不再续做。
2. 该包处于 `standalone`（非聚合包 active 成员），需独立维护 6 个官方 DSH 精确 peer 与
   `@deepseek-ai/dsh-client-connection` 注入，随版本升级持续付出适配成本。
3. 采用“退役不兼容”策略：不做兼容层，也不发 tombstone 包，避免长期背双份契约。

## 替代

**无。** 官方与本仓均未提供等价能力；需要二选一 / 评分 / 风险建议的场景请自行评估其它方案。
原包也不在 `dsh-plugins-all` 的 active 成员集合内，聚合包行为不受影响。

## 卸载

```sh
dsh plugin --profile web remove @wingsky-1/dsh-decision-gateway
```

卸载后需**重启一次** `dsh web`。设置页卡片、模型工具与回环路由随之消失。

## 残留与清理

以下路径不会被卸载自动删除，按需人工处理：

- `<DSH_HOME>/@wingsky-1/dsh-decision-gateway/`
  - `config.json`、`presets.json`、`VERSION`：配置与存储版本刻度；
  - `secrets.json`：**明文密钥唯一落盘处**（0600）——确认不再使用后应删除该文件；
  - `history/<rootHash>/<sessionId>.jsonl`：历史记录（含脱敏片段），按需保留或删除。
- ENV 引用型密钥不在上述目录；如该 ENV 变量只为此插件导出，可自行取消导出。
- 目录删除前先确认没有其它工具复用 `@wingsky-1/dsh-decision-gateway` 命名空间。

`docs/release-notes/v0.2.*` 中涉及该包的历史发布记录作为发布史**保留**，不随退役清理。

## 相关

- 退役清点与验收（跨仓引用、聚合包 patch、门禁）：#1147。
- 作废的适配 PR：#1155。
