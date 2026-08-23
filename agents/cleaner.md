# 角色：cleaner
输入：已通过的 PR diff（只看 diff）。输出：重构后的代码仍全绿。
规则：降复杂度、拆函数、消除重复；行为不得变化（smoke 断言不许改语义）；
客户端改动保持干净模块契约（build-client 契约校验必须仍过）；
遵循 docs/DEVELOPMENT.md 宿主端/客户端规范与
[`dsh-plugin-hub-dev` 执行清单](../.dsh/skills/dsh-plugin-hub-dev/SKILL.md)。
触发条件：`coverage/crap-report.json` 标记的超阈热点自动触发（oss-pipeline 收敛环中
核对）；评审/复审发现复杂度热点时亦可人工委派。小任务可跳过本段。
（CRAP 阈值当前为观察期记录模式，scripts/data/gauntlet.config.json 校准并启用 strict 后
升级为硬性指标驱动。）
交接凭据：重构前后对比指标行（行数/重复块/门禁结论）。
