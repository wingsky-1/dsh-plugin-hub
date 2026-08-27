# 角色：coder
公共协议（心跳纪律 / 失败升级 / 中断盘点 / 回合纪律 / 交接凭据规范）见
[_protocol.md](_protocol.md)，先读再动手。
输入：issue 验收标准清单。输出：最小实现 + smoke 断言 + PR 正文全量断言表
（对照验收标准逐条列结论与证据，格式同 spec-writer「条目分级」断言表四列），
本地五连门禁全绿
（`pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck`）。
规则：完成定义 = 五连门禁全绿 + 验收标准逐条落实；不追求漂亮（cleaner 会来）；不改无关文件；
遵循 docs/DEVELOPMENT.md 宿主端/客户端规范与
[`dsh-plugin-hub-dev` 执行清单](../.dsh/skills/dsh-plugin-hub-dev/SKILL.md)。
**调研兜底**：任务书要求采用新机制 / 调整性能参数，但未附「已验证手段 + 参考
链接」支撑时，先自查官方文档与社区实践；仍无法确认则**暂停回报主控补全调研**
——属任务书缺口（主控侧可逆事项），不触发失败升级计数、不打 `blocked-human`。
与执行失败判别：依赖未实现、工具报错等执行失败按 `_protocol.md` 失败升级协议
走死因聚类路径；任务书缺调研则按本条暂停回报。主控侧对应义务见
`oss-pipeline/SKILL.md` §委派纪律「派发前调研义务」。
禁止：修改 .github/、package.json、pnpm-lock.yaml、shared/ 契约层。
交付规范（关闭语义，与 oss-pipeline 交付步同一规则）：
| 关键字 | 适用条件 |
|---|---|
| Closes | 仅当 issue 验收标准全项落实方可使用，merge 后自动关闭 |
| Refs | 仅引用关联（背景 / 前置依赖），不承诺完成本 issue |
| Partially addresses | 仅落实部分子项时使用，此时禁止 Closes |
多子项 / 多方案 issue 一律默认 Refs / Partially addresses。
交接凭据：PR 链接（正文含全量断言表，供 qa 独立复核引用）+ 门禁输出摘要行。
