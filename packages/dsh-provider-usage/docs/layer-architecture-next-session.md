# 下会话 prompt：主控协调子 agent 推进 dsh-provider-usage 分层重构（交接物 v3）

> 使用：把下面「交接 prompt」整段贴给新会话。新会话为**主控**，按编排建议派子 agent 推进
> 阶段三→收尾。全部回复/注释/提交信息全中文（技术专名保留）；方案已定稿无需再评审，
> 按本文件执行并如实汇报门禁/CI 结果。

---

## 交接 prompt

```
背景：dsh-provider-usage（packages/dsh-provider-usage/）分层重构已推进三阶段：
- 阶段零/一（变异分层网 + D7 面板缓存整体下沉）已合入 main（PR #671，squash）
- 阶段二（D8 executor 独立工厂 + 报告面组合收敛）PR #675：CI 39 checks 全绿、仅 BEHIND，
  本会话第一步 rebase 合入
- 跟踪 issue：wingsky-1/dsh-plugin-hub#670（阶段清单前三已勾选，D1-D17 决策表）
- 方案唯一事实源：packages/dsh-provider-usage/docs/refactor-implementation-plan.md
  （阶段零→收尾、目录树两级域→层、35 文件映射表 §5、跨域引用清单 §6、双专家评审结论 §7）
- 契约基线：docs/layer-architecture.md（符号锚契约表 + 决策表 D1-D17）
- 交接物：本文档（含编排建议与经验教训）

## 执行序列（每阶段门禁全绿 → commit → push → PR 关联 #670 → issue 勾选+评论 → 合入后下一阶段）

### 0. 合入阶段二 PR #675
1. git fetch origin；新 worktree：git worktree add ../dsh-hub-task-670-phase3 -b task/670-phase3 origin/main
   （主 checkout dsh-plugin-hub 禁改禁切分支禁实验，一切在 worktree）
2. 合 #675：gh pr merge 675 --squash --delete-branch（若 BEHIND：先 rebase origin/main →
   force push → 等 CI 全绿再 merge；rebase 后检查 docs 中基线哈希引用是否失效并同步）
3. 基于合入后的 origin/main 起阶段三 worktree，pnpm install，继续

### 1. 阶段三 · 护栏 + aggregator 拆分（M，2-3 天）
顺序铁律：R8 断言先上线 → aggregator 拆分 → 变异段同步
- R8 四不变量：真缺口仅「台账守恒」（Σ事件 == buckets == agg == dirRows + unidentified）；
  其余三不变量（身份快照/防双计/残差归未识别）已被 unit-trend 1991 行覆盖，仅显式命名归组
  ——事件回放式端到端断言（注入时钟 + 回放 collector emit 序列全链对账）
- aggregator 拆分（D2）：守恒断言钉住后按职责拆（纯函数提取：压实转换/查询投影→独立模块，
  主类留状态容器+方法；防「拆文件=共享 this」坏味道）；trend-aggregate 段 mutate 文件组同步
- 域2每层错误面（可选）：aggregator/schedule/execute 每层错误计数+最近 N 条（registry.recordError
  同款模式），/health 增 per-layer 段；崩溃注入冒烟（可选）：formatPanel 抛错/LLM 超时/
  写盘失败/executor 抛错 → 进程不退出、他域不感知、无半写

### 2. 阶段四 · 目录化（L，3-5 天，可派多子 agent 并行）
- 目录树见 plan §4（shared/ + domain1/{registry,pipeline,history,adapters,routes} +
  domain2/{collect,aggregate,common,schedule,execute,routes} + apply/ + client 不动）
- 35 文件映射表 plan §5；每层 interface.ts **最小面导出**（禁整文件 re-export；
  关键收口点 StatsService/executor 工厂/路由 context 深封装）
- 门禁：main 已合入 verify-dir-imports（#668）——先查 scripts/gate/verify-dir-imports 能否
  扩展覆盖本包（或按 plan D9 扩展 verify-docs 软/硬组合）；跨目录直引软报告不卡 CI
- 契约表符号锚已迁移（layer-architecture）；import 边界成果 = 目录结构 + interface.ts + 门禁
- 验收：产物等价性 diff（重构前后 lib/index.js 仅 import 路径差异）+ AI 可导航性前后对比
  （修复典型 bug 打开文件数）
- 变异 topology segments 与目录对齐（gen-stryker-conf 派生，SSOT=mutation-topology.json）
- 客户端本轮不改（D15 backlog）；prompts.ts 顺手拆不排期

### 3. 收尾 · 死面清理（S，独立 PR）
- capsuleHtmlFromHistory（v2.ts + index.ts re-export + unit-contract 用例）：deprecated shim
  一个版本周期后删除（本收尾 PR 直接删除时须在提交信息注明 breaking）
- contracts.ts:108 retention 删除 + adapter-guide.md/README.en.md 文档示例同步（两处）
- 独立 PR 关联 #670

## 主控编排建议（子 agent 分工，后台并行）
- 阶段四拆 3-4 个子 agent 并行：A=shared/+domain1 组（含 StatsService 门面收口）、B=domain2 组、
  C=apply/+verify-docs 门禁扩展+产物 diff 验收、D=变异拓扑对齐+测试迁移；主控汇总冲突裁决
- 阶段三拆 2 个子 agent：A=R8 台账守恒断言 + aggregator 拆分（串行依赖，一 agent 顺序做）、
  B=域2错误面/崩溃注入冒烟（独立并行）
- 每阶段完成后主控跑全量门禁（build/test/contract/typecheck/pack:check/stryker:check +
  受影响段变异实测），禁止仅依赖子 agent 自报

## 硬性纪律
- worktree 内改代码/跑门禁；主 checkout 保持干净；测试落盘 mkdtemp 隔离；smoke 离线
- 变异机制：SSOT=scripts/data/mutation-topology.json（增段/改 mutate/testFiles）→
  node scripts/gate/gen-stryker-conf.mjs && --check；新测试文件**必须进 testFiles 杀灭面**
  （否则新文件变异 0%——executor/list-dirs/config-service 首跑全 0 的前车之鉴）
- 变异基线：新段/改段后全包基线需重建（段无重叠直接加和；位置去重口径见
  scripts/lib/mutation-report-lib.mjs；gauntlet.config.json 的 baseline* 与 scope/config 描述同步，
  baselineDate 更新当日）
- 注释只写 why；设计决策进提交信息（Suggested Commit Message 三段：改动摘要/设计决策/关联 issue）
- ralph/深层子 agent 不用于本任务；子 agent 返回完整结论，主控裁决

## 经验教训（本次会话排坑记录，避免重踩）
1. 新测试必须入 mutation-topology testFiles（否则变异 0% 覆盖）
2. smoke 源码契约断言锁定实现位置（如 listDirs 净化表达式原先在 apply.ts）——移动实现后
   断言目标文件必须同步（本次已把断言指向 report/list-dirs.ts）
3. ReportConfig 结构是顶层平铺（daily/weekly/monthly 为顶层字段，非嵌套 periods）
4. generation/并发时序测试：用 pollUntil 等「已进入挂起点」信号（fetchEntered），
   避免同步动作早于异步链快照（purgeAllCaches 先于 getStats 取 gen 快照的竞态）
5. getStats 成功后 append 落盘会清面板缓存（主失效机制）；/stats 错误帧会写缓存——
   「清空后 cacheSize==0」等断言须放在相应请求之前
6. 契约表/Docs 中基线哈希引用（D14 符号锚替代行号）在 rebase 后失效——合入流程中检查并同步
   （先例：86831a8 → e64f859）
7. 每阶段 = 源码 + L1/L2 + L3 关联 UC + L4 段更新，缺一不可入 PR（D17）
8. cli 接近尾声时先 summary；worktree 清理（git worktree remove）只动自己建的
```

---

## 供主控参考的快速事实

- 主 checkout：/home/tangyi/dev/learn/dsh-plugin/github/dsh-plugin-hub（main，禁改）
- 阶段二 worktree：/home/tangyi/dev/learn/dsh-plugin/github/dsh-hub-task-670-phase2（task/670-phase2，PR #675）
- 阶段三起新 worktree：../dsh-hub-task-670-phase3（基于 origin/main）
- 方案/映射/清单：packages/dsh-provider-usage/docs/refactor-implementation-plan.md
- 跟踪 issue：#670；阶段二 PR：#675
- archify bin：/home/tangyi/.dsh/profiles/web/node_modules/@tt-a1i/archify-dsh/skills/archify/bin/archify.mjs
  （validate/deliver/visual-check，图更新需重渲染）