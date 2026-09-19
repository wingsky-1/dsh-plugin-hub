# #768 重构施工计划表（目标架构 v3 落地顺序）

> 目标锚：v3 `draft-768-target-arch.md` + PR #920（4A 图：BA 11 边 / AA 19 边 / DA 12 边 / TA 9 边）+ `docs/architecture/dsh-provider-usage.md` 目标版。
> 基线：`origin/main@66dc2865`。方法：`docs/ARCHITECTURE-METHOD.md` §11（每阶段单提交、可独立回滚）。
> 节奏铁律（统一 spec）：一个域一个提交；每步跑类型构建 + 契约导入门禁链路探针；等价性 A/B/C 分级 + 整模块重写面基线逐条对账。
> 本表是 #768 施工顺序，落地后随收官删除或转附录，不进长期维护。

## 0. 开工门槛（先合后干）

| # | 门槛 | 状态 |
|---|---|---|
| 0-1 | v3§2 + PR§2 回写 upgrade 解耦定义：运行时完全解耦（UpgradeDeps = logger + root 解析 + 旧文件显式读面，无业务实例；装配前 await，失败即抛）+ 源码允许纯面复用（schedule 纯函数 type+pure，文件原语经 server/shared 新叶注入） | 待合 |
| 0-2 | 4A 图与文字同词（AA 图 U0/U1/U2 边即定义） | 已合（本分支） |
| 0-3 | 门禁尺子：verify-dir-imports 叶子粒度（server 分组层透明）、export-surface 逐入口比对基线就位 | 待验 |

## 1. 地基层（先行，不碰业务）

| 提交 | 范围 | 验收判据 | 等价证据 | 回滚 |
|---|---|---|---|---|
| S1 | 门禁尺子 + 空 upgrade/config/schedule 壳域（interface/deps 先行，无实现搬迁） | 环/直引计数基线落盘（四要素：commit + 脚本 + 粒度 + 单位） | 导出面快照零漂移 | 单提交 revert |
| S2 | upgrade 三步实现：存储归位（纯字节搬移）+ 配置形态割接 + last-run 迁移（derive/align 纯复用 + 文件原语注入落盘） | 任一步失败即抛（吞错必须红）；幂等：失败不回写刻度、已存在不覆盖、坏文件容错读 | 迁移前后落盘字节对账 + 集成链路覆盖 | revert 后刻度未动 |
| S3 | server/shared 新叶：errsurf（三域写 + 健康读）+ file-io（per-root 链 + 读写原语，mcp file-io 对标） | Q5 尺子论证留痕；零 node 全局依赖 | 直引改经门面后断注入必须红 | 单提交 revert |

## 2. 域搬迁（每行一提交，可单独回退）

| 提交 | 域 | 内容 | 验收 |
|---|---|---|---|
| D1 | config 新域 | report-config-service 归入；report config 形态 + 归一化单答案；LEGACY_PROMPT V1–V4 旧词锁 upgrade 映射表（type-only 复用） | 根只递 root+initial+onUpdate；根内无业务判断 |
| D2 | schedule | 到期判定 + 串行执行（两题不拆）；LAST_RUN_SCHEMA + derive/align 纯面归属本域 interface | 60s 轮询 + 5min 预热汇入 getStats（拆坏锁必须红） |
| D3 | execute | parseReportIndexLines + runner 记忆化迁入 | SSE/轮询否定判据（toFake 面 + pollUntil，不用 sleep） |
| D4–D7 | adapters/history/pipeline/registry | domain1 下移；history 补并发三条（大跨度/同戳/故障注入） | history 落盘时序（先设 DSH_HOME 后 import） |
| D8–D9 | aggregate/collect | domain2 下移；随行修正：deletePromises 注解、A4(f) 补 dir、forgetPersisted 删除、resolveCwd/性能预留标延期未验证 | store 多错语义不动（另立行为评审） |
| D10 | data-routes | domain1/routes 改名（stats/history/适配器管理） | 越围栏必须红 |
| D11 | report-routes | 执行面：配置服务窄面消费 + 任务队列 + 执行器 | upgrade 先于业务域装配（改序必须红）、逆序释放 |
| D12 | ui-routes | 一域四块（health/trend/ui-config/SSE，块级切分不升域） | 健康读 errsurf；SSE 非可靠（断线不补） |
| D13 | 收尾 | common 消除确认（目录消失）；directImpl 清零；49 弃用清零后 prune 收基线 | 环与直引清零；common 不存在 |

## 3. 测试与门禁（与搬迁同原子，不另起 PR）

| 项 | 要求 |
|---|---|
| integration 新建 | test/integration 进变异面；§5.1 每条附判据句（把 X 改坏必须红）；反面冒烟（只断不抛错）不计数 |
| 面→级映射 | A 差分 / B 定向变异 / C 只读论证 + 基线对账（改名面禁先跑差分，先对账） |
| 删测登记 | 文件:行 + expect + 加强/弱化 + 待补落点 + owner；删段/并段单独登记；探针 worktree 隔离 + 双同步 |
| 重构期六动作 | 拓扑重切与搬家同原子；--force 重测；coverage 快照；CRAP/complexity 分验；.mjs 另立覆盖率锚；重基线只升 |

## 4. #771 移交（双坐标：旧 domain1/2 → 新 server 域，owner 见 evidence-pack 附录）

- history：并发三条；aggregate：多错语义冻结、注解、dir、死代码删、性能延期；组合根：钩子移出包入口（snapshot 证明）；upgrade/schedule：ensureLastRunMigrated 走注入写面；e2e：pollUntil 化 + 可观测断言；随搬家：JSDoc 错位修正。

## 5. 收官检查

- 导出面零漂移；leaf/file 环与 directImpl 清零；common 消失；跨域值边只经 deps.ts 且 Pick 收窄；组合根无业务判断、装配卸载成对逆序。
- 本表每行粘贴实际 exit code；任一非 0 不得声称完成。
