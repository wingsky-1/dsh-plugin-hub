# dsh-mcp-manager 分层架构重构方案——对抗性评审（v1 结论 62/100，需重大修正）

> 评审代理：cc6b84b8（微服务专家/资深架构师视角，只读核验 src/test/shared/scripts/门禁配置）
> 评审对象：docs/architecture-redesign.md（v1，253 行）；依据：requirements-and-tdd-plan.md（374 行）

## 总评
方向大体正确（拆 manager、L06 路由单一事实源、L11 执行管道、B1–B18 修复映射都是对的），
但方案是「把迁移风险和交付顺序严重低估、把契约面当成'现状已具备'的重设计蓝图」。

三关键修正：
1. index.ts 聚合 re-export 保导出面**不成立**：service-contract.test.ts:145 硬编码
   readFileSync("src/apply-services.ts") 做 provide marker 静态扫描——apply-services.ts 移入
   bootstrap/ 该测试必红（pnpm test 必跑路径）。
2. stryker/基线影响严重低估：六段 stryker.conf.d mutate 是显式 src 文件清单，
   mutation-topology.json 由 workflow-assert 锚定三方一致，PR 有 mutate-scope-guard，
   observe 基线为 src 口径夜间全量班重建；物理迁移 = 清单全失效 + incremental 缓存全废 +
   58.74%（<60%）基线的重建窗口。方案一笔带过。
3. 拆分归属多处错位：B10 是 ws_mcp_search 检索面缺陷（middleware-register.ts:181）非执行管道；
   目录检索函数族（searchCatalogMulti/listCatalog/findToolDetail/boundCatalogTools/scoreTool/
   isCatalogFresh）在 9 域目录无落位；L04 契约 normalizeScope 与 L06 矛盾；
   客户端目录图缺 src/client/index.ts（build-client 入口+干净模块锚点）；
   MIDDLEWARE_GLOBAL_ROOT 双常量（manager.ts:42 / middleware-utils.ts:37）未收敛。

## 逐维度发现（摘要）
- 微服务教条化：13 层过度设计；L04/L05、L07/L08、L13 是「已拆好的文件贴标签」；
  合并为 7 逻辑层 + 9 物理目录。唯一真实拆分收益是 L07/L08（manager 1184 行 +
  MIDDLEWARE_GLOBAL_ROOT 双常量证明路由域名需收敛）。
- L11「组合器 executeTool 单入口」收益有限：两路径差异面已由 CallResultTextHandlers 注入，
  无第三消费者；改「纯函数族 + 薄适配 + 契约测试强制两路径同构」，不建大组合器。
- 契约缺口：错误契约（HTTP body 与日志双轨脱敏，B8 P0-② supervisor:362 日志不脱敏未入方案）；
  事件契约（summary 帧经 emitStatus 无参 coalesce；ui-config-changed 帧由 settings onChange
  直接广播不经 emitStatus 不 coalesce——两帧不同链）；AbortSignal 面；Config schema 默认
  （middleware: project）vs 运行时默认（off）双源；B5 修复 start() 同步→异步契约涟漪
  （波及 routes×9 + apply + 测试）。
- 依赖环事实：manager↔middleware、catalog↔manager 无环（最小面接口已成功）；
  middleware-register↔middleware 是类型环（已用 import type 破，物理分域后若 middleware.ts
  仍 re-export 会变真环）；漏报 routes.ts:21 import type from ./index.ts 组合根类型环。
- off 模式 guard 不挂载（pre-execute guard 只在 middleware-register.ts:632，
  apply.ts:139 仅 mode≠off 注册）→「工具级禁用三入口」off 模式实际一入口。
- B5/B18 归因半对：B5 是编排层漏调清理（必要不充分，需写明 L07 调用义务）；
  B18 是执行层两实例口径分裂（supervisor vs 池），非编排 vs 执行。
- registerCatalogInjection 半对：决策纯函数属 L10 ✓，挂载实现（apply-runtime.ts:74
  ctx.on("agent/pre-step")）在 bootstrap，catalogViewFor 实现仍在 manager.ts:443
  依赖三个私有状态，搬迁成本未披露。
- B1–C15 映射缺口：B2/B6/B7/B11/B12/B19 在阶段表无落位。
- 门禁口径悬案：gauntlet baselineScore=58.74（<60）但 baselineCovered=74.66（>60），
  DEV §0 判分输入是 covered——「≥60」是总得分还是 covered 须先澄清，
  否则迁移 PR（全量重算）在未达标态互相卡死。

## 拆分裁定表（合并后 7 逻辑层 + 组合根 + 共享）
| 层 | 裁定 | 说明 |
|----|------|------|
| 客户端层（L00–L02） | ✅ | core/ float/ settings/ 子目录；补 src/client/index.ts + style.css 引用路径 |
| API 层（L03） | ✅ | sse-exit/health 归属写明 |
| 配置域（L04+L05） | ⚠️合并 | model/ 与 store/ 子目录即边界，不再双逻辑层；normalizeScope 归 L06 |
| 连接域（L07+L08） | ⚠️合并+拆子 | orchestrator/ execution/；状态事件层并入；B5 契约先行；callTool 管道段切割线 |
| 模型面+目录（L09+L10） | ⚠️拆目录 | inject/ catalog/；目录检索函数族落位 catalog/search.ts；guard off 覆盖语义 |
| 执行管道（L11） | ✅修正 | 纯函数族+薄适配；B10 移出；supervisor 埋点为行为扩展声明 |
| 服务/统计（L12+L13） | ✅ | 契约补 B6 决策、B2 接线前置 |
| 状态事件层 | ⚠️并入 L07 | 两帧触发源/coalesce 差异契约先定 |
| 组合根/共享 | ✅ | 维持 |

## P0/P1/P2 修正
P0：①迁移方案重写为「逻辑收敛 + 单一集中纯搬移 PR + 静态面全同步 + 门禁兜底」，静态面清单
（service-contract 路径/stryker 六段/topology/observe 基线/incremental 缓存）；
②契约先行补错误契约/事件契约/AbortSignal 与超时口径；③修拆分归属（B10/检索族/normalizeScope/
双常量/客户端 index.ts/B11 拍板/阶段表补 B2 B6 B7 B11 B12 B19）；④B5 start 同步→异步决策先行。
P1：阶段 1 先做测试基建（fakeTransport/fakeMCPClient 桩、B2 接线、createRedactor 基线测试、B7
直测）；B3 提前脱离 L06；六态一致（B1+B4+C13）单 PR；stryker 段管理集中到迁移 PR。
P2：B12/B19/B15/B16、哑断言清理、smoke sleep 改 pollUntil、C2/C6/C7、
阶段 7 目标校准（先澄清判分输入再排「先提分后迁移」或「迁移走夜间重建豁免」）。

## 一句话收尾
「对的方向 + 错的比例尺」：L06/L11/B 系列修复与 TDD 分阶段是对的；13 层、分布式物理迁移、
「导出面保住一切静态契约」三个假设必须按 P0 修正后才可进入 issue 方案评审；
建议先落「阶段 0 规格决策表 + 契约缺口清单 + 迁移门禁策略」三件文档再谈拆代码。

---

## 二轮评审（评审对象 v2，结论 78/100，可执行骨架仍有机制空洞）

> 评审代理：14e24671。A 核验（v1 P0/P1/P2 落实）、B 新问题、C 复核 v1 断言。

### 最关键 3 条
1. **D2 是伪决策**：B5 最小修复只需替换分支补调 `void existing.disconnect()`——旧实例 disconnect await
   syncChain（supervisor.ts L508-512）、新代际 syncTools 经 enqueueSync 排同一 syncChain（L323-327），
   FIFO 天然保证旧清理先于新注册，start 无需变 async；「涟漪波及 routes×9」失实（routes-controllers.ts
   零处直接调 manager.start/reconcileServers，真涟漪在 manager 内部 5 处 + apply.ts L148/L150）。
2. **D7 已闭环**：mutation-gate.mjs 判 coveredScore < threshold（covered 口径）；gauntlet
   dsh-mcp-manager baselineCovered=74.66≥60 已达标、strict=true——「迁移卡死」不成立。
   D7 改写为「observe 回落判据（covered<baselineCovered-1pp，observe-check.mjs）+ incremental 缓存
   重建豁免」二选一，而非「先澄清判分输入」。
3. **阶段 2 与 §四3 矛盾**：阶段 2「execution/ 挂 stryker 段」vs §四3「六段清单阶段 6 同步」+
   v1 P1「段管理集中迁移 PR」；防空段断言（workflow-assert L346-354）只查正向条目 glob 到现存文件、
   不查 src 全覆盖 → 阶段 1–5 新文件属变异盲区。二选一必须拍死。

### A 核验（v1 P0/P1/P2 → v2 落实）
- P0-① ⚠️部分：静态面清单✓；但 apply-services.ts 阶段 1–5「禁止薄转发」不变式未写死（service-contract
  L145 readFileSync + L150 marker 扫描落点，薄转发即红）。
- P0-② ⚠️部分：HTTP 400 body 脱敏写了承诺没写机制（routes handleError 直写、routes 侧无 redactor 注入面）。
- P0-③ ⚠️部分：B6 无修复落位（只有阶段 0 决策 D3）。
- P0-④ ❌前提有误：D2 async 选项基于失实的 routes×9 涟漪。
- P1 ⚠️：六态单 PR 中 C13 客户端改动与宿主端 B1/B4 同 PR 跨端。
- P2 ⚠️：D7 未闭环。

### B 新问题（11 项要点）
- 目录图漏 middleware-const.ts（10+ 常量）与 middleware-types.ts（ProjectUnit/CatalogTool 等）落位；
- msgOf 无归位；stryker exclude 只排 !src/types.ts 不排 src/types/**；
- connection/execution 与 execution 双目录命名歧义；
- config-schema.ts L10-11 跨域 import catalog/supervisor 常量未处理；
- catalogViewFor 迁出需含私有 diskCatalogSummaryCache（mtime 缓存）；
- getTools 同源后裸名/注册名键形态未决策；
- D5「规格化不可逆」若改名会冲击官方 mcp__ 同名契约；
- D8 off 模式 guard 无数据源（off 时 manager.middleware===undefined）；
- B12/B19 行为修复在阶段 6 之后（迁移时未修完，可自洽但未显式化）；
- 阶段 6「迁移专用验证」未定义机制。

### C 复核（v1 断言）
- 撤回：v1「PR 有 mutate-scope-guard」——已随 #276 退役，workflow-assert.test.ts L407-413 锁定不得再调用，
  v2 沿用了过时事实，应从静态面清单删除。
- 修正：「迁移 PR 互相卡死（58.74<60）」后果过强（判分输入是 covered 已达标）；「routes×9 涟漪」失实。
- 维持：service-contract 必红、13 层过度设计、B10 归属、B9 方向说反、B20 热切换修正、unit-call-stats 孤儿。
