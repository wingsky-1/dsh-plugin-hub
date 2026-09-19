# #768 重构施工计划表（目标架构 v3 落地顺序，rev2）

> 目标锚：v3 `draft-768-target-arch.md` + PR #920（4A 图：BA 11 边 / AA 19 边 / DA 12 边 / TA 9 边，四图复核已采纳）+ `docs/architecture/dsh-provider-usage.md` 目标版。
> 基线：`origin/main@66dc2865`。方法：`docs/ARCHITECTURE-METHOD.md` §11（每阶段单提交、可独立回滚；顺序：尺子→度量→缺陷→契约共享→分层→接口→测试）。
> 铁律：单域单行单提交（rev1 P0-1 返工：S1/D4–D7/D8–D9 已拆分）；每步跑类型构建 + 契约导入门禁链路探针；等价性 A/B/C 分级 + 整模块重写面基线逐条对账。
> 本表是 #768 施工顺序，落地后随收官删除或转附录，不进长期维护。

## 0. 开工门槛（先合后干）

| # | 门槛 | 状态 |
|---|---|---|
| 0-1 | v3§2 + PR§2 回写 upgrade 解耦定义（运行时完全解耦：UpgradeDeps = logger + root 解析 + 旧文件显式读面，无业务实例，装配前 await 失败即抛；源码允许纯面复用：schedule 纯函数 type+pure，per-root 链留 schedule 经 deps 注入，不新建 file-io 叶） | 待合（落点在目标文档，不在本表） |
| 0-2 | 4A 图与文字同词（AA 图 U0/U1/U2 边即定义） | 已合 |
| 0-3 | 门禁尺子：verify-dir-imports 叶子粒度（server 分组层透明）、export-surface 逐入口比对基线就位 | 待验（S1 落地） |

## 1. 地基层（S1→S2→S3，契约共享先于结构实现）

| 提交 | 范围（单域单行） | 验收判据 | 等价证据 | 回滚 |
|---|---|---|---|---|
| S1 | 门禁尺子：verify-dir-imports 叶子粒度 + export-surface 逐入口基线 + topology 登记（无业务改动） | 环/直引计数基线落盘（四要素：commit + 脚本 + 粒度 + 单位） | 导出面快照零漂移（空壳前基线） | 单提交 revert |
| S2 | 契约与共享层：server/shared 新叶 errsurf（三域写 + 健康读，Q5 尺子）+ schedule 纯面先行（LAST_RUN_SCHEMA/derive/align 经 interface，type+pure）+ config 归一化单答案/LEGACY 映射表先行（type-only）+ UpgradeDeps 窄面冻结；per-root 链留 schedule（METHOD §3 Q1 有主即止，不新建 file-io 叶） | 他域经本域 deps 声明依赖（事实×意图图可对照）；断门面注入必须红 | 导出面快照零漂移 | 单提交 revert |
| S3 | upgrade 三步实现（经 S2 注入面：文件原语走 schedule per-root 链注入，语义走纯函数复用）：存储归位（纯字节搬移）+ 配置形态割接 + last-run 迁移 | 任一步失败即抛，吞错必须红；幂等三条：失败不回写刻度必须红、已存在覆盖必须红、坏文件容错读（保持原状 + 诊断） | 迁移前后落盘字节对账 + upgrade 先于业务域装配（改序必须红） | revert 后刻度未动 |

## 2. 域搬迁（每行一提交，可单独回退）

| 提交 | 域 | 内容 | 验收（判据句） |
|---|---|---|---|
| D1 | config 新域 | report-config-service 归入；report config 形态 + 归一化单答案；LEGACY_PROMPT V1–V4 旧词锁表 | 根只递 root+initial+onUpdate，根内无业务判断必须红 |
| D2 | schedule | 到期判定 + 串行执行（两题不拆）；per-root 链 + 读写原语 + schema 本域归属 | 60s 轮询 + 5min 预热汇入 getStats，拆坏锁必须红 |
| D3 | execute | parseReportIndexLines + runner 记忆化迁入 | 轮询否定判据用 toFake 面 + pollUntil，裸 sleep 必须红 |
| D4 | adapters | domain1 下移；契约校验 fail-fast | 非法适配器拒收必须红 |
| D5 | history | domain1 下移；补并发三条（大跨度/同戳/故障注入） | 落盘时序先设 DSH_HOME 后 import，时序反了连跑必须红 |
| D6 | pipeline | domain1 下移；取数渲染管道 | 净化缺失必须红 |
| D7 | registry | domain1 下移；候选 + 唯一启用 | 双启用必须红 |
| D8 | aggregate | domain2 下移；随行修正 deletePromises 注解、A4(f) 补 dir、forgetPersisted 删除；性能预留延期标未验证 | store 多错语义不动（另立行为评审，改多错必须另立评审） |
| D9 | collect | domain2 下移；resolveCwd 运行时观测后裁决（延期标未验证，owner collect） | 超时悬挂必须红 |
| D10 | data-routes | domain1/routes 改名（stats/history/适配器管理） | 越围栏必须红（403 先于 405） |
| D11 | report-routes | 执行面：配置服务窄面消费 + 任务队列 + 执行器 | 逆序释放，复位标记缺失必须红 |
| D12 | ui-routes | 一域四块（health/trend/ui-config/SSE，块级切分不升域）；SSE 非可靠 | 健康读 errsurf；SSE 断线帧丢失为预期（e2e 可观测断言，pollUntil；补帧断言必须红） |
| D13 | 组合根收尾 | 测试钩子移出包入口（export-surface snapshot 证明，owner 组合根）；common 消除确认（目录消失）；directImpl 清零；49 弃用清零后 prune 收基线 | 环与直引清零；包入口新增导出必须红 |

## 3. 测试与门禁（绑定 D 行验收列，同原子，不另起 PR）

| 项 | 要求 | 绑定 |
|---|---|---|
| integration 新建 | test/integration 进变异面；v3§5.1 每条附判据句 | S3/D2/D5/D10–D12 验收列 |
| 面→级映射 | A 差分 / B 定向变异 / C 只读论证 + 基线对账（改名面禁先跑差分，先对账） | D10–D12 |
| 删测登记 | 文件:行 + expect + 加强/弱化 + 待补落点 + owner；删段/并段单独登记；探针 worktree 隔离 + 双同步 | 全 D 行 |
| 重构期六动作 | 拓扑重切与搬家同原子；--force 重测；coverage 快照；CRAP/complexity 分验；.mjs 另立覆盖率锚；重基线只升 | D4（.mjs）/ 全 D 行 |

## 4. #771 移交（双坐标：旧 domain1/2 → 新 server 域，owner 见 evidence-pack 附录 L22–L33；flaky L34 除外）

- D5 history：并发三条。
- D8 aggregate：多错语义冻结、deletePromises 注解、A4(f) 补 dir、forgetPersisted 删除、性能预留延期。
- D9 collect：resolveCwd 延期（owner collect）。
- D13 组合根：钩子移出包入口（snapshot 证明）。
- S3/D2：ensureLastRunMigrated 走注入写面。
- e2e（D12）：pollUntil 化 + 可观测断言；3 处裸 setTimeout 中 1 处刻意 IO 延迟注明保留，其余改造。
- 随搬家：JSDoc 错位修正。

## 5. 收官检查

- 导出面零漂移；leaf/file 环与 directImpl 清零；common 消失；跨域值边只经 deps.ts 且 Pick 收窄；组合根无业务判断、装配卸载成对逆序。
- 本表每行粘贴实际 exit code；任一非 0 不得声称完成。
